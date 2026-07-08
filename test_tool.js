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
      case "report": {
        const htmlContent = await fs.readFile(resolvedPath, "utf-8");
        const htmlErrors = await validateHtmlContent(htmlContent);
        const seoIssues = auditSeoMetadata(htmlContent);
        const schemaIssues = validateSchemaMarkup(htmlContent);
        const linkStatuses = await checkBrokenLinks(htmlContent);

        const htmlErrCount = htmlErrors.filter(e => e.type === "error").length;
        const htmlWarnCount = htmlErrors.filter(e => e.type !== "error").length;
        const seoErrCount = seoIssues.filter(i => i.severity === "error").length;
        const seoWarnCount = seoIssues.filter(i => i.severity !== "error").length;
        const schemaErrCount = schemaIssues.filter(i => i.severity === "error").length;
        const brokenLinkCount = linkStatuses.filter(l => !l.ok).length;

        const report = [
          `# 📋 Web Validation & SEO Audit Report`,
          `*Generated for: \`${path.basename(target)}\`*`,
          ``,
          `## 📊 Summary Overview`,
          `| Audit Category | Status | Details |`,
          `| :--- | :---: | :--- |`,
          `| **W3C HTML Validation** | ${htmlErrCount > 0 ? "❌ Failed" : "✅ Passed"} | ${htmlErrCount} Errors, ${htmlWarnCount} Warnings |`,
          `| **Technical SEO & Accessibility** | ${seoErrCount > 0 ? "❌ Critical Issues" : (seoWarnCount > 0 ? "⚠️ Warnings" : "✅ Optimized")} | ${seoErrCount} Errors, ${seoWarnCount} Warnings |`,
          `| **JSON-LD Schema Verification** | ${schemaErrCount > 0 ? "❌ Invalid" : "✅ Valid"} | ${schemaErrCount} Syntax Errors |`,
          `| **Broken Link Check** | ${brokenLinkCount > 0 ? "❌ Broken Links Found" : "✅ All Links OK"} | ${brokenLinkCount} Dead Links, ${linkStatuses.length} Total Links Checked |`,
          ``,
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

        console.log(report.join("\n"));
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
