import * as cheerio from "cheerio";
import {
  assertPublicHttpUrl,
  cancelResponseBody,
  fetchPublicHttp,
  getErrorMessage,
  PublicUrlError,
} from "./network.js";
import { getPrimaryLanguageSubtag, isKnownPrimaryLanguageSubtag } from "./language-subtags.js";
import { PACKAGE_VERSION } from "./version.js";

export const MAX_AUDIT_ISSUES = 200;
export const MAX_LINKS_TO_CHECK = 25;
const LINK_CHECK_CONCURRENCY = 5;
const LINK_CHECK_TIMEOUT_MS = 5_000;
const LINK_CHECK_USER_AGENT = `mcp-web-validator/${PACKAGE_VERSION} (+https://digestseo.com/validator-mcp/)`;

export interface SEOIssue {
  code: string;
  severity: "error" | "warning" | "info";
  category: "SEO" | "Schema" | "BrokenLinks" | "Accessibility";
  message: string;
  element?: string;
}

export interface LinkStatus {
  url: string;
  status: number | string;
  ok: boolean;
  message?: string;
}

const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isHttpRedirectStatus(status: LinkStatus["status"]): boolean {
  return typeof status === "number" && HTTP_REDIRECT_STATUSES.has(status);
}

export interface AuditCounts {
  error: number;
  warning: number;
  info: number;
}

export interface AuditDetails {
  issues: SEOIssue[];
  totalIssues: number;
  truncated: boolean;
  counts: AuditCounts;
}

function addIssue(issues: SEOIssue[], issue: SEOIssue): void {
  if (issues.length < MAX_AUDIT_ISSUES) {
    issues.push(issue);
  }
}

function createIssueCollector(): {
  issues: SEOIssue[];
  add: (issue: SEOIssue) => void;
  details: () => AuditDetails;
} {
  const issues: SEOIssue[] = [];
  let totalIssues = 0;
  const counts: AuditCounts = { error: 0, warning: 0, info: 0 };
  return {
    issues,
    add(issue) {
      totalIssues += 1;
      counts[issue.severity] += 1;
      addIssue(issues, issue);
    },
    details() {
      return {
        issues,
        totalIssues,
        truncated: totalIssues > issues.length,
        counts: { ...counts },
      };
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

function hasNegativeTabIndex(element: unknown): boolean {
  type ElementNode = { attribs?: Record<string, string> };
  const value = (element as ElementNode | null)?.attribs?.tabindex?.trim();
  if (!value || !/^[+-]?\d+$/.test(value)) return false;
  return Number(value) < 0;
}

function isDecorativeIframe(element: unknown): boolean {
  const role = explicitSemanticRole(element);
  return role === "none" || role === "presentation";
}

function isUnambiguouslyPresentationalImage(element: unknown): boolean {
  type ElementNode = { attribs?: Record<string, string> };
  const attribs = (element as ElementNode | null)?.attribs ?? {};
  const role = explicitSemanticRole(element);
  if (role !== "none" && role !== "presentation") return false;

  // Presentational roles are ignored when an element can take focus. Treat any
  // explicit tabindex as a potential conflict instead of guessing whether the
  // authored value will be focusable in a particular user agent.
  if (attribs.tabindex !== undefined) return false;
  const contentEditable = attribs.contenteditable?.trim().toLowerCase();
  if (contentEditable !== undefined && contentEditable !== "false") return false;

  // Global ARIA states/properties also override none/presentation. Using the
  // broader aria-* set here is intentionally conservative for static auditing:
  // uncertain role-specific attributes keep the existing missing-name check.
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

  const userScalable = directives.get("user-scalable");
  if (userScalable !== undefined) {
    if (userScalable !== "yes" && userScalable !== "device-width" && userScalable !== "device-height") {
      const numericUserScalable = Number(userScalable);
      if (!Number.isFinite(numericUserScalable) || (numericUserScalable > -1 && numericUserScalable < 1)) {
        return true;
      }
    }
  }

  const maximumScale = directives.get("maximum-scale");
  if (maximumScale === undefined) return false;
  if (maximumScale === "device-width" || maximumScale === "device-height") return false;
  if (maximumScale === "yes") return true;
  const numericMaximumScale = Number(maximumScale);
  if (!Number.isFinite(numericMaximumScale)) return true;
  return numericMaximumScale >= 0 && numericMaximumScale < 2;
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

function canParseCanonicalHref(href: string): boolean {
  try {
    new URL(href, "https://example.invalid/");
    return true;
  } catch {
    return false;
  }
}

/**
 * Audits technical SEO and accessibility basics on HTML content using Cheerio
 */
export function auditSeoMetadataDetailed(htmlContent: string): AuditDetails {
  const $ = cheerio.load(htmlContent, { sourceCodeLocationInfo: true });
  const collector = createIssueCollector();
  const { add } = collector;

  // --- Title Tag Audits ---
  const titleTag = $("head > title");
  if (titleTag.length === 0) {
    add({
      code: "seo.title.missing_or_empty",
      severity: "error",
      category: "SEO",
      message: "Missing <title> tag. Add a concise, descriptive title to help represent the page in search results.",
    });
  } else {
    if (titleTag.length > 1) {
      add({
        code: "seo.title.multiple",
        severity: "warning",
        category: "SEO",
        message: "Multiple <title> elements are declared in the document head. Keep one unambiguous page title.",
      });
    }
    const titleText = titleTag.first().text().trim();
    if (titleText.length === 0) {
      add({
        code: "seo.title.missing_or_empty",
        severity: "error",
        category: "SEO",
        message: "The <title> tag is empty.",
      });
    } else if (titleText.length < 30) {
      add({
        code: "seo.title.length",
        severity: "info",
        category: "SEO",
        message: `Title is ${titleText.length} characters. This is shorter than the audit's common editorial range; review whether it describes the page clearly.`,
        element: `<title>${titleText}</title>`,
      });
    } else if (titleText.length > 60) {
      add({
        code: "seo.title.length",
        severity: "info",
        category: "SEO",
        message: `Title is ${titleText.length} characters. This is longer than the audit's common editorial range; Google title links may be shortened or rewritten depending on context and device.`,
        element: `<title>${titleText}</title>`,
      });
    }
  }

  // --- Meta Description Audits ---
  const metaDescription = $('head > meta[name="description" i]');
  if (metaDescription.length === 0) {
    add({
      code: "seo.meta_description.missing_or_empty",
      severity: "error",
      category: "SEO",
      message: "Missing <meta name=\"description\">. Add a concise, accurate page summary; Google may use page content or this description to generate a snippet.",
    });
  } else {
    if (metaDescription.length > 1) {
      add({
        code: "seo.meta_description.multiple",
        severity: "warning",
        category: "SEO",
        message: "Multiple meta descriptions are declared in the document head. Keep one unambiguous page description.",
      });
    }
    const descText = metaDescription.first().attr("content")?.trim() || "";
    if (descText.length === 0) {
      add({
        code: "seo.meta_description.missing_or_empty",
        severity: "error",
        category: "SEO",
        message: "Meta description content attribute is empty.",
      });
    } else if (descText.length < 120) {
      add({
        code: "seo.meta_description.length",
        severity: "info",
        category: "SEO",
        message: `Meta description is ${descText.length} characters. This is shorter than the audit's common editorial range; review whether it provides a useful page summary.`,
        element: `<meta name="description" content="${descText}">`,
      });
    } else if (descText.length > 160) {
      add({
        code: "seo.meta_description.length",
        severity: "info",
        category: "SEO",
        message: `Meta description is ${descText.length} characters. This is longer than the audit's common editorial range; displayed snippets may be shortened depending on the query and device.`,
        element: `<meta name="description" content="${descText}">`,
      });
    }
  }

  // --- Canonical Link ---
  const canonicalLinks = $("head > link[rel]").filter((_, element) => {
    const rel = $(element).attr("rel") ?? "";
    return rel
      .trim()
      .split(/[\t\n\f\r ]+/)
      .some((token) => token.toLowerCase() === "canonical");
  });
  const nonEmptyCanonical = canonicalLinks.filter((_, element) => Boolean($(element).attr("href")?.trim()));
  const parseableCanonical = nonEmptyCanonical.filter((_, element) =>
    canParseCanonicalHref(($(element).attr("href") ?? "").trim()),
  );
  const invalidCanonical = nonEmptyCanonical.filter((_, element) =>
    !canParseCanonicalHref(($(element).attr("href") ?? "").trim()),
  );
  const usableCanonical = parseableCanonical.filter(
    (_, element) => !["hreflang", "lang", "media", "type"].some((attribute) => $(element).attr(attribute) !== undefined),
  );
  if (invalidCanonical.length > 0) {
    add({
      code: "seo.canonical.invalid_url",
      severity: "warning",
      category: "SEO",
      message: "Canonical link href cannot be parsed as a URL. Provide a valid canonical target or remove the declaration.",
    });
  }
  if (usableCanonical.filter((_, element) => ($(element).attr("href") ?? "").includes("#")).length > 0) {
    add({
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
    add({
      code: "seo.canonical.relative_not_recommended",
      severity: "info",
      category: "SEO",
      message: "Canonical href is relative. Google supports relative canonical URLs but recommends absolute URLs to avoid long-term canonicalization mistakes.",
    });
  }
  if (canonicalLinks.length === 0) {
    add({
      code: "seo.canonical.missing",
      severity: "info",
      category: "SEO",
      message: "No rel=\"canonical\" preference is declared. This is optional unless the page needs an explicit canonicalization signal.",
    });
  } else if (usableCanonical.length === 0) {
    if (parseableCanonical.length > 0) {
      add({
        code: "seo.canonical.unusable",
        severity: "warning",
        category: "SEO",
        message: "Canonical link is present but uses attributes Google ignores for canonicalization. Use a plain rel=\"canonical\" link in <head>.",
      });
    } else if (nonEmptyCanonical.length === 0) {
      add({
        code: "seo.canonical.missing",
        severity: "warning",
        category: "SEO",
        message: "Canonical link is present but its href is empty. Provide a usable canonical target or remove the declaration.",
      });
    }
  } else if (usableCanonical.length > 1) {
    add({
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
  if (indexBlockingRobotsMeta.length > 0) {
    add({
      code: "seo.robots.noindex",
      severity: "warning",
      category: "SEO",
      message: "A robots directive prevents Google from indexing this page. Confirm that noindex is intentional.",
    });
  }

  // --- Viewport Meta Tag (Mobile Responsiveness) ---
  const viewport = $('head > meta[name="viewport" i]');
  if (viewport.length === 0) {
    add({
      code: "seo.viewport.missing",
      severity: "error",
      category: "SEO",
      message: "Missing <meta name=\"viewport\"> tag. Review mobile rendering; this tag helps browsers size and scale the page on mobile devices.",
    });
  } else if (viewport.filter((_, element) => Boolean($(element).attr("content")?.trim())).length === 0) {
    add({
      code: "seo.viewport.unusable",
      severity: "error",
      category: "SEO",
      message: "Viewport meta tag is present but its content is empty. Provide viewport settings such as width=device-width.",
    });
  }
  if (viewport.filter((_, element) => viewportContentRestrictsZoom($(element).attr("content") ?? "")).length > 0) {
    add({
      code: "accessibility.viewport.zoom_restricted",
      severity: "warning",
      category: "Accessibility",
      message: "Viewport metadata restricts user zoom below 200%. Ensure user-scalable permits zoom and maximum-scale allows at least 2x zoom.",
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
    add({
      code: "accessibility.meta_refresh.delayed",
      severity: "warning",
      category: "Accessibility",
      message: "Meta refresh uses a delay between 1 second and 20 hours. Prefer an immediate redirect or user-controlled navigation.",
    });
  }

  // --- Heading Structure ---
  const h1Tags = $("h1").filter((_, element) => !isInTemplateContents(element));
  if (h1Tags.length === 0) {
    add({
      code: "seo.h1.missing",
      severity: "warning",
      category: "SEO",
      message: "No <h1> heading found. Review whether the page has a clear main heading and a meaningful heading hierarchy.",
    });
  } else if (h1Tags.length > 1) {
    add({
      code: "seo.h1.multiple",
      severity: "info",
      category: "SEO",
      message: `Found multiple (${h1Tags.length}) <h1> headings. Multiple H1s are not inherently an SEO error; ensure the heading hierarchy is meaningful and the main visual title is clear.`,
    });
  }

  const textById = new Map<string, string>();
  $("[id]").filter((_, element) => !isInTemplateContents(element)).each((_, element) => {
    const id = $(element).attr("id");
    if (id !== undefined && !textById.has(id)) textById.set(id, $(element).text().trim());
  });

  // --- Images Alt Tags (SEO + Accessibility) ---
  $("img").filter((_, element) =>
    !isInTemplateContents(element)
    && !isAriaHiddenFromAccessibilityTree(element)
    && !isUnambiguouslyPresentationalImage(element)
  ).each((_, element) => {
    const img = $(element);
    const src = img.attr("src") || "unknown-source";
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
      add({
        code: "accessibility.image_alt.missing",
        severity: "error",
        category: "Accessibility",
        message: "Image needs a non-empty accessible name. Provide meaningful alt text or another supported label such as aria-label, aria-labelledby, or title.",
        element: `<img src="${src}">`,
      });
    } else if (alt !== undefined && alt !== "" && alt.trim() === "") {
      add({
        code: "accessibility.image_alt.empty",
        severity: "info",
        category: "Accessibility",
        message: "Whitespace-only 'alt' text does not provide an accessible name. Use alt=\"\" for a decorative image or meaningful alternative text for an informative image.",
        element: `<img src="${src}" alt="${alt}">`,
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
      add({
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
      add({
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
      add({
        code: "accessibility.input_image_alt.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Image submit buttons need a non-empty accessible name. Provide alt text or another supported label such as aria-label, aria-labelledby, or title.",
      });
    }
  });

  $("iframe").filter((_, element) =>
    !isInTemplateContents(element)
    && !isAriaHiddenFromAccessibilityTree(element)
    && !hasNegativeTabIndex(element)
    && !isDecorativeIframe(element)
  ).each((_, element) => {
    const iframe = $(element);
    const labelledByIds = (iframe.attr("aria-labelledby") ?? "")
      .trim()
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    const hasAccessibleName = labelledByIds.some((id) => Boolean(textById.get(id)))
      || Boolean(iframe.attr("aria-label")?.trim())
      || Boolean(iframe.attr("title")?.trim());

    if (!hasAccessibleName) {
      add({
        code: "accessibility.iframe_name.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Iframe elements exposed to assistive technologies need a non-empty accessible name. Provide title, aria-label, or aria-labelledby.",
      });
    }
  });

  $("area[href]").filter((_, element) =>
    !isInTemplateContents(element) && !isAriaHiddenFromAccessibilityTree(element)
  ).each((_, element) => {
    const area = $(element);
    const labelledByIds = (area.attr("aria-labelledby") ?? "")
      .trim()
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    const hasAccessibleName = labelledByIds.some((id) => Boolean(textById.get(id)))
      || Boolean(area.attr("aria-label")?.trim())
      || Boolean(area.attr("alt")?.trim())
      || Boolean(area.attr("title")?.trim());
    let needsAccessibleName = !hasAccessibleName;

    if (needsAccessibleName) {
      const href = area.attr("href")?.trim() ?? "";
      const map = area.closest("map");
      const hasLabeledEquivalent = map.find("area[href]").filter((_, peer) =>
        !isInTemplateContents(peer)
        && !isAriaHiddenFromAccessibilityTree(peer)
        && ($(peer).attr("href")?.trim() ?? "") === href
        && Boolean($(peer).attr("alt")?.trim())
      ).length > 0;
      needsAccessibleName = !hasLabeledEquivalent;
    }

    if (needsAccessibleName) {
      add({
        code: "accessibility.area_alt.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Image-map links need a non-empty accessible name. Provide alt text or another supported label such as aria-label, aria-labelledby, or title.",
      });
    }
  });

  const htmlElement = $("html").first();
  const htmlNode = htmlElement.get(0) as { sourceCodeLocation?: unknown } | undefined;
  if (htmlNode?.sourceCodeLocation) {
    const pageLanguage = htmlElement.attr("lang")?.trim();
    if (!pageLanguage) {
      add({
        code: "accessibility.page_language.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "The document <html> element needs a non-empty lang attribute so assistive technologies can determine the page language.",
      });
    } else {
      const primaryLanguageSubtag = getPrimaryLanguageSubtag(pageLanguage);
      if (!isKnownPrimaryLanguageSubtag(primaryLanguageSubtag)) {
        add({
          code: "accessibility.page_language.invalid_primary_subtag",
          severity: "error",
          category: "Accessibility",
          message: `The document <html> lang attribute uses unknown primary language subtag "${primaryLanguageSubtag}". Use a primary language subtag registered by IANA.`,
        });
      }
    }
  }

  // --- Open Graph / Social Tags ---
  const requiredOpenGraphProperties = ["og:title", "og:type", "og:image", "og:url"] as const;
  const hasCompleteOpenGraphMetadata = requiredOpenGraphProperties.every((property) =>
    $(`head > meta[property="${property}"]`).filter(
      (_, element) => Boolean($(element).attr("content")?.trim()),
    ).length > 0
  );
  if (!hasCompleteOpenGraphMetadata) {
    add({
      code: "seo.open_graph.missing",
      severity: "info",
      category: "SEO",
      message: "Open Graph basic metadata is incomplete or empty. Provide non-empty og:title, og:type, og:image, and og:url values.",
    });
  }

  return collector.details();
}

export function auditSeoMetadata(htmlContent: string): SEOIssue[] {
  return auditSeoMetadataDetailed(htmlContent).issues;
}

/**
 * Parses and validates JSON-LD Schema markup
 */
export function validateSchemaMarkupDetailed(htmlContent: string): AuditDetails {
  const $ = cheerio.load(htmlContent);
  const collector = createIssueCollector();
  const { add } = collector;
  const blocks = $("script[type]").filter(
    (_, element) => !isInTemplateContents(element) && isJsonLdScriptType($(element).attr("type")),
  );

  blocks.each((index, element) => {
    const scriptText = $(element).html() || "";
    if (scriptText.trim() === "") {
      add({
        code: "schema.jsonld.empty",
        severity: "warning",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is empty.`,
      });
      return;
    }

    try {
      const parsed = JSON.parse(scriptText) as unknown;
      if (!hasJsonLdDocumentShape(parsed)) {
        add({
          code: "schema.jsonld.invalid_document",
          severity: "error",
          category: "Schema",
          message: "Invalid JSON-LD document shape: the top level must be an object or an array of objects.",
          element: `<script type="application/ld+json">...</script>`,
        });
      }
    } catch (error: unknown) {
      add({
        code: "schema.jsonld.invalid_json",
        severity: "error",
        category: "Schema",
        message: `Invalid JSON-LD schema syntax: ${getErrorMessage(error)}`,
        element: `<script type="application/ld+json">...</script>`,
      });
    }
  });

  return collector.details();
}

export function validateSchemaMarkup(htmlContent: string): SEOIssue[] {
  return validateSchemaMarkupDetailed(htmlContent).issues;
}

/**
 * Extracts and tests links, treating redirect responses as reachable and 4xx/5xx as broken.
 */
export async function checkBrokenLinks(
  htmlContent: string,
  baseUrl?: string,
  maxLinks = MAX_LINKS_TO_CHECK,
): Promise<LinkStatus[]> {
  if (!Number.isSafeInteger(maxLinks) || maxLinks <= 0) {
    throw new Error("maxLinks must be a positive integer");
  }
  const linkLimit = Math.min(maxLinks, MAX_LINKS_TO_CHECK);
  const $ = cheerio.load(htmlContent);
  const fallbackBaseUrl = baseUrl ? await assertPublicHttpUrl(baseUrl) : undefined;
  let parsedBaseUrl = fallbackBaseUrl;
  const documentBaseHref = $("base[href]")
    .filter((_, element) => !isInTemplateContents(element))
    .first()
    .attr("href");
  if (documentBaseHref !== undefined) {
    let resolvedDocumentBase: URL | undefined;
    try {
      resolvedDocumentBase = fallbackBaseUrl
        ? new URL(documentBaseHref, fallbackBaseUrl)
        : new URL(documentBaseHref);
    } catch {
      // HTML falls back to the document URL when the first base href cannot
      // be parsed. Preserve that fallback instead of dropping relative links.
      parsedBaseUrl = fallbackBaseUrl;
    }
    if (resolvedDocumentBase) {
      if (resolvedDocumentBase.protocol === "data:" || resolvedDocumentBase.protocol === "javascript:") {
        // These schemes are not allowed to become a document base URL; the
        // browser keeps the document fallback base URL instead.
        parsedBaseUrl = fallbackBaseUrl;
      } else {
        try {
          parsedBaseUrl = await assertPublicHttpUrl(resolvedDocumentBase);
        } catch (error: unknown) {
          if (!(error instanceof PublicUrlError)) {
            throw error;
          }
          // A parseable but non-public base must not redirect relative link
          // checks through the caller-provided public fallback.
          parsedBaseUrl = undefined;
        }
      }
    }
  }
  const urls: string[] = [];
  const seenUrls = new Set<string>();

  $("a, area").filter((_, element) => !isInTemplateContents(element)).each((_, element) => {
    if (urls.length >= linkLimit) {
      return false;
    }

    const href = $(element).attr("href")?.trim();
    if (!href || href.startsWith("#")) {
      return;
    }

    let resolvedUrl: URL;
    try {
      resolvedUrl = parsedBaseUrl ? new URL(href, parsedBaseUrl) : new URL(href);
    } catch {
      // Relative links require a public base URL; unsupported or malformed links are skipped.
      return;
    }

    if (resolvedUrl.protocol !== "http:" && resolvedUrl.protocol !== "https:") {
      return;
    }

    resolvedUrl.hash = "";
    const normalizedUrl = resolvedUrl.href;
    if (!seenUrls.has(normalizedUrl)) {
      seenUrls.add(normalizedUrl);
      urls.push(normalizedUrl);
    }
  });

  const results = new Array<LinkStatus>(urls.length);
  let nextIndex = 0;

  async function checkLink(url: string): Promise<LinkStatus> {
    try {
      const headResult = await fetchPublicHttp(url, {
        method: "HEAD",
        headers: { "User-Agent": LINK_CHECK_USER_AGENT },
        timeoutMs: LINK_CHECK_TIMEOUT_MS,
        maxRedirects: 0,
      });
      const headStatus = headResult.response.status;
      const headFinalUrl = headResult.url.href;
      await cancelResponseBody(headResult.response);

      // Some sites reject or do not implement HEAD even when the linked resource is available.
      if (headStatus === 405 || headStatus === 403 || headStatus === 501) {
        let getResult = await fetchPublicHttp(url, {
          method: "GET",
          headers: {
            Range: "bytes=0-0",
            "User-Agent": LINK_CHECK_USER_AGENT,
          },
          timeoutMs: LINK_CHECK_TIMEOUT_MS,
          maxRedirects: 0,
        });
        if (getResult.response.status === 416) {
          await cancelResponseBody(getResult.response);
          getResult = await fetchPublicHttp(url, {
            method: "GET",
            headers: { "User-Agent": LINK_CHECK_USER_AGENT },
            timeoutMs: LINK_CHECK_TIMEOUT_MS,
            maxRedirects: 0,
          });
        }

        const status = getResult.response.status;
        const ok = status >= 200 && status < 400;
        const finalUrl = getResult.url.href;
        await cancelResponseBody(getResult.response);
        return {
          url,
          status,
          ok,
          message:
            isHttpRedirectStatus(status)
              ? "Redirect not followed"
              : finalUrl !== url
                ? `Redirected to ${finalUrl}`
                : undefined,
        };
      }

      return {
        url,
        status: headStatus,
        ok: headStatus >= 200 && headStatus < 400,
        message:
          isHttpRedirectStatus(headStatus)
            ? "Redirect not followed"
            : headFinalUrl !== url
              ? `Redirected to ${headFinalUrl}`
              : undefined,
      };
    } catch (error: unknown) {
      return {
        url,
        status: error instanceof PublicUrlError ? "blocked" : "failed",
        ok: false,
        message: getErrorMessage(error),
      };
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= urls.length) {
        return;
      }
      results[index] = await checkLink(urls[index]);
    }
  }

  const workerCount = Math.min(LINK_CHECK_CONCURRENCY, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
