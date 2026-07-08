import { validateHtmlContent, validateCssContent } from "./dist/w3c-validator.js";
import { auditSeoMetadata, validateSchemaMarkup, checkBrokenLinks } from "./dist/seo-auditor.js";
import * as fs from "fs/promises";
import * as path from "path";

const args = process.argv.slice(2);
const command = args[0];
const target = args[1];

async function run() {
  if (!command || !target) {
    console.log("Usage: node test_tool.js <html|css|seo|links|schema> <file_path_or_url>");
    process.exit(0);
  }

  const resolvedPath = path.resolve(target);

  try {
    switch (command) {
      case "html": {
        const content = await fs.readFile(resolvedPath, "utf-8");
        const results = await validateHtmlContent(content);
        console.log("HTML Validation Results:", JSON.stringify(results, null, 2));
        break;
      }
      case "css": {
        const content = await fs.readFile(resolvedPath, "utf-8");
        const results = await validateCssContent(content);
        console.log("CSS Validation Results:", JSON.stringify(results, null, 2));
        break;
      }
      case "seo": {
        const content = await fs.readFile(resolvedPath, "utf-8");
        const results = auditSeoMetadata(content);
        console.log("SEO Audit Results:", JSON.stringify(results, null, 2));
        break;
      }
      case "schema": {
        const content = await fs.readFile(resolvedPath, "utf-8");
        const results = validateSchemaMarkup(content);
        console.log("Schema Audit Results:", JSON.stringify(results, null, 2));
        break;
      }
      case "links": {
        const content = await fs.readFile(resolvedPath, "utf-8");
        const results = await checkBrokenLinks(content);
        console.log("Broken Links Results:", JSON.stringify(results, null, 2));
        break;
      }
      default:
        console.log(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error("Error executing validation:", error.message);
  }
}

run();
