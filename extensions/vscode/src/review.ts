import { parse } from "parse5";
import { observeMetadata } from "../../../src/modules/content-schema/extract-metadata-consistency.js";
import { analyzeMetadataConsistency, MAX_METADATA_HTML_BYTES, safeMetadataLabel } from "../../../src/modules/content-schema/metadata-consistency.js";
import { reviewSupportedSchemaHtml } from "../../../src/modules/content-schema/extract-structured-data.js";

export interface Finding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  field?: string;
  start?: number;
  end?: number;
}

const MAX_PARSE_FINDINGS = 12;
const LOCAL_LABEL = "https://editor.invalid/";

/** No network, editor file writes, crawler inference or workspace traversal. */
export function reviewDocument(html: string, pageUrl = ""): Finding[] {
  if (!html.trim()) return [];
  if (new TextEncoder().encode(html).byteLength > MAX_METADATA_HTML_BYTES) {
    return [{ code: "input_limit", severity: "info", message: "Local review skipped: the document exceeds the 180,000 UTF-8 byte limit." }];
  }

  const findings: Finding[] = [];
  const supplied = pageUrl.trim();
  const validUrl = supplied ? safeMetadataLabel(supplied) : undefined;
  if (supplied && !validUrl) {
    findings.push({ code: "invalid_page_url", severity: "info", message: "The configured page URL is not a supported HTTP(S) document label. URL-dependent comparisons are skipped." });
  }

  const documentLike = /<!doctype\s+html\b|<html[\s>]|<head[\s>]/i.test(html);
  let parseCount = 0;
  parse(html, {
    onParseError(error) {
      if (error.code === "missing-doctype" && !documentLike) return;
      parseCount++;
      if (parseCount > MAX_PARSE_FINDINGS) return;
      findings.push({
        code: "html_" + error.code,
        severity: "warning",
        message: "HTML parser recovery: " + error.code + ". Review the markup; this is not full HTML conformance validation.",
        start: error.startOffset,
        end: error.endOffset,
      });
    },
  });
  if (parseCount > MAX_PARSE_FINDINGS) findings.push({
    code: "html_findings_limited", severity: "info", message: "Additional HTML parser recovery observations were capped.",
  });

  const observed = observeMetadata(html, validUrl ?? LOCAL_LABEL);
  const metadata = analyzeMetadataConsistency([observed]);
  for (const issue of metadata.findings) {
    if (!validUrl && (issue.code === "canonical_social_url_difference" ||
        (issue.field === "canonical" && (issue.code === "duplicate_declaration" || issue.code === "conflicting_declaration")))) continue;
    findings.push({ code: issue.code, severity: issue.severity, field: issue.field, message: issue.message });
  }
  if (!validUrl && observed.values.canonical.length > 1) findings.push({
    code: "multiple_canonicals", severity: "info", field: "canonical",
    message: "Multiple canonical declarations observed. Supply the exact page URL to compare their resolved targets.",
  });
  if (metadata.excluded_annotated_canonicals) findings.push({
    code: "annotated_canonicals", severity: "info", field: "canonical",
    message: "Annotated canonical declarations were excluded from comparison; review these manually.",
  });
  if (metadata.findings_truncated) findings.push({
    code: "metadata_findings_limited", severity: "info", message: "Additional metadata findings were capped.",
  });

  for (const field of ["robots", "googlebot"] as const) {
    const tokens = observed.values[field].flatMap(value => value.toLowerCase().split(",").map(x => x.trim()));
    if (tokens.includes("noindex") || tokens.includes("none")) findings.push({
      code: "declared_noindex", severity: "info", field,
      message: "A static " + field + " noindex directive is declared. Confirm this matches the intended indexing policy; intentional noindex is not an error.",
    });
  }

  const schema = reviewSupportedSchemaHtml(html);
  for (const issue of schema.findings) findings.push({
    code: issue.code, severity: issue.severity, field: "json-ld", message: "JSON-LD block " + issue.block + ": " + issue.message,
  });
  if (schema.findings_truncated || schema.blocks_skipped) findings.push({
    code: "schema_findings_limited", severity: "info", field: "json-ld", message: "Some JSON-LD observations were capped or skipped. Review unsupported data separately.",
  });
  return findings;
}
