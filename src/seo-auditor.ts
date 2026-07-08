import * as cheerio from "cheerio";

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

/**
 * Audits technical SEO and accessibility basics on HTML content using Cheerio
 */
export function auditSeoMetadata(htmlContent: string): SEOIssue[] {
  const $ = cheerio.load(htmlContent);
  const issues: SEOIssue[] = [];

  // --- Title Tag Audits ---
  const titleTag = $("title");
  if (titleTag.length === 0) {
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing <title> tag. This is critical for search indexing and click-through rates.",
    });
  } else {
    const titleText = titleTag.text().trim();
    if (titleText.length === 0) {
      issues.push({
        severity: "error",
        category: "SEO",
        message: "The <title> tag is empty.",
      });
    } else if (titleText.length < 30) {
      issues.push({
        severity: "warning",
        category: "SEO",
        message: `Title length (${titleText.length} chars) is too short. Try to make it at least 30-50 characters.`,
        element: `<title>${titleText}</title>`,
      });
    } else if (titleText.length > 60) {
      issues.push({
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
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing <meta name=\"description\">. Search engines will automatically generate snippets, which may lower CTR.",
    });
  } else {
    const descText = metaDescription.attr("content")?.trim() || "";
    if (descText.length === 0) {
      issues.push({
        severity: "error",
        category: "SEO",
        message: "Meta description content attribute is empty.",
      });
    } else if (descText.length < 120) {
      issues.push({
        severity: "warning",
        category: "SEO",
        message: `Meta description is too short (${descText.length} chars). Aim for 120-160 characters to optimize your search snippet.`,
        element: `<meta name="description" content="${descText}">`,
      });
    } else if (descText.length > 160) {
      issues.push({
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
    issues.push({
      severity: "warning",
      category: "SEO",
      message: "Missing canonical tag (<link rel=\"canonical\">). This helps prevent duplicate content issues.",
    });
  }

  // --- Viewport Meta Tag (Mobile Responsiveness) ---
  const viewport = $('meta[name="viewport"]');
  if (viewport.length === 0) {
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing <meta name=\"viewport\"> tag. Mobile friendliness is a critical ranking factor.",
    });
  }

  // --- Heading Structure ---
  const h1Tags = $("h1");
  if (h1Tags.length === 0) {
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing <h1> tag. Every page must have exactly one <h1> representing the main topic.",
    });
  } else if (h1Tags.length > 1) {
    issues.push({
      severity: "warning",
      category: "SEO",
      message: `Found multiple (${h1Tags.length}) <h1> tags. Multiple <h1> tags dilutes topic keyword focus.`,
    });
  }

  // --- Images Alt Tags (SEO + Accessibility) ---
  $("img").each((_, element) => {
    const img = $(element);
    const src = img.attr("src") || "unknown-source";
    const alt = img.attr("alt");

    if (alt === undefined) {
      issues.push({
        severity: "error",
        category: "Accessibility",
        message: "Missing 'alt' attribute on image. This makes it inaccessible to screen readers.",
        element: `<img src="${src}">`,
      });
    } else if (alt.trim() === "") {
      // Empty alt is acceptable for purely decorative images, but worth warning
      issues.push({
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
    issues.push({
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
    const scriptText = $(element).html() || "";
    if (scriptText.trim() === "") {
      issues.push({
        severity: "warning",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is empty.`,
      });
      return;
    }

    try {
      JSON.parse(scriptText);
    } catch (e: any) {
      issues.push({
        severity: "error",
        category: "Schema",
        message: `Invalid JSON-LD schema syntax: ${e.message}`,
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
  baseUrl?: string
): Promise<LinkStatus[]> {
  const $ = cheerio.load(htmlContent);
  const urls: string[] = [];

  $("a").each((_, element) => {
    const href = $(element).attr("href");
    if (href && !href.startsWith("#") && !href.startsWith("mailto:") && !href.startsWith("tel:") && !href.startsWith("javascript:")) {
      let resolvedUrl = href;
      if (href.startsWith("/") && baseUrl) {
        resolvedUrl = new URL(href, baseUrl).toString();
      }
      if (!urls.includes(resolvedUrl)) {
        urls.push(resolvedUrl);
      }
    }
  });

  const results: LinkStatus[] = [];

  // Parallel requests with timeout limits to keep validation fast
  const requests = urls.map(async (url) => {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        // Avoid rejection on self-signed certs or SSL errors commonly found on local testing servers
        signal: AbortSignal.timeout(5000), 
      });

      // If HEAD is not allowed (e.g. Cloudflare / 405 Method Not Allowed), retry with GET
      if (response.status === 405 || response.status === 403) {
        const getResponse = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
        });
        return {
          url,
          status: getResponse.status,
          ok: getResponse.ok,
        };
      }

      return {
        url,
        status: response.status,
        ok: response.ok,
      };
    } catch (error: any) {
      return {
        url,
        status: "FAILED",
        ok: false,
        message: error.name === "TimeoutError" ? "Timeout" : error.message,
      };
    }
  });

  return Promise.all(requests);
}
