import type { ValidationReport } from "./report.js";
import type { LinkStatus, SEOIssue } from "./seo-auditor.js";
import type { CSSMessage, W3CMessage } from "./w3c-validator.js";

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
  const actions = formatActions(options.actions ?? []);
  if (actions) {
    sections.push(`**Fix first**\n${actions}`);
  }
  sections.push(`**Next step:** ${collapseWhitespace(options.nextStep, 400)}`);
  return sections.join("\n\n");
}

export function htmlValidationContent(messages: W3CMessage[], source?: string): string {
  const errorCount = messages.filter((message) => message.type.toLowerCase() === "error").length;
  const otherCount = messages.length - errorCount;
  const sourceText = source ? ` for ${markdownCode(source, 180)}` : "";
  if (messages.length === 0) {
    return toolContent({
      title: "HTML validation",
      status: "clean",
      outcome: `The W3C validator returned no HTML diagnostics${sourceText}.`,
      nextStep: "Keep this result as a baseline and validate again after the next markup change.",
    });
  }

  return toolContent({
    title: "HTML validation",
    status: "attention needed",
    outcome: `The W3C validator returned ${countLabel(errorCount, "error")} and ${countLabel(otherCount, "other diagnostic")}${sourceText}.`,
    actions: messages.map((message) => ({
      priority: priorityForSeverity(message.type),
      message: message.message,
      location: formatLocation(message.lastLine ?? message.firstLine, message.lastColumn ?? message.firstColumn),
    })),
    nextStep: "Fix the errors in order, then rerun HTML validation to confirm the markup is clean.",
  });
}

export function cssValidationContent(messages: CSSMessage[]): string {
  if (messages.length === 0) {
    return toolContent({
      title: "CSS validation",
      status: "clean",
      outcome: "The W3C validator returned no CSS errors.",
      nextStep: "Validate again after the next stylesheet change.",
    });
  }

  return toolContent({
    title: "CSS validation",
    status: "attention needed",
    outcome: `The W3C validator returned ${countLabel(messages.length, "CSS error")}.`,
    actions: messages.map((message) => ({
      priority: 0,
      message: message.context ? `${message.message} Context: ${message.context}` : message.message,
      location: formatLocation(message.line),
    })),
    nextStep: "Correct the first errors, then rerun CSS validation because one syntax issue can cause later diagnostics.",
  });
}

export function seoAuditContent(issues: SEOIssue[], totalIssues: number, truncated: boolean): string {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const info = issues.filter((issue) => issue.severity === "info").length;
  if (totalIssues === 0) {
    return toolContent({
      title: "SEO audit",
      status: "clean within this audit",
      outcome: "This focused rules-based audit found no SEO or accessibility issues in the supplied HTML.",
      nextStep: "Keep the metadata current and rerun the audit whenever the page template changes.",
      note: "This result does not replace a crawl, performance test, or Search Console review.",
    });
  }

  return toolContent({
    title: "SEO audit",
    status: "attention needed",
    outcome: `The audit found ${countLabel(errors, "error")}, ${countLabel(warnings, "warning")}, and ${countLabel(info, "suggestion")}.`,
    actions: issues.map((issue) => ({
      priority: priorityForSeverity(issue.severity),
      message: issue.message,
      location: issue.element ? collapseWhitespace(issue.element, 120) : undefined,
    })),
    nextStep: "Address errors first, then warnings, and rerun the audit after updating the page.",
    note: truncated
      ? `Showing the first ${issues.length} of ${totalIssues} findings in structured output.`
      : undefined,
  });
}

function countJsonLdBlocks(htmlContent: string): number {
  const matches = htmlContent.match(
    /<script\b(?=[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json\b))[^>]*>/gi,
  );
  return matches?.length ?? 0;
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
  if (typeof link.status === "number" && link.status >= 300 && link.status < 400) return 1;
  return 0;
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

  const unhealthy = links.filter((link) => !link.ok);
  if (unhealthy.length === 0) {
    return toolContent({
      title: "Link check",
      status: "clean",
      outcome: links.length === 1
        ? "The checked link returned a successful response."
        : `All ${links.length} checked links returned a successful response.`,
      nextStep: "Recheck periodically because external link availability can change.",
    });
  }

  return toolContent({
    title: "Link check",
    status: "attention needed",
    outcome: `${countLabel(unhealthy.length, "link")} of ${links.length} checked ${unhealthy.length === 1 ? "needs" : "need"} attention. Redirects are reported but not followed.`,
    actions: unhealthy.map((link) => ({
      priority: linkPriority(link),
      location: link.url,
      message: `${typeof link.status === "number" ? `HTTP ${link.status}` : link.status}${link.message ? ` — ${link.message}` : ""}`,
    })),
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
      priority: priorityForSeverity(message.type),
      message: `HTML: ${message.message}`,
      location: formatLocation(message.lastLine ?? message.firstLine, message.lastColumn ?? message.firstColumn),
    })),
    ...reportData.cssMessages.map((message) => ({
      priority: 0 as const,
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
      .filter((link) => !link.ok)
      .map((link) => ({
        priority: linkPriority(link),
        message: `Link returned ${typeof link.status === "number" ? `HTTP ${link.status}` : link.status}${link.message ? ` — ${link.message}` : ""}`,
        location: link.url,
      })),
  ];
}

export function reportContent(reportData: ValidationReportResult): string {
  const { summary } = reportData;
  const actions = reportActionItems(reportData);
  const hasActionableFinding = actions.some((action) => action.priority < 2);
  const status = actions.length === 0
    ? "clean across completed checks"
    : hasActionableFinding
      ? "attention needed"
      : "review suggested";
  const cssSummary = summary.cssScore === null
    ? "CSS not audited"
    : countLabel(summary.cssErrors, "CSS error");
  const linkSummary = summary.linkScore === null
    ? "no eligible links checked"
    : `${summary.brokenLinks} of ${countLabel(summary.linksChecked, "link")} ${summary.brokenLinks === 1 ? "needs" : "need"} attention`;
  return toolContent({
    title: "Validation report",
    status,
    outcome: `The report's heuristic overall score is **${summary.overallScore}/100**. HTML has ${countLabel(summary.htmlErrors, "error")} and ${countLabel(summary.htmlWarnings, "other diagnostic")}; ${cssSummary}; SEO has ${countLabel(summary.seoErrors, "error")} and ${countLabel(summary.seoWarnings, "warning")}; JSON-LD has ${countLabel(summary.schemaErrors, "syntax error")}; ${linkSummary}.`,
    actions,
    nextStep: actions.length === 0
      ? "Use the full Markdown report as the audit record and rerun it after meaningful page changes."
      : "Work through these priorities, then regenerate the report to compare the heuristic score.",
    note: "The score is a triage heuristic based on these checks, not a Lighthouse score or a search-ranking prediction.",
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
