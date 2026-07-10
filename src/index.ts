#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import { validateHtmlContent, validateCssContent } from "./w3c-validator.js";
import { auditSeoMetadata, validateSchemaMarkup, checkBrokenLinks } from "./seo-auditor.js";
import { captureScreenshots } from "./screenshot.js";

// Initialize MCP Server
const server = new Server(
  {
    name: "mcp-web-validator",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register Tool Definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "html_validate_local",
        description: "Validates a local HTML file against the official W3C Nu HTML Checker API. Catches syntax, tags, and compliance errors.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Absolute or relative path to the local HTML file.",
            },
          },
          required: ["filePath"],
        },
        outputSchema: {
          type: "object",
          description: "Validation result containing W3C HTML parser validation messages.",
          properties: {
            errors: {
              type: "array",
              description: "List of HTML validation error and warning objects returned from W3C.",
              items: {
                type: "object",
                properties: {
                  type: { "type": "string", "description": "The category of message: 'error', 'info', or 'non-document-error'." },
                  message: { "type": "string", "description": "The specific validation or parsing error message." },
                  extract: { "type": "string", "description": "The HTML snippet around the validation location." },
                  lastLine: { "type": "number", "description": "Line number where the issue occurred." },
                  lastColumn: { "type": "number", "description": "Column number where the issue occurred." }
                },
                required: ["type", "message"]
              }
            }
          },
          required: ["errors"]
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false
        }
      },
      {
        name: "html_validate_url",
        description: "Validates the markup of a live public URL using the W3C HTML validation engine.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The live URL to validate (must start with http:// or https://).",
            },
          },
          required: ["url"],
        },
        outputSchema: {
          type: "object",
          description: "Validation result containing W3C HTML parser validation messages.",
          properties: {
            errors: {
              type: "array",
              description: "List of HTML validation error and warning objects returned from W3C.",
              items: {
                type: "object",
                properties: {
                  type: { "type": "string", "description": "The category of message: 'error', 'info', or 'non-document-error'." },
                  message: { "type": "string", "description": "The specific validation or parsing error message." },
                  extract: { "type": "string", "description": "The HTML snippet around the validation location." },
                  lastLine: { "type": "number", "description": "Line number where the issue occurred." },
                  lastColumn: { "type": "number", "description": "Column number where the issue occurred." }
                },
                required: ["type", "message"]
              }
            }
          },
          required: ["errors"]
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false
        }
      },
      {
        name: "css_validate_local",
        description: "Validates a local CSS file against the W3C Jigsaw CSS Validator API. Finds styling syntax errors.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Absolute or relative path to the local CSS file.",
            },
          },
          required: ["filePath"],
        },
        outputSchema: {
          type: "object",
          description: "CSS validation results.",
          properties: {
            errors: {
              type: "array",
              description: "List of CSS validation errors from W3C Jigsaw API.",
              items: {
                type: "object",
                properties: {
                  line: { "type": "number", "description": "Line number of the CSS error." },
                  context: { "type": "string", "description": "The CSS selector or context where the error occurred." },
                  message: { "type": "string", "description": "The specific CSS validation warning or error message." }
                },
                required: ["line", "message"]
              }
            }
          },
          required: ["errors"]
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false
        }
      },
      {
        name: "seo_audit_metadata",
        description: "Runs a fast offline audit of HTML metadata, heading structure, viewport responsive tags, image alt tags, and Open Graph cards.",
        inputSchema: {
          type: "object",
          properties: {
            htmlContent: {
              type: "string",
              description: "The raw HTML string content to analyze.",
            },
          },
          required: ["htmlContent"],
        },
        outputSchema: {
          type: "object",
          description: "Audited Technical SEO results.",
          properties: {
            issues: {
              type: "array",
              description: "List of audited Technical SEO issues, warnings, and error indicators.",
              items: {
                type: "object",
                properties: {
                  category: { "type": "string", "description": "SEO audit category (e.g. metadata, structure, accessibility)." },
                  severity: { "type": "string", "description": "Severity of the issue: 'error' or 'warning'." },
                  message: { "type": "string", "description": "Detailed explanation of the SEO issue." },
                  element: { "type": "string", "description": "Relevant HTML snippet or element if applicable." }
                },
                required: ["category", "severity", "message"]
              }
            }
          },
          required: ["issues"]
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false
        }
      },
      {
        name: "links_check_broken",
        description: "Extracts all links (a href tags) in the HTML content and tests their HTTP status codes to detect broken internal or external URLs.",
        inputSchema: {
          type: "object",
          properties: {
            htmlContent: {
              type: "string",
              description: "The raw HTML string content to inspect.",
            },
            baseUrl: {
              type: "string",
              description: "Optional base URL to resolve relative paths (e.g., https://example.com).",
            },
          },
          required: ["htmlContent"],
        },
        outputSchema: {
          type: "object",
          description: "Reachability report of page links.",
          properties: {
            links: {
              type: "array",
              description: "Status details of all checked links on the page.",
              items: {
                type: "object",
                properties: {
                  url: { "type": "string", "description": "The destination URL that was tested." },
                  status: { "type": "number", "description": "HTTP status code response (e.g., 200, 404)." },
                  ok: { "type": "boolean", "description": "Whether the link is reachable and returned a successful status code." },
                  message: { "type": "string", "description": "Reachable status details or error description." }
                },
                required: ["url", "status", "ok"]
              }
            }
          },
          required: ["links"]
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false
        }
      },
      {
        name: "schema_validate_markup",
        description: "Finds and validates the JSON-LD schema blocks within the HTML, catching syntax issues.",
        inputSchema: {
          type: "object",
          properties: {
            htmlContent: {
              type: "string",
              description: "The raw HTML string containing <script type=\"application/ld+json\"> blocks.",
            },
          },
          required: ["htmlContent"],
        },
        outputSchema: {
          type: "object",
          description: "Parsed JSON-LD validation report.",
          properties: {
            issues: {
              type: "array",
              description: "List of parsed JSON-LD validation results.",
              items: {
                type: "object",
                properties: {
                  category: { "type": "string", "description": "Always 'Schema Markup'." },
                  severity: { "type": "string", "description": "Severity level: 'error' or 'warning'." },
                  message: { "type": "string", "description": "Validation message explaining JSON parsing errors or schema problems." }
                },
                required: ["category", "severity", "message"]
              }
            }
          },
          required: ["issues"]
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false
        }
      },
      {
        name: "report_generate_validation",
        description: "Runs all validation checks (HTML, CSS, SEO, Schema, Links) on local files and aggregates them into a beautifully formatted Markdown report with summary tables.",
        inputSchema: {
          type: "object",
          properties: {
            htmlFilePath: {
              type: "string",
              description: "Absolute or relative path to the local HTML file to validate.",
            },
            cssFilePath: {
              type: "string",
              description: "Optional absolute or relative path to the local CSS file to validate.",
            },
            baseUrl: {
              type: "string",
              description: "Optional base URL to resolve relative link paths.",
            },
          },
          required: ["htmlFilePath"],
        },
        outputSchema: {
          type: "object",
          description: "Aggregated Markdown validation and SEO report details.",
          properties: {
            content: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { "type": "string", "enum": ["text"] },
                  text: { "type": "string", "description": "Formatted Markdown report." }
                },
                required: ["type", "text"]
              }
            }
          },
          required: ["content"]
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false
        }
      },
      {
        name: "screenshot_capture",
        description: "Renders a local HTML file or remote URL using Puppeteer and captures screenshots at different viewport sizes (desktop, tablet, mobile).",
        inputSchema: {
          type: "object",
          properties: {
            targetPath: {
              type: "string",
              description: "Path to the local HTML file or remote URL (e.g. http:// or https://) to screenshot.",
            },
            outputDir: {
              type: "string",
              description: "Optional absolute or relative directory path where screenshots will be saved. Defaults to '.mcp-validator/screenshots'.",
            },
            viewports: {
              type: "array",
              description: "Optional list of custom viewports to capture. Each viewport object must have name, width, and height.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Name of the viewport (e.g., mobile-portrait)." },
                  width: { type: "number", description: "Width in pixels." },
                  height: { type: "number", description: "Height in pixels." }
                },
                required: ["name", "width", "height"]
              }
            }
          },
          required: ["targetPath"]
        },
        outputSchema: {
          type: "object",
          description: "Status report of screenshot file paths and coordinates generated.",
          properties: {
            content: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { "type": "string", "enum": ["text"] },
                  text: { "type": "string", "description": "Markdown list of screenshots created and their directories." }
                },
                required: ["type", "text"]
              }
            }
          },
          required: ["content"]
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true
        }
      }
    ] as any,
  };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "html_validate_local": {
        const filePath = String(args?.filePath);
        const resolvedPath = path.resolve(filePath);
        
        try {
          const content = await fs.readFile(resolvedPath, "utf-8");
          const errors = await validateHtmlContent(content);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(errors, null, 2),
              },
            ],
          };
        } catch (e: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error reading file at "${resolvedPath}": ${e.message}`,
              },
            ],
          };
        }
      }

      case "html_validate_url": {
        const url = String(args?.url);
        try {
          const response = await fetch(url);
          if (!response.ok) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Failed to fetch URL ${url}. Status code: ${response.status}`,
                },
              ],
            };
          }
          const content = await response.text();
          const errors = await validateHtmlContent(content);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(errors, null, 2),
              },
            ],
          };
        } catch (e: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error fetching URL "${url}": ${e.message}`,
              },
            ],
          };
        }
      }

      case "css_validate_local": {
        const filePath = String(args?.filePath);
        const resolvedPath = path.resolve(filePath);
        
        try {
          const content = await fs.readFile(resolvedPath, "utf-8");
          const errors = await validateCssContent(content);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(errors, null, 2),
              },
            ],
          };
        } catch (e: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error reading CSS file at "${resolvedPath}": ${e.message}`,
              },
            ],
          };
        }
      }

      case "seo_audit_metadata": {
        const htmlContent = String(args?.htmlContent);
        const issues = auditSeoMetadata(htmlContent);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(issues, null, 2),
            },
          ],
        };
      }

      case "links_check_broken": {
        const htmlContent = String(args?.htmlContent);
        const baseUrl = args?.baseUrl ? String(args.baseUrl) : undefined;
        const linkStatuses = await checkBrokenLinks(htmlContent, baseUrl);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(linkStatuses, null, 2),
            },
          ],
        };
      }

      case "schema_validate_markup": {
        const htmlContent = String(args?.htmlContent);
        const issues = validateSchemaMarkup(htmlContent);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(issues, null, 2),
            },
          ],
        };
      }

      case "report_generate_validation": {
        const htmlFilePath = String(args?.htmlFilePath);
        const cssFilePath = args?.cssFilePath ? String(args.cssFilePath) : undefined;
        const baseUrl = args?.baseUrl ? String(args.baseUrl) : undefined;

        const resolvedHtmlPath = path.resolve(htmlFilePath);
        const htmlContent = await fs.readFile(resolvedHtmlPath, "utf-8");

        // Runs checks
        const htmlErrors = await validateHtmlContent(htmlContent);
        const seoIssues = auditSeoMetadata(htmlContent);
        const schemaIssues = validateSchemaMarkup(htmlContent);
        const linkStatuses = await checkBrokenLinks(htmlContent, baseUrl);

        let cssErrors: any[] = [];
        if (cssFilePath) {
          try {
            const resolvedCssPath = path.resolve(cssFilePath);
            const cssContent = await fs.readFile(resolvedCssPath, "utf-8");
            cssErrors = await validateCssContent(cssContent);
          } catch (e: any) {
            cssErrors = [{ line: 0, type: "error", message: `Failed to read CSS: ${e.message}` }];
          }
        }

        // Generate Report Markdown
        const htmlErrCount = htmlErrors.filter(e => e.type === "error").length;
        const htmlWarnCount = htmlErrors.filter(e => e.type !== "error").length;
        const cssErrCount = cssErrors.length;
        const seoErrCount = seoIssues.filter(i => i.severity === "error").length;
        const seoWarnCount = seoIssues.filter(i => i.severity !== "error").length;
        const schemaErrCount = schemaIssues.filter(i => i.severity === "error").length;
        const brokenLinkCount = linkStatuses.filter(l => !l.ok).length;

        // Calculate Scores (PageSpeed style: Base 100)
        let htmlScore = 100 - (htmlErrCount * 15) - (htmlWarnCount * 2);
        let cssScore = cssFilePath ? (100 - (cssErrCount * 20)) : 100;
        let seoScore = 100 - (seoErrCount * 15) - (seoWarnCount * 4) - (schemaErrCount * 15);
        let linkScore = linkStatuses.length > 0 ? (100 - (brokenLinkCount * 25)) : 100;

        // Clamp to [0, 100]
        htmlScore = Math.max(0, Math.min(100, htmlScore));
        cssScore = Math.max(0, Math.min(100, cssScore));
        seoScore = Math.max(0, Math.min(100, seoScore));
        linkScore = Math.max(0, Math.min(100, linkScore));

        const getCircle = (score: number): string => {
          if (score >= 90) return "🟢";
          if (score >= 50) return "🟠";
          return "🔴";
        };

        const totalAuditCount = cssFilePath ? 4 : 3;
        const totalScoreSum = htmlScore + seoScore + linkScore + (cssFilePath ? cssScore : 0);
        const overallScore = Math.round(totalScoreSum / totalAuditCount);

        const report = [
          `# 📋 Web Validation & SEO Audit Report — ${getCircle(overallScore)} **${overallScore}**/100`,
          `*Generated for: \`${path.basename(htmlFilePath)}\`*`,
          ``,
          `## ⚡ Page Health Scores (PageSpeed Inspired)`,
          ``,
          `| Score Card | Status | Score |`,
          `| :--- | :---: | :---: |`,
          `| **W3C HTML Validation** | ${getCircle(htmlScore)} ${htmlScore >= 90 ? "Excellent" : (htmlScore >= 50 ? "Needs Work" : "Poor")} | **${htmlScore}** / 100 |`,
          `| **W3C CSS Validation** | ${cssFilePath ? `${getCircle(cssScore)} ${cssScore >= 90 ? "Excellent" : (cssScore >= 50 ? "Needs Work" : "Poor")}` : "ℹ️ Not Audited"} | ${cssFilePath ? `**${cssScore}** / 100` : "N/A"} |`,
          `| **SEO & Accessibility** | ${getCircle(seoScore)} ${seoScore >= 90 ? "Optimized" : (seoScore >= 50 ? "Warnings" : "Poor")} | **${seoScore}** / 100 |`,
          `| **Links Integrity** | ${linkStatuses.length > 0 ? `${getCircle(linkScore)} ${linkScore >= 90 ? "All Good" : "Broken Links"}` : "ℹ️ No Links"} | ${linkStatuses.length > 0 ? `**${linkScore}** / 100` : "N/A"} |`,
          ``,
          `---`,
          ``,
          `## 📊 Audit Details Overview`,
          `| Audit Category | Status | Details |`,
          `| :--- | :---: | :--- |`,
          `| **W3C HTML Validation** | ${htmlErrCount > 0 ? "❌ Failed" : "✅ Passed"} | ${htmlErrCount} Errors, ${htmlWarnCount} Warnings |`,
          `| **W3C CSS Validation** | ${cssFilePath ? (cssErrCount > 0 ? "❌ Failed" : "✅ Passed") : "ℹ️ Not Audited"} | ${cssErrCount} Errors |`,
          `| **Technical SEO & Accessibility** | ${seoErrCount > 0 ? "❌ Critical Issues" : (seoWarnCount > 0 ? "⚠️ Warnings" : "✅ Optimized")} | ${seoErrCount} Errors, ${seoWarnCount} Warnings |`,
          `| **JSON-LD Schema Verification** | ${schemaErrCount > 0 ? "❌ Invalid" : "✅ Valid"} | ${schemaErrCount} Syntax Errors |`,
          `| **Broken Link Check** | ${brokenLinkCount > 0 ? "❌ Broken Links Found" : "✅ All Links OK"} | ${brokenLinkCount} Dead Links, ${linkStatuses.length} Total Links Checked |`,
          `---`,
          ``,
          `## 🔴 HTML Syntax & Compliance Issues (${htmlErrors.length})`,
        ];

        if (htmlErrors.length === 0) {
          report.push("*No HTML syntax or markup validation errors found! Excellent job.*");
        } else {
          report.push("| Line | Col | Severity | Message | Extract |");
          report.push("| :---: | :---: | :--- | :--- | :--- |");
          for (const err of htmlErrors) {
            const extract = err.extract ? `\`${err.extract.replace(/\n/g, " ").trim()}\`` : "N/A";
            report.push(`| ${err.lastLine || "N/A"} | ${err.lastColumn || "N/A"} | ${err.type === "error" ? "🔴 Error" : "⚠️ Warning"} | ${err.message} | ${extract} |`);
          }
        }

        if (cssFilePath) {
          report.push(
            ``,
            `---`,
            ``,
            `## 🎨 CSS Styling Issues (${cssErrors.length})`
          );
          if (cssErrors.length === 0) {
            report.push("*No CSS syntax errors found! Stylesheet is fully compliant.*");
          } else {
            report.push("| Line | Context | Message |");
            report.push("| :---: | :--- | :--- |");
            for (const err of cssErrors) {
              report.push(`| ${err.line} | \`${err.context || "N/A"}\` | ${err.message} |`);
            }
          }
        }

        report.push(
          ``,
          `---`,
          ``,
          `## 🔍 Technical SEO & Accessibility Issues (${seoIssues.length + schemaIssues.length})`
        );

        const allSeo = [...seoIssues, ...schemaIssues];
        if (allSeo.length === 0) {
          report.push("*No technical SEO or schema issues found! Page is search-engine ready.*");
        } else {
          report.push("| Category | Severity | Message | Element Snippet |");
          report.push("| :--- | :--- | :--- | :--- |");
          for (const issue of allSeo) {
            const severityLabel = issue.severity === "error" ? "🔴 Error" : (issue.severity === "warning" ? "⚠️ Warning" : "ℹ️ Info");
            const snippet = issue.element ? `\`${issue.element.trim()}\`` : "N/A";
            report.push(`| ${issue.category} | ${severityLabel} | ${issue.message} | ${snippet} |`);
          }
        }

        report.push(
          ``,
          `---`,
          ``,
          `## 🔗 Link Health Check (${linkStatuses.length} links checked)`
        );

        if (linkStatuses.length === 0) {
          report.push("*No hyperlinks found in the document.*");
        } else {
          report.push("| Link URL | Status Code | Health | Details |");
          report.push("| :--- | :---: | :---: | :--- |");
          for (const link of linkStatuses) {
            report.push(`| [${link.url}](${link.url}) | ${link.status} | ${link.ok ? "✅ Healthy" : "❌ Broken"} | ${link.message || "Accessible"} |`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: report.join("\n"),
            },
          ],
        };
      }

      case "screenshot_capture": {
        const targetPath = String(args?.targetPath);
        const outputDir = args?.outputDir ? String(args.outputDir) : ".mcp-validator/screenshots";
        const viewports = args?.viewports as any[] | undefined;

        const resolvedOutputDir = path.resolve(outputDir);
        const results = await captureScreenshots(targetPath, resolvedOutputDir, viewports);

        const responseText = [
          `# 📸 Viewport Screenshot Generation Complete`,
          `Captured **${results.length}** viewport rendering(s):`,
          ``,
          `| Viewport | Dimensions | Output Path |`,
          `| :--- | :---: | :--- |`,
          ...results.map(r => `| **${r.viewportName}** | ${r.width}x${r.height} px | [${path.basename(r.outputPath)}](file:///${r.outputPath.replace(/\\/g, "/")}) |`),
          ``,
          `> [!NOTE]`,
          `> Screenshots have been saved successfully to [${outputDir}](file:///${resolvedOutputDir.replace(/\\/g, "/")})`
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
      }

      default:
        throw new Error(`Tool "${name}" not found.`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Server error executing tool "${name}": ${error.message}`,
        },
      ],
    };
  }
});

// Run server using stdio transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-web-validator server successfully started on stdio");
}

run().catch((error) => {
  console.error("Fatal error starting mcp-web-validator server:", error);
  process.exit(1);
});
