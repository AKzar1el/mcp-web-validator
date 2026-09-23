import * as cheerio from "cheerio";
import {
  assertPublicHttpUrl,
  cancelResponseBody,
  fetchPublicHttp,
  getErrorMessage,
  PublicUrlError,
} from "./network.js";
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

/**
 * Audits technical SEO and accessibility basics on HTML content using Cheerio
 */
export function auditSeoMetadataDetailed(htmlContent: string): AuditDetails {
  const $ = cheerio.load(htmlContent);
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
    const titleText = titleTag.text().trim();
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
    const descText = metaDescription.attr("content")?.trim() || "";
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
  const usableCanonical = nonEmptyCanonical.filter(
    (_, element) => !["hreflang", "lang", "media", "type"].some((attribute) => $(element).attr(attribute) !== undefined),
  );
  if (canonicalLinks.length === 0) {
    add({
      code: "seo.canonical.missing",
      severity: "info",
      category: "SEO",
      message: "No rel=\"canonical\" preference is declared. This is optional unless the page needs an explicit canonicalization signal.",
    });
  } else if (usableCanonical.length === 0) {
    if (nonEmptyCanonical.length > 0) {
      add({
        code: "seo.canonical.unusable",
        severity: "warning",
        category: "SEO",
        message: "Canonical link is present but uses attributes Google ignores for canonicalization. Use a plain rel=\"canonical\" link in <head>.",
      });
    } else {
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

  // --- Images Alt Tags (SEO + Accessibility) ---
  $("img").filter((_, element) => !isInTemplateContents(element)).each((_, element) => {
    const img = $(element);
    const src = img.attr("src") || "unknown-source";
    const alt = img.attr("alt");

    if (alt === undefined) {
      add({
        code: "accessibility.image_alt.missing",
        severity: "error",
        category: "Accessibility",
        message: "Missing 'alt' attribute on image. This makes it inaccessible to screen readers.",
        element: `<img src="${src}">`,
      });
    } else if (alt.trim() === "") {
      // Empty alt is acceptable for purely decorative images, but worth warning
      add({
        code: "accessibility.image_alt.empty",
        severity: "info",
        category: "Accessibility",
        message: "Empty 'alt' attribute found. Ensure this image is purely decorative, otherwise add descriptive text.",
        element: `<img src="${src}" alt="">`,
      });
    }
  });

  // --- Open Graph / Social Tags ---
  const ogTitle = $('head > meta[property="og:title"]');
  const ogImage = $('head > meta[property="og:image"]');
  if (ogTitle.length === 0 || ogImage.length === 0) {
    add({
      code: "seo.open_graph.missing",
      severity: "info",
      category: "SEO",
      message: "Missing Open Graph social metadata (og:title / og:image). Add these to control preview cards on platforms like LinkedIn and X.",
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
 * Extracts and tests links, treating 3xx responses as reachable redirects and 4xx/5xx as broken.
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
      parsedBaseUrl = undefined;
    }
    if (resolvedDocumentBase) {
      try {
        parsedBaseUrl = await assertPublicHttpUrl(resolvedDocumentBase);
      } catch (error: unknown) {
        if (!(error instanceof PublicUrlError)) {
          throw error;
        }
        parsedBaseUrl = undefined;
      }
    }
  }
  const urls: string[] = [];
  const seenUrls = new Set<string>();

  $("a").filter((_, element) => !isInTemplateContents(element)).each((_, element) => {
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
            status >= 300 && status < 400
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
          headStatus >= 300 && headStatus < 400
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
