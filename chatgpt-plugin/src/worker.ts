import { createMcpHandler } from "agents/mcp";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditSeoMetadata, checkBrokenLinks, validateSchemaMarkup } from "./audits";
import { validateCss, validateHtml } from "./validators";
import { WIDGET_HTML, WIDGET_URI } from "./widget";

const HTML_MAX_LENGTH = 200_000;
const CSS_MAX_LENGTH = 200_000;
const MCP_BODY_MAX_BYTES = 2 * 1024 * 1024;
const SERVER_VERSION = "0.2.0";
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

function countValidationMessages(messages: Array<{ type: "error" | "warning" | "info" }>) {
  return {
    errors: messages.filter((message) => message.type === "error").length,
    warnings: messages.filter((message) => message.type === "warning").length,
    info: messages.filter((message) => message.type === "info").length,
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

function contentForResult(summary: string) {
  return [{ type: "text" as const, text: summary }];
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
            "A read-only validation summary that groups HTML, CSS, SEO, schema, accessibility, and link findings.",
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
      outputSchema: { errors: z.array(validationMessageSchema), error: z.string().optional() },
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Validating HTML…", invoked: "HTML validation complete." }),
    },
    async ({ html }) => {
      try {
        const errors = await validateHtml(html);
        const counts = countValidationMessages(errors);
        return {
          structuredContent: { errors },
          content: contentForResult(
            `HTML validation found ${counts.errors} error(s), ${counts.warnings} warning(s), and ${counts.info} informational message(s).`,
          ),
        };
    } catch (cause) {
      console.error(
        "W3C HTML validation failed:",
        cause instanceof Error ? cause.message : "Unknown upstream error",
      );
      const error = "HTML validation is temporarily unavailable. Please try again shortly.";
      return { structuredContent: { errors: [], error }, content: contentForResult(error), isError: true };
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
      outputSchema: { errors: z.array(cssMessageSchema), error: z.string().optional() },
      annotations: localReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Validating CSS…", invoked: "CSS validation complete." }),
    },
    async ({ css }) => {
      try {
        const errors = await validateCss(css);
        return {
          structuredContent: { errors },
          content: contentForResult(`CSS validation found ${errors.length} message(s).`),
        };
    } catch (cause) {
      console.error("Local CSS validation failed:", cause instanceof Error ? cause.message : "Unknown error");
      const error = "CSS validation is temporarily unavailable. Please try again shortly.";
      return { structuredContent: { errors: [], error }, content: contentForResult(error), isError: true };
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
      const result = auditSeoMetadata(html);
      return {
        structuredContent: {
          issues: result.issues,
          total_issues: result.total,
          truncated: result.truncated,
        },
        content: contentForResult(
          `SEO metadata audit found ${result.total} issue(s)${result.truncated ? "; the first 100 are shown" : ""}.`,
        ),
      };
    },
  );

  registerAppTool(
    server,
    "validate_schema_markup",
    {
      title: "Validate JSON-LD schema",
      description: "Parses JSON-LD blocks in supplied HTML and reports JSON syntax problems without contacting external services.",
      inputSchema: { html: htmlInput },
      outputSchema: auditResultSchema,
      annotations: localReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Checking JSON-LD…", invoked: "JSON-LD check complete." }),
    },
    async ({ html }) => {
      const result = validateSchemaMarkup(html);
      return {
        structuredContent: {
          issues: result.issues,
          total_issues: result.total,
          truncated: result.truncated,
        },
        content: contentForResult(
          `JSON-LD validation found ${result.total} issue(s)${result.truncated ? "; the first 100 are shown" : ""}.`,
        ),
      };
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
      outputSchema: { links: z.array(linkStatusSchema), error: z.string().optional() },
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Checking public links…", invoked: "Link check complete." }),
    },
    async ({ html, base_url, max_links }) => {
      try {
        const links = await checkBrokenLinks(html, base_url, max_links);
        const broken = links.filter((link) => !link.ok).length;
        return {
          structuredContent: { links },
          content: contentForResult(`Checked ${links.length} link(s); ${broken} need attention.`),
        };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : "Link checking could not be completed.";
        return { structuredContent: { links: [], error }, content: contentForResult(error), isError: true };
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
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
      _meta: withWidget({ invoking: "Generating validation report…", invoked: "Validation report complete." }),
    },
    async ({ html, css, check_links, base_url, max_links }) => {
      const [htmlResult, cssResult] = await Promise.allSettled([
        validateHtml(html),
        css ? validateCss(css) : Promise.resolve([]),
      ]);
      const seoResult = auditSeoMetadata(html);
      const schemaResult = validateSchemaMarkup(html);
      let links: Awaited<ReturnType<typeof checkBrokenLinks>> = [];
      let error: string | undefined;

      if (htmlResult.status === "rejected" || cssResult.status === "rejected") {
        error = "One or more validation checks are temporarily unavailable.";
      }
      if (check_links) {
        try {
          links = await checkBrokenLinks(html, base_url, max_links);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : "Link checking could not be completed.";
        }
      }

      const htmlMessages = htmlResult.status === "fulfilled" ? htmlResult.value : [];
      const cssMessages = cssResult.status === "fulfilled" ? cssResult.value : [];
      const htmlCounts = countValidationMessages(htmlMessages);
      const summary = {
        html_errors: htmlCounts.errors,
        css_errors: cssResult.status === "fulfilled" ? cssResult.value.length : 0,
        seo_issues: seoResult.total,
        schema_issues: schemaResult.total,
        links_checked: links.length,
        broken_links: links.filter((link) => !link.ok).length,
        html_warnings: htmlCounts.warnings,
        html_info: htmlCounts.info,
        html_messages: htmlMessages,
        css_messages: cssMessages,
        seo_findings: seoResult.issues,
        schema_findings: schemaResult.issues,
        links,
        seo_truncated: seoResult.truncated,
        schema_truncated: schemaResult.truncated,
        ...(error ? { error } : {}),
      };
      return {
        structuredContent: summary,
        content: contentForResult(
          `Validation report: ${summary.html_errors} HTML error(s), ${summary.css_errors} CSS error(s), ${summary.seo_issues} SEO/accessibility issue(s), ${summary.schema_issues} schema issue(s), and ${summary.broken_links} broken link(s).`,
        ),
        ...(error ? { isError: true } : {}),
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
