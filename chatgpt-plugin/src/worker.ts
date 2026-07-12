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
  contentForOverview,
  overviewSchema,
  plural,
  type OverviewMetric,
  type PresentableFinding,
  type ResultOverview,
} from "./presentation";
import { validateCss, validateHtmlDetailed } from "./validators";
import { WIDGET_HTML, WIDGET_URI } from "./widget";

const HTML_MAX_LENGTH = 200_000;
const CSS_MAX_LENGTH = 200_000;
const MCP_BODY_MAX_BYTES = 2 * 1024 * 1024;
const SERVER_VERSION = "0.3.0";
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

const htmlInput = z.string().min(1).max(HTML_MAX_LENGTH);
const cssInput = z.string().min(1).max(CSS_MAX_LENGTH);
const externalReadOnlyAnnotations = {
  // These tools send the supplied markup or URLs to services outside ChatGPT.
  // They never modify user data, but ChatGPT should ask for approval first.
  readOnlyHint: false,
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
  const actor = sessionId
    ? `session:${sessionId.slice(0, 128)}`
    : ip
      ? `ip:${ip}`
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
    next_action: "Try again shortly. If the problem continues, run the other local checks separately.",
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

function createServer() {
  const server = new McpServer(
    { name: "web-validator-by-digestseo", version: SERVER_VERSION },
    {
      instructions:
        "Use this app only for markup the user owns or is authorized to share. No tool modifies user data. HTML validation sends supplied markup to the Nu HTML Checker hosted at validator.nu; CSS syntax, SEO, and JSON-LD checks run locally. Link checking contacts public links in supplied markup, never follows redirects, and must only be used for URLs the user is authorized to inspect. Do not submit credentials, health data, payment data, or other sensitive personal data.",
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
            "Shows the completed check's status, key counts, highest-priority next step, and expandable validation findings.",
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
        "Sends supplied HTML markup to the Nu HTML Checker hosted at validator.nu and returns validation messages. Use only markup you are authorized to share.",
      inputSchema: { html: htmlInput },
      outputSchema: {
        errors: z.array(validationMessageSchema),
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
        const errors = result.messages;
        const counts = {
          errors: result.counts.error,
          warnings: result.counts.warning,
          info: result.counts.info,
        };
        const needsAttention = counts.errors > 0 || counts.warnings > 0;
        const headline = needsAttention
          ? `HTML needs attention: ${plural(counts.errors, "error")} and ${plural(counts.warnings, "warning")}.`
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
            : `${plural(result.total, "diagnostic")} returned${result.truncated ? `; showing the first ${errors.length}` : ""}.`,
          total: result.total,
          shown: errors.length,
          truncated: result.truncated,
          counts: [
            metric("errors", "Errors", counts.errors, "error"),
            metric("warnings", "Warnings", counts.warnings, "warning"),
            metric("notes", "Notes", counts.info, "info"),
          ],
          ...(needsAttention
            ? { next_action: "Fix errors first, review warnings, then run HTML validation again." }
            : {}),
        };
        return {
          structuredContent: {
            errors,
            total_messages: result.total,
            truncated: result.truncated,
            overview,
          },
          content: contentForOverview(overview, validationFindings(errors)),
        };
    } catch (cause) {
      console.error(
        "W3C HTML validation failed:",
        cause instanceof Error ? cause.message : "Unknown upstream error",
      );
      const error = "HTML validation is temporarily unavailable. Please try again shortly.";
      const overview = failedOverview("html", "HTML validation", "HTML validation could not be completed.", error);
      return {
        structuredContent: { errors: [], total_messages: 0, truncated: false, overview, error },
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
        "Parses supplied CSS locally and returns syntax messages without contacting an external service.",
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
        "Analyzes supplied HTML locally for title, description, canonical, viewport, heading, image-alt, and Open Graph issues.",
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
          ...(needsAttention
            ? { next_action: "Resolve SEO and accessibility errors first, then review the warnings." }
            : {}),
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
      title: "Validate JSON-LD schema",
      description: "Parses JSON-LD blocks in supplied HTML and reports JSON syntax problems without contacting external services.",
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
        "Checks up to 25 public HTTP(S) links found in supplied HTML. It does not follow redirects or fetch response bodies. Use only URLs you are authorized to inspect.",
      inputSchema: {
        html: htmlInput,
        base_url: z.string().url().optional(),
        max_links: z.number().int().min(1).max(25).default(15),
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
        "Combines validator.nu HTML validation with local CSS, SEO, and JSON-LD checks for supplied markup. Optionally checks public links when the user has authorized those requests.",
      inputSchema: {
        html: htmlInput,
        css: z.string().max(CSS_MAX_LENGTH).optional(),
        check_links: z.boolean().default(false),
        base_url: z.string().url().optional(),
        max_links: z.number().int().min(1).max(25).default(15),
      },
      outputSchema: {
        html_errors: z.number(),
        css_errors: z.number(),
        seo_issues: z.number(),
        schema_issues: z.number(),
        links_checked: z.number(),
        broken_links: z.number(),
        html_warnings: z.number(),
        html_info: z.number(),
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
        failed_checks: z.array(z.enum(["html", "css", "links"])),
        overview: overviewSchema,
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Generating validation report…", invoked: "Validation report complete." }),
    },
    async ({ html, css, check_links, base_url, max_links }) => {
      const [htmlResult, cssResult] = await Promise.allSettled([
        validateHtmlDetailed(html),
        css ? validateCss(css) : Promise.resolve([]),
      ]);
      const seoResult = auditSeoMetadata(html);
      const schemaResult = validateSchemaMarkup(html);
      let links: Awaited<ReturnType<typeof checkBrokenLinks>> = [];
      const failedChecks: Array<"html" | "css" | "links"> = [];
      const failureDetails: string[] = [];

      if (htmlResult.status === "rejected") {
        failedChecks.push("html");
        failureDetails.push("HTML validation was unavailable");
      }
      if (cssResult.status === "rejected") {
        failedChecks.push("css");
        failureDetails.push("CSS validation was unavailable");
      }
      if (check_links) {
        try {
          links = await checkBrokenLinks(html, base_url, max_links);
        } catch (cause) {
          failedChecks.push("links");
          failureDetails.push(cause instanceof Error ? cause.message : "Link checking could not be completed");
        }
      }

      const htmlValidation = htmlResult.status === "fulfilled"
        ? htmlResult.value
        : { messages: [], total: 0, truncated: false, counts: { error: 0, warning: 0, info: 0 } };
      const htmlMessages = htmlValidation.messages;
      const cssMessages = cssResult.status === "fulfilled" ? cssResult.value : [];
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
        Boolean(css) && cssResult.status === "fulfilled" && cssMessages.length === 0,
        seoCounts.errors === 0 && seoCounts.warnings === 0,
        schemaResult.blocksChecked > 0 && schemaCounts.errors === 0 && schemaCounts.warnings === 0,
        check_links && linkSummary.checked > 0 && linkSummary.redirects === 0 && linkSummary.unreachable === 0,
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
      const linksDetail = check_links
        ? failedChecks.includes("links")
          ? "Link checking did not complete."
          : `${plural(linkSummary.checked, "link")} checked.`
        : "Links were not requested.";
      const overview: ResultOverview = {
        kind: "report",
        status: hasFailures ? "partial" : needsAttention ? "needs_attention" : "passed",
        title: "Validation report",
        headline: hasFailures
          ? `Validation report is partial: ${plural(failedChecks.length, "check")} could not complete.`
          : needsAttention
            ? `Validation report is ready: ${plural(reportCounts.errors, "error")} and ${plural(reportCounts.warnings, "warning")} need attention.`
            : "Validation report is clear: no errors or warnings were found.",
        detail: `Completed checks found ${summarizeSeverities(reportCounts)}. ${linksDetail}`,
        total: totalFindings,
        shown: shownFindings,
        truncated,
        counts: [
          metric("errors", "Errors", reportCounts.errors, "error"),
          metric("warnings", "Warnings", reportCounts.warnings, "warning"),
          metric("notes", "Notes", reportCounts.info, "info"),
          metric("checks_passed", "Checks passed", passedChecks, "success"),
        ],
        ...(hasFailures
          ? { next_action: "Review the completed findings, then retry the unavailable checks." }
          : needsAttention
            ? { next_action: "Fix errors first, review warnings, then generate the report again." }
            : {}),
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
      const summary = {
        html_errors: htmlCounts.errors,
        css_errors: cssResult.status === "fulfilled" ? cssResult.value.length : 0,
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
        links_requested: check_links,
        failed_checks: failedChecks,
        overview,
        ...(error ? { error } : {}),
      };
      return {
        structuredContent: summary,
        content: contentForOverview(overview, reportFindings),
      };
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
    if (origin && !TRUSTED_BROWSER_ORIGINS.has(origin)) {
      logRequest("mcp_request_rejected", {
        reason: "untrusted_origin",
        method: request.method,
        status: 403,
      });
      return jsonRpcHttpError(403, "Forbidden: untrusted Origin header.");
    }

    if (request.method !== "OPTIONS") {
      const key = await rateLimitKey(request);
      const { success } = await env.MCP_RATE_LIMITER.limit({ key });
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

    const handler = createMcpHandler(createServer(), {
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
  },
} satisfies ExportedHandler<Env>;
