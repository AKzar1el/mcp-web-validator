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

function addIssue(issues: SEOIssue[], issue: SEOIssue): void {
  if (issues.length < MAX_AUDIT_ISSUES) {
    issues.push(issue);
  }
}

/**
 * Audits technical SEO and accessibility basics on HTML content using Cheerio
 */
export function auditSeoMetadata(htmlContent: string): SEOIssue[] {
  const $ = cheerio.load(htmlContent);
  const issues: SEOIssue[] = [];

  // --- Title Tag Audits ---
  const titleTag = $("title");
  if (titleTag.length === 0) {
    addIssue(issues, {
      severity: "error",
      category: "SEO",
      message: "Missing <title> tag. This is critical for search indexing and click-through rates.",
    });
  } else {
    const titleText = titleTag.text().trim();
    if (titleText.length === 0) {
      addIssue(issues, {
        severity: "error",
        category: "SEO",
        message: "The <title> tag is empty.",
      });
    } else if (titleText.length < 30) {
      addIssue(issues, {
        severity: "warning",
        category: "SEO",
        message: `Title length (${titleText.length} chars) is too short. Try to make it at least 30-50 characters.`,
        element: `<title>${titleText}</title>`,
      });
    } else if (titleText.length > 60) {
      addIssue(issues, {
        severity: "warning",
        category: "SEO",
        message: `Title length (${titleText.length} chars) is too long. Search engines will truncate it. Keep it under 60 characters.`,
        element: `<title>${titleText}</title>`,
      });
    }
  }

  // --- Meta Description Audits ---
  const metaDescription = $('meta[name="description"]');
  if (metaDescription.length === 0) {
    addIssue(issues, {
      severity: "error",
      category: "SEO",
      message: "Missing <meta name=\"description\">. Search engines will automatically generate snippets, which may lower CTR.",
    });
  } else {
    const descText = metaDescription.attr("content")?.trim() || "";
    if (descText.length === 0) {
      addIssue(issues, {
        severity: "error",
        category: "SEO",
        message: "Meta description content attribute is empty.",
      });
    } else if (descText.length < 120) {
      addIssue(issues, {
        severity: "warning",
        category: "SEO",
        message: `Meta description is too short (${descText.length} chars). Aim for 120-160 characters to optimize your search snippet.`,
        element: `<meta name="description" content="${descText}">`,
      });
    } else if (descText.length > 160) {
      addIssue(issues, {
        severity: "warning",
        category: "SEO",
        message: `Meta description is too long (${descText.length} chars). Search engines will truncate it. Keep it under 160 characters.`,
        element: `<meta name="description" content="${descText}">`,
      });
    }
  }

  // --- Canonical Link ---
  const canonical = $('link[rel="canonical"]');
  if (canonical.length === 0) {
    addIssue(issues, {
      severity: "warning",
      category: "SEO",
      message: "Missing canonical tag (<link rel=\"canonical\">). This helps prevent duplicate content issues.",
    });
  }

  // --- Viewport Meta Tag (Mobile Responsiveness) ---
  const viewport = $('meta[name="viewport"]');
  if (viewport.length === 0) {
    addIssue(issues, {
      severity: "error",
      category: "SEO",
      message: "Missing <meta name=\"viewport\"> tag. Mobile friendliness is a critical ranking factor.",
    });
  }

  // --- Heading Structure ---
  const h1Tags = $("h1");
  if (h1Tags.length === 0) {
    addIssue(issues, {
      severity: "error",
      category: "SEO",
      message: "Missing <h1> tag. Every page must have exactly one <h1> representing the main topic.",
    });
  } else if (h1Tags.length > 1) {
    addIssue(issues, {
      severity: "warning",
      category: "SEO",
      message: `Found multiple (${h1Tags.length}) <h1> tags. Multiple <h1> tags dilutes topic keyword focus.`,
    });
  }

  // --- Images Alt Tags (SEO + Accessibility) ---
  $("img").each((_, element) => {
    if (issues.length >= MAX_AUDIT_ISSUES) {
      return false;
    }

    const img = $(element);
    const src = img.attr("src") || "unknown-source";
    const alt = img.attr("alt");

    if (alt === undefined) {
      addIssue(issues, {
        severity: "error",
        category: "Accessibility",
        message: "Missing 'alt' attribute on image. This makes it inaccessible to screen readers.",
        element: `<img src="${src}">`,
      });
    } else if (alt.trim() === "") {
      // Empty alt is acceptable for purely decorative images, but worth warning
      addIssue(issues, {
        severity: "info",
        category: "Accessibility",
        message: "Empty 'alt' attribute found. Ensure this image is purely decorative, otherwise add descriptive text.",
        element: `<img src="${src}" alt="">`,
      });
    }
  });

  // --- Open Graph / Social Tags ---
  const ogTitle = $('meta[property="og:title"]');
  const ogImage = $('meta[property="og:image"]');
  if (ogTitle.length === 0 || ogImage.length === 0) {
    addIssue(issues, {
      severity: "info",
      category: "SEO",
      message: "Missing Open Graph social metadata (og:title / og:image). Add these to control preview cards on platforms like LinkedIn and X.",
    });
  }

  return issues;
}

/**
 * Parses and validates JSON-LD Schema markup
 */
export function validateSchemaMarkup(htmlContent: string): SEOIssue[] {
  const $ = cheerio.load(htmlContent);
  const issues: SEOIssue[] = [];

  $('script[type="application/ld+json"]').each((index, element) => {
    if (issues.length >= MAX_AUDIT_ISSUES) {
      return false;
    }

    const scriptText = $(element).html() || "";
    if (scriptText.trim() === "") {
      addIssue(issues, {
        severity: "warning",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is empty.`,
      });
      return;
    }

    try {
      JSON.parse(scriptText);
    } catch (error: unknown) {
      addIssue(issues, {
        severity: "error",
        category: "Schema",
        message: `Invalid JSON-LD schema syntax: ${getErrorMessage(error)}`,
        element: `<script type="application/ld+json">...</script>`,
      });
    }
  });

  return issues;
}

/**
 * Extracts and tests all links inside the HTML content for broken links (4xx / 5xx)
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
  const parsedBaseUrl = baseUrl ? await assertPublicHttpUrl(baseUrl) : undefined;
  const urls: string[] = [];
  const seenUrls = new Set<string>();

  $("a").each((_, element) => {
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

      // Some sites reject HEAD even when the linked resource is available.
      if (headStatus === 405 || headStatus === 403) {
        const getResult = await fetchPublicHttp(url, {
          method: "GET",
          headers: {
            Range: "bytes=0-0",
            "User-Agent": LINK_CHECK_USER_AGENT,
          },
          timeoutMs: LINK_CHECK_TIMEOUT_MS,
          maxRedirects: 0,
        });
        const status = getResult.response.status;
        const ok = getResult.response.ok;
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
        ok: headStatus >= 200 && headStatus < 300,
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
