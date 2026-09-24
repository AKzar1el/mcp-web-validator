import * as path from "node:path";
import {
  getW3CMessageSeverity,
  type CSSMessage,
  type W3CMessage,
} from "./w3c-validator.js";
import { isHttpRedirectStatus, type AuditCounts, type LinkStatus, type SEOIssue } from "./seo-auditor.js";

export const validationReportChecks = ["input", "html", "css", "seo", "schema", "links"] as const;
export type ValidationReportCheck = (typeof validationReportChecks)[number];

export interface ValidationReportSummary {
  overallScore: number | null;
  htmlScore: number | null;
  cssScore: number | null;
  seoScore: number | null;
  linkScore: number | null;
  htmlErrors: number;
  htmlWarnings: number;
  cssErrors: number;
  cssWarnings?: number;
  cssCompatibilityLimitations: number;
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
  htmlTotalMessages: number;
  htmlTruncated: boolean;
  cssMessages: CSSMessage[];
  cssTotalMessages: number;
  cssTruncated: boolean;
  seoIssues: SEOIssue[];
  seoTotalIssues: number;
  seoTruncated: boolean;
  schemaIssues: SEOIssue[];
  schemaTotalIssues: number;
  schemaTruncated: boolean;
  links: LinkStatus[];
  failedChecks: ValidationReportCheck[];
  errors?: string[];
}

export interface ValidationReportInput {
  htmlFilePath: string;
  cssAudited: boolean;
  htmlMessages: W3CMessage[];
  htmlTotalMessages?: number;
  htmlTruncated?: boolean;
  htmlCounts?: { error: number; warning: number; info: number };
  cssMessages: CSSMessage[];
  cssTotalMessages?: number;
  cssTruncated?: boolean;
  cssCounts?: { error: number; warning?: number; compatibilityLimitation: number };
  seoIssues: SEOIssue[];
  seoTotalIssues?: number;
  seoTruncated?: boolean;
  seoCounts?: AuditCounts;
  schemaIssues: SEOIssue[];
  schemaTotalIssues?: number;
  schemaTruncated?: boolean;
  schemaCounts?: AuditCounts;
  links: LinkStatus[];
  failedChecks?: ValidationReportCheck[];
  errors?: string[];
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function scoreIndicator(score: number | null): string {
  if (score === null) return "Unavailable";
  if (score >= 90) return "🟢";
  if (score >= 50) return "🟠";
  return "🔴";
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]|~])/g, "\\$1")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function isRedirect(link: LinkStatus): boolean {
  return isHttpRedirectStatus(link.status);
}

/** Builds the human-readable report and its machine-readable equivalent. */
export function createValidationReport(input: ValidationReportInput): ValidationReport {
  const failedChecks = input.failedChecks ?? [];
  const checkFailed = (check: ValidationReportCheck): boolean => failedChecks.includes(check);
  const htmlErrors = input.htmlCounts?.error
    ?? input.htmlMessages.filter((message) => getW3CMessageSeverity(message) === "error").length;
  const htmlWarnings = input.htmlCounts?.warning
    ?? input.htmlMessages.filter((message) => getW3CMessageSeverity(message) === "warning").length;
  const htmlTotalMessages = input.htmlTotalMessages ?? input.htmlMessages.length;
  const htmlTruncated = input.htmlTruncated ?? htmlTotalMessages > input.htmlMessages.length;
  const cssTotalMessages = input.cssTotalMessages ?? input.cssMessages.length;
  const cssTruncated = input.cssTruncated ?? cssTotalMessages > input.cssMessages.length;
  const cssCompatibilityLimitations = input.cssCounts?.compatibilityLimitation
    ?? input.cssMessages.filter((message) => message.compatibility === "known-validator-limitation").length;
  const cssWarnings = input.cssCounts?.warning
    ?? input.cssMessages.filter((message) => message.type.toLowerCase() === "warning").length;
  const cssErrors = input.cssCounts?.error
    ?? input.cssMessages.length - cssWarnings - cssCompatibilityLimitations;
  const seoTotalIssues = input.seoTotalIssues ?? input.seoIssues.length;
  const seoTruncated = input.seoTruncated ?? seoTotalIssues > input.seoIssues.length;
  const schemaTotalIssues = input.schemaTotalIssues ?? input.schemaIssues.length;
  const schemaTruncated = input.schemaTruncated ?? schemaTotalIssues > input.schemaIssues.length;
  const seoErrors = input.seoCounts?.error ?? input.seoIssues.filter((issue) => issue.severity === "error").length;
  const seoWarnings = input.seoCounts?.warning ?? input.seoIssues.filter((issue) => issue.severity === "warning").length;
  const schemaErrors = input.schemaCounts?.error ?? input.schemaIssues.filter((issue) => issue.severity === "error").length;
  const brokenLinks = input.links.filter((link) => !link.ok).length;
  const redirectLinks = input.links.filter(isRedirect).length;

  const htmlScore = checkFailed("html") ? null : clampScore(100 - htmlErrors * 15 - htmlWarnings * 2);
  const cssScore = checkFailed("css") || !input.cssAudited || cssCompatibilityLimitations > 0
    ? null
    : clampScore(100 - cssErrors * 20);
  const seoScore = checkFailed("seo") || checkFailed("schema")
    ? null
    : clampScore(100 - seoErrors * 15 - seoWarnings * 4 - schemaErrors * 15);
  const linkScore = checkFailed("links") || input.links.length === 0
    ? null
    : clampScore(100 - brokenLinks * 25);
  const auditedScores = [htmlScore, seoScore, cssScore, linkScore].filter(
    (score): score is number => score !== null,
  );
  const overallScore = failedChecks.length > 0 || cssCompatibilityLimitations > 0 || auditedScores.length === 0
    ? null
    : Math.round(auditedScores.reduce((total, score) => total + score, 0) / auditedScores.length);

  const summary: ValidationReportSummary = {
    overallScore,
    htmlScore,
    cssScore,
    seoScore,
    linkScore,
    htmlErrors,
    htmlWarnings,
    cssErrors,
    cssWarnings,
    cssCompatibilityLimitations,
    seoErrors,
    seoWarnings,
    schemaErrors,
    linksChecked: input.links.length,
    brokenLinks,
  };

  const report: string[] = [
    `# Web Validation & SEO Audit Report — ${overallScore === null ? "Partial" : `${scoreIndicator(overallScore)} **${overallScore}**/100`}`,
    `*Generated for: \`${markdownCell(path.basename(input.htmlFilePath))}\`*`,
    "",
    "## Page health scores",
    "",
    "| Audit | Status | Score |",
    "| :--- | :---: | :---: |",
    `| W3C HTML validation | ${htmlScore === null ? "Unavailable" : scoreIndicator(htmlScore)} | ${htmlScore === null ? "N/A" : `**${htmlScore}** / 100`} |`,
    `| CSS validation | ${cssScore === null ? (checkFailed("css") ? "Unavailable" : cssCompatibilityLimitations > 0 ? "Compatibility-limited" : "Not audited") : scoreIndicator(cssScore)} | ${cssScore === null ? "N/A" : `**${cssScore}** / 100`} |`,
    `| SEO and accessibility | ${seoScore === null ? "Unavailable" : scoreIndicator(seoScore)} | ${seoScore === null ? "N/A" : `**${seoScore}** / 100`} |`,
    `| Link integrity | ${linkScore === null ? (checkFailed("links") ? "Unavailable" : "No links checked") : scoreIndicator(linkScore)} | ${linkScore === null ? "N/A" : `**${linkScore}** / 100`} |`,
    "",
    "## Summary",
    "",
    `- HTML: ${htmlErrors} error(s), ${htmlWarnings} warning(s)` ,
    `- CSS: ${input.cssAudited ? `${cssErrors} error(s), ${cssWarnings} warning(s)${cssCompatibilityLimitations > 0 ? `, ${cssCompatibilityLimitations} known validator limitation(s)` : ""}` : "not audited"}`,
    `- SEO and accessibility: ${seoErrors} error(s), ${seoWarnings} warning(s)`,
    `- JSON-LD syntax: ${schemaErrors} error(s)`,
    `- Links: ${brokenLinks} broken or unreachable, ${redirectLinks} redirect${redirectLinks === 1 ? "" : "s"} to review of ${input.links.length} checked`,
    "",
    `## HTML diagnostics (${htmlTruncated ? `${input.htmlMessages.length} shown of ${htmlTotalMessages}` : htmlTotalMessages})`,
  ];

  if (failedChecks.length > 0) {
    report.splice(2, 0, "", "## Partial validation report", "The following checks were unavailable: " + failedChecks.join(", ") + ". Remaining checks completed.");
  }

  if (input.htmlMessages.length === 0) {
    report.push("No HTML validation diagnostics were returned.");
  } else {
    if (htmlTruncated) {
      report.push(`The structured HTML diagnostics are capped; showing the first ${input.htmlMessages.length} of ${htmlTotalMessages}. Summary counts and scoring use all returned Nu diagnostics.`);
    }
    report.push("", "| Line | Column | Severity | Message | Extract |", "| :---: | :---: | :--- | :--- | :--- |");
    for (const message of input.htmlMessages) {
      report.push(
        `| ${message.lastLine ?? "N/A"} | ${message.lastColumn ?? "N/A"} | ${markdownCell(getW3CMessageSeverity(message))} | ${markdownCell(message.message)} | ${markdownCell(message.extract ?? "N/A")} |`,
      );
    }
  }

  if (input.cssAudited) {
    report.push("", `## CSS diagnostics (${cssTruncated ? `${input.cssMessages.length} shown of ${cssTotalMessages}` : cssTotalMessages})`);
    if (input.cssMessages.length === 0) {
      report.push("No CSS validation errors or warnings were returned.");
    } else {
      if (cssTruncated) {
        report.push(`The structured CSS diagnostics are capped; showing the first ${input.cssMessages.length} of ${cssTotalMessages}. Summary counts and scoring use all returned Jigsaw diagnostics.`);
      }
      report.push("", "| Line | Severity | Context | Message |", "| :---: | :--- | :--- | :--- |");
      for (const message of input.cssMessages) {
        report.push(
          `| ${message.line} | ${markdownCell(message.compatibility === "known-validator-limitation" ? "known validator limitation" : message.type)} | ${markdownCell(message.context ?? "N/A")} | ${markdownCell(message.message)} |`,
        );
      }
      if (cssCompatibilityLimitations > 0) {
        report.push(
          "",
          `${cssCompatibilityLimitations} known validator limitation(s) match Jigsaw's current parser gap for the standards-defined \`@container\` rule. The original Jigsaw diagnostic is preserved, but CSS and overall scores are withheld because this upstream limitation can report valid modern CSS as invalid.`,
        );
      }
    }
  }

  const combinedIssues = [...input.seoIssues, ...input.schemaIssues];
  const combinedTotalIssues = seoTotalIssues + schemaTotalIssues;
  const combinedTruncated = seoTruncated || schemaTruncated;
  report.push(
    "",
    `## SEO, accessibility, and JSON-LD findings (${combinedTruncated ? `${combinedIssues.length} shown of ${combinedTotalIssues}` : combinedTotalIssues})`,
  );
  if (combinedIssues.length === 0) {
    report.push("No SEO, accessibility, or JSON-LD syntax findings were returned.");
  } else {
    if (seoTruncated) {
      report.push(`The structured SEO/accessibility findings are capped; showing the first ${input.seoIssues.length} of ${seoTotalIssues}. Summary counts and scoring use all findings.`);
    }
    if (schemaTruncated) {
      report.push(`The structured JSON-LD findings are capped; showing the first ${input.schemaIssues.length} of ${schemaTotalIssues}. Summary counts and scoring use all findings.`);
    }
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
    report.push("", "| URL | Status | Reachable | Details |", "| :--- | :---: | :---: | :--- |");
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
    htmlTotalMessages,
    htmlTruncated,
    cssMessages: input.cssMessages,
    cssTotalMessages,
    cssTruncated,
    seoIssues: input.seoIssues,
    seoTotalIssues,
    seoTruncated,
    schemaIssues: input.schemaIssues,
    schemaTotalIssues,
    schemaTruncated,
    links: input.links,
    failedChecks,
    ...(input.errors && input.errors.length > 0 ? { errors: input.errors } : {}),
  };
}
