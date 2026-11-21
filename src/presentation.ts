import * as cheerio from "cheerio";
import type { ValidationReport } from "./report.js";
import type { SameLanguageDuplicateAnalysis } from "./modules/content-schema/same-language-duplicates.js";
import type { PageContentQualityAnalysis } from "./modules/content-schema/empty-boilerplate-content.js";
import type { ProductClaimResult } from "./modules/content-schema/product-claims.js";
import type { ProvenanceResult } from "./modules/content-schema/citation-methodology-consistency.js";
import type { IntentComparison } from "./modules/content-schema/competitor-intent-comparison.js";
import type { SupportedSchemaReview } from "./modules/content-schema/structured-data-validation.js";
import type { InternalLinkReview } from "./modules/site-architecture/internal-link-quality.js";
import type { MetadataReview } from "./modules/content-schema/metadata-consistency.js";
import type { MediaDiagnostics } from "./modules/browser-ux/media-diagnostics.js";
import type { WcagInteractionReview } from "./modules/browser-ux/wcag-interactions.js";
import type { HttpDirectiveReview } from "./modules/http-crawl/non-html-directives.js";
import type { HttpsSecurityReview } from "./modules/http-crawl/https-security.js";
import type { UrlVariantReview } from "./modules/http-crawl/url-variants.js";
import type { HistoricalReview } from "./modules/change-regression/historical-comparisons.js";
import type { ProductionChangeReview } from "./modules/change-regression/production-change-comparison.js";
import type { LabReview } from "./modules/browser-ux/lighthouse-lab.js";
import type { MonitorPreview } from "./modules/change-regression/regression-alerts.js";
import type { MultilingualClusterAnalysis } from "./modules/site-architecture/multilingual-clusters.js";
import { isHttpRedirectStatus, isUnverifiedLinkStatus, type AuditCounts, type LinkStatus, type SEOIssue } from "./seo-auditor.js";
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
  // Validator text is untrusted; terminal and bidi controls survive whitespace folding.
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  counts?: { error: number; warning?: number; compatibilityLimitation: number },
): string {
  if (totalMessages === 0) {
    return toolContent({
      title: "CSS validation",
      status: "clean",
      outcome: "The W3C validator returned no CSS errors or warnings.",
      nextStep: "Validate again after the next stylesheet change.",
    });
  }

  const compatibilityLimitations = messages.filter(
    (message) => message.compatibility === "known-validator-limitation",
  );
  const compatibilityLimitationCount = counts?.compatibilityLimitation ?? compatibilityLimitations.length;
  const warningCount = counts?.warning
    ?? messages.filter((message) => message.type.toLowerCase() === "warning").length;
  const actionableErrors = counts?.error
    ?? messages.filter(
      (message) => message.type.toLowerCase() !== "warning"
        && message.compatibility !== "known-validator-limitation",
    ).length;

  return toolContent({
    title: "CSS validation",
    status: actionableErrors > 0 ? "attention needed" : "review suggested",
    outcome: `The W3C validator returned ${countLabel(actionableErrors, "CSS error")}, ${countLabel(warningCount, "CSS warning")}, and ${countLabel(compatibilityLimitationCount, "known validator limitation")}.`,
    actions: messages.map((message) => ({
      priority: message.compatibility === "known-validator-limitation"
        ? 2
        : priorityForSeverity(message.type),
      message: message.context ? `${message.message} Context: ${message.context}` : message.message,
      location: formatLocation(message.line),
    })),
    nextStep: actionableErrors > 0
      ? "Correct the actionable errors, review warnings, then rerun CSS validation because one syntax issue can cause later diagnostics."
      : warningCount > 0
        ? "Review the warnings, then rerun CSS validation after relevant stylesheet changes."
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
    // Match the schema parser: scripts in inert template contents are not executed.
    let ancestor: { name?: string; parent?: unknown } | null = element;
    while (ancestor) {
      if (ancestor.name?.toLowerCase() === "template") return false;
      ancestor = (ancestor.parent ?? null) as typeof ancestor;
    }
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
  if (isUnverifiedLinkStatus(link.status)) return 2;
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
  if (isUnverifiedLinkStatus(link.status)) {
    return `Link could not be verified (${link.status})${link.message ? ` — ${link.message}` : ""}`;
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

  const unreachable = links.filter((link) => !link.ok && !isUnverifiedLinkStatus(link.status));
  const unverified = links.filter((link) => !link.ok && isUnverifiedLinkStatus(link.status));
  const redirects = links.filter(isRedirect);
  if (unreachable.length === 0 && unverified.length === 0 && redirects.length === 0) {
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
    ...unverified,
    ...redirects,
  ].map((link) => ({
    priority: linkPriority(link),
    location: link.url,
    message: linkActionMessage(link),
  }));

  const linkOutcome = [
    unreachable.length > 0
      ? `${countLabel(unreachable.length, "link")} ${unreachable.length === 1 ? "returned an HTTP failure" : "returned HTTP failures"}`
      : "no confirmed HTTP failures",
    unverified.length > 0
      ? `${countLabel(unverified.length, "check")} unverified`
      : undefined,
    redirects.length > 0
      ? `${countLabel(redirects.length, "redirect")} ${redirects.length === 1 ? "needs" : "need"} review`
      : undefined,
  ].filter((item): item is string => item !== undefined).join("; ");

  return toolContent({
    title: "Link check",
    status: unreachable.length > 0 ? "attention needed" : unverified.length > 0 ? "partial" : "review suggested",
    outcome: `${linkOutcome} of ${links.length} checked. Redirect destinations are not followed.`,
    actions,
    nextStep: unverified.length > 0
      ? "Review confirmed HTTP failures and redirects; retry unverified links only if public and permitted."
      : "Update failed destinations and review redirects, then rerun the link check.",
  });
}

export function contentDuplicateContent(analysis: SameLanguageDuplicateAnalysis): string {
  const matches = analysis.pairs;
  const coverage = `${analysis.eligible_pages}/${analysis.sampled_pages} sampled pages had usable main content and a known language`;
  return toolContent({
    title: "Same-language main-content comparison",
    status: matches.length ? "attention needed" : analysis.coverage_limited ? "partial" : "clean",
    outcome: analysis.total_pairs
      ? `${countLabel(analysis.total_pairs, "duplicate-content pair")} found in the sampled pages; ${coverage}.`
      : `No duplicate main-content pairs found; ${coverage}. This is not evidence of site-wide uniqueness.`,
    actions: matches.map((pair) => ({
      priority: pair.kind === "exact" ? 1 : 2,
      location: `${pair.first_url} vs ${pair.second_url}`,
      message: `${pair.kind === "exact" ? "Exact" : "Near"} ${pair.language} main-text match (${pair.similarity_percent}%, ${pair.confidence}).`,
    })),
    nextStep: analysis.pairs_truncated
      ? "More matches exist than the result cap; review these pairs and repeat on a narrower page sample."
      : "Review matched pages manually; this static-text comparison cannot infer search-engine canonicalization or semantic equivalence.",
  });
}

export function contentQualityContent(analysis: PageContentQualityAnalysis): string {
  return toolContent({
    title: "Sampled main-content quality review",
    status: analysis.total_findings ? "attention needed" : analysis.coverage_limited ? "partial" : "clean",
    outcome: analysis.total_findings
      ? `${countLabel(analysis.total_findings, "potential content-quality finding")} across ${analysis.eligible_pages}/${analysis.sampled_pages} sampled pages.`
      : `No checked content-quality signals were found across ${analysis.eligible_pages}/${analysis.sampled_pages} sampled pages. This is not a usefulness or site-wide verdict.`,
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: finding.example_urls.join(", "),
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: analysis.findings_truncated
      ? "More review findings exist than the preview cap. Inspect the affected page families and narrow the sample."
      : "Inspect flagged pages in a browser, verify their purpose and unique value, then rerun the bounded comparison.",
  });
}

export function productClaimContent(analysis: ProductClaimResult): string {
  return toolContent({
    title: "Landing-page promises versus registered MCP tools",
    status: analysis.contradicted_claims > 0 ? "attention needed"
      : analysis.coverage_limited ? "partial" : "clean",
    outcome: analysis.catalog_available
      ? analysis.checked_claims + " explicit or bounded claims checked; " +
        analysis.consistent_claims + " consistent with the registered " + analysis.surface +
        " tool catalog, " + analysis.contradicted_claims + " contradicted and " +
        analysis.unverified_claims + " unverified."
      : "The MCP tool registry was unavailable, so no claim is verified.",
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: finding.claim,
      message: finding.message,
    })),
    nextStep: "Confirm any discrepancies against current tools/list output and exercise the affected tool. Registry exposure is not proof of successful behavior.",
  });
}

export function provenanceContent(analysis: ProvenanceResult): string {
  return toolContent({
    title: "Citation, dataset, freshness and methodology evidence",
    status: analysis.conflicting_declarations > 0 ? "attention needed"
      : analysis.coverage_limited ? "partial" : "clean",
    outcome: `${analysis.consistent_declarations} declarations agree with supplied or on-page evidence, ` +
      `${analysis.conflicting_declarations} have observed inconsistencies, ` +
      `${analysis.unverified_declarations} remain unverified ` +
      `across ${analysis.pages_eligible}/${analysis.pages_sampled} supplied pages.`,
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: finding.page_url,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: analysis.findings_truncated
      ? "More evidence findings exist than the result cap; inspect sources and compare smaller authorized page batches."
      : "Verify the underlying sources, dataset release and methodology independently before asserting factual accuracy or current freshness.",
  });
}

export function intentComparisonContent(analysis: IntentComparison): string {
  return toolContent({
    title: "Competitor search-intent evidence comparison",
    status: analysis.findings.some((finding) => finding.severity === "warning")
      ? "attention needed" : "partial",
    outcome: `${analysis.competitors_eligible}/${analysis.competitors_submitted} competitor pages compared from supplied static HTML` +
      (analysis.expected_intent ? `; selected intent: ${analysis.expected_intent}` : "; no explicit intent selected") +
      ". This does not predict Google rankings or semantic relevance.",
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Review the indicated headings and static structured signals, check page purpose manually, and use authorized search or analytics data before drawing competitive SEO conclusions.",
  });
}

export function supportedSchemaContent(analysis: SupportedSchemaReview): string {
  return toolContent({
    title: "Supported JSON-LD structural review",
    status: analysis.errors > 0 || analysis.warnings > 0 ? "attention needed" : "partial",
    outcome: `${analysis.supported_nodes} recognized node profiles across ${analysis.blocks_checked}/${analysis.blocks_seen} inspected JSON-LD blocks; ` +
      `${analysis.errors} syntax/document errors, ${analysis.warnings} review warnings, ${analysis.unverified} unresolved signals. ` +
      "This does not determine rich-result eligibility.",
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "error" ? 0 : finding.severity === "warning" ? 1 : 2,
      location: `JSON-LD block ${finding.block}, node ${finding.node}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: analysis.findings_truncated
      ? "Review the first prioritized findings and rerun a smaller supported JSON-LD sample for the rest."
      : "Review structural findings, then use the official Rich Results Test and inspect page content for actual feature eligibility.",
  });
}

export function internalLinkContent(analysis: InternalLinkReview): string {
  return toolContent({
    title: "Sampled internal links and anchor evidence",
    status: analysis.missing_anchor_labels > 0 ? "attention needed" : "partial",
    outcome: `${analysis.internal_links_observed} contextual same-origin links across ${analysis.pages_sampled} supplied pages; ` +
      `${analysis.linked_sample_targets} sampled targets referenced, ${analysis.missing_anchor_labels} without observed accessible names, ` +
      `${analysis.generic_anchor_links} generic anchors, ${analysis.unmatched_internal_links} unsupplied target links.`,
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Supplied page ${finding.source_page}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Review contextual anchor labels against actual page purpose; supply more authorized target pages to inspect the sample. Unvisited links have not been tested, and lexical overlap is not a ranking signal.",
  });
}

export function metadataConsistencyContent(analysis: MetadataReview): string {
  return toolContent({
    title: "Sampled metadata consistency review",
    status: analysis.conflicting_declaration_fields > 0 ? "attention needed" : "partial",
    outcome: `${analysis.pages_sampled} supplied pages: ${analysis.conflicting_declaration_fields} conflicting field groups, ` +
      `${analysis.duplicate_declaration_fields} repeated equivalent fields, ` +
      `${analysis.cross_field_review_leads} cross-field review leads, ` +
      `${analysis.duplicate_title_groups + analysis.duplicate_description_groups} cross-page metadata groups.`,
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Supplied page ${finding.source_page} - ${finding.field}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Review on-page declarations in context. Identical titles and social-metadata variations may be intentional; use authorized crawling and Search Console evidence before attributing search performance.",
  });
}

export function wcagInteractionsContent(review: WcagInteractionReview): string {
  const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
  return toolContent({
    title: "Browser keyboard and WCAG evidence",
    status: warnings ? "attention needed" : "partial",
    outcome: `In script-disabled, offline Chromium, ${review.controls_inspected} of ${review.controls_seen} ` +
      `controls were sampled at ${review.viewport_width} × ${review.viewport_height}; ` +
      `${review.tab_steps} Tab key steps covered ${review.unique_tab_targets} distinct targets. ` +
      `${review.visible_controls_without_name} accessible-name review leads, ` +
      `${review.focus_indicator_review_leads} possible focus-indicator gaps, ` +
      `${review.native_summaries_toggled}/${review.native_summaries_tested} native summaries toggled with Enter.`,
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Rendered control ${finding.control} · ${finding.evidence}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Recheck the flagged focus/name signals in a fully styled, authorized website with JavaScript enabled and a screen reader. This inert sample is not an accessibility audit or WCAG 2.2 compliance determination.",
  });
}

export function mediaDiagnosticsContent(review: MediaDiagnostics): string {
  const warningCount = review.findings.filter((finding) => finding.severity === "warning").length;
  return toolContent({
    title: "Static media markup diagnostics",
    status: warningCount ? "attention needed" : "partial",
    outcome: `${review.media_elements_checked} of ${review.images_observed + review.pictures_observed +
      review.videos_observed} sampled media elements reviewed: ${review.images_observed} images, ` +
      `${review.videos_observed} videos and ${review.pictures_observed} pictures. ` +
      `${review.total_findings} review findings; media loading and playback not checked.`,
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Static ${finding.media_type} element ${finding.element}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Inspect the flagged elements and verify their rendered behavior separately. Static metadata cannot prove actual resource availability, accessibility compliance, loading speed or video caption accuracy.",
  });
}

export function regressionPreviewContent(preview: MonitorPreview): string {
  return toolContent({
    title: "Manual dry-run regression alert preview",
    status: preview.candidate_count ? "attention needed" : "partial",
    outcome: `${preview.candidate_count} unsent alert candidate(s), ` +
      `${preview.review_only_count} coverage/discovery review observation(s) and ` +
      `${preview.suppressed_count} suppressed defect rule(s) for the latest comparison of ` +
      `${preview.latest_completed_pairs} completed matching page pairs. ` +
      "Notifications sent: 0. No schedule, network or delivery was enabled.",
    actions: preview.rules
      .filter((rule) => rule.review_required)
      .map((rule) => ({
        priority: rule.decision === "preview_candidate" ? 1 : 2,
        location: "Manual review only",
        message: `${rule.rule}: ${rule.message}`,
      })),
    nextStep: "Inspect actual saved audit coverage and comparable page observations manually before any action. This is a simulation only; no alerts are sent or monitored automatically. A clean preview does not establish sitewide health or Google outcomes.",
  });
}

export function historicalComparisonContent(review: HistoricalReview): string {
  const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
  return toolContent({
    title: "Saved site-audit history trends",
    status: warnings ? "attention needed" : "partial",
    outcome: `${review.versions_compared} versions, ${review.comparisons_made} adjacent comparisons; ` +
      `${review.comparable_transitions} comparable samples, ${review.partial_transitions} limited and ` +
      `${review.not_comparable_transitions} nonoverlapping transitions. Across their matching checked pages, ` +
      `${review.total_regressed_page_transitions} page regressions and ` +
      `${review.total_improved_page_transitions} improvements were observed. ` +
      `${review.complete_stable_cohort_pages} pages have fully checked evidence across all versions.`,
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Saved version ${finding.version}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Review the per-version complete-cohort error/warning totals and changes, then collect comparable authorized audits where coverage is missing. Unobserved pages and unavailable validators cannot establish fixes, website-wide improvement, ranking changes or causality.",
  });
}

export function productionChangeContent(review: ProductionChangeReview): string {
  const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
  const changed = review.html_fingerprint_changed === null
    ? "Full HTML byte comparison unavailable."
    : review.html_fingerprint_changed
      ? "Supplied HTML bytes differ."
      : "Supplied HTML bytes match.";
  return toolContent({
    title: "Production HTML baseline comparison",
    status: review.status === "not_comparable" ? "partial" :
      warnings ? "attention needed" : "partial",
    outcome: `${review.status}: ${changed} ` +
      (review.main_words_added === null || review.main_words_removed === null
        ? "Comparable sampled main-text word changes are unavailable. "
        : `${review.main_words_added} sampled main-text words added, ` +
          `${review.main_words_removed} removed. `) +
      "No production fetch, deployment or search-ranking attribution was performed.",
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: "Supplied baseline versus current HTML",
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Confirm capture timestamps and HTTP statuses against independent delivery evidence. Compare source deployments and crawler observations separately before attributing a production or Google visibility change.",
  });
}

export function lighthouseLabContent(review: LabReview): string {
  const score = review.performance_score_percent === null
    ? "unavailable" : String(review.performance_score_percent) + "/100";
  const metric = (value: number | null, unit = "ms") =>
    value === null ? "unavailable" : String(value) + unit;
  return toolContent({
    title: "Isolated Lighthouse performance laboratory",
    status: review.status === "failed" ? "partial" :
      review.findings.some((finding) => finding.severity === "warning")
        ? "attention needed" : "partial",
    outcome: `${review.status}: Lighthouse ${review.form_factor} lab score ${score}; ` +
      `FCP ${metric(review.metrics.fcp_ms)}, LCP ${metric(review.metrics.lcp_ms)}, ` +
      `TBT ${metric(review.metrics.tbt_ms)}, Speed Index ${metric(review.metrics.speed_index_ms)}, ` +
      `CLS ${metric(review.metrics.cls, "")}. ` +
      `${review.requests_blocked} requests blocked by the offline security policy.`,
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: "One isolated static-HTML lab run",
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Repeat consistent Lighthouse runs for trends. This sandboxed static HTML audit did not load live production JavaScript, CSS, network assets or real-user CrUX field data; it cannot establish production Core Web Vitals, SEO rankings or visibility-cause conclusions.",
  });
}

export function urlVariantsContent(review: UrlVariantReview): string {
  const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
  return toolContent({
    title: "Supplied URL variant comparison",
    status: warnings ? "attention needed" : "partial",
    outcome: `${review.pages_sampled} supplied same-path URL observations: ` +
      `${review.scheme_variants} scheme, ${review.www_variants} apex/www, ` +
      `${review.slash_variants} trailing-slash, ${review.case_variants} path-case and ` +
      `${review.query_variants} query dimensions; ${review.redirects_to_reference} redirect ` +
      `declarations point to the supplied reference, ${review.matching_content_variants} ` +
      `HTTP 200 variants carry matching caller SHA-256 body fingerprints.`,
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Supplied URL observation ${finding.page}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Verify HTTP redirects to completion, intended query behavior, observed page bodies and canonical declarations with authorized live requests and Search Console. Path case and query parameters can represent different content; neither byte equality nor a declared canonical proves Google's selected canonical.",
  });
}

export function httpsSecurityContent(review: HttpsSecurityReview): string {
  const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
  return toolContent({
    title: "Sampled HTTPS and HTTP security signals",
    status: warnings ? "attention needed" : "partial",
    outcome: `${review.pages_sampled} supplied same-host observations: ${review.http_observations} HTTP, ` +
      `${review.https_observations} HTTPS; ${review.https_redirect_declarations} declared HTTPS redirects, ` +
      `${review.https_without_hsts_observation} without supplied HTTPS HSTS, ` +
      `${review.mixed_blockable_declarations} potentially blockable mixed resources, ` +
      `${review.mixed_upgradable_declarations} upgrade candidates, ` +
      `${review.insecure_form_actions} HTTP form-action declarations.`,
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Supplied page ${finding.page}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Verify observations against authorized live HTTPS/HTTP GET responses, redirect chains, browser DevTools, CSP enforcement and TLS certificates. Supplied headers or static markup do not establish production security, certificate validity or actual browser mixed-content blocking.",
  });
}

export function httpDirectivesContent(review: HttpDirectiveReview): string {
  return toolContent({
    title: "Sampled non-HTML HTTP directive review",
    status: review.conflicting_robots_resources + review.conflicting_canonical_resources > 0
      ? "attention needed" : "partial",
    outcome: `${review.non_html_resources} non-HTML declarations in ${review.resources_sampled} supplied HTTP observations: ` +
      `${review.googlebot_noindex_resources} with a Googlebot-applicable noindex declaration, ` +
      `${review.canonical_header_resources} with HTTP canonical declarations, ` +
      `${review.conflicting_robots_resources + review.conflicting_canonical_resources} conflicting groups.`,
    actions: review.findings.map((finding) => ({
      priority: finding.severity === "warning" ? 1 : 2,
      location: `Supplied response ${finding.resource}`,
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: "Compare these supplied headers against live authorized GET/HEAD observations, robots.txt and Search Console. No resource was fetched; missing X-Robots-Tag does not prove indexability, and Link canonicals are not Google selections.",
  });
}

export function multilingualClusterContent(analysis: MultilingualClusterAnalysis): string {
  const observed = `${analysis.eligible_pages}/${analysis.sampled_pages} supplied pages were eligible`;
  const count = analysis.total_findings;
  return toolContent({
    title: "Multilingual hreflang and canonical clusters",
    status: count ? "attention needed" : analysis.coverage_limited ? "partial" : "clean",
    outcome: count
      ? `${countLabel(count, "cluster finding")} found across the supplied pages; ${observed}.`
      : `No checked hreflang/canonical conflicts were found; ${observed}. This is not evidence that unseen targets are healthy.`,
    actions: analysis.findings.map((finding) => ({
      priority: finding.severity === "error" ? 0 : 1,
      location: finding.example_urls.join(" ↔ "),
      message: `${finding.code}: ${finding.message}`,
    })),
    nextStep: analysis.findings_truncated
      ? "More findings exist than the result cap. Address the displayed conflicts and retest."
      : "Review observed conflicts and provide additional authorized localized page HTML to verify any unseen reciprocal links.",
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
      priority: message.compatibility === "known-validator-limitation"
        ? 2 as const
        : priorityForSeverity(message.type),
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
  const cssWarnings = summary.cssWarnings ?? 0;
  const actions = reportActionItems(reportData);
  const partial = reportData.failedChecks.length > 0;
  const compatibilityLimited = summary.cssCompatibilityLimitations > 0;
  const redirects = reportData.links.filter(isRedirect).length;
  const incompleteLinks = summary.unverifiedLinks > 0 || redirects > 0;
  const scoreUnavailable = summary.overallScore === null;
  const incompleteLinkReason = [
    summary.unverifiedLinks > 0 ? `${countLabel(summary.unverifiedLinks, "unverified link check")}` : undefined,
    redirects > 0 ? `${countLabel(redirects, "unfollowed redirect")}` : undefined,
  ].filter(Boolean).join(" and ");
  const hasActionableFinding = actions.some((action) => action.priority < 2);
  const status = partial
    ? "partial"
    : compatibilityLimited
      ? "compatibility-limited"
      : incompleteLinks
        ? "partial"
        : scoreUnavailable
          ? "partial"
          : actions.length === 0
            ? "clean across completed checks"
            : hasActionableFinding
              ? "attention needed"
              : "review suggested";
  const cssSummary = summary.cssScore === null
    ? reportData.failedChecks.includes("css")
      ? "CSS validation unavailable"
      : compatibilityLimited
        ? `${countLabel(summary.cssErrors, "CSS error")}, ${countLabel(cssWarnings, "CSS warning")}; ${countLabel(summary.cssCompatibilityLimitations, "known validator limitation")}`
        : "CSS not audited"
    : `${countLabel(summary.cssErrors, "CSS error")} and ${countLabel(cssWarnings, "CSS warning")}`;
  const linkSummary = summary.linkScore === null
    ? reportData.failedChecks.includes("links")
      ? "link checking unavailable"
      : incompleteLinks
        ? `${countLabel(summary.brokenLinks, "confirmed HTTP failure")}, ${countLabel(summary.unverifiedLinks, "unverified link check")}, and ${countLabel(redirects, "redirect")} to review of ${countLabel(summary.linksChecked, "link")}`
        : summary.linksChecked > 0 ? "link verification unavailable" : "no eligible links checked"
    : `${countLabel(summary.brokenLinks, "confirmed HTTP failure")} and ${countLabel(redirects, "redirect")} to review of ${countLabel(summary.linksChecked, "link")}`;
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
        : incompleteLinks
          ? `The overall heuristic score is withheld because ${incompleteLinkReason} cannot establish destination availability. HTML has ${countLabel(summary.htmlErrors, "error")} and ${countLabel(summary.htmlWarnings, "warning")}; ${cssSummary}; SEO has ${countLabel(summary.seoErrors, "error")} and ${countLabel(summary.seoWarnings, "warning")}; JSON-LD has ${countLabel(summary.schemaErrors, "syntax error")}; ${linkSummary}.`
          : scoreUnavailable
            ? `The overall heuristic score is unavailable because some diagnostic results are incomplete. Review the detailed report before drawing conclusions; ${linkSummary}.`
            : `The report's heuristic overall score is **${summary.overallScore}/100**. HTML has ${countLabel(summary.htmlErrors, "error")} and ${countLabel(summary.htmlWarnings, "warning")}; ${cssSummary}; SEO has ${countLabel(summary.seoErrors, "error")} and ${countLabel(summary.seoWarnings, "warning")}; JSON-LD has ${countLabel(summary.schemaErrors, "syntax error")}; ${linkSummary}.`,
    actions,
    nextStep: partial
      ? "Review the completed findings, then retry the unavailable checks."
      : compatibilityLimited
        ? "Review actionable findings normally, and treat the marked @container diagnostic as an upstream validator limitation rather than proof of invalid CSS."
        : incompleteLinks
          ? "Review confirmed HTTP failures and unfollowed redirects; retry unverified links only when the URLs are public and checks are permitted."
          : scoreUnavailable
            ? "Review incomplete diagnostic counts and rerun the affected checks before comparing scores."
            : actions.length === 0
              ? "Use the full Markdown report as the audit record and rerun it after meaningful page changes."
              : "Work through these priorities, then regenerate the report to compare the heuristic score.",
    note: partial
      ? ["No overall score is shown while one or more checks are unavailable.", truncationNote].filter(Boolean).join(" ")
      : compatibilityLimited
        ? ["CSS and overall scores are withheld while a known Jigsaw parser limitation is present; the original upstream diagnostic remains visible.", truncationNote].filter(Boolean).join(" ")
        : incompleteLinks
          ? ["Link and overall scores are withheld while destinations are unverified or redirects are unfollowed; neither proves a broken destination.", truncationNote].filter(Boolean).join(" ")
          : scoreUnavailable
            ? ["Incomplete diagnostics prevent a reliable overall score.", truncationNote].filter(Boolean).join(" ")
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

export function screenshotPartialCaptureContent(count: number, outputDirectory: string, error: string): string {
  return toolContent({
    title: "Screenshot capture",
    status: "partial",
    outcome: `Saved ${countLabel(count, "PNG screenshot")} to ${markdownCode(outputDirectory)} before capture failed: ${markdownText(error, 500)}`,
    nextStep: "Review the completed PNG files and retry the unfinished viewport captures after resolving the failure.",
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
