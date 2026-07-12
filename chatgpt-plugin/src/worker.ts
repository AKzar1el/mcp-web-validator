import { createMcpHandler } from "agents/mcp";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditSeoMetadata, checkBrokenLinks, validateSchemaMarkup } from "./audits";
import {
  CSS_MAX_LENGTH,
  HOSTED_MAX_LINKS,
  HTML_MAX_LENGTH,
  SERVER_VERSION,
  SITE_AUDIT_DEFAULT_MAX_PAGES,
  SITE_AUDIT_MAX_PAGES,
  SITE_AUDIT_MAX_SITEMAP_URLS,
} from "./constants";
import { fetchPublicHtml, PublicHtmlFetchError } from "./network";
import {
  contentForOverview,
  overviewSchema,
  plural,
  type OverviewMetric,
  type PresentableFinding,
  type ResultOverview,
} from "./presentation";
import { validateCss, validateHtmlDetailed } from "./validators";
import { auditPublicSite } from "./site-audit";
import { WIDGET_HTML, WIDGET_URI } from "./widget";

const MCP_BODY_MAX_BYTES = 2 * 1024 * 1024;
const TRUSTED_BROWSER_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
  "https://digestseo.com",
  "https://web-validator-mcp.digestseo.com",
]);
const GLAMA_CONNECTOR_METADATA = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  maintainers: [{ email: "tomi.seregi99@gmail.com" }],
};

const validationMessageSchema = z.object({
  type: z.enum(["error", "warning", "info"]),
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
});

const cssMessageSchema = z.object({
  line: z.number(),
  message: z.string(),
  context: z.string().optional(),
});

const auditIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["SEO", "Schema", "Accessibility"]),
  message: z.string(),
});

const auditResultSchema = {
  issues: z.array(auditIssueSchema),
  total_issues: z.number().int().nonnegative(),
  truncated: z.boolean(),
  overview: overviewSchema,
  error: z.string().optional(),
};

const linkStatusSchema = z.object({
  url: z.string(),
  status: z.union([z.number(), z.enum(["blocked", "failed"])]),
  ok: z.boolean(),
  message: z.string().optional(),
});

const siteFindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["HTML", "SEO", "Schema", "Accessibility"]),
  message: z.string(),
});

const sitePageSchema = z.object({
  url: z.string(),
  fetched_url: z.string().optional(),
  status: z.enum(["passed", "needs_attention", "partial", "failed", "skipped"]),
  http_status: z.number().int().min(200).max(299).optional(),
  redirects_followed: z.number().int().min(0).max(3).optional(),
  page_fetched: z.boolean(),
  html_validation_status: z.enum(["completed", "timeout", "unavailable", "not_run"]),
  html_errors: z.number().int().nonnegative(),
  html_warnings: z.number().int().nonnegative(),
  seo_errors: z.number().int().nonnegative(),
  seo_warnings: z.number().int().nonnegative(),
  schema_errors: z.number().int().nonnegative(),
  schema_warnings: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  health_score: z.number().int().min(0).max(100).optional(),
  failure_code: z.string().optional(),
  top_findings: z.array(siteFindingSchema),
});

const siteIssueGroupSchema = siteFindingSchema.extend({
  affected_pages: z.number().int().nonnegative(),
  example_urls: z.array(z.string()),
});

const siteAuditOutputSchema = {
  site_url: z.string(),
  sitemap_url: z.string().optional(),
  discovery: z.enum(["sitemap", "root_only", "partial"]),
  discovery_error: z.enum(["robots_unavailable", "sitemap_unavailable", "sitemap_invalid"]).optional(),
  pages_discovered: z.number().int().nonnegative(),
  pages_selected: z.number().int().nonnegative(),
  pages_audited: z.number().int().nonnegative(),
  pages_partial: z.number().int().nonnegative(),
  pages_failed: z.number().int().nonnegative(),
  pages_skipped_robots: z.number().int().nonnegative(),
  truncated: z.boolean(),
  next_page_offset: z.number().int().nonnegative().optional(),
  audit_health_score: z.number().int().min(0).max(100).optional(),
  score_coverage_percent: z.number().int().min(0).max(100),
  pages: z.array(sitePageSchema),
  issue_groups: z.array(siteIssueGroupSchema),
  issue_groups_truncated: z.boolean(),
  overview: overviewSchema,
  error: z.string().optional(),
};

const reportOutputSchema = {
  html_errors: z.number().int().nonnegative(),
  css_errors: z.number().int().nonnegative(),
  seo_issues: z.number().int().nonnegative(),
  schema_issues: z.number().int().nonnegative(),
  links_checked: z.number().int().nonnegative(),
  broken_links: z.number().int().nonnegative(),
  html_warnings: z.number().int().nonnegative(),
  html_info: z.number().int().nonnegative(),
  html_messages: z.array(validationMessageSchema),
  css_messages: z.array(cssMessageSchema),
  seo_findings: z.array(auditIssueSchema),
  schema_findings: z.array(auditIssueSchema),
  links: z.array(linkStatusSchema),
  seo_truncated: z.boolean(),
  schema_truncated: z.boolean(),
  html_total_messages: z.number().int().nonnegative(),
  html_truncated: z.boolean(),
  schema_blocks_checked: z.number().int().nonnegative(),
  healthy_links: z.number().int().nonnegative(),
  redirects: z.number().int().nonnegative(),
  unreachable_links: z.number().int().nonnegative(),
  links_requested: z.boolean(),
  css_checked: z.boolean(),
  failed_checks: z.array(z.enum(["fetch", "html", "css", "links"])),
  overview: overviewSchema,
  error: z.string().optional(),
};

const htmlInput = z
  .string()
  .min(1)
  .max(HTML_MAX_LENGTH)
  .describe("Raw HTML markup supplied by the user; this is not a webpage URL.");
const cssInput = z
  .string()
  .min(1)
  .max(CSS_MAX_LENGTH)
  .describe("Raw CSS source supplied by the user.");
const publicPageUrlInput = z
  .string()
  .url()
  .max(2_048)
  .describe("One authorized public HTTP(S) webpage URL; private pages, credentials, and custom ports are rejected.");
const externalReadOnlyAnnotations = {
  // These tools contact external recipients but never modify external state.
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;
const localReadOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

function noAuthSecuritySchemes() {
  return [{ type: "noauth" as const }];
}

function withWidget(statusText: { invoking: string; invoked: string }) {
  return {
    securitySchemes: noAuthSecuritySchemes(),
    ui: { resourceUri: WIDGET_URI },
    "openai/toolInvocation/invoking": statusText.invoking,
    "openai/toolInvocation/invoked": statusText.invoked,
  };
}

function withExactCors(response: Response, origin?: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("access-control-allow-origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    const vary = headers.get("vary");
    if (!vary) headers.set("vary", "Origin");
    else if (vary !== "*" && !vary.toLowerCase().split(",").map((value) => value.trim()).includes("origin")) {
      headers.set("vary", `${vary}, Origin`);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonRpcHttpError(status: number, message: string, origin?: string, extraHeaders?: HeadersInit): Response {
  const response = Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers: extraHeaders },
  );
  return withExactCors(response, origin);
}

async function requestBodyExceedsLimit(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const bytes = Number(contentLength);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > MCP_BODY_MAX_BYTES) return true;
  }
  if (!request.body) return false;

  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      bytes += value.byteLength;
      if (bytes > MCP_BODY_MAX_BYTES) {
        await reader.cancel("MCP request body exceeded the configured limit.");
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function rateLimitKey(request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  const sessionId = request.headers.get("mcp-session-id")?.trim();
  const actor = ip
    ? `ip:${ip}`
    : sessionId
      ? `session:${sessionId.slice(0, 128)}`
      : `anonymous:${request.headers.get("user-agent")?.slice(0, 128) ?? "unknown"}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(actor));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function logRequest(event: string, fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ event, ...fields }));
}

function validationFindings(
  messages: Array<{ type: "error" | "warning" | "info"; message: string; line?: number; column?: number }>,
): PresentableFinding[] {
  return messages.map((message) => ({
    severity: message.type,
    message: message.message,
    line: message.line,
    column: message.column,
  }));
}

function auditFindings(
  issues: Array<{ severity: "error" | "warning" | "info"; category: string; message: string }>,
): PresentableFinding[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    message: issue.message,
    label: issue.category,
  }));
}

function failedOverview(
  kind: ResultOverview["kind"],
  title: string,
  headline: string,
  detail: string,
): ResultOverview {
  return {
    kind,
    status: "failed",
    title,
    headline,
    detail,
    total: 0,
    shown: 0,
    truncated: false,
    counts: [],
    next_action: "Try again shortly. If the problem continues, run the remaining checks separately.",
  };
}

function metric(
  key: string,
  label: string,
  value: number,
  tone: OverviewMetric["tone"],
): OverviewMetric {
  return { key, label, value, tone };
}

function summarizeSeverities(counts: { errors: number; warnings: number; info: number }): string {
  const parts = [
    counts.errors > 0 ? plural(counts.errors, "error") : undefined,
    counts.warnings > 0 ? plural(counts.warnings, "warning") : undefined,
    counts.info > 0 ? plural(counts.info, "informational note") : undefined,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return "no findings";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function linkCounts(links: Array<{ status: number | "blocked" | "failed"; ok: boolean }>) {
  const redirects = links.filter(
    (link) => typeof link.status === "number" && link.status >= 300 && link.status < 400,
  ).length;
  const unreachable = links.filter((link) => !link.ok).length;
  return {
    checked: links.length,
    healthy: links.length - redirects - unreachable,
    redirects,
    unreachable,
  };
}

type ReportCheck = "html" | "css" | "links";

interface ValidationReportOptions {
  html: string;
  css?: string;
  checkLinks: boolean;
  baseUrl?: string;
  maxLinks: number;
  title: "Validation report" | "Public webpage audit";
  sourceDetail?: string;
}

function reportNextAction(errors: number, warnings: number, rerunLabel: string): string | undefined {
  if (errors > 0 && warnings > 0) {
    return `Fix errors first, review warnings, then ${rerunLabel}.`;
  }
  if (errors > 0) return `Fix the errors, then ${rerunLabel}.`;
  if (warnings > 0) return `Review the warnings, then ${rerunLabel}.`;
  return undefined;
}

async function runValidationReport({
  html,
  css,
  checkLinks,
  baseUrl,
  maxLinks,
  title,
  sourceDetail,
}: ValidationReportOptions) {
  const cssChecked = css !== undefined;
  const [htmlResult, cssResult, linksResult] = await Promise.allSettled([
    validateHtmlDetailed(html),
    cssChecked ? Promise.resolve().then(() => validateCss(css)) : Promise.resolve([]),
    checkLinks ? checkBrokenLinks(html, baseUrl, maxLinks) : Promise.resolve([]),
  ]);
  const seoResult = auditSeoMetadata(html);
  const schemaResult = validateSchemaMarkup(html);
  const failedChecks: ReportCheck[] = [];
  const failureDetails: string[] = [];

  if (htmlResult.status === "rejected") {
    failedChecks.push("html");
    failureDetails.push("HTML validation was unavailable");
  }
  if (cssChecked && cssResult.status === "rejected") {
    failedChecks.push("css");
    failureDetails.push("CSS validation was unavailable");
  }
  if (checkLinks && linksResult.status === "rejected") {
    failedChecks.push("links");
    failureDetails.push(
      linksResult.reason instanceof Error
        ? linksResult.reason.message
        : "Link checking could not be completed",
    );
  }

  const htmlValidation = htmlResult.status === "fulfilled"
    ? htmlResult.value
    : { messages: [], total: 0, truncated: false, counts: { error: 0, warning: 0, info: 0 } };
  const htmlMessages = htmlValidation.messages;
  const cssMessages = cssResult.status === "fulfilled" ? cssResult.value : [];
  const links = linksResult.status === "fulfilled" ? linksResult.value : [];
  const htmlCounts = {
    errors: htmlValidation.counts.error,
    warnings: htmlValidation.counts.warning,
    info: htmlValidation.counts.info,
  };
  const seoCounts = {
    errors: seoResult.counts.error,
    warnings: seoResult.counts.warning,
    info: seoResult.counts.info,
  };
  const schemaCounts = {
    errors: schemaResult.counts.error,
    warnings: schemaResult.counts.warning,
    info: schemaResult.counts.info,
  };
  const linkSummary = linkCounts(links);
  const reportCounts = {
    errors: htmlCounts.errors + cssMessages.length + seoCounts.errors + schemaCounts.errors + linkSummary.unreachable,
    warnings: htmlCounts.warnings + seoCounts.warnings + schemaCounts.warnings + linkSummary.redirects,
    info: htmlCounts.info + seoCounts.info + schemaCounts.info,
  };
  const passedChecks = [
    htmlResult.status === "fulfilled" && htmlCounts.errors === 0 && htmlCounts.warnings === 0,
    cssChecked && cssResult.status === "fulfilled" && cssMessages.length === 0,
    seoCounts.errors === 0 && seoCounts.warnings === 0,
    schemaResult.blocksChecked > 0 && schemaCounts.errors === 0 && schemaCounts.warnings === 0,
    checkLinks && linkSummary.checked > 0 && linkSummary.redirects === 0 && linkSummary.unreachable === 0,
  ].filter(Boolean).length;
  const totalFindings = htmlValidation.total
    + cssMessages.length
    + seoResult.total
    + schemaResult.total
    + linkSummary.redirects
    + linkSummary.unreachable;
  const shownFindings = htmlMessages.length
    + cssMessages.length
    + seoResult.issues.length
    + schemaResult.issues.length
    + linkSummary.redirects
    + linkSummary.unreachable;
  const truncated = htmlValidation.truncated || seoResult.truncated || schemaResult.truncated;
  const hasFailures = failedChecks.length > 0;
  const needsAttention = reportCounts.errors > 0 || reportCounts.warnings > 0;
  const linksDetail = checkLinks
    ? failedChecks.includes("links")
      ? "Link checking did not complete."
      : `${plural(linkSummary.checked, "link")} checked.`
    : "Links were not requested.";
  const cssDetail = cssChecked ? "CSS was checked." : "Linked and external CSS were not checked.";
  const nextAction = hasFailures
    ? "Review the completed findings, then retry the unavailable checks."
    : reportNextAction(reportCounts.errors, reportCounts.warnings, `run ${title.toLowerCase()} again`);
  const overview: ResultOverview = {
    kind: "report",
    status: hasFailures ? "partial" : needsAttention ? "needs_attention" : "passed",
    title,
    headline: hasFailures
      ? `${title} is partial: ${plural(failedChecks.length, "check")} could not complete.`
      : needsAttention
        ? `${title} is ready: ${summarizeSeverities({ ...reportCounts, info: 0 })} need attention.`
        : `${title} is clear: no errors or warnings were found.`,
    detail: `${sourceDetail ? `${sourceDetail} ` : ""}Completed checks found ${summarizeSeverities(reportCounts)}. ${cssDetail} ${linksDetail}`,
    total: totalFindings,
    shown: shownFindings,
    truncated,
    counts: [
      metric("errors", "Errors", reportCounts.errors, "error"),
      metric("warnings", "Warnings", reportCounts.warnings, "warning"),
      metric("notes", "Notes", reportCounts.info, "info"),
      metric("checks_passed", "Checks passed", passedChecks, "success"),
    ],
    ...(nextAction ? { next_action: nextAction } : {}),
  };
  const reportFindings: PresentableFinding[] = [
    ...validationFindings(htmlMessages),
    ...cssMessages.map((message) => ({
      severity: "error" as const,
      message: message.message,
      line: message.line || undefined,
      label: "CSS",
    })),
    ...auditFindings(seoResult.issues),
    ...auditFindings(schemaResult.issues),
    ...links.flatMap<PresentableFinding>((link): PresentableFinding[] => {
      if (!link.ok) {
        return [{
          severity: "error" as const,
          message: `${link.url} — ${link.message ?? `returned status ${link.status}`}`,
          label: "Link",
        }];
      }
      if (typeof link.status === "number" && link.status >= 300 && link.status < 400) {
        return [{
          severity: "warning" as const,
          message: `${link.url} returned redirect status ${link.status}.`,
          label: "Link",
        }];
      }
      return [];
    }),
  ];
  const error = failureDetails.length > 0 ? `${failureDetails.join("; ")}.` : undefined;
  const structuredContent = {
    html_errors: htmlCounts.errors,
    css_errors: cssResult.status === "fulfilled" ? cssMessages.length : 0,
    seo_issues: seoResult.total,
    schema_issues: schemaResult.total,
    links_checked: linkSummary.checked,
    broken_links: linkSummary.unreachable,
    html_warnings: htmlCounts.warnings,
    html_info: htmlCounts.info,
    html_messages: htmlMessages,
    css_messages: cssMessages,
    seo_findings: seoResult.issues,
    schema_findings: schemaResult.issues,
    links,
    seo_truncated: seoResult.truncated,
    schema_truncated: schemaResult.truncated,
    html_total_messages: htmlValidation.total,
    html_truncated: htmlValidation.truncated,
    schema_blocks_checked: schemaResult.blocksChecked,
    healthy_links: linkSummary.healthy,
    redirects: linkSummary.redirects,
    unreachable_links: linkSummary.unreachable,
    links_requested: checkLinks,
    css_checked: cssChecked,
    failed_checks: failedChecks,
    overview,
    ...(error ? { error } : {}),
  };

  return {
    structuredContent,
    content: contentForOverview(overview, reportFindings),
  };
}

function failedPublicPageAudit(error: string, linksRequested: boolean) {
  const overview = failedOverview(
    "report",
    "Public webpage audit",
    "The public webpage could not be audited.",
    error,
  );
  return {
    structuredContent: {
      html_errors: 0,
      css_errors: 0,
      seo_issues: 0,
      schema_issues: 0,
      links_checked: 0,
      broken_links: 0,
      html_warnings: 0,
      html_info: 0,
      html_messages: [],
      css_messages: [],
      seo_findings: [],
      schema_findings: [],
      links: [],
      seo_truncated: false,
      schema_truncated: false,
      html_total_messages: 0,
      html_truncated: false,
      schema_blocks_checked: 0,
      healthy_links: 0,
      redirects: 0,
      unreachable_links: 0,
      links_requested: linksRequested,
      css_checked: false,
      failed_checks: ["fetch"],
      page_fetched: false,
      overview,
      error,
    },
    content: contentForOverview(overview),
    isError: true,
  };
}

function siteAuditFindings(
  groups: Array<{ severity: "error" | "warning" | "info"; category: string; message: string }>,
): PresentableFinding[] {
  return groups.map((group) => ({
    severity: group.severity,
    label: group.category,
    message: group.message,
  }));
}

function siteAuditOverview(result: Awaited<ReturnType<typeof auditPublicSite>>): ResultOverview {
  const totals = result.pages.reduce(
    (current, page) => ({
      errors: current.errors + page.html_errors + page.seo_errors + page.schema_errors,
      warnings: current.warnings + page.html_warnings + page.seo_warnings + page.schema_warnings,
      notes: current.notes + page.notes,
    }),
    { errors: 0, warnings: 0, notes: 0 },
  );
  const completed = result.pages_audited;
  const hasCoverageGap = result.pages_partial > 0
    || result.pages_failed > 0
    || result.pages_skipped_robots > 0
    || result.truncated;
  const status: ResultOverview["status"] = completed === 0 && result.pages_partial === 0
    ? "failed"
    : hasCoverageGap
      ? "partial"
      : totals.errors > 0 || totals.warnings > 0
        ? "needs_attention"
        : "passed";
  const headline = status === "failed"
    ? "Public site audit could not complete an eligible page audit."
    : status === "partial"
      ? `Public site audit is partial: ${plural(completed, "page")} completed with coverage limits.`
      : totals.errors > 0 || totals.warnings > 0
        ? `Public site audit found ${summarizeSeverities({ errors: totals.errors, warnings: totals.warnings, info: 0 })}.`
        : "Public site audit found no errors or warnings in the completed checks.";
  const scoreDetail = result.audit_health_score === undefined
    ? "No full HTML-and-metadata score was available."
    : `Audit health score: ${result.audit_health_score}/100 across ${result.score_coverage_percent}% of selected pages.`;
  const detail = `Sitemap-first discovery found ${plural(result.pages_discovered, "same-origin candidate page")}; ${plural(result.pages_selected, "page")} were selected. ${scoreDetail} Link checks are intentionally not run by this bounded site tool.`;
  const nextAction = result.next_page_offset !== undefined
    ? `Continue with page_offset ${result.next_page_offset} to audit the next bounded sitemap batch.`
    : totals.errors > 0 || totals.warnings > 0
      ? "Fix the highest-impact grouped findings, then rerun the bounded site audit."
      : result.pages_partial > 0 || result.pages_failed > 0
        ? "Review partial and failed page coverage, then retry the affected batch."
        : undefined;
  return {
    kind: "site",
    status,
    title: "Public site audit",
    headline,
    detail,
    total: totals.errors + totals.warnings + totals.notes,
    shown: result.issue_groups.length,
    truncated: result.truncated || result.issue_groups_truncated,
    counts: [
      metric("pages_audited", "Pages audited", result.pages_audited, "success"),
      metric("pages_partial", "Pages partial", result.pages_partial, "warning"),
      metric("pages_failed", "Pages failed", result.pages_failed, "error"),
      metric("errors", "Errors", totals.errors, "error"),
      metric("warnings", "Warnings", totals.warnings, "warning"),
      ...(result.audit_health_score === undefined
        ? []
        : [metric("audit_health_score", "Audit health score", result.audit_health_score, "success")]),
    ],
    ...(nextAction ? { next_action: nextAction } : {}),
  };
}

function failedPublicSiteAudit(error: string) {
  const overview = failedOverview(
    "site",
    "Public site audit",
    "The public site could not be audited.",
    error,
  );
  return {
    structuredContent: {
      site_url: "",
      discovery: "root_only" as const,
      pages_discovered: 0,
      pages_selected: 0,
      pages_audited: 0,
      pages_partial: 0,
      pages_failed: 0,
      pages_skipped_robots: 0,
      truncated: false,
      score_coverage_percent: 0,
      pages: [],
      issue_groups: [],
      issue_groups_truncated: false,
      overview,
      error,
    },
    content: contentForOverview(overview),
    isError: true,
  };
}

function createServer(env: Env, siteAuditRateLimitKey: string) {
  const server = new McpServer(
    { name: "web-validator-by-digestseo", version: SERVER_VERSION },
    {
      instructions:
        "Use this app only for markup and public webpages the user owns or is authorized to inspect. For one live public page, use audit_public_webpage. For a bounded sitemap-first public-site audit, use audit_public_site; it audits at most eight same-origin pages per call, respects robots.txt, does not recursively follow HTML links, and never runs site-wide link checks. For pasted markup, use the focused markup tools or generate_validation_report. No tool modifies user data. HTML validation sends markup to the Nu HTML Checker hosted at validator.nu; CSS syntax, SEO, and JSON-LD checks run inside the Worker. Link checking is optional only on the focused markup/page tools, contacts eligible public links, and never follows redirects. Do not submit credentials, health data, payment data, or other sensitive personal data.",
    },
  );

  registerAppResource(server, "web-validator-results", WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: WIDGET_HTML,
        _meta: {
          ui: {
            prefersBorder: true,
            domain: "https://web-validator-mcp.digestseo.com",
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
          "openai/widgetDescription":
            "Shows a markup, public-webpage, or bounded public-site audit's status, key counts, highest-priority next step, and expandable validation findings.",
        },
      },
    ],
  }));

  registerAppTool(
    server,
    "validate_html",
    {
      title: "Validate HTML",
      description:
        "Use this when raw HTML markup is supplied. Sends that markup to the Nu HTML Checker hosted at validator.nu and returns validation messages. For a live URL, use audit_public_webpage.",
      inputSchema: { html: htmlInput },
      outputSchema: {
        messages: z.array(validationMessageSchema),
        total_messages: z.number().int().nonnegative(),
        truncated: z.boolean(),
        overview: overviewSchema,
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Validating HTML…", invoked: "HTML validation complete." }),
    },
    async ({ html }) => {
      try {
        const result = await validateHtmlDetailed(html);
        const messages = result.messages;
        const counts = {
          errors: result.counts.error,
          warnings: result.counts.warning,
          info: result.counts.info,
        };
        const needsAttention = counts.errors > 0 || counts.warnings > 0;
        const nextAction = reportNextAction(counts.errors, counts.warnings, "run HTML validation again");
        const headline = needsAttention
          ? `HTML needs attention: ${summarizeSeverities({ ...counts, info: 0 })}.`
          : counts.info > 0
            ? `HTML passes with no errors or warnings. ${plural(counts.info, "informational note")} returned.`
            : "HTML passes validation with no errors or warnings.";
        const overview: ResultOverview = {
          kind: "html",
          status: needsAttention ? "needs_attention" : "passed",
          title: "HTML validation",
          headline,
          detail: result.total === 0
            ? "The Nu HTML Checker returned no diagnostics."
            : `${plural(result.total, "diagnostic")} returned${result.truncated ? `; showing the first ${messages.length}` : ""}.`,
          total: result.total,
          shown: messages.length,
          truncated: result.truncated,
          counts: [
            metric("errors", "Errors", counts.errors, "error"),
            metric("warnings", "Warnings", counts.warnings, "warning"),
            metric("notes", "Notes", counts.info, "info"),
          ],
          ...(nextAction ? { next_action: nextAction } : {}),
        };
        return {
          structuredContent: {
            messages,
            total_messages: result.total,
            truncated: result.truncated,
            overview,
          },
          content: contentForOverview(overview, validationFindings(messages)),
        };
    } catch (cause) {
      console.error(
        "W3C HTML validation failed:",
        cause instanceof Error ? cause.message : "Unknown upstream error",
      );
      const error = "HTML validation is temporarily unavailable. Please try again shortly.";
      const overview = failedOverview("html", "HTML validation", "HTML validation could not be completed.", error);
      return {
        structuredContent: { messages: [], total_messages: 0, truncated: false, overview, error },
        content: contentForOverview(overview),
        isError: true,
      };
    }
    },
  );

  registerAppTool(
    server,
    "validate_css",
    {
      title: "Validate CSS",
      description:
        "Use this when raw CSS source is supplied. Parses it inside the Worker and returns syntax messages without contacting an external service.",
      inputSchema: { css: cssInput },
      outputSchema: {
        errors: z.array(cssMessageSchema),
        overview: overviewSchema,
        error: z.string().optional(),
      },
      annotations: localReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Validating CSS…", invoked: "CSS validation complete." }),
    },
    async ({ css }) => {
      try {
        const errors = await validateCss(css);
        const needsAttention = errors.length > 0;
        const headline = needsAttention
          ? `CSS needs attention: ${plural(errors.length, "syntax error")}.`
          : "CSS parses successfully with no syntax errors.";
        const overview: ResultOverview = {
          kind: "css",
          status: needsAttention ? "needs_attention" : "passed",
          title: "CSS validation",
          headline,
          detail: needsAttention
            ? "The local parser stopped at the first invalid syntax it encountered."
            : "The local syntax parser completed without contacting an external service.",
          total: errors.length,
          shown: errors.length,
          truncated: false,
          counts: [metric("syntax_errors", "Syntax errors", errors.length, "error")],
          ...(needsAttention ? { next_action: "Correct the syntax error, then run CSS validation again." } : {}),
        };
        return {
          structuredContent: { errors, overview },
          content: contentForOverview(
            overview,
            errors.map((message) => ({
              severity: "error" as const,
              message: message.message,
              line: message.line || undefined,
            })),
          ),
        };
    } catch (cause) {
      console.error("Local CSS validation failed:", cause instanceof Error ? cause.message : "Unknown error");
      const error = "CSS validation is temporarily unavailable. Please try again shortly.";
      const overview = failedOverview("css", "CSS validation", "CSS validation could not be completed.", error);
      return {
        structuredContent: { errors: [], overview, error },
        content: contentForOverview(overview),
        isError: true,
      };
    }
    },
  );

  registerAppTool(
    server,
    "audit_seo_metadata",
    {
      title: "Audit SEO metadata",
      description:
        "Use this for a focused SEO/accessibility-signal check of supplied HTML. It does not fetch a live webpage; use audit_public_webpage for a URL.",
      inputSchema: { html: htmlInput },
      outputSchema: auditResultSchema,
      annotations: localReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Auditing SEO metadata…", invoked: "SEO audit complete." }),
    },
    async ({ html }) => {
      try {
        const result = auditSeoMetadata(html);
        const counts = {
          errors: result.counts.error,
          warnings: result.counts.warning,
          info: result.counts.info,
        };
        const needsAttention = counts.errors > 0 || counts.warnings > 0;
        const nextAction = reportNextAction(counts.errors, counts.warnings, "run the SEO audit again");
        const headline = needsAttention
          ? `SEO audit found ${summarizeSeverities(counts)}.`
          : result.total > 0
            ? `SEO metadata and accessibility checks passed with ${plural(counts.info, "informational note")}.`
            : "SEO metadata and accessibility checks passed with no actionable issues.";
        const overview: ResultOverview = {
          kind: "seo",
          status: needsAttention ? "needs_attention" : "passed",
          title: "SEO metadata audit",
          headline,
          detail: result.truncated
            ? `${plural(result.total, "finding")} identified; showing the first ${result.issues.length}.`
            : `${plural(result.total, "finding")} identified across SEO and accessibility checks.`,
          total: result.total,
          shown: result.issues.length,
          truncated: result.truncated,
          counts: [
            metric("errors", "Errors", counts.errors, "error"),
            metric("warnings", "Warnings", counts.warnings, "warning"),
            metric("notes", "Notes", counts.info, "info"),
          ],
          ...(nextAction ? { next_action: nextAction } : {}),
        };
        return {
          structuredContent: {
            issues: result.issues,
            total_issues: result.total,
            truncated: result.truncated,
            overview,
          },
          content: contentForOverview(overview, auditFindings(result.issues)),
        };
      } catch (cause) {
        console.error("Local SEO audit failed:", cause instanceof Error ? cause.message : "Unknown error");
        const error = "The SEO metadata audit could not be completed. Please try again shortly.";
        const overview = failedOverview("seo", "SEO metadata audit", "SEO audit could not be completed.", error);
        return {
          structuredContent: { issues: [], total_issues: 0, truncated: false, overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "validate_schema_markup",
    {
      title: "Validate JSON-LD syntax",
      description: "Use this for a focused JSON-LD syntax check of supplied HTML. It parses JSON only and does not validate Schema.org vocabulary semantics.",
      inputSchema: { html: htmlInput },
      outputSchema: { ...auditResultSchema, blocks_checked: z.number().int().nonnegative() },
      annotations: localReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Checking JSON-LD…", invoked: "JSON-LD check complete." }),
    },
    async ({ html }) => {
      try {
        const result = validateSchemaMarkup(html);
        const counts = {
          errors: result.counts.error,
          warnings: result.counts.warning,
          info: result.counts.info,
        };
        const needsAttention = counts.errors > 0 || counts.warnings > 0;
        const noBlocks = result.blocksChecked === 0;
        const headline = noBlocks
          ? "No JSON-LD blocks were found in the supplied HTML."
          : needsAttention
            ? `JSON-LD syntax check found ${summarizeSeverities(counts)} in ${plural(result.blocksChecked, "block")}.`
            : result.blocksChecked === 1
              ? "The JSON-LD block contains valid JSON syntax."
              : `All ${result.blocksChecked} JSON-LD blocks contain valid JSON syntax.`;
        const overview: ResultOverview = {
          kind: "schema",
          status: noBlocks ? "not_applicable" : needsAttention ? "needs_attention" : "passed",
          title: "JSON-LD syntax check",
          headline,
          detail: result.truncated
            ? `${plural(result.total, "finding")} identified; showing the first ${result.issues.length}. This check validates JSON syntax only.`
            : "This check validates JSON syntax only; it does not validate schema.org vocabulary or eligibility.",
          total: result.total,
          shown: result.issues.length,
          truncated: result.truncated,
          counts: [
            metric(
              "valid_blocks",
              "Valid blocks",
              Math.max(0, result.blocksChecked - counts.errors - counts.warnings),
              "success",
            ),
            metric("errors", "Errors", counts.errors, "error"),
            metric("warnings", "Warnings", counts.warnings, "warning"),
          ],
          ...(needsAttention ? { next_action: "Correct invalid or empty JSON-LD blocks, then run the syntax check again." } : {}),
        };
        return {
          structuredContent: {
            issues: result.issues,
            total_issues: result.total,
            truncated: result.truncated,
            blocks_checked: result.blocksChecked,
            overview,
          },
          content: contentForOverview(overview, auditFindings(result.issues)),
        };
      } catch (cause) {
        console.error("Local JSON-LD check failed:", cause instanceof Error ? cause.message : "Unknown error");
        const error = "The JSON-LD syntax check could not be completed. Please try again shortly.";
        const overview = failedOverview("schema", "JSON-LD syntax check", "JSON-LD check could not be completed.", error);
        return {
          structuredContent: {
            issues: [],
            total_issues: 0,
            truncated: false,
            blocks_checked: 0,
            overview,
            error,
          },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "check_broken_links",
    {
      title: "Check public links",
      description:
        `Use this for a focused check of up to ${HOSTED_MAX_LINKS} public HTTP(S) links found in supplied HTML. It does not fetch base_url, follow redirects, or retain response bodies.`,
      inputSchema: {
        html: htmlInput,
        base_url: z
          .string()
          .url()
          .optional()
          .describe("Only resolves relative links; it does not fetch this webpage."),
        max_links: z
          .number()
          .int()
          .min(1)
          .max(HOSTED_MAX_LINKS)
          .default(15)
          .describe(`Maximum links to check, from 1 to ${HOSTED_MAX_LINKS}.`),
      },
      outputSchema: {
        links: z.array(linkStatusSchema),
        links_checked: z.number().int().nonnegative(),
        healthy_links: z.number().int().nonnegative(),
        redirects: z.number().int().nonnegative(),
        unreachable_links: z.number().int().nonnegative(),
        overview: overviewSchema,
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Checking public links…", invoked: "Link check complete." }),
    },
    async ({ html, base_url, max_links }) => {
      try {
        const links = await checkBrokenLinks(html, base_url, max_links);
        const counts = linkCounts(links);
        const needsAttention = counts.redirects > 0 || counts.unreachable > 0;
        const headline = counts.checked === 0
          ? "No eligible public HTTP(S) links were found to check."
          : `Checked ${plural(counts.checked, "link")}: ${plural(counts.healthy, "healthy link")}, ${plural(counts.redirects, "redirect")}, and ${plural(counts.unreachable, "unreachable link")}.`;
        const overview: ResultOverview = {
          kind: "links",
          status: counts.checked === 0 ? "not_applicable" : needsAttention ? "needs_attention" : "passed",
          title: "Public link check",
          headline,
          detail: counts.checked === 0
            ? "Only eligible public HTTP(S) links are checked; fragments and non-web links are skipped."
            : "Redirects are reported but not followed, and response bodies are not downloaded.",
          total: counts.checked,
          shown: links.length,
          truncated: false,
          counts: [
            metric("checked", "Checked", counts.checked, "info"),
            metric("healthy", "Healthy", counts.healthy, "success"),
            metric("redirects", "Redirects", counts.redirects, "warning"),
            metric("unreachable", "Unreachable", counts.unreachable, "error"),
          ],
          ...(needsAttention
            ? { next_action: counts.unreachable > 0
              ? "Fix unreachable links first, then confirm that each redirect is intentional."
              : "Confirm that each redirect is intentional and points to the preferred destination." }
            : {}),
        };
        const findings = links.flatMap<PresentableFinding>((link): PresentableFinding[] => {
          if (!link.ok) {
            return [{
              severity: "error" as const,
              message: `${link.url} — ${link.message ?? `returned status ${link.status}`}`,
              label: String(link.status),
            }];
          }
          if (typeof link.status === "number" && link.status >= 300 && link.status < 400) {
            return [{
              severity: "warning" as const,
              message: `${link.url} returned redirect status ${link.status}; the redirect was not followed.`,
              label: String(link.status),
            }];
          }
          return [];
        });
        return {
          structuredContent: {
            links,
            links_checked: counts.checked,
            healthy_links: counts.healthy,
            redirects: counts.redirects,
            unreachable_links: counts.unreachable,
            overview,
          },
          content: contentForOverview(overview, findings),
        };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : "Link checking could not be completed.";
        const overview = failedOverview("links", "Public link check", "Link checking could not be completed.", error);
        return {
          structuredContent: {
            links: [],
            links_checked: 0,
            healthy_links: 0,
            redirects: 0,
            unreachable_links: 0,
            overview,
            error,
          },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "generate_validation_report",
    {
      title: "Generate validation report",
      description:
        "Use this when HTML markup is already supplied. Combines Nu HTML validation with local CSS, SEO, accessibility-signal, and JSON-LD syntax checks. It does not fetch a webpage from base_url; use audit_public_webpage for a live URL.",
      inputSchema: {
        html: htmlInput,
        css: z
          .string()
          .max(CSS_MAX_LENGTH)
          .optional()
          .describe("Optional raw CSS source. Linked stylesheets are not fetched."),
        check_links: z
          .boolean()
          .default(false)
          .describe("Whether to contact eligible public links found in the supplied HTML."),
        base_url: z
          .string()
          .url()
          .optional()
          .describe("Only resolves relative links when check_links is true; it does not fetch this webpage."),
        max_links: z
          .number()
          .int()
          .min(1)
          .max(HOSTED_MAX_LINKS)
          .default(15)
          .describe(`Maximum links to check, from 1 to ${HOSTED_MAX_LINKS}.`),
      },
      outputSchema: reportOutputSchema,
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Generating validation report…", invoked: "Validation report complete." }),
    },
    async ({ html, css, check_links, base_url, max_links }) => runValidationReport({
      html,
      css,
      checkLinks: check_links,
      baseUrl: base_url,
      maxLinks: max_links,
      title: "Validation report",
    }),
  );

  registerAppTool(
    server,
    "audit_public_webpage",
    {
      title: "Audit public webpage",
      description:
        "Use this when the user provides one live public webpage URL. Fetches one bounded static HTML response, then runs HTML validation, SEO/accessibility-signal, and JSON-LD syntax checks. It checks links only when requested and does not crawl, execute JavaScript, authenticate, or fetch linked stylesheets. Use only URLs the user owns or is authorized to inspect.",
      inputSchema: {
        url: publicPageUrlInput,
        check_links: z
          .boolean()
          .default(false)
          .describe("Whether to contact eligible public links found on the fetched page."),
        max_links: z
          .number()
          .int()
          .min(1)
          .max(HOSTED_MAX_LINKS)
          .default(15)
          .describe(`Maximum links to check, from 1 to ${HOSTED_MAX_LINKS}.`),
      },
      outputSchema: {
        ...reportOutputSchema,
        requested_url: z.string().optional(),
        fetched_url: z.string().optional(),
        redirects_followed: z.number().int().min(0).max(3).optional(),
        http_status: z.number().int().min(200).max(299).optional(),
        content_type: z.literal("text/html").optional(),
        page_fetched: z.boolean(),
      },
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({
        invoking: "Fetching and auditing webpage…",
        invoked: "Public webpage audit complete.",
      }),
    },
    async ({ url, check_links, max_links }) => {
      try {
        const fetched = await fetchPublicHtml(url);
        const report = await runValidationReport({
          html: fetched.html,
          checkLinks: check_links,
          baseUrl: fetched.finalUrl,
          maxLinks: max_links,
          title: "Public webpage audit",
          sourceDetail: fetched.redirectsFollowed > 0
            ? `Audited ${fetched.finalUrl} after ${plural(fetched.redirectsFollowed, "redirect")}.`
            : `Audited ${fetched.finalUrl}.`,
        });
        return {
          ...report,
          structuredContent: {
            ...report.structuredContent,
            requested_url: fetched.requestedUrl,
            fetched_url: fetched.finalUrl,
            redirects_followed: fetched.redirectsFollowed,
            http_status: fetched.status,
            content_type: fetched.contentType,
            page_fetched: true,
          },
        };
      } catch (cause) {
        const code = cause instanceof PublicHtmlFetchError ? cause.code : "audit_failed";
        console.error(JSON.stringify({ event: "public_webpage_audit_failed", code }));
        const error = cause instanceof PublicHtmlFetchError
          ? cause.message
          : "The public webpage audit could not be completed. Please try again shortly.";
        return failedPublicPageAudit(error, check_links);
      }
    },
  );

  registerAppTool(
    server,
    "audit_public_site",
    {
      title: "Audit public site",
      description:
        `Use this for a bounded, sitemap-first audit of a public website the user owns or is authorized to inspect. It fetches at most ${SITE_AUDIT_MAX_PAGES} same-origin HTML pages per call, respects robots.txt, and returns compact page summaries plus deduplicated findings. It does not recursively follow HTML links, authenticate, execute JavaScript, fetch assets, or run site-wide link checks. Use page_offset to continue when more sitemap pages remain.`,
      inputSchema: {
        site_url: publicPageUrlInput.describe("Authorized public website URL. The final public origin becomes the crawl boundary."),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(SITE_AUDIT_MAX_PAGES)
          .default(SITE_AUDIT_DEFAULT_MAX_PAGES)
          .describe(`Maximum same-origin pages to audit in this call, from 1 to ${SITE_AUDIT_MAX_PAGES}.`),
        page_offset: z
          .number()
          .int()
          .min(0)
          .max(SITE_AUDIT_MAX_SITEMAP_URLS)
          .default(0)
          .describe("Zero-based sitemap-page offset for continuing a capped audit batch."),
      },
      outputSchema: siteAuditOutputSchema,
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({
        invoking: "Discovering and auditing public sitemap pages…",
        invoked: "Public site audit complete.",
      }),
    },
    async ({ site_url, max_pages, page_offset }) => {
      try {
        const rateLimit = await env.SITE_AUDIT_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
        if (!rateLimit.success) {
          return failedPublicSiteAudit("Site audits are temporarily rate limited. Please retry shortly.");
        }
      } catch {
        return failedPublicSiteAudit("Site auditing is temporarily unavailable. Please retry shortly.");
      }

      try {
        const result = await auditPublicSite({
          siteUrl: site_url,
          maxPages: max_pages,
          pageOffset: page_offset,
        });
        const overview = siteAuditOverview(result);
        return {
          structuredContent: { ...result, overview },
          content: contentForOverview(overview, siteAuditFindings(result.issue_groups)),
        };
      } catch (cause) {
        const error = cause instanceof PublicHtmlFetchError
          ? cause.message
          : "The public site audit could not be completed. Please try again shortly.";
        console.error(JSON.stringify({
          event: "public_site_audit_failed",
          code: cause instanceof PublicHtmlFetchError ? cause.code : "audit_failed",
        }));
        return failedPublicSiteAudit(error);
      }
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("Web Validator by DigestSEO MCP server. Connect with streamable HTTP at /mcp.\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (url.pathname === "/.well-known/glama.json") {
      return Response.json(GLAMA_CONNECTOR_METADATA);
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not found\n", { status: 404 });
    }

    const startedAt = Date.now();
    const origin = request.headers.get("origin") ?? undefined;
    try {
      if (origin && !TRUSTED_BROWSER_ORIGINS.has(origin)) {
        logRequest("mcp_request_rejected", {
          reason: "untrusted_origin",
          method: request.method,
          status: 403,
        });
        return jsonRpcHttpError(403, "Forbidden: untrusted Origin header.");
      }

      const siteAuditRateLimitKey = request.method === "OPTIONS" ? "options" : await rateLimitKey(request);
      if (request.method !== "OPTIONS") {
        const { success } = await env.MCP_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
        if (!success) {
          logRequest("mcp_request_rejected", {
            reason: "rate_limited",
            method: request.method,
            status: 429,
          });
          return jsonRpcHttpError(429, "Too many requests. Please retry shortly.", origin, {
            "retry-after": "60",
          });
        }
      }

      if (await requestBodyExceedsLimit(request)) {
        logRequest("mcp_request_rejected", {
          reason: "body_too_large",
          method: request.method,
          status: 413,
        });
        return jsonRpcHttpError(413, "MCP request body exceeds the 2 MiB limit.", origin);
      }

      const handler = createMcpHandler(createServer(env, siteAuditRateLimitKey), {
        corsOptions: {
          origin: origin ?? "https://chatgpt.com",
          headers:
            "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Mcp-Method, Mcp-Name",
          methods: "GET, POST, DELETE, OPTIONS",
          exposeHeaders: "Mcp-Session-Id",
          maxAge: 86400,
        },
      });
      const response = withExactCors(await handler(request, env, ctx), origin);
      logRequest("mcp_request", {
        method: request.method,
        status: response.status,
        duration_ms: Date.now() - startedAt,
        browser_origin: Boolean(origin),
      });
      return response;
    } catch (cause) {
      console.error(JSON.stringify({
        event: "mcp_request_failed",
        method: request.method,
        duration_ms: Date.now() - startedAt,
        error_type: cause instanceof Error ? cause.name : "UnknownError",
      }));
      const corsOrigin = origin && TRUSTED_BROWSER_ORIGINS.has(origin) ? origin : undefined;
      return jsonRpcHttpError(500, "The MCP request could not be completed.", corsOrigin);
    }
  },
} satisfies ExportedHandler<Env>;
