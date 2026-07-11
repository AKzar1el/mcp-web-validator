import * as path from "node:path";
import type { CSSMessage, W3CMessage } from "./w3c-validator.js";
import type { LinkStatus, SEOIssue } from "./seo-auditor.js";

export interface ValidationReportSummary {
  overallScore: number;
  htmlScore: number;
  cssScore: number | null;
  seoScore: number;
  linkScore: number | null;
  htmlErrors: number;
  htmlWarnings: number;
  cssErrors: number;
  seoErrors: number;
  seoWarnings: number;
  schemaErrors: number;
  linksChecked: number;
  brokenLinks: number;
}

export interface ValidationReport {
  report: string;
  summary: ValidationReportSummary;
  htmlMessages: W3CMessage[];
  cssMessages: CSSMessage[];
  seoIssues: SEOIssue[];
  schemaIssues: SEOIssue[];
  links: LinkStatus[];
}

export interface ValidationReportInput {
  htmlFilePath: string;
  cssAudited: boolean;
  htmlMessages: W3CMessage[];
  cssMessages: CSSMessage[];
  seoIssues: SEOIssue[];
  schemaIssues: SEOIssue[];
  links: LinkStatus[];
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function scoreIndicator(score: number): string {
  if (score >= 90) return "🟢";
  if (score >= 50) return "🟠";
  return "🔴";
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** Builds the human-readable report and its machine-readable equivalent. */
export function createValidationReport(input: ValidationReportInput): ValidationReport {
  const htmlErrors = input.htmlMessages.filter((message) => message.type === "error").length;
  const htmlWarnings = input.htmlMessages.length - htmlErrors;
  const cssErrors = input.cssMessages.length;
  const seoErrors = input.seoIssues.filter((issue) => issue.severity === "error").length;
  const seoWarnings = input.seoIssues.filter((issue) => issue.severity === "warning").length;
  const schemaErrors = input.schemaIssues.filter((issue) => issue.severity === "error").length;
  const brokenLinks = input.links.filter((link) => !link.ok).length;

  const htmlScore = clampScore(100 - htmlErrors * 15 - htmlWarnings * 2);
  const cssScore = input.cssAudited ? clampScore(100 - cssErrors * 20) : null;
  const seoScore = clampScore(100 - seoErrors * 15 - seoWarnings * 4 - schemaErrors * 15);
  const linkScore = input.links.length > 0 ? clampScore(100 - brokenLinks * 25) : null;
  const auditedScores = [htmlScore, seoScore, cssScore, linkScore].filter(
    (score): score is number => score !== null,
  );
  const overallScore = Math.round(
    auditedScores.reduce((total, score) => total + score, 0) / auditedScores.length,
  );

  const summary: ValidationReportSummary = {
    overallScore,
    htmlScore,
    cssScore,
    seoScore,
    linkScore,
    htmlErrors,
    htmlWarnings,
    cssErrors,
    seoErrors,
    seoWarnings,
    schemaErrors,
    linksChecked: input.links.length,
    brokenLinks,
  };

  const report: string[] = [
    `# Web Validation & SEO Audit Report — ${scoreIndicator(overallScore)} **${overallScore}**/100`,
    `*Generated for: \`${markdownCell(path.basename(input.htmlFilePath))}\`*`,
    "",
    "## Page health scores",
    "",
    "| Audit | Status | Score |",
    "| :--- | :---: | :---: |",
    `| W3C HTML validation | ${scoreIndicator(htmlScore)} | **${htmlScore}** / 100 |`,
    `| CSS validation | ${cssScore === null ? "Not audited" : scoreIndicator(cssScore)} | ${cssScore === null ? "N/A" : `**${cssScore}** / 100`} |`,
    `| SEO and accessibility | ${scoreIndicator(seoScore)} | **${seoScore}** / 100 |`,
    `| Link integrity | ${linkScore === null ? "No links checked" : scoreIndicator(linkScore)} | ${linkScore === null ? "N/A" : `**${linkScore}** / 100`} |`,
    "",
    "## Summary",
    "",
    `- HTML: ${htmlErrors} error(s), ${htmlWarnings} other diagnostic(s)` ,
    `- CSS: ${input.cssAudited ? `${cssErrors} error(s)` : "not audited"}`,
    `- SEO and accessibility: ${seoErrors} error(s), ${seoWarnings} warning(s)`,
    `- JSON-LD syntax: ${schemaErrors} error(s)`,
    `- Links: ${brokenLinks} broken or unreachable of ${input.links.length} checked`,
    "",
    `## HTML diagnostics (${input.htmlMessages.length})`,
  ];

  if (input.htmlMessages.length === 0) {
    report.push("No HTML validation diagnostics were returned.");
  } else {
    report.push("", "| Line | Column | Severity | Message | Extract |", "| :---: | :---: | :--- | :--- | :--- |");
    for (const message of input.htmlMessages) {
      report.push(
        `| ${message.lastLine ?? "N/A"} | ${message.lastColumn ?? "N/A"} | ${markdownCell(message.type)} | ${markdownCell(message.message)} | ${markdownCell(message.extract ?? "N/A")} |`,
      );
    }
  }

  if (input.cssAudited) {
    report.push("", `## CSS diagnostics (${input.cssMessages.length})`);
    if (input.cssMessages.length === 0) {
      report.push("No CSS validation errors were returned.");
    } else {
      report.push("", "| Line | Context | Message |", "| :---: | :--- | :--- |");
      for (const message of input.cssMessages) {
        report.push(
          `| ${message.line} | ${markdownCell(message.context ?? "N/A")} | ${markdownCell(message.message)} |`,
        );
      }
    }
  }

  const combinedIssues = [...input.seoIssues, ...input.schemaIssues];
  report.push("", `## SEO, accessibility, and JSON-LD findings (${combinedIssues.length})`);
  if (combinedIssues.length === 0) {
    report.push("No SEO, accessibility, or JSON-LD syntax findings were returned.");
  } else {
    report.push("", "| Category | Severity | Message | Element |", "| :--- | :--- | :--- | :--- |");
    for (const issue of combinedIssues) {
      report.push(
        `| ${markdownCell(issue.category)} | ${markdownCell(issue.severity)} | ${markdownCell(issue.message)} | ${markdownCell(issue.element ?? "N/A")} |`,
      );
    }
  }

  report.push("", `## Link health (${input.links.length} checked)`);
  if (input.links.length === 0) {
    report.push("No public HTTP(S) links were checked.");
  } else {
    report.push("", "| URL | Status | Healthy | Details |", "| :--- | :---: | :---: | :--- |");
    for (const link of input.links) {
      report.push(
        `| ${markdownCell(link.url)} | ${markdownCell(link.status)} | ${link.ok ? "Yes" : "No"} | ${markdownCell(link.message ?? "Accessible")} |`,
      );
    }
  }

  return {
    report: report.join("\n"),
    summary,
    htmlMessages: input.htmlMessages,
    cssMessages: input.cssMessages,
    seoIssues: input.seoIssues,
    schemaIssues: input.schemaIssues,
    links: input.links,
  };
}
