import * as cheerio from "cheerio";
import type { ValidationReport } from "./report.js";
import { isHttpRedirectStatus, type AuditCounts, type LinkStatus, type SEOIssue } from "./seo-auditor.js";
import {
  getW3CMessageSeverity,
  type CSSMessage,
  type W3CMessage,
} from "./w3c-validator.js";

type ActionPriority = 0 | 1 | 2;

interface ActionItem {
  message: string;
  priority: ActionPriority;
  location?: string;
}

interface ValidationReportResult extends ValidationReport {
  errors?: string[];
}

function collapseWhitespace(value: string, maxLength = 240): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Escapes untrusted text while leaving the surrounding, controlled Markdown intact. */
function markdownText(value: string, maxLength = 240): string {
  return collapseWhitespace(value, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]{}()#+\-.!|~])/g, "\\$1");
}

/** Wraps untrusted identifiers and paths in a code span that cannot be closed by their content. */
function markdownCode(value: string, maxLength = 240): string {
  const collapsed = collapseWhitespace(value, maxLength);
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(collapsed.matchAll(/`+/g), (match) => match[0].length),
  );
  const delimiter = "`".repeat(longestBacktickRun + 1);
  const content = collapsed.startsWith("`") || collapsed.endsWith("`")
    ? ` ${collapsed} `
    : collapsed;
  return `${delimiter}${content}${delimiter}`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function priorityForSeverity(severity: string): ActionPriority {
  if (severity.toLowerCase() === "error") return 0;
  if (severity.toLowerCase() === "warning") return 1;
  return 2;
}

function formatLocation(line?: number, column?: number): string | undefined {
  if (line === undefined && column === undefined) return undefined;
  if (line === undefined) return `column ${column}`;
  if (column === undefined) return `line ${line}`;
  return `line ${line}, column ${column}`;
}

function formatActions(items: ActionItem[]): string | undefined {
  const prioritized = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.priority - right.item.priority || left.index - right.index)
    .slice(0, 3)
    .map(({ item }) => {
      const label = item.priority === 0 ? "Error" : item.priority === 1 ? "Warning" : "Check";
      const location = item.location
        ? ` · ${markdownCode(item.location, 120)}`
        : "";
      return `- **${label}**${location}: ${markdownText(item.message)}`;
    });

  return prioritized.length > 0 ? prioritized.join("\n") : undefined;
}

function toolContent(options: {
  title: string;
  status: string;
  outcome: string;
  nextStep: string;
  actions?: ActionItem[];
  note?: string;
}): string {
  const sections = [
    `### ${options.title}: ${options.status}`,
    collapseWhitespace(options.outcome, 500),
  ];
  if (options.note) {
    sections.push(collapseWhitespace(options.note, 500));
  }
  const actionItems = options.actions ?? [];
  const actions = formatActions(actionItems);
  if (actions) {
    const hasActionableItem = actionItems.some((item) => item.priority < 2);
    const actionHeading = options.status === "review suggested" || !hasActionableItem ? "Review" : "Fix first";
    sections.push(`**${actionHeading}**\n${actions}`);
  }
  sections.push(`**Next step:** ${collapseWhitespace(options.nextStep, 400)}`);
  return sections.join("\n\n");
}

export function htmlValidationContent(
  messages: W3CMessage[],
  source?: string,
  totalMessages = messages.length,
  counts?: { error: number; warning: number; info: number },
): string {
  const errorCount = counts?.error
    ?? messages.filter((message) => getW3CMessageSeverity(message) === "error").length;
  const warningCount = counts?.warning
    ?? messages.filter((message) => getW3CMessageSeverity(message) === "warning").length;
  const infoCount = counts?.info ?? Math.max(0, totalMessages - errorCount - warningCount);
  const sourceText = source ? ` for ${markdownCode(source, 180)}` : "";
  if (totalMessages === 0) {
    return toolContent({
      title: "HTML validation",
      status: "clean",
      outcome: `The W3C validator returned no HTML diagnostics${sourceText}.`,
      nextStep: "Keep this result as a baseline and validate again after the next markup change.",
    });
  }

  const hasActionableDiagnostics = errorCount > 0 || warningCount > 0;
  return toolContent({
    title: "HTML validation",
    status: hasActionableDiagnostics ? "attention needed" : "review suggested",
    outcome: `The W3C validator returned ${countLabel(errorCount, "error")}, ${countLabel(warningCount, "warning")}, and ${countLabel(infoCount, "informational diagnostic")}${sourceText}.`,
    actions: messages.map((message) => ({
      priority: priorityForSeverity(getW3CMessageSeverity(message)),
      message: message.message,
      location: formatLocation(message.lastLine ?? message.firstLine, message.lastColumn ?? message.firstColumn),
    })),
    nextStep: hasActionableDiagnostics
      ? "Fix errors first, then warnings, and rerun HTML validation to confirm the markup is clean."
      : "Review the informational diagnostics, then rerun validation after relevant markup changes.",
    note: totalMessages > messages.length
      ? `Showing the first ${messages.length} of ${totalMessages} HTML diagnostics in structured output; severity totals include all returned Nu diagnostics.`
      : undefined,
  });
}

export function cssValidationContent(
  messages: CSSMessage[],
  totalMessages = messages.length,
  counts?: { error: number; compatibilityLimitation: number },
): string {
  if (totalMessages === 0) {
    return toolContent({
      title: "CSS validation",
      status: "clean",
      outcome: "The W3C validator returned no CSS errors.",
      nextStep: "Validate again after the next stylesheet change.",
    });
  }

  const compatibilityLimitations = messages.filter(
    (message) => message.compatibility === "known-validator-limitation",
  );
  const compatibilityLimitationCount = counts?.compatibilityLimitation ?? compatibilityLimitations.length;
  const actionableErrors = counts?.error ?? messages.length - compatibilityLimitations.length;

  return toolContent({
    title: "CSS validation",
    status: actionableErrors > 0 ? "attention needed" : "review suggested",
    outcome: compatibilityLimitationCount > 0
      ? `The W3C validator returned ${countLabel(totalMessages, "CSS diagnostic")}; ${countLabel(compatibilityLimitationCount, "diagnostic")} ${compatibilityLimitationCount === 1 ? "matches" : "match"} a known validator limitation.`
      : `The W3C validator returned ${countLabel(actionableErrors, "CSS error")}.`,
    actions: messages.map((message) => ({
      priority: message.compatibility === "known-validator-limitation" ? 2 : 0,
      message: message.context ? `${message.message} Context: ${message.context}` : message.message,
      location: formatLocation(message.line),
    })),
    nextStep: actionableErrors > 0
      ? "Correct the actionable errors, then rerun CSS validation because one syntax issue can cause later diagnostics."
      : "Review the marked @container diagnostic against current CSS specifications; do not treat it as invalid CSS by itself.",
    note: [
      compatibilityLimitationCount > 0
        ? "Jigsaw currently does not recognize the standards-defined @container rule. The upstream diagnostic is preserved and marked as a known validator limitation."
        : undefined,
      totalMessages > messages.length
        ? `Showing the first ${messages.length} of ${totalMessages} CSS diagnostics in structured output; summary counts include all returned Jigsaw diagnostics.`
        : undefined,
    ].filter(Boolean).join(" ") || undefined,
  });
}

export function seoAuditContent(
  issues: SEOIssue[],
  totalIssues: number,
  truncated: boolean,
  counts?: AuditCounts,
): string {
  const errors = counts?.error ?? issues.filter((issue) => issue.severity === "error").length;
  const warnings = counts?.warning ?? issues.filter((issue) => issue.severity === "warning").length;
  const info = counts?.info ?? issues.filter((issue) => issue.severity === "info").length;
  if (totalIssues === 0) {
    return toolContent({
      title: "SEO audit",
      status: "clean within this audit",
      outcome: "This focused rules-based audit found no SEO or accessibility issues in the supplied HTML.",
      nextStep: "Keep the metadata current and rerun the audit whenever the page template changes.",
      note: "This result does not replace a crawl, performance test, or Search Console review.",
    });
  }

  const hasActionableFindings = errors > 0 || warnings > 0;
  return toolContent({
    title: "SEO audit",
    status: hasActionableFindings ? "attention needed" : "review suggested",
    outcome: `The audit found ${countLabel(errors, "error")}, ${countLabel(warnings, "warning")}, and ${countLabel(info, "suggestion")}.`,
    actions: issues.map((issue) => ({
      priority: priorityForSeverity(issue.severity),
      message: issue.message,
      location: issue.element ? collapseWhitespace(issue.element, 120) : undefined,
    })),
    nextStep: hasActionableFindings
      ? "Address errors first, then warnings, and rerun the audit after updating the page."
      : "Review the suggestions that apply to this page, then rerun the audit after relevant template changes.",
    note: truncated
      ? `Showing the first ${issues.length} of ${totalIssues} findings in structured output.`
      : undefined,
  });
}

function countJsonLdBlocks(htmlContent: string): number {
  const $ = cheerio.load(htmlContent);
  return $("script[type]").filter((_, element) => {
    const type = $(element).attr("type");
    return type?.split(";", 1)[0].trim().toLowerCase() === "application/ld+json";
  }).length;
}

export function schemaValidationContent(
  issues: SEOIssue[],
  totalIssues: number,
  truncated: boolean,
  htmlContent: string,
): string {
  const blockCount = countJsonLdBlocks(htmlContent);
  if (blockCount === 0) {
    return toolContent({
      title: "JSON-LD syntax",
      status: "not present",
      outcome: "No JSON-LD script blocks were found, so there was no structured data to parse.",
      nextStep: "Add JSON-LD only when it accurately describes visible page content, then validate it again.",
    });
  }
  if (totalIssues === 0) {
    return toolContent({
      title: "JSON-LD syntax",
      status: "clean",
      outcome: `${countLabel(blockCount, "JSON-LD block")} parsed without syntax errors.`,
      nextStep: "Verify the properties against the relevant Schema.org type and search-engine requirements.",
      note: "This check covers JSON syntax only; it does not validate vocabulary semantics or rich-result eligibility.",
    });
  }

  return toolContent({
    title: "JSON-LD syntax",
    status: "attention needed",
    outcome: `${countLabel(totalIssues, "syntax issue")} ${totalIssues === 1 ? "was" : "were"} found across ${countLabel(blockCount, "JSON-LD block")}.`,
    actions: issues.map((issue) => ({
      priority: priorityForSeverity(issue.severity),
      message: issue.message,
    })),
    nextStep: "Repair the invalid or empty blocks, then rerun this syntax check before testing rich-result eligibility.",
    note: truncated
      ? `Showing the first ${issues.length} of ${totalIssues} findings in structured output.`
      : undefined,
  });
}

function linkPriority(link: LinkStatus): ActionPriority {
  if (isRedirect(link)) return 1;
  return 0;
}

function isRedirect(link: LinkStatus): boolean {
  return isHttpRedirectStatus(link.status);
}

function linkActionMessage(link: LinkStatus): string {
  if (isRedirect(link)) {
    return `${link.status} redirect; destination was not followed`;
  }
  return `Link returned ${typeof link.status === "number" ? `HTTP ${link.status}` : link.status}${link.message ? ` — ${link.message}` : ""}`;
}

export function linkCheckContent(links: LinkStatus[], baseUrl?: string): string {
  if (links.length === 0) {
    return toolContent({
      title: "Link check",
      status: "nothing checked",
      outcome: "No eligible public HTTP(S) links were found, so no link requests were made.",
      nextStep: baseUrl
        ? "Confirm the HTML contains reachable anchor URLs, then run the check again."
        : "If the page uses relative links, provide its public base URL and run the check again.",
    });
  }

  const unreachable = links.filter((link) => !link.ok);
  const redirects = links.filter(isRedirect);
  if (unreachable.length === 0 && redirects.length === 0) {
    return toolContent({
      title: "Link check",
      status: "clean",
      outcome: links.length === 1
        ? "The checked link returned a reachable response."
        : `All ${links.length} checked links returned reachable responses.`,
      nextStep: "Recheck periodically because external link availability can change.",
    });
  }

  const actions = [
    ...unreachable,
    ...redirects,
  ].map((link) => ({
    priority: linkPriority(link),
    location: link.url,
    message: linkActionMessage(link),
  }));

  const linkOutcome = [
    unreachable.length > 0
      ? `${countLabel(unreachable.length, "link")} ${unreachable.length === 1 ? "is" : "are"} broken or unreachable`
      : "no checked links are broken or unreachable",
    redirects.length > 0
      ? `${countLabel(redirects.length, "redirect")} ${redirects.length === 1 ? "needs" : "need"} review`
      : undefined,
  ].filter((item): item is string => item !== undefined).join("; ");

  return toolContent({
    title: "Link check",
    status: unreachable.length > 0 ? "attention needed" : "review suggested",
    outcome: `${linkOutcome} of ${links.length} checked. Redirect destinations are not followed.`,
    actions,
    nextStep: "Update failed destinations and review redirects, then rerun the link check.",
  });
}

function reportActionItems(reportData: ValidationReportResult): ActionItem[] {
  return [
    ...(reportData.errors ?? []).map((message) => ({
      priority: 0 as const,
      message,
    })),
    ...reportData.htmlMessages.map((message) => ({
      priority: priorityForSeverity(getW3CMessageSeverity(message)),
      message: `HTML: ${message.message}`,
      location: formatLocation(message.lastLine ?? message.firstLine, message.lastColumn ?? message.firstColumn),
    })),
    ...reportData.cssMessages.map((message) => ({
      priority: message.compatibility === "known-validator-limitation" ? 2 as const : 0 as const,
      message: `CSS: ${message.message}`,
      location: formatLocation(message.line),
    })),
    ...reportData.seoIssues.map((issue) => ({
      priority: priorityForSeverity(issue.severity),
      message: `${issue.category}: ${issue.message}`,
      location: issue.element ? collapseWhitespace(issue.element, 120) : undefined,
    })),
    ...reportData.schemaIssues.map((issue) => ({
      priority: priorityForSeverity(issue.severity),
      message: `JSON-LD: ${issue.message}`,
    })),
    ...reportData.links
      .filter((link) => !link.ok || isRedirect(link))
      .map((link) => ({
        priority: linkPriority(link),
        message: linkActionMessage(link),
        location: link.url,
      })),
  ];
}

export function reportContent(reportData: ValidationReportResult): string {
  const { summary } = reportData;
  const actions = reportActionItems(reportData);
  const partial = reportData.failedChecks.length > 0;
  const compatibilityLimited = summary.cssCompatibilityLimitations > 0;
  const hasActionableFinding = actions.some((action) => action.priority < 2);
  const status = partial
    ? "partial"
    : compatibilityLimited
      ? "compatibility-limited"
      : actions.length === 0
        ? "clean across completed checks"
        : hasActionableFinding
          ? "attention needed"
          : "review suggested";
  const cssSummary = summary.cssScore === null
    ? reportData.failedChecks.includes("css")
      ? "CSS validation unavailable"
      : compatibilityLimited
        ? `${countLabel(summary.cssErrors, "CSS error")}; ${countLabel(summary.cssCompatibilityLimitations, "known validator limitation")}`
        : "CSS not audited"
    : countLabel(summary.cssErrors, "CSS error");
  const redirects = reportData.links.filter(isRedirect).length;
  const linkSummary = summary.linkScore === null
    ? reportData.failedChecks.includes("links")
      ? "link checking unavailable"
      : "no eligible links checked"
    : `${summary.brokenLinks} broken or unreachable and ${countLabel(redirects, "redirect")} to review of ${countLabel(summary.linksChecked, "link")}`;
  const checkLabels = {
    input: "input file",
    html: "HTML validation",
    css: "CSS validation",
    seo: "SEO analysis",
    schema: "JSON-LD analysis",
    links: "link checking",
  } as const;
  const unavailableChecks = reportData.failedChecks
    .filter((check) => check !== "input")
    .map((check) => checkLabels[check]);
  const scoreNote = "The score is a triage heuristic based on these checks, not a Lighthouse score or a search-ranking prediction.";
  const truncationNote = [
    reportData.htmlTruncated
      ? `Showing the first ${reportData.htmlMessages.length} of ${reportData.htmlTotalMessages} HTML diagnostics; HTML summary counts and scoring include all returned Nu diagnostics.`
      : undefined,
    reportData.cssTruncated
      ? `Showing the first ${reportData.cssMessages.length} of ${reportData.cssTotalMessages} CSS diagnostics; CSS summary counts and scoring include all returned Jigsaw diagnostics.`
      : undefined,
    reportData.seoTruncated
      ? `Showing the first ${reportData.seoIssues.length} of ${reportData.seoTotalIssues} SEO findings; SEO summary counts and scoring include all findings.`
      : undefined,
    reportData.schemaTruncated
      ? `Showing the first ${reportData.schemaIssues.length} of ${reportData.schemaTotalIssues} JSON-LD findings; JSON-LD summary counts and scoring include all findings.`
      : undefined,
  ].filter(Boolean).join(" ") || undefined;
  return toolContent({
    title: "Validation report",
    status,
    outcome: partial
      ? `Partial validation report: ${unavailableChecks.join(", ")} ${unavailableChecks.length === 1 ? "was" : "were"} unavailable; remaining checks completed. HTML has ${countLabel(summary.htmlErrors, "error")}; ${cssSummary}; SEO has ${countLabel(summary.seoErrors, "error")}; JSON-LD has ${countLabel(summary.schemaErrors, "syntax error")}; ${linkSummary}.`
      : compatibilityLimited
        ? `The overall heuristic score is withheld because CSS validation includes ${countLabel(summary.cssCompatibilityLimitations, "known validator limitation")}. HTML has ${countLabel(summary.htmlErrors, "error")} and ${countLabel(summary.htmlWarnings, "warning")}; ${cssSummary}; SEO has ${countLabel(summary.seoErrors, "error")} and ${countLabel(summary.seoWarnings, "warning")}; JSON-LD has ${countLabel(summary.schemaErrors, "syntax error")}; ${linkSummary}.`
        : `The report's heuristic overall score is **${summary.overallScore}/100**. HTML has ${countLabel(summary.htmlErrors, "error")} and ${countLabel(summary.htmlWarnings, "warning")}; ${cssSummary}; SEO has ${countLabel(summary.seoErrors, "error")} and ${countLabel(summary.seoWarnings, "warning")}; JSON-LD has ${countLabel(summary.schemaErrors, "syntax error")}; ${linkSummary}.`,
    actions,
    nextStep: partial
      ? "Review the completed findings, then retry the unavailable checks."
      : compatibilityLimited
        ? "Review actionable findings normally, and treat the marked @container diagnostic as an upstream validator limitation rather than proof of invalid CSS."
        : actions.length === 0
          ? "Use the full Markdown report as the audit record and rerun it after meaningful page changes."
          : "Work through these priorities, then regenerate the report to compare the heuristic score.",
    note: partial
      ? ["No overall score is shown while one or more checks are unavailable.", truncationNote].filter(Boolean).join(" ")
      : compatibilityLimited
        ? ["CSS and overall scores are withheld while a known Jigsaw parser limitation is present; the original upstream diagnostic remains visible.", truncationNote].filter(Boolean).join(" ")
        : [scoreNote, truncationNote].filter(Boolean).join(" "),
  });
}

export function screenshotCaptureContent(count: number, outputDirectory: string): string {
  return toolContent({
    title: "Screenshot capture",
    status: "complete",
    outcome: `Saved ${countLabel(count, "PNG screenshot")} to ${markdownCode(outputDirectory)}.`,
    nextStep: "Open the PNG files and compare the rendered layouts at each requested viewport.",
  });
}

export function failureContent(title: string, error: string, nextStep: string): string {
  return toolContent({
    title,
    status: "could not finish",
    outcome: markdownText(error, 500),
    nextStep,
  });
}
