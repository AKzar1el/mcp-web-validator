import * as cheerio from "cheerio";

/**
 * P1-10: local-only, static HTML media evidence.
 * Do not fetch sources, execute scripts, infer decoded assets or claim WCAG compliance.
 */
export const MAX_MEDIA_HTML_BYTES = 180_000;
export const MAX_MEDIA_ELEMENTS = 160;
export const MAX_MEDIA_FINDINGS = 12;

export type MediaFindingCode =
  | "image_name_unobserved"
  | "image_whitespace_alt"
  | "linked_image_name_unobserved"
  | "image_source_unobserved"
  | "image_lazy_dimensions_unobserved"
  | "image_invalid_loading"
  | "image_invalid_decoding"
  | "image_invalid_fetchpriority"
  | "picture_fallback_unobserved"
  | "picture_source_srcset_unobserved"
  | "video_source_unobserved"
  | "video_caption_track_unobserved"
  | "video_caption_source_unobserved"
  | "video_autoplay_without_muted";

export interface MediaFinding {
  code: MediaFindingCode;
  severity: "warning" | "info";
  media_type: "image" | "picture" | "video";
  element: number;
  message: string;
}

export interface MediaDiagnostics {
  scope: "caller_supplied_static_media_markup_only";
  images_observed: number;
  pictures_observed: number;
  videos_observed: number;
  source_elements_observed: number;
  track_elements_observed: number;
  media_elements_checked: number;
  media_elements_truncated: boolean;
  images_without_explicit_alt: number;
  images_with_empty_alt: number;
  images_without_intrinsic_dimensions: number;
  lazy_images_without_intrinsic_dimensions: number;
  image_sources_unobserved: number;
  videos_without_observed_source: number;
  videos_without_caption_track: number;
  picture_fallbacks_unobserved: number;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: MediaFinding[];
  findings_truncated: boolean;
  error?: string;
}

export function emptyMediaDiagnostics(): MediaDiagnostics {
  return {
    scope: "caller_supplied_static_media_markup_only",
    images_observed: 0, pictures_observed: 0, videos_observed: 0,
    source_elements_observed: 0, track_elements_observed: 0,
    media_elements_checked: 0, media_elements_truncated: false,
    images_without_explicit_alt: 0, images_with_empty_alt: 0,
    images_without_intrinsic_dimensions: 0, lazy_images_without_intrinsic_dimensions: 0,
    image_sources_unobserved: 0, videos_without_observed_source: 0,
    videos_without_caption_track: 0, picture_fallbacks_unobserved: 0,
    coverage_limited: true,
    limitations: ["The supplied static HTML could not be reviewed within the declared media limits."],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function validDimension(value: string | undefined): boolean {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value.trim());
}

export function reviewMediaHtml(htmlContent: string): MediaDiagnostics {
  if (!htmlContent || new TextEncoder().encode(htmlContent).byteLength > MAX_MEDIA_HTML_BYTES) {
    throw new Error("Media HTML must be nonempty and at most 180,000 UTF-8 bytes.");
  }
  const $ = cheerio.load(htmlContent);
  // Template and noscript bodies are inert source fragments in this static
  // view. Do not infer that their media are rendered, even without a browser.
  $("template, noscript").remove();
  const hidden = (element: Parameters<typeof $>[0]): boolean =>
    $(element).closest('[hidden], [aria-hidden="true"]').length > 0 ||
    $(element).parentsUntil("html").addBack().toArray().some((parent) =>
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/iu
        .test($(parent).attr("style") ?? ""));

  const media = $("img, picture, video").toArray().filter((element) => !hidden(element));
  const images = media.filter((element) => $(element).is("img"));
  const pictures = media.filter((element) => $(element).is("picture"));
  const videos = media.filter((element) => $(element).is("video"));
  const sources = $("picture > source, video > source").toArray().filter((element) => !hidden(element));
  const tracks = $("video > track").toArray().filter((element) => !hidden(element));
  const selected = media.slice(0, MAX_MEDIA_ELEMENTS);

  // Resolve ARIA label ID references once. This is only a static label hint,
  // not an implementation of the browser accessibility-name algorithm.
  const labelled = new Map<string, boolean>();
  $("[id]").each((_, element) => {
    const id = $(element).attr("id");
    if (id && !labelled.has(id)) labelled.set(id, hasValue($(element).text()));
  });
  const namedBy = (element: ReturnType<typeof $>): boolean => {
    if (hasValue(element.attr("aria-label")) || hasValue(element.attr("title"))) return true;
    const references = (element.attr("aria-labelledby") ?? "").trim().split(/\s+/u);
    return references.some((id) => labelled.get(id) === true);
  };
  const findings: MediaFinding[] = [];
  let imagesWithoutAlt = 0, emptyAlt = 0, noDimensions = 0, lazyNoDimensions = 0;
  let imageSourcesUnobserved = 0, videosWithoutSource = 0, videosWithoutCaptions = 0, picturesWithoutImg = 0;

  function add(code: MediaFindingCode, severity: MediaFinding["severity"],
    mediaType: MediaFinding["media_type"], element: number, message: string) {
    findings.push({ code, severity, media_type: mediaType, element, message });
  }

  selected.forEach((element, i) => {
    const number = i + 1;
    const node = $(element);
    if (node.is("img")) {
      const alt = node.attr("alt");
      const role = (node.attr("role") ?? "").trim().toLowerCase().split(/\s+/u)[0];
      const explicitlyDecorative = role === "presentation" || role === "none";
      const explicitlySemantic = role === "img" || role === "image";
      const sourcePresent = hasValue(node.attr("src")) || hasValue(node.attr("srcset"));
      if (!sourcePresent) {
        imageSourcesUnobserved++;
        add("image_source_unobserved", "warning", "image", number,
          "No nonempty src or srcset attribute was observed. Client-side source assignment remains unverified.");
      }
      if (alt === undefined) {
        imagesWithoutAlt++;
        if (!explicitlyDecorative && !namedBy(node)) {
          add("image_name_unobserved", "warning", "image", number,
            "No explicit alt or supported static name fallback was observed; review the intended image purpose.");
        }
      } else if (alt === "") {
        emptyAlt++;
        if (explicitlySemantic && !namedBy(node)) {
          add("image_name_unobserved", "warning", "image", number,
            "An image explicitly given semantic image role has empty alt and no static name fallback.");
        }
      } else if (alt.trim() === "") {
        add("image_whitespace_alt", "warning", "image", number,
          "Whitespace-only alt is neither an explicitly empty decorative alternative nor a meaningful text alternative.");
      }
      const link = node.closest("a[href]");
      if (link.length > 0 && !namedBy(link) && !hasValue(link.text()) &&
        !link.find("img").toArray().some((image) =>
          hasValue($(image).attr("alt")) || namedBy($(image)))) {
        add("linked_image_name_unobserved", "warning", "image", number,
          "The image appears in a link without a static accessible name; review whether the link has usable label text.");
      }
      const dimensions = validDimension(node.attr("width")) && validDimension(node.attr("height"));
      if (!dimensions) noDimensions++;
      const loading = node.attr("loading")?.trim().toLowerCase();
      if (loading !== undefined && !["eager", "lazy"].includes(loading)) {
        add("image_invalid_loading", "info", "image", number,
          "The loading attribute has an unrecognized static value; browser behavior is not verified.");
      }
      if (loading === "lazy" && !dimensions) {
        lazyNoDimensions++;
        add("image_lazy_dimensions_unobserved", "info", "image", number,
          "A lazy-loaded image has no positive intrinsic width and height attributes. CSS sizing may still reserve space.");
      }
      const decoding = node.attr("decoding")?.trim().toLowerCase();
      if (decoding !== undefined && !["sync", "async", "auto"].includes(decoding)) {
        add("image_invalid_decoding", "info", "image", number,
          "The decoding attribute has an unrecognized static value; rendering behavior is not verified.");
      }
      const fetchpriority = node.attr("fetchpriority")?.trim().toLowerCase();
      if (fetchpriority !== undefined && !["high", "low", "auto"].includes(fetchpriority)) {
        add("image_invalid_fetchpriority", "info", "image", number,
          "The fetchpriority attribute has an unrecognized static value; request priority is not measured.");
      }
    } else if (node.is("picture")) {
      if (node.children("img").length === 0) {
        picturesWithoutImg++;
        add("picture_fallback_unobserved", "warning", "picture", number,
          "No direct img fallback was observed in this picture element.");
      }
      if (node.children("source").toArray().some((source) => !hasValue($(source).attr("srcset")))) {
        add("picture_source_srcset_unobserved", "info", "picture", number,
          "A picture source lacks a nonempty srcset; responsive candidate selection is unverified.");
      }
    } else if (node.is("video")) {
      const sourcePresent = hasValue(node.attr("src")) ||
        node.children("source").toArray().some((source) => hasValue($(source).attr("src")));
      if (!sourcePresent) {
        videosWithoutSource++;
        add("video_source_unobserved", "info", "video", number,
          "No video src or direct source src was observed. Dynamically assigned media remains unverified.");
      }
      const captionTracks = node.children("track").filter((_, track) => {
        const kind = ($(track).attr("kind") ?? "subtitles").trim().toLowerCase();
        return kind === "captions" || kind === "subtitles";
      });
      if (captionTracks.length === 0) {
        videosWithoutCaptions++;
        add("video_caption_track_unobserved", "info", "video", number,
          "No captions/subtitles track was observed; verify whether alternatives are needed for the media's purpose.");
      } else if (captionTracks.toArray().some((track) => !hasValue($(track).attr("src")))) {
        add("video_caption_source_unobserved", "warning", "video", number,
          "A captions/subtitles track lacks a nonempty src; playback and text alternatives remain unverified.");
      }
      if (node.attr("autoplay") !== undefined && node.attr("muted") === undefined) {
        add("video_autoplay_without_muted", "info", "video", number,
          "Autoplay is declared without muted; browser autoplay policy may prevent playback.");
      }
    }
  });

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1) ||
    a.element - b.element || a.code.localeCompare(b.code));
  return {
    scope: "caller_supplied_static_media_markup_only",
    images_observed: images.length,
    pictures_observed: pictures.length,
    videos_observed: videos.length,
    source_elements_observed: sources.length,
    track_elements_observed: tracks.length,
    media_elements_checked: selected.length,
    media_elements_truncated: media.length > selected.length,
    images_without_explicit_alt: imagesWithoutAlt,
    images_with_empty_alt: emptyAlt,
    images_without_intrinsic_dimensions: noDimensions,
    lazy_images_without_intrinsic_dimensions: lazyNoDimensions,
    image_sources_unobserved: imageSourcesUnobserved,
    videos_without_observed_source: videosWithoutSource,
    videos_without_caption_track: videosWithoutCaptions,
    picture_fallbacks_unobserved: picturesWithoutImg,
    coverage_limited: true,
    limitations: [
      "Only caller-supplied static HTML media declarations were inspected. No network fetch, browser rendering, JavaScript, CSS, layout, decoded assets, video playback, or caption contents were verified.",
      "Missing intrinsic image dimensions may be handled in CSS; empty alt may be intentional. Counts of possible problems cover only checked elements, not unseen or capped elements.",
      ...(media.length > selected.length ? ["The media sample reached its per-request element cap; unexamined elements remain unverified."] : []),
    ],
    total_findings: findings.length,
    findings: findings.slice(0, MAX_MEDIA_FINDINGS),
    findings_truncated: findings.length > MAX_MEDIA_FINDINGS,
  };
}
