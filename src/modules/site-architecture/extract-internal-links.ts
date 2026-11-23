import * as cheerio from "cheerio";
import {
  MAX_LINK_HTML_BYTES, MAX_LINKS_PER_PAGE, safeLinkPageUrl,
  type InternalLinkObservation,
} from "./internal-link-quality.js";

/** Inert static DOM observation: never runs scripts or resolves fetched pages. */
export function observeInternalLinks(html: string, rawUrl: string): InternalLinkObservation {
  const url = safeLinkPageUrl(rawUrl) ?? "";
  const empty: InternalLinkObservation = {
    url, title: "", h1: "", main_present: false,
    navigation_links_excluded: 0, extraction_limited: false, links: [],
  };
  if (!url || !html || new TextEncoder().encode(html).byteLength > MAX_LINK_HTML_BYTES) {
    return empty;
  }
  const $ = cheerio.load(html);
  const pageUrl = new URL(url);
  const rawBase = $("head > base[href]").first().attr("href");
  let documentBase: URL | undefined;
  if (rawBase && rawBase.length <= 1024) {
    try {
      const candidate = new URL(rawBase, pageUrl);
      if (["http:", "https:"].includes(candidate.protocol) && candidate.hostname &&
        !candidate.username && !candidate.password && !candidate.port &&
        (candidate.origin !== pageUrl.origin || candidate.pathname !== pageUrl.pathname ||
          candidate.search !== pageUrl.search)) documentBase = candidate;
    } catch { /* Invalid document base: retain the supplied page URL. */ }
  }
  const titleText = $("head > title").first().text().replace(/\s+/gu, " ").trim();
  let limited = titleText.length > 300;
  const title = titleText.slice(0, 300);
  const excludedLinks = $("nav a[href],header a[href],footer a[href],aside a[href]").length;
  $("template,script,style,noscript,nav,header,footer,aside,[hidden],[aria-hidden='true']").remove();
  const main = $("main,[role='main']").first();
  const article = $("article").first();
  const root = main.length ? main : article.length ? article : $("body").first();
  if (!root.length) {
    return { ...empty, title, navigation_links_excluded: Math.min(excludedLinks, MAX_LINKS_PER_PAGE),
      extraction_limited: limited || excludedLinks > MAX_LINKS_PER_PAGE };
  }
  const h1Text = root.find("h1").first().text().replace(/\s+/gu, " ").trim();
  const h1 = h1Text.slice(0, 300);
  if (h1Text.length > 300) limited = true;
  const anchors = root.find("a[href]").toArray();
  if (anchors.length > MAX_LINKS_PER_PAGE || excludedLinks > MAX_LINKS_PER_PAGE) limited = true;
  const links: InternalLinkObservation["links"] = [];
  const safeTrim = (text: string) => text.replace(/\s+/gu, " ").trim().slice(0, 180);
  const sampledAnchors = anchors.slice(0, MAX_LINKS_PER_PAGE);
  const referencedIds = new Set<string>();
  for (const anchor of sampledAnchors) {
    for (const id of ($(anchor).attr("aria-labelledby") ?? "").split(/\s+/u).slice(0, 4)) {
      if (id && id.length <= 80) referencedIds.add(id);
    }
  }
  // Pre-index the referenced names once instead of searching the DOM for
  // every anchor and every aria-labelledby token.
  const referencedLabels = new Map<string, string>();
  if (referencedIds.size) {
    $("[id]").each((_, element) => {
      const id = $(element).attr("id");
      if (id && referencedIds.has(id) && !referencedLabels.has(id)) {
        referencedLabels.set(id, safeTrim($(element).text()));
      }
    });
  }

  for (const element of sampledAnchors) {
    const node = $(element);
    const href = node.attr("href") ?? "";
    // Never leak href into tool results; it exists only in the transient comparison.
    if (href.length > 1024) {
      limited = true;
      continue;
    }
    let effectiveHref = href;
    if (documentBase && href.trim() && !/^[a-z][a-z\d+.-]*:/iu.test(href.trim())) {
      try {
        const resolved = new URL(href.trim(), documentBase);
        if (resolved.href.length > 1024) {
          limited = true;
          continue;
        }
        effectiveHref = resolved.href;
      } catch {
        limited = true;
        continue;
      }
    }
    const aria = safeTrim(node.attr("aria-label") ?? "");
    const labelledbyIds = (node.attr("aria-labelledby") ?? "")
      .split(/\s+/u).slice(0, 4).filter((id) => id.length > 0 && id.length <= 80);
    const labelledby = labelledbyIds
      .map((id) => referencedLabels.get(id) ?? "")
      .filter(Boolean).join(" ").slice(0, 180);
    const visible = safeTrim(node.text());
    const alt = safeTrim(node.find("img[alt]").toArray().slice(0, 4)
      .map((image) => $(image).attr("alt") ?? "").join(" "));
    const titleLabel = safeTrim(node.attr("title") ?? "");
    const label = aria || labelledby || visible || alt || titleLabel;
    const rel = new Set((node.attr("rel") ?? "").toLowerCase().split(/\s+/u));
    links.push({
      href: effectiveHref, label,
      accessible: Boolean(label),
      nofollow: rel.has("nofollow"),
    });
  }
  return {
    url, title, h1,
    main_present: Boolean(main.length || article.length),
    navigation_links_excluded: Math.min(excludedLinks, MAX_LINKS_PER_PAGE),
    extraction_limited: limited,
    links,
  };
}
