import * as cheerio from "cheerio";

export type AuditSeverity = "error" | "warning" | "info";

export interface AuditIssue {
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

const MAX_LINKS = 25;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Checks on-page metadata and accessibility signals without fetching or storing
 * any external content.
 */
export function auditSeoMetadata(html: string): AuditIssue[] {
  const $ = cheerio.load(html);
  const issues: AuditIssue[] = [];

  const title = $("title").first().text().trim();
  if (!title) {
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing or empty <title> tag.",
    });
  } else if (title.length < 30 || title.length > 60) {
    issues.push({
      severity: "warning",
      category: "SEO",
      message: `Title length is ${title.length} characters; aim for roughly 30–60 characters.`,
    });
  }

  const description = $('meta[name="description"]').first().attr("content")?.trim() ?? "";
  if (!description) {
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing or empty meta description.",
    });
  } else if (description.length < 120 || description.length > 160) {
    issues.push({
      severity: "warning",
      category: "SEO",
      message: `Meta description length is ${description.length} characters; aim for roughly 120–160 characters.`,
    });
  }

  if ($('link[rel="canonical"]').length === 0) {
    issues.push({
      severity: "warning",
      category: "SEO",
      message: "Missing canonical link tag.",
    });
  }

  if ($('meta[name="viewport"]').length === 0) {
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing viewport meta tag.",
    });
  }

  const h1Count = $("h1").length;
  if (h1Count === 0) {
    issues.push({
      severity: "error",
      category: "SEO",
      message: "Missing an H1 heading.",
    });
  } else if (h1Count > 1) {
    issues.push({
      severity: "warning",
      category: "SEO",
      message: `Found ${h1Count} H1 headings; use one primary H1 unless there is a clear structural reason not to.`,
    });
  }

  $("img").each((_, element) => {
    const alt = $(element).attr("alt");
    if (alt === undefined) {
      issues.push({
        severity: "error",
        category: "Accessibility",
        message: "An image is missing its alt attribute.",
      });
    } else if (alt.trim() === "") {
      issues.push({
        severity: "info",
        category: "Accessibility",
        message: "An image has an empty alt attribute; confirm that it is decorative.",
      });
    }
  });

  if ($('meta[property="og:title"]').length === 0 || $('meta[property="og:image"]').length === 0) {
    issues.push({
      severity: "info",
      category: "SEO",
      message: "Open Graph title or image metadata is missing.",
    });
  }

  return issues;
}

/** Parses JSON-LD blocks locally and reports syntax problems only. */
export function validateSchemaMarkup(html: string): AuditIssue[] {
  const $ = cheerio.load(html);
  const issues: AuditIssue[] = [];

  $('script[type="application/ld+json"]').each((index, element) => {
    const value = $(element).html()?.trim() ?? "";
    if (!value) {
      issues.push({
        severity: "warning",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is empty.`,
      });
      return;
    }

    try {
      JSON.parse(value);
    } catch {
      issues.push({
        severity: "error",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is not valid JSON.`,
      });
    }
  });

  return issues;
}

function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return true;
    const [first, second] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  return (
    host === "::1" ||
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:") ||
    host.startsWith("::ffff:")
  );
}

function toPublicHttpUrl(value: string, baseUrl?: string): URL | undefined {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    if (url.port && url.port !== "80" && url.port !== "443") return undefined;
    if (isPrivateOrReservedHost(url.hostname)) return undefined;
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
    if (response.status === 405 || response.status === 501) {
      response = await execute("GET");
    }
    return {
      url: url.toString(),
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      message: response.status >= 300 && response.status < 400 ? "Redirect not followed." : undefined,
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
  const safeBaseUrl = baseUrl ? toPublicHttpUrl(baseUrl)?.toString() : undefined;
  if (baseUrl && !safeBaseUrl) {
    throw new Error("base_url must be a public HTTP(S) URL on port 80 or 443.");
  }

  const $ = cheerio.load(html);
  const urls: URL[] = [];
  const seen = new Set<string>();
  const limit = Math.min(Math.max(maxLinks, 1), MAX_LINKS);

  $("a[href]").each((_, element) => {
    if (urls.length >= limit) return;
    const href = $(element).attr("href")?.trim();
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(href)) return;
    const url = toPublicHttpUrl(href, safeBaseUrl);
    if (!url || seen.has(url.toString())) return;
    seen.add(url.toString());
    urls.push(url);
  });

  return mapWithConcurrency(urls, 5, fetchStatus);
}
