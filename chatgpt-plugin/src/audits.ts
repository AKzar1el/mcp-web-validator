import * as cheerio from "cheerio";
import ipaddr from "ipaddr.js";
import { HOSTED_MAX_LINKS, SERVICE_USER_AGENT } from "./constants";

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

export interface AuditResult {
  issues: AuditIssue[];
  total: number;
  truncated: boolean;
  counts: Record<AuditSeverity, number>;
}

const MAX_AUDIT_ISSUES = 100;
const REQUEST_TIMEOUT_MS = 5_000;

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

/**
 * Checks on-page metadata and accessibility signals without fetching or storing
 * any external content.
 */
export function auditSeoMetadata(html: string): AuditResult {
  const $ = cheerio.load(html);
  const collector = createAuditCollector();

  const title = $("title").first().text().trim();
  if (!title) {
    collector.add({
      severity: "error",
      category: "SEO",
      message: "Missing or empty <title> tag.",
    });
  } else if (title.length < 30 || title.length > 60) {
    collector.add({
      severity: "warning",
      category: "SEO",
      message: `Title length is ${title.length} characters; aim for roughly 30–60 characters.`,
    });
  }

  const description = $('meta[name="description"]').first().attr("content")?.trim() ?? "";
  if (!description) {
    collector.add({
      severity: "error",
      category: "SEO",
      message: "Missing or empty meta description.",
    });
  } else if (description.length < 120 || description.length > 160) {
    collector.add({
      severity: "warning",
      category: "SEO",
      message: `Meta description length is ${description.length} characters; aim for roughly 120–160 characters.`,
    });
  }

  if ($('link[rel="canonical"]').length === 0) {
    collector.add({
      severity: "warning",
      category: "SEO",
      message: "Missing canonical link tag.",
    });
  }

  if ($('meta[name="viewport"]').length === 0) {
    collector.add({
      severity: "error",
      category: "SEO",
      message: "Missing viewport meta tag.",
    });
  }

  const h1Count = $("h1").length;
  if (h1Count === 0) {
    collector.add({
      severity: "error",
      category: "SEO",
      message: "Missing an H1 heading.",
    });
  } else if (h1Count > 1) {
    collector.add({
      severity: "warning",
      category: "SEO",
      message: `Found ${h1Count} H1 headings; use one primary H1 unless there is a clear structural reason not to.`,
    });
  }

  $("img").each((_, element) => {
    const alt = $(element).attr("alt");
    if (alt === undefined) {
      collector.add({
        severity: "error",
        category: "Accessibility",
        message: "An image is missing its alt attribute.",
      });
    } else if (alt.trim() === "") {
      collector.add({
        severity: "info",
        category: "Accessibility",
        message: "An image has an empty alt attribute; confirm that it is decorative.",
      });
    }
  });

  if ($('meta[property="og:title"]').length === 0 || $('meta[property="og:image"]').length === 0) {
    collector.add({
      severity: "info",
      category: "SEO",
      message: "Open Graph title or image metadata is missing.",
    });
  }

  return collector.result();
}

/** Parses JSON-LD blocks locally and reports syntax problems only. */
export function validateSchemaMarkup(html: string): AuditResult & { blocksChecked: number } {
  const $ = cheerio.load(html);
  const collector = createAuditCollector();
  const blocks = $('script[type="application/ld+json"]');

  blocks.each((index, element) => {
    const value = $(element).html()?.trim() ?? "";
    if (!value) {
      collector.add({
        severity: "warning",
        category: "Schema",
        message: `JSON-LD block #${index + 1} is empty.`,
      });
      return;
    }

    try {
      JSON.parse(value);
    } catch {
      collector.add({
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
  const limit = Math.min(Math.max(maxLinks, 1), HOSTED_MAX_LINKS);

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
