import * as cheerio from "cheerio";
import ipaddr from "ipaddr.js";
import { HOSTED_MAX_LINKS, SERVICE_USER_AGENT } from "./constants";

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

function isJsonLdScriptType(type: string | undefined): boolean {
  return type?.split(";", 1)[0].trim().toLowerCase() === "application/ld+json";
}

function hasJsonLdDocumentShape(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry));
  }
  return typeof value === "object" && value !== null;
}

/**
 * Checks on-page metadata and accessibility signals without fetching or storing
 * any external content.
 */
export function auditSeoMetadata(html: string): AuditResult {
  const $ = cheerio.load(html);
  const collector = createAuditCollector();

  const title = $("head > title").first().text().trim();
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

  const description = $('head > meta[name="description" i]').first().attr("content")?.trim() ?? "";
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
  const usableCanonical = canonicalLinks.filter((_, element) => Boolean($(element).attr("href")?.trim()));
  if (canonicalLinks.length === 0) {
    collector.add({
      code: "seo.canonical.missing",
      severity: "info",
      category: "SEO",
      message: "No rel=\"canonical\" preference is declared. This is optional unless the page needs an explicit canonicalization signal.",
    });
  } else if (usableCanonical.length === 0) {
    collector.add({
      code: "seo.canonical.missing",
      severity: "warning",
      category: "SEO",
      message: "Canonical link is present but its href is empty. Provide a usable canonical target or remove the declaration.",
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

  const h1Count = $("h1").length;
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

  $("img").each((_, element) => {
    const alt = $(element).attr("alt");
    if (alt === undefined) {
      collector.add({
        code: "accessibility.image_alt.missing",
        severity: "error",
        category: "Accessibility",
        message: "An image is missing its alt attribute.",
      });
    } else if (alt.trim() === "") {
      collector.add({
        code: "accessibility.image_alt.empty",
        severity: "info",
        category: "Accessibility",
        message: "An image has an empty alt attribute; confirm that it is decorative.",
      });
    }
  });

  if ($('head > meta[property="og:title"]').length === 0 || $('head > meta[property="og:image"]').length === 0) {
    collector.add({
      code: "seo.open_graph.missing",
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
  const blocks = $("script[type]").filter((_, element) => isJsonLdScriptType($(element).attr("type")));

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
  const fallbackBaseUrl = baseUrl ? toPublicHttpUrl(baseUrl)?.toString() : undefined;
  if (baseUrl && !fallbackBaseUrl) {
    throw new Error("base_url must be a public HTTP(S) URL on port 80 or 443.");
  }

  const $ = cheerio.load(html);
  let effectiveBaseUrl = fallbackBaseUrl;
  const documentBaseHref = $("base[href]").first().attr("href");
  if (documentBaseHref !== undefined) {
    try {
      const resolvedDocumentBase = fallbackBaseUrl
        ? new URL(documentBaseHref, fallbackBaseUrl)
        : new URL(documentBaseHref);
      effectiveBaseUrl = toPublicHttpUrl(resolvedDocumentBase.href)?.toString();
    } catch {
      effectiveBaseUrl = undefined;
    }
  }
  const urls: URL[] = [];
  const seen = new Set<string>();
  const limit = Math.min(Math.max(maxLinks, 1), HOSTED_MAX_LINKS);

  $("a[href]").each((_, element) => {
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
