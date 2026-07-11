#!/usr/bin/env node
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { captureScreenshots } from "./screenshot.js";
import { auditSeoMetadata, checkBrokenLinks, validateSchemaMarkup } from "./seo-auditor.js";
import { createValidationReport, type ValidationReport } from "./report.js";
import { fetchPublicText, getErrorMessage, readTextFile } from "./network.js";
import { PACKAGE_VERSION } from "./version.js";
import {
  MAX_CSS_VALIDATION_BYTES,
  validateCssContent,
  validateHtmlContent,
} from "./w3c-validator.js";

export const SERVER_VERSION = PACKAGE_VERSION;

const HTML_MAX_BYTES = 2_000_000;
const CSS_MAX_BYTES = MAX_CSS_VALIDATION_BYTES;
const PATH_MAX_LENGTH = 4_096;
const MAX_VIEWPORTS = 8;

const filePathSchema = z.string().trim().min(1).max(PATH_MAX_LENGTH);
const htmlContentSchema = z.string().min(1).max(HTML_MAX_BYTES);
const publicUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use HTTP or HTTPS.");

const w3cMessageSchema = z.object({
  type: z.string(),
  message: z.string(),
  lastLine: z.number().int().optional(),
  lastColumn: z.number().int().optional(),
  firstLine: z.number().int().optional(),
  firstColumn: z.number().int().optional(),
  extract: z.string().optional(),
});

const cssMessageSchema = z.object({
  line: z.number().int(),
  type: z.string(),
  message: z.string(),
  context: z.string().optional(),
});

const seoIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["SEO", "Schema", "BrokenLinks", "Accessibility"]),
  message: z.string(),
  element: z.string().optional(),
});

const linkStatusSchema = z.object({
  url: z.string(),
  status: z.union([z.number().int(), z.enum(["blocked", "failed"])]),
  ok: z.boolean(),
  message: z.string().optional(),
});

const screenshotSchema = z.object({
  viewportName: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  outputPath: z.string(),
});

const reportSummarySchema = z.object({
  overallScore: z.number().int().min(0).max(100),
  htmlScore: z.number().int().min(0).max(100),
  cssScore: z.number().int().min(0).max(100).nullable(),
  seoScore: z.number().int().min(0).max(100),
  linkScore: z.number().int().min(0).max(100).nullable(),
  htmlErrors: z.number().int().nonnegative(),
  htmlWarnings: z.number().int().nonnegative(),
  cssErrors: z.number().int().nonnegative(),
  seoErrors: z.number().int().nonnegative(),
  seoWarnings: z.number().int().nonnegative(),
  schemaErrors: z.number().int().nonnegative(),
  linksChecked: z.number().int().nonnegative(),
  brokenLinks: z.number().int().nonnegative(),
});

const externalReadOnlyAnnotations = {
  // These calls send supplied content or URLs outside the local MCP process.
  // Marking them non-read-only ensures clients can request informed approval.
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const localReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function result<T extends object>(
  structuredContent: T,
  summary: string,
  isError = false,
): CallToolResult {
  return {
    structuredContent: structuredContent as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: `${summary}\n\n${JSON.stringify(structuredContent, null, 2)}`,
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function failedReport(filePath: string, error: string): ValidationReport & { errors: string[] } {
  return {
    report: `Validation report could not be generated: ${error}`,
    summary: {
      overallScore: 0,
      htmlScore: 0,
      cssScore: null,
      seoScore: 0,
      linkScore: null,
      htmlErrors: 0,
      htmlWarnings: 0,
      cssErrors: 0,
      seoErrors: 0,
      seoWarnings: 0,
      schemaErrors: 0,
      linksChecked: 0,
      brokenLinks: 0,
    },
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [],
    errors: [`${path.basename(filePath || "document")}: ${error}`],
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-web-validator", version: SERVER_VERSION },
    {
      instructions:
        "Validate only files, markup, and public URLs the user owns or is authorized to inspect. HTML and CSS validation send supplied content to W3C-operated validators. Link checks contact public links without following redirects. Screenshot capture executes page content in a sandboxed local browser and writes PNG files.",
    },
  );

  server.registerTool(
    "html_validate_local",
    {
      title: "Validate local HTML",
      description:
        "Reads a bounded local HTML file and sends its markup to the W3C Nu HTML Checker. Use only files the user is authorized to share.",
      inputSchema: {
        filePath: filePathSchema.describe("Absolute or workspace-relative path to an HTML file."),
      },
      outputSchema: {
        errors: z.array(w3cMessageSchema),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ filePath }) => {
      try {
        const html = await readTextFile(filePath, HTML_MAX_BYTES);
        const errors = await validateHtmlContent(html);
        return result({ errors }, `HTML validation returned ${errors.length} diagnostic(s).`);
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result({ errors: [], error }, `HTML validation failed: ${error}`, true);
      }
    },
  );

  server.registerTool(
    "html_validate_url",
    {
      title: "Validate a public URL",
      description:
        "Fetches a bounded public HTTP(S) page, then sends its markup to the W3C Nu HTML Checker. Private, reserved, credentialed, and nonstandard-port destinations are rejected.",
      inputSchema: {
        url: publicUrlSchema.describe("Public HTTP(S) URL on port 80 or 443."),
      },
      outputSchema: {
        errors: z.array(w3cMessageSchema),
        fetchedUrl: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url }) => {
      try {
        const fetched = await fetchPublicText(url, {
          maxBytes: HTML_MAX_BYTES,
          timeoutMs: 15_000,
          maxRedirects: 3,
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
            "user-agent": `DigestSEO-Web-Validator/${SERVER_VERSION} (+https://digestseo.com/validator-mcp/)`,
          },
        });
        if (fetched.status < 200 || fetched.status >= 300) {
          throw new Error(`Target URL returned HTTP ${fetched.status}.`);
        }
        const errors = await validateHtmlContent(fetched.text);
        return result(
          { errors, fetchedUrl: fetched.url },
          `HTML validation returned ${errors.length} diagnostic(s).`,
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result({ errors: [], error }, `URL validation failed: ${error}`, true);
      }
    },
  );

  server.registerTool(
    "css_validate_local",
    {
      title: "Validate local CSS",
      description:
        "Reads a bounded local CSS file and sends it to the W3C Jigsaw CSS Validator. Use only files the user is authorized to share.",
      inputSchema: {
        filePath: filePathSchema.describe("Absolute or workspace-relative path to a CSS file."),
      },
      outputSchema: {
        errors: z.array(cssMessageSchema),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ filePath }) => {
      try {
        const css = await readTextFile(filePath, CSS_MAX_BYTES);
        const errors = await validateCssContent(css);
        return result({ errors }, `CSS validation returned ${errors.length} error(s).`);
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result({ errors: [], error }, `CSS validation failed: ${error}`, true);
      }
    },
  );

  server.registerTool(
    "seo_audit_metadata",
    {
      title: "Audit SEO metadata",
      description:
        "Analyzes supplied HTML locally for metadata, heading structure, viewport configuration, image alternatives, and Open Graph fields.",
      inputSchema: {
        htmlContent: htmlContentSchema.describe("Raw HTML markup to inspect locally."),
      },
      outputSchema: {
        issues: z.array(seoIssueSchema),
        totalIssues: z.number().int().nonnegative(),
        truncated: z.boolean(),
        error: z.string().optional(),
      },
      annotations: localReadOnlyAnnotations,
    },
    async ({ htmlContent }) => {
      try {
        const allIssues = auditSeoMetadata(htmlContent);
        const issues = allIssues.slice(0, 200);
        return result(
          { issues, totalIssues: allIssues.length, truncated: issues.length < allIssues.length },
          `SEO audit found ${allIssues.length} issue(s).`,
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { issues: [], totalIssues: 0, truncated: false, error },
          `SEO audit failed: ${error}`,
          true,
        );
      }
    },
  );

  server.registerTool(
    "links_check_broken",
    {
      title: "Check public links",
      description:
        "Resolves and checks up to 25 public HTTP(S) links in supplied HTML. Redirects are reported but not followed, and response bodies are discarded.",
      inputSchema: {
        htmlContent: htmlContentSchema.describe("Raw HTML markup containing links to check."),
        baseUrl: publicUrlSchema
          .optional()
          .describe("Optional public HTTP(S) base URL used to resolve relative links."),
        maxLinks: z.number().int().min(1).max(25).default(25),
      },
      outputSchema: {
        links: z.array(linkStatusSchema),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ htmlContent, baseUrl, maxLinks }) => {
      try {
        const links = await checkBrokenLinks(htmlContent, baseUrl, maxLinks);
        const broken = links.filter((link) => !link.ok).length;
        return result({ links }, `Checked ${links.length} link(s); ${broken} need attention.`);
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result({ links: [], error }, `Link check failed: ${error}`, true);
      }
    },
  );

  server.registerTool(
    "schema_validate_markup",
    {
      title: "Validate JSON-LD syntax",
      description:
        "Parses JSON-LD blocks in supplied HTML locally and reports empty blocks or JSON syntax errors. It does not validate vocabulary semantics.",
      inputSchema: {
        htmlContent: htmlContentSchema.describe("Raw HTML containing JSON-LD script blocks."),
      },
      outputSchema: {
        issues: z.array(seoIssueSchema),
        totalIssues: z.number().int().nonnegative(),
        truncated: z.boolean(),
        error: z.string().optional(),
      },
      annotations: localReadOnlyAnnotations,
    },
    async ({ htmlContent }) => {
      try {
        const allIssues = validateSchemaMarkup(htmlContent);
        const issues = allIssues.slice(0, 200);
        return result(
          { issues, totalIssues: allIssues.length, truncated: issues.length < allIssues.length },
          `JSON-LD syntax validation found ${allIssues.length} issue(s).`,
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { issues: [], totalIssues: 0, truncated: false, error },
          `JSON-LD validation failed: ${error}`,
          true,
        );
      }
    },
  );

  server.registerTool(
    "report_generate_validation",
    {
      title: "Generate a validation report",
      description:
        "Combines W3C HTML/CSS validation, local SEO/accessibility checks, JSON-LD syntax checks, and a bounded public-link check into a Markdown and structured report.",
      inputSchema: {
        htmlFilePath: filePathSchema.describe("Absolute or workspace-relative HTML file path."),
        cssFilePath: filePathSchema
          .optional()
          .describe("Optional absolute or workspace-relative CSS file path."),
        baseUrl: publicUrlSchema
          .optional()
          .describe("Optional public HTTP(S) base URL used to resolve relative links."),
      },
      outputSchema: {
        report: z.string(),
        summary: reportSummarySchema,
        htmlMessages: z.array(w3cMessageSchema),
        cssMessages: z.array(cssMessageSchema),
        seoIssues: z.array(seoIssueSchema),
        schemaIssues: z.array(seoIssueSchema),
        links: z.array(linkStatusSchema),
        errors: z.array(z.string()).optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ htmlFilePath, cssFilePath, baseUrl }) => {
      try {
        const html = await readTextFile(htmlFilePath, HTML_MAX_BYTES);
        const css = cssFilePath ? await readTextFile(cssFilePath, CSS_MAX_BYTES) : undefined;
        const [htmlMessages, cssMessages, links] = await Promise.all([
          validateHtmlContent(html),
          css === undefined ? Promise.resolve([]) : validateCssContent(css),
          checkBrokenLinks(html, baseUrl, 25),
        ]);
        const reportData = createValidationReport({
          htmlFilePath,
          cssAudited: css !== undefined,
          htmlMessages,
          cssMessages,
          seoIssues: auditSeoMetadata(html).slice(0, 200),
          schemaIssues: validateSchemaMarkup(html).slice(0, 200),
          links,
        });
        return result(reportData, reportData.report);
      } catch (cause) {
        const error = getErrorMessage(cause);
        const reportData = failedReport(htmlFilePath, error);
        return result(reportData, reportData.report, true);
      }
    },
  );

  server.registerTool(
    "screenshot_capture",
    {
      title: "Capture responsive screenshots",
      description:
        "Renders a local HTML file or HTTP(S) URL in a sandboxed local Chromium browser and writes PNG screenshots to the requested directory. Existing matching files may be replaced.",
      inputSchema: {
        targetPath: z
          .string()
          .trim()
          .min(1)
          .max(PATH_MAX_LENGTH)
          .describe("Local HTML path or HTTP(S) URL to render."),
        outputDir: filePathSchema
          .optional()
          .default(".mcp-validator/screenshots")
          .describe("Directory where PNG screenshots will be written."),
        viewports: z
          .array(
            z.object({
              name: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),
              width: z.number().int().min(200).max(3_840),
              height: z.number().int().min(200).max(4_320),
            }),
          )
          .min(1)
          .max(MAX_VIEWPORTS)
          .optional(),
      },
      outputSchema: {
        screenshots: z.array(screenshotSchema),
        outputDirectory: z.string(),
        error: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ targetPath, outputDir, viewports }) => {
      const outputDirectory = path.resolve(outputDir);
      try {
        const screenshots = await captureScreenshots(targetPath, outputDirectory, viewports);
        return result(
          { screenshots, outputDirectory },
          `Captured ${screenshots.length} screenshot(s) in ${outputDirectory}.`,
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { screenshots: [], outputDirectory, error },
          `Screenshot capture failed: ${error}`,
          true,
        );
      }
    },
  );

  return server;
}

export async function run(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`mcp-web-validator ${SERVER_VERSION} started on stdio`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  run().catch((cause: unknown) => {
    console.error("Fatal error starting mcp-web-validator:", getErrorMessage(cause));
    process.exitCode = 1;
  });
}
