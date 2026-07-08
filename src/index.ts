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
        name: "validate_local_html",
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
      },
      {
        name: "validate_url",
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
      },
      {
        name: "validate_local_css",
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
      },
      {
        name: "audit_seo_metadata",
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
      },
      {
        name: "check_broken_links",
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
      },
      {
        name: "validate_schema_markup",
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
      },
    ],
  };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "validate_local_html": {
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

      case "validate_url": {
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

      case "validate_local_css": {
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

      case "audit_seo_metadata": {
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

      case "check_broken_links": {
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

      case "validate_schema_markup": {
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
