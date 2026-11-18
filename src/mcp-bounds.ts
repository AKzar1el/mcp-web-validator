import type { ValidationReport } from "./report.js";
import type { AuditDetails } from "./seo-auditor.js";

// Keep complete counts while limiting diagnostic previews to a size that
// survives MCP gateways with stricter structured-result limits.
export const MAX_MCP_STRUCTURED_BYTES = 16_000;

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function boundedMcpArray<T>(items: readonly T[], maxBytes = MAX_MCP_STRUCTURED_BYTES): T[] {
  let bytes = 2; // JSON array brackets.
  let count = 0;
  for (const item of items) {
    const increment = jsonBytes(item) + (count > 0 ? 1 : 0);
    if (bytes + increment > maxBytes) break;
    bytes += increment;
    count += 1;
  }
  return items.slice(0, count);
}

export function boundedMcpIssues(details: AuditDetails): AuditDetails {
  const issues = boundedMcpArray(details.issues);
  if (issues.length === details.issues.length) return details;
  return { ...details, issues, truncated: true };
}

/**
 * Preserve the report's exact summary, totals, and completed-check status.
 * Only huge reports lose verbose Markdown tables and diagnostic previews.
 */
export function boundedMcpReport(data: ValidationReport, narrative: string): ValidationReport {
  if (jsonBytes(data) <= MAX_MCP_STRUCTURED_BYTES) return data;

  const preview = narrative.length > 1_800
    ? `${narrative.slice(0, 1_800)}\n\n*The narrative preview was shortened.*`
    : narrative;

  for (const cap of [32, 24, 16, 12, 8, 6, 4, 2, 1, 0]) {
    const htmlMessages = data.htmlMessages.slice(0, cap);
    const cssMessages = data.cssMessages.slice(0, cap);
    const seoIssues = data.seoIssues.slice(0, cap);
    const schemaIssues = data.schemaIssues.slice(0, cap);
    const links = data.links.slice(0, cap);
    const errors = data.errors?.slice(0, cap).map((error) =>
      error.length > 400 ? `${error.slice(0, 397)}...` : error
    );
    const details = [
      `HTML ${htmlMessages.length}/${data.htmlTotalMessages}`,
      `CSS ${cssMessages.length}/${data.cssTotalMessages}`,
      `SEO ${seoIssues.length}/${data.seoTotalIssues}`,
      `JSON-LD ${schemaIssues.length}/${data.schemaTotalIssues}`,
      `links ${links.length}/${data.summary.linksChecked}`,
    ].join("; ");
    const compact: ValidationReport = {
      ...data,
      report: `# Web validation report (condensed)\n\n${preview}\n\nDetailed tables were shortened for MCP transport limits. The summary scores and total counts still cover all completed checks. Preview: ${details}.`,
      htmlMessages,
      htmlTruncated: data.htmlTruncated || htmlMessages.length < data.htmlMessages.length,
      cssMessages,
      cssTruncated: data.cssTruncated || cssMessages.length < data.cssMessages.length,
      seoIssues,
      seoTruncated: data.seoTruncated || seoIssues.length < data.seoIssues.length,
      schemaIssues,
      schemaTruncated: data.schemaTruncated || schemaIssues.length < data.schemaIssues.length,
      links,
      ...(errors ? { errors } : {}),
    };
    if (jsonBytes(compact) <= MAX_MCP_STRUCTURED_BYTES) return compact;
  }
  throw new Error("The validation report could not be bounded for MCP transport.");
}
