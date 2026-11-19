import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewMediaHtml, MAX_MEDIA_ELEMENTS, MAX_MEDIA_FINDINGS, MAX_MEDIA_HTML_BYTES,
} from "../dist/modules/browser-ux/media-diagnostics.js";

const html = (body) => "<!doctype html><html lang=en><head><title>Media</title></head><body>" +
  body + "</body></html>";
const findings = (value, code) => value.findings.filter((entry) => entry.code === code);

test("P1-10 reads ordinary static responsive media without inventing failures", () => {
  const result = reviewMediaHtml(html(
    '<picture><source type="image/webp" srcset="image.webp"><img src="image.jpg" alt="Tea cup" width="640" height="480" loading="lazy" decoding="async" fetchpriority="low"></picture>' +
    '<video src="movie.mp4" controls><track kind="captions" src="movie.vtt" srclang="en"></video>',
  ));
  assert.equal(result.images_observed, 1);
  assert.equal(result.pictures_observed, 1);
  assert.equal(result.videos_observed, 1);
  assert.equal(result.source_elements_observed, 1);
  assert.equal(result.track_elements_observed, 1);
  assert.equal(result.images_without_explicit_alt, 0);
  assert.equal(result.videos_without_caption_track, 0);
  assert.equal(result.total_findings, 0);
  assert.equal(result.coverage_limited, true);
});

test("P1-10 missing alt is observed; intentionally decorative empty alt is not automatically an error", () => {
  const result = reviewMediaHtml(html('<img src="a.jpg"><img src="decor.jpg" alt="">'));
  assert.equal(result.images_without_explicit_alt, 1);
  assert.equal(result.images_with_empty_alt, 1);
  assert.equal(findings(result, "image_name_unobserved").length, 1);
  assert(findings(result, "image_name_unobserved").every((f) => f.severity === "warning"));
});

test("P1-10 distinguishes presentational image roles from explicit semantic images", () => {
  const result = reviewMediaHtml(html(
    '<img src="a.svg" role="presentation">' +
    '<img src="b.svg" role="none">' +
    '<img src="c.svg" role="img" alt="">' +
    '<img src="d.svg" role="img" alt="" aria-label="Status icon">',
  ));
  assert.equal(result.images_without_explicit_alt, 2);
  assert.equal(result.images_with_empty_alt, 2);
  assert.equal(findings(result, "image_name_unobserved").length, 1);
  assert.equal(findings(result, "image_name_unobserved")[0].element, 3);
});

test("P1-10 nonempty ARIA label or resolvable labelledby prevents false missing-name findings", () => {
  const result = reviewMediaHtml(html('<span id="label">Portrait</span>' +
    '<img src="a.jpg" aria-labelledby="label">' +
    '<img src="b.jpg" aria-label="Portrait">' +
    '<img src="c.jpg" title="Portrait">'));
  assert.equal(result.images_without_explicit_alt, 3);
  assert.equal(findings(result, "image_name_unobserved").length, 0);
});

test("P1-10 unresolved aria-labelledby is not mistaken for a verified accessible name", () => {
  const result = reviewMediaHtml(html('<img src="a.jpg" aria-labelledby="does-not-exist">'));
  assert.equal(findings(result, "image_name_unobserved").length, 1);
});

test("P1-10 whitespace-only alt is distinct from alt explicitly equal to empty string", () => {
  const result = reviewMediaHtml(html('<img src="a.jpg" alt=" ">'));
  assert.equal(findings(result, "image_whitespace_alt").length, 1);
  assert.equal(result.images_with_empty_alt, 0);
});

test("P1-10 link with a sole decorative or missing-name image is a review lead", () => {
  const result = reviewMediaHtml(html('<a href="/go"><img src="decor.jpg" alt=""></a>' +
    '<a href="/ok" aria-label="Go to gallery"><img src="ok.jpg" alt=""></a>' +
    '<a href="/text"><img src="x.jpg" alt="">View photo</a>' +
    '<a href="/alt"><img src="y.jpg" alt="View gallery"></a>'));
  assert.equal(findings(result, "linked_image_name_unobserved").length, 1);
});

test("P1-10 srcset-only image counts as source; missing both src and srcset is unobserved", () => {
  const result = reviewMediaHtml(html('<img srcset="a.webp 2x" alt="A">' +
    '<img src="  " srcset=" " alt="B">'));
  assert.equal(result.image_sources_unobserved, 1);
  assert.equal(findings(result, "image_source_unobserved").length, 1);
});

test("P1-10 checks loading, decoding and fetchpriority hints without claiming measured performance", () => {
  const result = reviewMediaHtml(html(
    '<img src="a.jpg" alt="A" loading="instant" decoding="wrong" fetchpriority="urgent">' +
    '<img src="b.jpg" alt="B" loading="LAZY">' +
    '<img src="c.jpg" alt="C" width="400" height="300" loading="lazy">',
  ));
  assert.equal(findings(result, "image_invalid_loading").length, 1);
  assert.equal(findings(result, "image_invalid_decoding").length, 1);
  assert.equal(findings(result, "image_invalid_fetchpriority").length, 1);
  assert.equal(result.lazy_images_without_intrinsic_dimensions, 1);
  assert.equal(findings(result, "image_lazy_dimensions_unobserved").length, 1);
  assert(result.limitations.join(" ").includes("CSS"));
});

test("P1-10 missing picture fallback and empty source srcset are independently observed", () => {
  const result = reviewMediaHtml(html('<picture><source srcset=""></picture>'));
  assert.equal(result.pictures_observed, 1);
  assert.equal(result.picture_fallbacks_unobserved, 1);
  assert.equal(findings(result, "picture_fallback_unobserved").length, 1);
  assert.equal(findings(result, "picture_source_srcset_unobserved").length, 1);
});

test("P1-10 video with no source or caption is uncertain, not automatically an accessibility violation", () => {
  const result = reviewMediaHtml(html('<video autoplay></video>'));
  assert.equal(result.videos_without_observed_source, 1);
  assert.equal(result.videos_without_caption_track, 1);
  assert.equal(findings(result, "video_source_unobserved").length, 1);
  assert.equal(findings(result, "video_caption_track_unobserved").length, 1);
  assert.equal(findings(result, "video_autoplay_without_muted").length, 1);
  assert(findings(result, "video_caption_track_unobserved").every((f) => f.severity === "info"));
});

test("P1-10 video recognizes source child, default subtitles kind and caption track source warnings", () => {
  const result = reviewMediaHtml(html('<video muted autoplay><source src="a.mp4">' +
    '<track src="a.vtt" srclang="en"></video>' +
    '<video src="b.mp4"><track kind="captions"></video>'));
  assert.equal(result.videos_without_observed_source, 0);
  assert.equal(result.videos_without_caption_track, 0);
  assert.equal(findings(result, "video_caption_source_unobserved").length, 1);
  assert.equal(findings(result, "video_autoplay_without_muted").length, 0);
});

test("P1-10 excludes explicitly hidden or inert descendants, not every page image", () => {
  const result = reviewMediaHtml(html('<template><img src="template.jpg"></template>' +
    '<div hidden><img src="hidden.jpg"></div>' +
    '<div aria-hidden="true"><img src="aria.jpg"></div>' +
    '<div style="display:none"><video></video></div>' +
    '<img src="visible.jpg" alt="Visible">'));
  assert.equal(result.images_observed, 1);
  assert.equal(result.videos_observed, 0);
  assert.equal(result.total_findings, 0);
});

test("P1-10 does not leak input HTML, source paths, query tokens or alt values in diagnostics", () => {
  const secret = "FAKE_SECRET_TOKEN";
  const result = reviewMediaHtml(html('<img src="https://example.test/'+secret+'?token='+secret+'" alt="'+secret+'" loading="bad">' +
    '<video src="https://user:'+secret+'@example.test/v.mp4"></video>'));
  assert.equal(findings(result, "image_invalid_loading").length, 1);
  assert(!JSON.stringify(result).includes(secret));
  assert(!JSON.stringify(result).includes("https://"));
  assert(!JSON.stringify(result).includes("/v.mp4"));
});

test("P1-10 reports deterministic bounded output under 160 images and many findings", () => {
  const page = html(Array.from({ length: MAX_MEDIA_ELEMENTS }, () => '<img loading="lazy">').join(""));
  const result = reviewMediaHtml(page);
  assert.equal(result.media_elements_checked, MAX_MEDIA_ELEMENTS);
  assert.equal(result.images_observed, MAX_MEDIA_ELEMENTS);
  assert(result.total_findings > MAX_MEDIA_FINDINGS);
  assert.equal(result.findings.length, MAX_MEDIA_FINDINGS);
  assert.equal(result.findings_truncated, true);
  assert(Buffer.byteLength(JSON.stringify(result), "utf8") < 8_000);
  assert.deepEqual(result, reviewMediaHtml(page));
});

test("P1-10 refuses oversized UTF-8 HTML; separately marks elements beyond sample cap", () => {
  assert.throws(() => reviewMediaHtml(""), /nonempty/);
  assert.throws(() => reviewMediaHtml("é".repeat(Math.floor(MAX_MEDIA_HTML_BYTES / 2) + 1)), /180,000/);
  const count = MAX_MEDIA_ELEMENTS + 9;
  const result = reviewMediaHtml(html("<img src='x.jpg' alt=''>".repeat(count)));
  assert.equal(result.images_observed, count);
  assert.equal(result.media_elements_checked, MAX_MEDIA_ELEMENTS);
  assert.equal(result.media_elements_truncated, true);
  assert(result.limitations.some((limitation) => limitation.includes("cap")));
});

test("P1-10 empty media sample stays limited rather than asserting the live site is healthy", () => {
  const result = reviewMediaHtml(html("<main><h1>Text-only</h1></main>"));
  assert.equal(result.media_elements_checked, 0);
  assert.equal(result.total_findings, 0);
  assert.equal(result.coverage_limited, true);
});
