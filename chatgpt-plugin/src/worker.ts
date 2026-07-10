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

export interface Env {}

const HTML_MAX_LENGTH = 200_000;
// Jigsaw's public text-validation API accepts the stylesheet as a query parameter.
// Keep the encoded URL comfortably below common intermediary limits.
const CSS_MAX_LENGTH = 12_000;

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

const linkStatusSchema = z.object({
  url: z.string(),
  status: z.union([z.number(), z.enum(["blocked", "failed"])]),
  ok: z.boolean(),
  message: z.string().optional(),
});

const htmlInput = z.string().min(1).max(HTML_MAX_LENGTH);
const cssInput = z.string().min(1).max(CSS_MAX_LENGTH);
const annotations = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
} as const;

function withWidget(statusText: { invoking: string; invoked: string }) {
  return {
    ui: { resourceUri: WIDGET_URI },
    "openai/toolInvocation/invoking": statusText.invoking,
    "openai/toolInvocation/invoked": statusText.invoked,
  };
}

function contentForResult(summary: string) {
  return [{ type: "text" as const, text: summary }];
}

function createServer() {
  const server = new McpServer(
    { name: "web-validator-by-digestseo", version: "0.1.0" },
    {
      instructions:
        "Use this app only for markup the user owns or is authorized to share. All tools are read-only. HTML and CSS validation send the supplied content to W3C validator endpoints. Link checking contacts public links in supplied markup, never follows redirects, and must only be used for URLs the user is authorized to inspect. Do not submit credentials, health data, payment data, or other sensitive personal data.",
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
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
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
        "Sends supplied HTML markup to the W3C Nu HTML Checker and returns validation messages. Use only markup you are authorized to share.",
      inputSchema: { html: htmlInput },
      outputSchema: { errors: z.array(validationMessageSchema), error: z.string().optional() },
      annotations,
      _meta: withWidget({ invoking: "Validating HTML…", invoked: "HTML validation complete." }),
    },
    async ({ html }) => {
      try {
        const errors = await validateHtml(html);
        return {
          structuredContent: { errors },
          content: contentForResult(`HTML validation found ${errors.length} message(s).`),
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
        "Sends supplied CSS to the W3C Jigsaw CSS Validator and returns syntax messages. Use only stylesheets you are authorized to share.",
      inputSchema: { css: cssInput },
      outputSchema: { errors: z.array(cssMessageSchema), error: z.string().optional() },
      annotations,
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
      console.error(
        "W3C CSS validation failed:",
        cause instanceof Error ? cause.message : "Unknown upstream error",
      );
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
      outputSchema: { issues: z.array(auditIssueSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: withWidget({ invoking: "Auditing SEO metadata…", invoked: "SEO audit complete." }),
    },
    async ({ html }) => {
      const issues = auditSeoMetadata(html);
      return {
        structuredContent: { issues },
        content: contentForResult(`SEO metadata audit found ${issues.length} issue(s).`),
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
      outputSchema: { issues: z.array(auditIssueSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: withWidget({ invoking: "Checking JSON-LD…", invoked: "JSON-LD check complete." }),
    },
    async ({ html }) => {
      const issues = validateSchemaMarkup(html);
      return {
        structuredContent: { issues },
        content: contentForResult(`JSON-LD validation found ${issues.length} issue(s).`),
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
      annotations,
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
        "Combines W3C HTML/CSS validation with local SEO and JSON-LD checks for supplied markup. Optionally checks public links when the user has authorized those requests.",
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
        error: z.string().optional(),
      },
      annotations,
      _meta: withWidget({ invoking: "Generating validation report…", invoked: "Validation report complete." }),
    },
    async ({ html, css, check_links, base_url, max_links }) => {
      const [htmlResult, cssResult] = await Promise.allSettled([
        validateHtml(html),
        css ? validateCss(css) : Promise.resolve([]),
      ]);
      const seoIssues = auditSeoMetadata(html);
      const schemaIssues = validateSchemaMarkup(html);
      let links: Awaited<ReturnType<typeof checkBrokenLinks>> = [];
      let error: string | undefined;

      if (htmlResult.status === "rejected" || cssResult.status === "rejected") {
        error = "One or more W3C validator checks are temporarily unavailable.";
      }
      if (check_links) {
        try {
          links = await checkBrokenLinks(html, base_url, max_links);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : "Link checking could not be completed.";
        }
      }

      const summary = {
        html_errors: htmlResult.status === "fulfilled" ? htmlResult.value.length : 0,
        css_errors: cssResult.status === "fulfilled" ? cssResult.value.length : 0,
        seo_issues: seoIssues.length,
        schema_issues: schemaIssues.length,
        links_checked: links.length,
        broken_links: links.filter((link) => !link.ok).length,
        ...(error ? { error } : {}),
      };
      return {
        structuredContent: summary,
        content: contentForResult("Validation report generated."),
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
    if (url.pathname !== "/mcp") {
      return new Response("Not found\n", { status: 404 });
    }
    return createMcpHandler(createServer())(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
