import * as cheerio from "cheerio";
import ipaddr from "ipaddr.js";
import { HOSTED_MAX_LINKS, SERVICE_USER_AGENT } from "./constants";
import { getPrimaryLanguageSubtag, isKnownPrimaryLanguageSubtag } from "./language-subtags";

export type AuditSeverity = "error" | "warning" | "info";

export interface AuditIssue {
  code: string;
  severity: AuditSeverity;
  category: "SEO" | "Schema" | "Accessibility";
  message: string;
}

export interface LinkStatus {
  url: string;
  status: number | "blocked" | "failed";
  ok: boolean;
  message?: string;
}

const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isHttpRedirectStatus(status: LinkStatus["status"]): boolean {
  return typeof status === "number" && HTTP_REDIRECT_STATUSES.has(status);
}

export interface AuditResult {
  issues: AuditIssue[];
  total: number;
  truncated: boolean;
  counts: Record<AuditSeverity, number>;
}

export interface AuditSeoMetadataOptions {
  /** Final HTTP X-Robots-Tag value when auditing a fetched live page. */
  xRobotsTag?: string;
}

const MAX_AUDIT_ISSUES = 100;
const REQUEST_TIMEOUT_MS = 5_000;
const IETF_PROTOCOL_ASSIGNMENTS_IPV4 = ipaddr.parseCIDR("192.0.0.0/24");
const GLOBALLY_REACHABLE_IETF_PROTOCOL_IPV4 = new Set(["192.0.0.9", "192.0.0.10"]);
const IETF_PROTOCOL_ASSIGNMENTS_IPV6 = ipaddr.parseCIDR("2001::/23");
const GLOBALLY_REACHABLE_IETF_PROTOCOL_IPV6 = [
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:1::3/128",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:20::/28",
  "2001:30::/28",
].map((range) => ipaddr.parseCIDR(range));

function createAuditCollector() {
  const issues: AuditIssue[] = [];
  const counts: Record<AuditSeverity, number> = { error: 0, warning: 0, info: 0 };
  let total = 0;
  return {
    add(issue: AuditIssue) {
      total += 1;
      counts[issue.severity] += 1;
      if (issues.length < MAX_AUDIT_ISSUES) issues.push(issue);
    },
    result(): AuditResult {
      return { issues, total, truncated: total > issues.length, counts };
    },
  };
}

function isJsonLdScriptType(type: string | undefined): boolean {
  return type?.split(";", 1)[0].trim().toLowerCase() === "application/ld+json";
}

function hasJsonLdDocumentShape(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry));
  }
  return typeof value === "object" && value !== null;
}

function isInTemplateContents(element: unknown): boolean {
  type ParentNode = { name?: string; parent?: unknown };
  let node = element as ParentNode | null;
  while (node) {
    if (node.name?.toLowerCase() === "template") return true;
    node = (node.parent ?? null) as ParentNode | null;
  }
  return false;
}

function isAriaHiddenFromAccessibilityTree(element: unknown): boolean {
  type ParentNode = { attribs?: Record<string, string>; parent?: unknown };
  let node = element as ParentNode | null;
  while (node) {
    if (node.attribs?.["aria-hidden"]?.trim().toLowerCase() === "true") return true;
    node = (node.parent ?? null) as ParentNode | null;
  }
  return false;
}

// Explicit role fallback uses the first recognized non-abstract role across WAI-ARIA, Graphics ARIA, and DPUB-ARIA.
const VALID_NON_ABSTRACT_ARIA_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "comment", "complementary", "contentinfo", "definition",
  "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid",
  "gridcell", "group", "heading", "image", "img", "insertion", "link", "list", "listbox", "listitem", "log",
  "main", "mark", "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter",
  "navigation", "none", "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region",
  "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "sectionfooter", "sectionheader", "separator",
  "slider", "spinbutton", "status", "strong", "subscript", "suggestion", "superscript", "switch", "tab", "table",
  "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
  "graphics-document", "graphics-object", "graphics-symbol",
  "doc-abstract", "doc-acknowledgments", "doc-afterword", "doc-appendix", "doc-backlink", "doc-biblioentry",
  "doc-bibliography", "doc-biblioref", "doc-chapter", "doc-colophon", "doc-conclusion", "doc-cover", "doc-credit",
  "doc-credits", "doc-dedication", "doc-endnote", "doc-endnotes", "doc-epigraph", "doc-epilogue", "doc-errata",
  "doc-example", "doc-footnote", "doc-foreword", "doc-glossary", "doc-glossref", "doc-index", "doc-introduction",
  "doc-noteref", "doc-notice", "doc-pagebreak", "doc-pagefooter", "doc-pageheader", "doc-pagelist", "doc-part",
  "doc-preface", "doc-prologue", "doc-pullquote", "doc-qna", "doc-subtitle", "doc-tip", "doc-toc",
]);

function explicitSemanticRole(element: unknown): string | undefined {
  type ElementNode = { attribs?: Record<string, string> };
  const role = (element as ElementNode | null)?.attribs?.role ?? "";
  return role
    .trim()
    .split(/[\t\n\f\r ]+/)
    .map((token) => token.toLowerCase())
    .find((token) => VALID_NON_ABSTRACT_ARIA_ROLES.has(token));
}
function isUnambiguouslyPresentationalImage(element: unknown): boolean {
  type ElementNode = { attribs?: Record<string, string> };
  const attribs = (element as ElementNode | null)?.attribs ?? {};
  const role = explicitSemanticRole(element);
  if (role !== "none" && role !== "presentation") return false;

  if (attribs.tabindex !== undefined) return false;
  const contentEditable = attribs.contenteditable?.trim().toLowerCase();
  if (contentEditable !== undefined && contentEditable !== "false") return false;
  if (Object.keys(attribs).some((name) => name.toLowerCase().startsWith("aria-"))) return false;
  return true;
}

function hasExplicitSemanticImageRole(element: unknown): boolean {
  const role = explicitSemanticRole(element);
  return role === "img" || role === "image";
}

function hasExplicitSvgImageRole(element: unknown): boolean {
  type ElementNode = { attribs?: Record<string, string>; namespace?: string };
  const node = element as ElementNode | null;
  if (node?.namespace !== "http://www.w3.org/2000/svg") return false;
  const role = explicitSemanticRole(element);
  return role === "img" || role === "graphics-document" || role === "graphics-symbol";
}

function viewportContentRestrictsZoom(content: string): boolean {
  const directives = new Map<string, string>();
  for (const part of content.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) continue;
    const name = part.slice(0, separatorIndex).trim().toLowerCase();
    const value = part.slice(separatorIndex + 1).trim().toLowerCase();
    if (name) directives.set(name, value);
  }

  if (directives.get("user-scalable") === "no") return true;

  const maximumScale = directives.get("maximum-scale");
  if (maximumScale === undefined || maximumScale === "") return false;
  if (maximumScale === "yes") return true;
  const numericMaximumScale = Number(maximumScale);
  return Number.isFinite(numericMaximumScale) && numericMaximumScale >= 0 && numericMaximumScale < 2;
}

function parseMetaRefreshDelaySeconds(content: string): number | undefined {
  const isAsciiWhitespace = (value: string | undefined) =>
    value === "\t" || value === "\n" || value === "\f" || value === "\r" || value === " ";
  const isAsciiDigit = (value: string | undefined) => value !== undefined && value >= "0" && value <= "9";
  let position = 0;

  while (isAsciiWhitespace(content[position])) position += 1;

  const timeStart = position;
  while (isAsciiDigit(content[position])) position += 1;
  const timeString = content.slice(timeStart, position);
  let time = 0;
  if (timeString === "") {
    if (content[position] !== ".") return undefined;
  } else {
    time = Number.parseInt(timeString, 10);
  }

  while (isAsciiDigit(content[position]) || content[position] === ".") position += 1;

  if (position < content.length) {
    if (content[position] !== ";" && content[position] !== "," && !isAsciiWhitespace(content[position])) {
      return undefined;
    }
    while (isAsciiWhitespace(content[position])) position += 1;
    if (content[position] === ";" || content[position] === ",") position += 1;
    while (isAsciiWhitespace(content[position])) position += 1;
  }

  if (position < content.length) {
    const originalUrlStart = position;
    if (content[position]?.toLowerCase() === "u") {
      const candidate = content.slice(position);
      const urlPrefix = /^url[\t\n\f\r ]*=/i.exec(candidate);
      if (urlPrefix) {
        position += urlPrefix[0].length;
        while (isAsciiWhitespace(content[position])) position += 1;
      } else {
        position = originalUrlStart;
      }
    }

    const quote = content[position] === "'" || content[position] === '"' ? content[position++] : "";
    let urlString = content.slice(position);
    if (quote) {
      const closingQuote = urlString.indexOf(quote);
      if (closingQuote >= 0) urlString = urlString.slice(0, closingQuote);
    }

    try {
      const url = new URL(urlString, "https://example.invalid/");
      if (url.protocol.toLowerCase() === "javascript:") return undefined;
    } catch {
      return undefined;
    }
  }

  return time;
}

function hasIndexBlockingXRobotsTagForGoogle(value: string | undefined): boolean {
  if (!value) return false;
  const parameterizedRules = new Set([
    "max-snippet",
    "max-image-preview",
    "max-video-preview",
    "unavailable_after",
  ]);
  let scope: "all" | "googlebot" | "other" = "all";

  for (const part of value.split(",")) {
    let directive = part.trim().toLowerCase();
    const scoped = /^([a-z0-9._-]+)\s*:\s*(.+)$/i.exec(directive);
    if (scoped && !parameterizedRules.has(scoped[1])) {
      scope = scoped[1] === "googlebot" ? "googlebot" : "other";
      directive = scoped[2].trim();
    }
    if (scope !== "other" && ["noindex", "none"].includes(directive)) return true;
  }
  return false;
}

/**
 * Checks on-page metadata and accessibility signals without fetching or storing
 * any external content.
 */
export function auditSeoMetadata(html: string, options: AuditSeoMetadataOptions = {}): AuditResult {
  const $ = cheerio.load(html, { sourceCodeLocationInfo: true });
  const collector = createAuditCollector();

  const titleTags = $("head > title");
  if (titleTags.length > 1) {
    collector.add({
      code: "seo.title.multiple",
      severity: "warning",
      category: "SEO",
      message: "Multiple <title> elements are declared in the document head. Keep one unambiguous page title.",
    });
  }
  const title = titleTags.first().text().trim();
  if (!title) {
    collector.add({
      code: "seo.title.missing_or_empty",
      severity: "error",
      category: "SEO",
      message: "Missing or empty <title> tag.",
    });
  } else if (title.length < 30) {
    collector.add({
      code: "seo.title.length",
      severity: "info",
      category: "SEO",
      message: `Title is ${title.length} characters. This is shorter than the audit's common editorial range; review whether it describes the page clearly.`,
    });
  } else if (title.length > 60) {
    collector.add({
      code: "seo.title.length",
      severity: "info",
      category: "SEO",
      message: `Title is ${title.length} characters. This is longer than the audit's common editorial range; Google title links may be shortened or rewritten depending on context and device.`,
    });
  }

  const metaDescriptions = $('head > meta[name="description" i]');
  if (metaDescriptions.length > 1) {
    collector.add({
      code: "seo.meta_description.multiple",
      severity: "warning",
      category: "SEO",
      message: "Multiple meta descriptions are declared in the document head. Keep one unambiguous page description.",
    });
  }
  const description = metaDescriptions.first().attr("content")?.trim() ?? "";
  if (!description) {
    collector.add({
      code: "seo.meta_description.missing_or_empty",
      severity: "error",
      category: "SEO",
      message: "Missing or empty meta description.",
    });
  } else if (description.length < 120) {
    collector.add({
      code: "seo.meta_description.length",
      severity: "info",
      category: "SEO",
      message: `Meta description is ${description.length} characters. This is shorter than the audit's common editorial range; review whether it provides a useful page summary.`,
    });
  } else if (description.length > 160) {
    collector.add({
      code: "seo.meta_description.length",
      severity: "info",
      category: "SEO",
      message: `Meta description is ${description.length} characters. This is longer than the audit's common editorial range; displayed snippets may be shortened depending on the query and device.`,
    });
  }

  const canonicalLinks = $("head > link[rel]").filter((_, element) => {
    const rel = $(element).attr("rel") ?? "";
    return rel
      .trim()
      .split(/[\t\n\f\r ]+/)
      .some((token) => token.toLowerCase() === "canonical");
  });
  const nonEmptyCanonical = canonicalLinks.filter((_, element) => Boolean($(element).attr("href")?.trim()));
  const usableCanonical = nonEmptyCanonical.filter(
    (_, element) => !["hreflang", "lang", "media", "type"].some((attribute) => $(element).attr(attribute) !== undefined),
  );
  if (usableCanonical.filter((_, element) => ($(element).attr("href") ?? "").includes("#")).length > 0) {
    collector.add({
      code: "seo.canonical.fragment_unsupported",
      severity: "warning",
      category: "SEO",
      message: "Canonical URL contains a fragment. Google generally does not support URL fragments for canonicalization; remove the #fragment from the canonical href.",
    });
  }
  if (
    usableCanonical.filter((_, element) => {
      const href = ($(element).attr("href") ?? "").trim();
      return !href.includes("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href);
    }).length > 0
  ) {
    collector.add({
      code: "seo.canonical.relative_not_recommended",
      severity: "info",
      category: "SEO",
      message: "Canonical href is relative. Google supports relative canonical URLs but recommends absolute URLs to avoid long-term canonicalization mistakes.",
    });
  }
  if (canonicalLinks.length === 0) {
    collector.add({
      code: "seo.canonical.missing",
      severity: "info",
      category: "SEO",
      message: "No rel=\"canonical\" preference is declared. This is optional unless the page needs an explicit canonicalization signal.",
    });
  } else if (usableCanonical.length === 0) {
    if (nonEmptyCanonical.length > 0) {
      collector.add({
        code: "seo.canonical.unusable",
        severity: "warning",
        category: "SEO",
        message: "Canonical link is present but uses attributes Google ignores for canonicalization. Use a plain rel=\"canonical\" link in <head>.",
      });
    } else {
      collector.add({
        code: "seo.canonical.missing",
        severity: "warning",
        category: "SEO",
        message: "Canonical link is present but its href is empty. Provide a usable canonical target or remove the declaration.",
      });
    }
  } else if (usableCanonical.length > 1) {
    collector.add({
      code: "seo.canonical.multiple",
      severity: "warning",
      category: "SEO",
      message: "Multiple usable canonical link relations are declared. Keep one unambiguous canonical target.",
    });
  }

  // Google Search respects robots meta directives in both the head and body.
  const indexBlockingRobotsMeta = $('meta[name]').filter((_, element) => {
    if (isInTemplateContents(element)) return false;
    const name = ($(element).attr("name") ?? "").trim().toLowerCase();
    if (name !== "robots" && name !== "googlebot") return false;
    const content = $(element).attr("content") ?? "";
    return content
      .split(",")
      .some((directive) => ["noindex", "none"].includes(directive.trim().toLowerCase()));
  });
  if (indexBlockingRobotsMeta.length > 0 || hasIndexBlockingXRobotsTagForGoogle(options.xRobotsTag)) {
    collector.add({
      code: "seo.robots.noindex",
      severity: "warning",
      category: "SEO",
      message: "A robots directive prevents Google from indexing this page. Confirm that noindex is intentional.",
    });
  }

  const viewport = $('head > meta[name="viewport" i]');
  if (viewport.length === 0) {
    collector.add({
      code: "seo.viewport.missing",
      severity: "error",
      category: "SEO",
      message: "Missing viewport meta tag.",
    });
  } else if (viewport.filter((_, element) => Boolean($(element).attr("content")?.trim())).length === 0) {
    collector.add({
      code: "seo.viewport.unusable",
      severity: "error",
      category: "SEO",
      message: "Viewport meta tag is present but its content is empty. Provide viewport settings such as width=device-width.",
    });
  }
  if (viewport.filter((_, element) => viewportContentRestrictsZoom($(element).attr("content") ?? "")).length > 0) {
    collector.add({
      code: "accessibility.viewport.zoom_restricted",
      severity: "warning",
      category: "Accessibility",
      message: "Viewport metadata restricts user zoom below 200%. Avoid user-scalable=no and maximum-scale values below 2.",
    });
  }

  const metaRefreshDelay = $("meta[http-equiv]")
    .filter((_, element) =>
      !isInTemplateContents(element)
      && ($(element).attr("http-equiv") ?? "").toLowerCase() === "refresh"
    )
    .toArray()
    .map((element) => parseMetaRefreshDelaySeconds($(element).attr("content") ?? ""))
    .find((delay) => delay !== undefined);
  if (metaRefreshDelay !== undefined && metaRefreshDelay > 0 && metaRefreshDelay <= 72_000) {
    collector.add({
      code: "accessibility.meta_refresh.delayed",
      severity: "warning",
      category: "Accessibility",
      message: "Meta refresh uses a delay between 1 second and 20 hours. Prefer an immediate redirect or user-controlled navigation.",
    });
  }

  const h1Count = $("h1").filter((_, element) => !isInTemplateContents(element)).length;
  if (h1Count === 0) {
    collector.add({
      code: "seo.h1.missing",
      severity: "warning",
      category: "SEO",
      message: "No <h1> heading found. Review whether the page has a clear main heading and a meaningful heading hierarchy.",
    });
  } else if (h1Count > 1) {
    collector.add({
      code: "seo.h1.multiple",
      severity: "info",
      category: "SEO",
      message: `Found multiple (${h1Count}) <h1> headings. Multiple H1s are not inherently an SEO error; ensure the heading hierarchy is meaningful and the main visual title is clear.`,
    });
  }

  const textById = new Map<string, string>();
  $("[id]").filter((_, element) => !isInTemplateContents(element)).each((_, element) => {
    const id = $(element).attr("id");
    if (id !== undefined && !textById.has(id)) textById.set(id, $(element).text().trim());
  });

  $("img").filter((_, element) =>
    !isInTemplateContents(element)
    && !isAriaHiddenFromAccessibilityTree(element)
    && !isUnambiguouslyPresentationalImage(element)
  ).each((_, element) => {
    const img = $(element);
    const alt = img.attr("alt");
    const labelledByIds = (img.attr("aria-labelledby") ?? "")
      .trim()
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    const hasAlternateAccessibleName = labelledByIds.some((id) => Boolean(textById.get(id)))
      || Boolean(img.attr("aria-label")?.trim())
      || Boolean(img.attr("title")?.trim());

    const requiresNonEmptyName = alt === undefined || (alt === "" && hasExplicitSemanticImageRole(element));
    if (requiresNonEmptyName && !hasAlternateAccessibleName) {
      collector.add({
        code: "accessibility.image_alt.missing",
        severity: "error",
        category: "Accessibility",
        message: "Image needs a non-empty accessible name. Provide meaningful alt text or another supported label such as aria-label, aria-labelledby, or title.",
      });
    } else if (alt !== undefined && alt !== "" && alt.trim() === "") {
      collector.add({
        code: "accessibility.image_alt.empty",
        severity: "info",
        category: "Accessibility",
        message: "Whitespace-only alt text does not provide an accessible name. Use alt=\"\" for a decorative image or meaningful alternative text for an informative image.",
      });
    }
  });

  $("div[role], span[role]").filter((_, element) =>
    hasExplicitSemanticImageRole(element)
    && !isInTemplateContents(element)
    && !isAriaHiddenFromAccessibilityTree(element)
  ).each((_, element) => {
    const semanticImage = $(element);
    const labelledByIds = (semanticImage.attr("aria-labelledby") ?? "")
      .trim()
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    const hasAccessibleName = labelledByIds.some((id) => Boolean(textById.get(id)))
      || Boolean(semanticImage.attr("aria-label")?.trim())
      || Boolean(semanticImage.attr("title")?.trim());

    if (!hasAccessibleName) {
      collector.add({
        code: "accessibility.image_alt.missing",
        severity: "error",
        category: "Accessibility",
        message: "Elements with a semantic image role need a non-empty accessible name. Provide aria-label, aria-labelledby, or title.",
      });
    }
  });

  $("[role]").filter((_, element) =>
    hasExplicitSvgImageRole(element)
    && !isInTemplateContents(element)
    && !isAriaHiddenFromAccessibilityTree(element)
  ).each((_, element) => {
    const svgImage = $(element);
    const labelledByIds = (svgImage.attr("aria-labelledby") ?? "")
      .trim()
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    const hasAccessibleName = labelledByIds.some((id) => Boolean(textById.get(id)))
      || Boolean(svgImage.attr("aria-label")?.trim())
      || Boolean(svgImage.children("title").first().text().trim());

    if (!hasAccessibleName) {
      collector.add({
        code: "accessibility.image_alt.missing",
        severity: "error",
        category: "Accessibility",
        message: "SVG elements explicitly exposed as images need a non-empty accessible name. Provide aria-label, aria-labelledby, or a direct child <title>.",
      });
    }
  });

  $("input[type=\"image\" i]").filter((_, element) =>
    !isInTemplateContents(element) && !isAriaHiddenFromAccessibilityTree(element)
  ).each((_, element) => {
    const input = $(element);
    const labelledByIds = (input.attr("aria-labelledby") ?? "")
      .trim()
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    const hasLabelledByText = labelledByIds.some((id) => Boolean(textById.get(id)));
    const hasAccessibleName = hasLabelledByText
      || Boolean(input.attr("aria-label")?.trim())
      || Boolean(input.attr("alt")?.trim())
      || Boolean(input.attr("title")?.trim());

    if (!hasAccessibleName) {
      collector.add({
        code: "accessibility.input_image_alt.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Image submit buttons need a non-empty accessible name. Provide alt text or another supported label such as aria-label, aria-labelledby, or title.",
      });
    }
  });

  $("area[href]").filter((_, element) => !isInTemplateContents(element)).each((_, element) => {
    const area = $(element);
    const alt = area.attr("alt");
    let needsAlt = alt === undefined;

    if (alt !== undefined && alt.trim() === "") {
      const href = area.attr("href")?.trim() ?? "";
      const map = area.closest("map");
      const hasLabeledEquivalent = map.find("area[href]").filter((_, peer) =>
        !isInTemplateContents(peer)
        && ($(peer).attr("href")?.trim() ?? "") === href
        && Boolean($(peer).attr("alt")?.trim())
      ).length > 0;
      needsAlt = !hasLabeledEquivalent;
    }

    if (needsAlt) {
      collector.add({
        code: "accessibility.area_alt.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Image-map links need alt text unless another area with the same href provides the label.",
      });
    }
  });

  const htmlElement = $("html").first();
  const htmlNode = htmlElement.get(0) as { sourceCodeLocation?: unknown } | undefined;
  if (htmlNode?.sourceCodeLocation) {
    const pageLanguage = htmlElement.attr("lang")?.trim();
    if (!pageLanguage) {
      collector.add({
        code: "accessibility.page_language.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "The document <html> element needs a non-empty lang attribute so assistive technologies can determine the page language.",
      });
    } else {
      const primaryLanguageSubtag = getPrimaryLanguageSubtag(pageLanguage);
      if (!isKnownPrimaryLanguageSubtag(primaryLanguageSubtag)) {
        collector.add({
          code: "accessibility.page_language.invalid_primary_subtag",
          severity: "error",
          category: "Accessibility",
          message: `The document <html> lang attribute uses unknown primary language subtag "${primaryLanguageSubtag}". Use a primary language subtag registered by IANA.`,
        });
      }
    }
  }

  const requiredOpenGraphProperties = ["og:title", "og:type", "og:image", "og:url"] as const;
  const hasCompleteOpenGraphMetadata = requiredOpenGraphProperties.every((property) =>
    $(`head > meta[property="${property}"]`).filter(
      (_, element) => Boolean($(element).attr("content")?.trim()),
    ).length > 0
  );
  if (!hasCompleteOpenGraphMetadata) {
    collector.add({
      code: "seo.open_graph.missing",
      severity: "info",
      category: "SEO",
      message: "Open Graph basic metadata is incomplete or empty. Provide non-empty og:title, og:type, og:image, and og:url values.",
    });
  }

  return collector.result();
}

/** Parses JSON-LD blocks locally and reports syntax problems only. */
export function validateSchemaMarkup(html: string): AuditResult & { blocksChecked: number } {
  const $ = cheerio.load(html);
  const collector = createAuditCollector();
  const blocks = $("script[type]").filter(
    (_, element) => !isInTemplateContents(element) && isJsonLdScriptType($(element).attr("type")),
  );

  blocks.each((index, element) => {
    const value = $(element).html()?.trim() ?? "";
    if (!value) {
      collector.add({
        code: "schema.jsonld.empty",
        severity: "warning",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is empty.`,
      });
      return;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (!hasJsonLdDocumentShape(parsed)) {
        collector.add({
          code: "schema.jsonld.invalid_document",
          severity: "error",
          category: "Schema",
          message: `JSON-LD block #${index + 1} must have an object or an array of objects at the top level.`,
        });
      }
    } catch {
      collector.add({
        code: "schema.jsonld.invalid_json",
        severity: "error",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is not valid JSON.`,
      });
    }
  });

  return { ...collector.result(), blocksChecked: blocks.length };
}

function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host.endsWith(".example") ||
    host.endsWith(".onion")
  ) {
    return true;
  }

  if (!ipaddr.isValid(host)) return false;
  const parsed = ipaddr.parse(host);
  const address = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
  if (address instanceof ipaddr.IPv4 && address.match(IETF_PROTOCOL_ASSIGNMENTS_IPV4)) {
    return !GLOBALLY_REACHABLE_IETF_PROTOCOL_IPV4.has(address.toString());
  }
  if (address instanceof ipaddr.IPv6 && address.match(IETF_PROTOCOL_ASSIGNMENTS_IPV6)) {
    return !GLOBALLY_REACHABLE_IETF_PROTOCOL_IPV6.some((range) => address.match(range));
  }
  return address.range() !== "unicast";
}

export function toPublicHttpUrl(value: string, baseUrl?: string): URL | undefined {
  try {
    if (!value || value.length > 2_048) return undefined;
    const url = new URL(value, baseUrl);
    if (url.href.length > 2_048) return undefined;
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    // URL removes scheme-appropriate default ports. Any remaining port is custom
    // or mismatched (for example, HTTP on 443) and must be rejected.
    if (url.port) return undefined;
    if (isPrivateOrReservedHost(url.hostname)) return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

async function fetchStatus(url: URL): Promise<LinkStatus> {
  const execute = async (method: "HEAD" | "GET") => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          accept: "*/*",
          "user-agent": SERVICE_USER_AGENT,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      await response.body?.cancel();
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let response = await execute("HEAD");
    if (response.status === 403 || response.status === 405 || response.status === 501) {
      response = await execute("GET");
    }
    return {
      url: url.toString(),
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      message: isHttpRedirectStatus(response.status) ? "Redirect not followed." : undefined,
    };
  } catch {
    return {
      url: url.toString(),
      status: "failed",
      ok: false,
      message: "Connection failed or timed out.",
    };
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await action(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

/**
 * Checks a capped set of public HTTP(S) links. It does not follow redirects,
 * request custom ports, or return response bodies.
 */
export async function checkBrokenLinks(
  html: string,
  baseUrl: string | undefined,
  maxLinks: number,
): Promise<LinkStatus[]> {
  const fallbackBaseUrl = baseUrl ? toPublicHttpUrl(baseUrl)?.toString() : undefined;
  if (baseUrl && !fallbackBaseUrl) {
    throw new Error("base_url must be a public HTTP(S) URL on port 80 or 443.");
  }

  const $ = cheerio.load(html);
  let effectiveBaseUrl = fallbackBaseUrl;
  const documentBaseHref = $("base[href]")
    .filter((_, element) => !isInTemplateContents(element))
    .first()
    .attr("href");
  if (documentBaseHref !== undefined) {
    try {
      const resolvedDocumentBase = fallbackBaseUrl
        ? new URL(documentBaseHref, fallbackBaseUrl)
        : new URL(documentBaseHref);
      effectiveBaseUrl = resolvedDocumentBase.protocol === "data:" || resolvedDocumentBase.protocol === "javascript:"
        ? fallbackBaseUrl
        : toPublicHttpUrl(resolvedDocumentBase.href)?.toString();
    } catch {
      effectiveBaseUrl = fallbackBaseUrl;
    }
  }
  const urls: URL[] = [];
  const seen = new Set<string>();
  const limit = Math.min(Math.max(maxLinks, 1), HOSTED_MAX_LINKS);

  $("a[href], area[href]").filter((_, element) => !isInTemplateContents(element)).each((_, element) => {
    if (urls.length >= limit) return;
    const href = $(element).attr("href")?.trim();
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(href)) return;
    const url = toPublicHttpUrl(href, effectiveBaseUrl);
    if (!url || seen.has(url.toString())) return;
    seen.add(url.toString());
    urls.push(url);
  });

  return mapWithConcurrency(urls, 5, fetchStatus);
}
