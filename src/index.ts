#!/usr/bin/env node
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { boundedMcpArray, boundedMcpIssues, boundedMcpReport } from "./mcp-bounds.js";
import { z } from "zod";
import { load as loadCheerio } from "cheerio";
import { captureScreenshots, PartialScreenshotCaptureError } from "./screenshot.js";
import {
  reviewMediaHtml,
  emptyMediaDiagnostics,
  MAX_MEDIA_HTML_BYTES,
  MAX_MEDIA_ELEMENTS,
  MAX_MEDIA_FINDINGS,
} from "./modules/browser-ux/media-diagnostics.js";
import {
  reviewWcagInteractions,
  emptyWcagReview,
  MAX_WCAG_HTML_BYTES,
  MAX_WCAG_CONTROLS,
  MAX_WCAG_TAB_STEPS,
  MAX_WCAG_FINDINGS,
  WCAG_FINDING_CODES,
  WCAG_EVIDENCE_TYPES,
} from "./modules/browser-ux/wcag-interactions.js";
import {
  analyzeHttpDirectives,
  emptyHttpDirectiveReview,
  safeHttpResourceUrl,
  MAX_HTTP_RESOURCES,
  MAX_HTTP_FINDINGS,
  MAX_HTTP_HEADER_VALUES,
  MAX_HTTP_HEADER_BYTES,
  HTTP_MIME_CATEGORIES,
  HTTP_CANONICAL_STATES,
  HTTP_FINDING_CODES,
} from "./modules/http-crawl/non-html-directives.js";
import {
  analyzeHttpsSecurity,
  emptyHttpsSecurityReview,
  MAX_SECURITY_PAGES,
  MAX_SECURITY_FINDINGS,
  MAX_SECURITY_HEADER_BYTES,
  MAX_SECURITY_HEADER_VALUES,
  MAX_SECURITY_HTML_BYTES,
  SECURITY_HSTS_STATES,
  SECURITY_CSP_STATES,
  SECURITY_FINDING_CODES,
} from "./modules/http-crawl/https-security.js";
import {
  analyzeUrlVariants,
  emptyUrlVariantReview,
  safeVariantLabel,
  MAX_VARIANT_OBSERVATIONS,
  MAX_VARIANT_FINDINGS,
  MAX_VARIANT_URL_BYTES,
  MAX_VARIANT_CANONICALS,
  VARIANT_DIMENSIONS,
  VARIANT_RESPONSE_STATES,
  VARIANT_TARGET_STATES,
  VARIANT_CANONICAL_STATES,
  VARIANT_FINDING_CODES,
} from "./modules/http-crawl/url-variants.js";
import {
  auditSeoMetadata,
  auditSeoMetadataDetailed,
  checkBrokenLinks,
  validateSchemaMarkup,
  validateSchemaMarkupDetailed,
} from "./seo-auditor.js";
import {
  createValidationReport,
  type ValidationReport,
  type ValidationReportCheck,
  validationReportChecks,
} from "./report.js";
import { fetchPublicText, getErrorMessage, readTextFile } from "./network.js";
import {
  cssValidationContent,
  contentDuplicateContent,
  contentQualityContent,
  productClaimContent,
  provenanceContent,
  intentComparisonContent,
  supportedSchemaContent,
  internalLinkContent,
  metadataConsistencyContent,
  mediaDiagnosticsContent,
  wcagInteractionsContent,
  httpDirectivesContent,
  httpsSecurityContent,
  urlVariantsContent,
  multilingualClusterContent,
  failureContent,
  htmlValidationContent,
  linkCheckContent,
  reportContent,
  schemaValidationContent,
  screenshotCaptureContent,
  screenshotPartialCaptureContent,
  seoAuditContent,
} from "./presentation.js";
import { observeMainContent } from "./modules/content-schema/extract-main-content.js";
import { analyzeSameLanguageDuplicates, safeObservedUrl } from "./modules/content-schema/same-language-duplicates.js";
import { analyzePageContentQuality } from "./modules/content-schema/empty-boilerplate-content.js";
import {
  compareProductClaims,
  registeredToolEvidence,
  MAX_PRODUCT_CLAIM_HTML_BYTES,
} from "./modules/content-schema/product-claims.js";
import { observeProductClaims } from "./modules/content-schema/extract-product-claims.js";
import {
  analyzeProvenance,
  normalizedEvidenceDate,
  safeDatasetVersion,
  safeProvenanceId,
  safeProvenanceUrl,
  MAX_PROVENANCE_HTML_BYTES,
  MAX_PROVENANCE_INPUT_BYTES,
} from "./modules/content-schema/citation-methodology-consistency.js";
import { observeProvenancePage } from "./modules/content-schema/extract-citation-methodology.js";
import {
  compareIntentObservations,
  emptyIntentComparison,
  safeIntentUrl,
  MAX_INTENT_HTML_BYTES,
  MAX_INTENT_TOTAL_BYTES,
  MAX_INTENT_QUERY_BYTES,
} from "./modules/content-schema/competitor-intent-comparison.js";
import { observeIntentHtml } from "./modules/content-schema/extract-competitor-intent.js";
import {
  MAX_SUPPORTED_SCHEMA_HTML_BYTES,
  MAX_SUPPORTED_SCHEMA_FINDINGS,
  SUPPORTED_SCHEMA_TYPES,
  type SupportedSchemaReview,
} from "./modules/content-schema/structured-data-validation.js";
import { reviewSupportedSchemaHtml } from "./modules/content-schema/extract-structured-data.js";
import {
  reviewInternalLinks,
  emptyInternalLinkReview,
  safeLinkPageUrl,
  MAX_LINK_HTML_BYTES,
  MAX_LINK_TOTAL_HTML_BYTES,
  MAX_LINK_FINDINGS,
} from "./modules/site-architecture/internal-link-quality.js";
import { observeInternalLinks } from "./modules/site-architecture/extract-internal-links.js";
import {
  analyzeMetadataConsistency,
  emptyMetadataReview,
  safeMetadataLabel,
  METADATA_FIELDS,
  MAX_METADATA_HTML_BYTES,
  MAX_METADATA_TOTAL_BYTES,
  MAX_METADATA_FINDINGS,
} from "./modules/content-schema/metadata-consistency.js";
import { observeMetadata } from "./modules/content-schema/extract-metadata-consistency.js";
import {
  analyzeMultilingualClusters,
  safeMultilingualUrl,
} from "./modules/site-architecture/multilingual-clusters.js";
import { observeMultilingualPage } from "./modules/site-architecture/extract-multilingual-page.js";
import { PACKAGE_VERSION } from "./version.js";
import {
  MAX_AUDIT_HISTORY,
  MAX_AUDIT_SNAPSHOT_BYTES,
  getAuditHistorySnapshot,
  listAuditHistory,
  saveAuditHistorySnapshot,
} from "./audit-history.js";
import {
  getW3CMessageSeverity,
  type HtmlValidationMediaType,
  MAX_CSS_VALIDATION_BYTES,
  validateCssContent,
  validateCssContentDetailed,
  validateHtmlContent,
  validateHtmlContentDetailed,
} from "./w3c-validator.js";

export const SERVER_VERSION = PACKAGE_VERSION;

const HTML_MAX_BYTES = 2_000_000;
const CSS_MAX_BYTES = MAX_CSS_VALIDATION_BYTES;
const PATH_MAX_LENGTH = 4_096;
const MAX_VIEWPORTS = 8;

function localHtmlValidationMediaType(filePath: string): HtmlValidationMediaType {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".xhtml" || extension === ".xht"
    ? "application/xhtml+xml"
    : "text/html";
}

const filePathSchema = z.string().trim().min(1).max(PATH_MAX_LENGTH);
const htmlContentSchema = z.string().min(1).max(HTML_MAX_BYTES).refine(
  (value) => new TextEncoder().encode(value).byteLength <= HTML_MAX_BYTES,
  `HTML input must not exceed ${HTML_MAX_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
);
const publicUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use HTTP or HTTPS.");

const w3cMessageSchema = z.object({
  type: z.string(),
  subType: z.string().optional(),
  message: z.string(),
  lastLine: z.number().int().optional(),
  lastColumn: z.number().int().optional(),
  firstLine: z.number().int().optional(),
  firstColumn: z.number().int().optional(),
  extract: z.string().optional(),
});

const cssMessageSchema = z.object({
  line: z.number().int(),
  type: z.string(),
  message: z.string(),
  context: z.string().optional(),
  compatibility: z.literal("known-validator-limitation").optional(),
});

const seoIssueSchema = z.object({
  code: z.string().describe("Stable machine-readable audit rule identifier."),
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["SEO", "Schema", "BrokenLinks", "Accessibility"]),
  message: z.string(),
  element: z.string().optional(),
});

const auditCountsSchema = z.object({
  error: z.number().int().nonnegative(),
  warning: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
});

const linkStatusSchema = z.object({
  url: z.string(),
  status: z.union([z.number().int(), z.enum(["blocked", "failed"])]),
  ok: z.boolean(),
  message: z.string().optional(),
});

const duplicateAnalysisOutputSchema = {
  scope: z.literal("sampled_pages_only"),
  sampled_pages: z.number().int().min(0).max(8),
  eligible_pages: z.number().int().min(0).max(8),
  skipped_pages: z.number().int().min(0).max(8),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string()),
  total_pairs: z.number().int().nonnegative(),
  pairs: z.array(z.object({
    first_url: z.string(),
    second_url: z.string(),
    language: z.string(),
    kind: z.enum(["exact", "near"]),
    confidence: z.enum(["observed", "potential"]),
    similarity_percent: z.number().int().min(0).max(100),
    first_words: z.number().int().nonnegative(),
    second_words: z.number().int().nonnegative(),
  })).max(8),
  pairs_truncated: z.boolean(),
  error: z.string().optional(),
};

const contentQualityOutputSchema = {
  scope: z.literal("sampled_pages_only"),
  sampled_pages: z.number().int().min(0).max(8),
  eligible_pages: z.number().int().min(0).max(8),
  skipped_pages: z.number().int().min(0).max(8),
  families_compared: z.number().int().min(0).max(8),
  empty_main_pages: z.number().int().min(0).max(8),
  short_main_pages: z.number().int().min(0).max(8),
  repeated_boilerplate_pages: z.number().int().min(0).max(8),
  possible_low_value_pages: z.number().int().min(0).max(8),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string().max(300)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["warning", "info"]),
    confidence: z.enum(["observed", "potential"]),
    message: z.string().max(320),
    affected_pages: z.number().int().nonnegative(),
    example_urls: z.array(z.string().max(512)).max(2),
  })).max(12),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const productClaimOutputSchema = {
  scope: z.literal("landing_html_vs_registered_mcp_metadata"),
  surface: z.enum(["hosted", "local"]),
  catalog_available: z.boolean(),
  registered_tools: z.number().int().nonnegative().max(64),
  tool_claims_checked: z.number().int().nonnegative().max(20),
  checked_claims: z.number().int().nonnegative(),
  consistent_claims: z.number().int().nonnegative(),
  contradicted_claims: z.number().int().nonnegative(),
  unverified_claims: z.number().int().nonnegative(),
  advertised_tools: z.array(z.object({
    name: z.string().max(64), registered: z.boolean(),
  })).max(20),
  site_batch_limit: z.object({
    advertised: z.number().int().positive(),
    registered: z.number().int().positive().optional(),
  }).optional(),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string().max(320)).max(5),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["warning", "info"]),
    verdict: z.enum(["contradicted", "unverifiable"]),
    claim: z.string().max(64),
    message: z.string().max(240),
    evidence_tool: z.string().max(64).optional(),
  })).max(10),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const provenanceIdSchema = z.string().min(1).max(64)
  .refine((value) => Boolean(safeProvenanceId(value)), "Use an ASCII identifier without secrets.")
  .describe("Short ASCII source, dataset or methodology ID; no tokens or private identifiers.");
const provenanceUrlSchema = z.string().url().max(512)
  .refine((value) => Boolean(safeProvenanceUrl(value)),
    "Use an absolute, query-free HTTP(S) URL without credentials, fragment or nonstandard port.")
  .describe("Public-style HTTP(S) source label, never fetched and without query, userinfo or fragment.");
const provenanceDateSchema = z.string().max(48)
  .refine((value) => Boolean(normalizedEvidenceDate(value)), "Use a valid ISO date or UTC-offset timestamp.")
  .describe("Calendar-valid ISO YYYY-MM-DD or timezone-qualified timestamp.");
const provenanceEvidenceSchema = z.object({
  as_of: provenanceDateSchema.optional().describe("Optional caller-selected comparison day; no current date is inferred."),
  sources: z.array(z.object({
    id: provenanceIdSchema,
    url: provenanceUrlSchema,
  })).max(24).optional().describe("Up to 24 caller-supplied source IDs and safe target URLs."),
  datasets: z.array(z.object({
    id: provenanceIdSchema,
    version: z.string().min(1).max(64)
      .refine((value) => Boolean(safeDatasetVersion(value)), "Use a safe version label.").optional()
      .describe("Optional exact dataset release/version string supplied by the caller."),
    as_of: provenanceDateSchema.optional().describe("Caller-supplied dataset snapshot reference date."),
    max_age_days: z.number().int().min(0).max(3650).optional()
      .describe("Only this explicit caller-supplied freshness threshold can trigger age review."),
    methodology_id: provenanceIdSchema.optional().describe("Optional methodology ID associated with this dataset."),
  })).max(16).optional().describe("Up to 16 optional dataset metadata entries; not independently sourced."),
  methodologies: z.array(z.object({ id: provenanceIdSchema, url: provenanceUrlSchema })).max(16).optional()
    .describe("Up to 16 methodology IDs and safe reference URLs supplied by the caller."),
});
const provenanceOutputSchema = {
  scope: z.literal("supplied_static_html_and_evidence"),
  pages_sampled: z.number().int().nonnegative().max(8),
  pages_eligible: z.number().int().nonnegative().max(8),
  citations_observed: z.number().int().nonnegative(),
  datasets_observed: z.number().int().nonnegative(),
  methodologies_observed: z.number().int().nonnegative(),
  checked_declarations: z.number().int().nonnegative(),
  consistent_declarations: z.number().int().nonnegative(),
  conflicting_declarations: z.number().int().nonnegative(),
  unverified_declarations: z.number().int().nonnegative(),
  invalid_date_declarations: z.number().int().nonnegative(),
  evidence_supplied: z.boolean(),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string().max(320)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["warning", "info"]),
    evidence: z.enum(["observed_html", "supplied_manifest", "reference_date"]),
    page_url: z.string().max(512),
    reference_id: z.string().max(64).optional(),
    message: z.string().max(320),
  })).max(12),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const intentPageInputSchema = z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeIntentUrl(value)),
      "Use a safe query-free HTTP(S) page label without credentials, fragments or nonstandard ports.")
    .describe("Absolute HTTP(S) page URL label; no network requests are made."),
  htmlContent: z.string().min(1).max(MAX_INTENT_HTML_BYTES)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INTENT_HTML_BYTES,
      "Each static HTML page must be at most 150,000 UTF-8 bytes.")
    .describe("Already obtained authorized static HTML for this page; 150 KB maximum."),
});
const intentSignalKinds = z.object({
  informational: z.array(z.string().max(40)).max(5),
  commercial: z.array(z.string().max(40)).max(5),
  transactional: z.array(z.string().max(40)).max(5),
  navigational: z.array(z.string().max(40)).max(5),
});
const intentSignalCounts = z.object({
  informational: z.number().int().min(0).max(5),
  commercial: z.number().int().min(0).max(5),
  transactional: z.number().int().min(0).max(5),
  navigational: z.number().int().min(0).max(5),
});
const intentPageOutputSchema = z.object({
  origin: z.string().max(200),
  title_present: z.boolean(),
  h1_present: z.boolean(),
  main_found: z.boolean(),
  signals: intentSignalKinds,
  signal_counts: intentSignalCounts,
  intent_signal_count: z.number().int().min(0).max(5).optional(),
  query_title_coverage_percent: z.number().int().min(0).max(100).optional(),
  query_h1_coverage_percent: z.number().int().min(0).max(100).optional(),
  extraction_limited: z.boolean(),
});
const intentComparisonOutputSchema = {
  scope: z.literal("caller_supplied_static_html_only"),
  expected_intent: z.enum(["informational", "commercial", "transactional", "navigational"]).optional(),
  query_supplied: z.boolean(),
  usable_query_terms: z.number().int().nonnegative().max(12),
  primary: intentPageOutputSchema,
  competitors: z.array(intentPageOutputSchema).max(6),
  competitors_submitted: z.number().int().nonnegative().max(6),
  competitors_eligible: z.number().int().nonnegative().max(6),
  competitors_with_intent_signals: z.number().int().nonnegative().max(6),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string().max(330)).max(5),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["warning", "info"]),
    confidence: z.enum(["observed", "review"]),
    message: z.string().max(320),
    competitors_supporting: z.number().int().min(0).max(6).optional(),
  })).max(10),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const supportedSchemaOutputSchema = {
  scope: z.literal("bounded_jsonld_structural_profiles"),
  blocks_seen: z.number().int().nonnegative(),
  blocks_checked: z.number().int().nonnegative().max(12),
  blocks_skipped: z.number().int().nonnegative(),
  nodes_examined: z.number().int().nonnegative().max(64),
  supported_nodes: z.number().int().nonnegative(),
  unsupported_nodes: z.number().int().nonnegative(),
  context_unverified_nodes: z.number().int().nonnegative(),
  types_checked: z.array(z.enum(SUPPORTED_SCHEMA_TYPES)).max(8),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  unverified: z.number().int().nonnegative(),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string().max(320)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["error", "warning", "info"]),
    block: z.number().int().nonnegative(),
    node: z.number().int().nonnegative(),
    type: z.enum(SUPPORTED_SCHEMA_TYPES).optional(),
    property: z.string().max(40).optional(),
    message: z.string().max(290),
  })).max(MAX_SUPPORTED_SCHEMA_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const internalLinkPageInputSchema = z.object({
  url: z.string().url().max(512).refine((value) => Boolean(safeLinkPageUrl(value)),
    "Use a query-free HTTP(S) document URL label without credentials, port or fragment.")
    .describe("Caller-supplied page URL label; no URL or linked target is fetched."),
  htmlContent: z.string().min(1).max(MAX_LINK_HTML_BYTES)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_LINK_HTML_BYTES,
      "Each page HTML must not exceed 160,000 UTF-8 bytes.")
    .describe("Already-authorized static page HTML, at most 160 KB UTF-8 per page."),
});
const internalLinkOutputPageSchema = z.object({
  page: z.number().int().min(1).max(8),
  main_present: z.boolean(),
  internal_links: z.number().int().nonnegative(),
  external_links: z.number().int().nonnegative(),
  linked_sample_pages: z.number().int().nonnegative().max(8),
  unmatched_internal_links: z.number().int().nonnegative(),
  missing_anchor_labels: z.number().int().nonnegative(),
  generic_anchor_links: z.number().int().nonnegative(),
  nofollow_internal_links: z.number().int().nonnegative(),
  self_links: z.number().int().nonnegative(),
  fragment_only_links: z.number().int().nonnegative(),
  extraction_limited: z.boolean(),
});
const internalLinkOutputSchema = {
  scope: z.literal("caller_supplied_same_origin_html_only"),
  pages_sampled: z.number().int().min(0).max(8),
  pages_eligible: z.number().int().min(0).max(8),
  origin: z.string().max(200),
  internal_links_observed: z.number().int().nonnegative(),
  external_links_observed: z.number().int().nonnegative(),
  excluded_navigation_links: z.number().int().nonnegative(),
  linked_sample_targets: z.number().int().min(0).max(8),
  unmatched_internal_links: z.number().int().nonnegative(),
  missing_anchor_labels: z.number().int().nonnegative(),
  generic_anchor_links: z.number().int().nonnegative(),
  low_heading_overlap_links: z.number().int().nonnegative(),
  ambiguous_anchor_target_groups: z.number().int().nonnegative(),
  nofollow_internal_links: z.number().int().nonnegative(),
  self_links: z.number().int().nonnegative(),
  fragment_only_links: z.number().int().nonnegative(),
  skipped_non_http_links: z.number().int().nonnegative(),
  pages: z.array(internalLinkOutputPageSchema).max(8),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(330)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["warning", "info"]),
    confidence: z.enum(["observed", "review"]),
    source_page: z.number().int().min(1).max(8),
    target_page: z.number().int().min(1).max(8).optional(),
    count: z.number().int().nonnegative(),
    message: z.string().max(320),
  })).max(MAX_LINK_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const metadataPageInputSchema = z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeMetadataLabel(value)),
      "Use a safe query-free HTTP(S) URL label without credentials, fragments or nonstandard port.")
    .describe("Caller-supplied page URL label; no URL or external metadata is fetched."),
  htmlContent: z.string().min(1).max(MAX_METADATA_HTML_BYTES)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_METADATA_HTML_BYTES,
      "Each static HTML page must be at most 180,000 UTF-8 bytes.")
    .describe("Authorized supplied static HTML; 180 KB UTF-8 per page."),
});
const metadataPageOutputSchema = z.object({
  page: z.number().int().min(1).max(8),
  fields_present: z.number().int().min(0).max(10),
  title_declarations: z.number().int().nonnegative().max(12),
  description_declarations: z.number().int().nonnegative().max(12),
  canonical_declarations: z.number().int().nonnegative().max(12),
  robots_declarations: z.number().int().nonnegative().max(24),
  duplicate_fields: z.number().int().nonnegative().max(10),
  conflicting_fields: z.number().int().nonnegative().max(10),
  unresolved_canonicals: z.number().int().nonnegative().max(12),
  cross_field_review_leads: z.number().int().nonnegative().max(5),
  extraction_limited: z.boolean(),
});
const metadataConsistencyOutputSchema = {
  scope: z.literal("caller_supplied_same_origin_metadata_only"),
  pages_sampled: z.number().int().min(0).max(8),
  origin: z.string().max(200),
  duplicate_declaration_fields: z.number().int().nonnegative(),
  conflicting_declaration_fields: z.number().int().nonnegative(),
  unresolved_canonical_references: z.number().int().nonnegative(),
  explicit_robots_conflicts: z.number().int().nonnegative(),
  cross_field_review_leads: z.number().int().nonnegative(),
  duplicate_title_groups: z.number().int().nonnegative(),
  duplicate_description_groups: z.number().int().nonnegative(),
  excluded_annotated_canonicals: z.number().int().nonnegative(),
  pages: z.array(metadataPageOutputSchema).max(8),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(360)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["warning", "info"]),
    confidence: z.enum(["observed", "review"]),
    source_page: z.number().int().min(1).max(8),
    field: z.enum(METADATA_FIELDS),
    count: z.number().int().nonnegative(),
    related_pages: z.array(z.number().int().min(1).max(8)).max(7).optional(),
    message: z.string().max(340),
  })).max(MAX_METADATA_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const boundedHtmlPageSnapshots = z.array(z.object({
  url: z.string().url().max(512).refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash;
  }, "Use a query-free HTTP(S) URL without credentials or fragments.")
    .describe("Absolute page URL label only; no network request is made or query parameters accepted."),
  htmlContent: z.string().min(1).max(250_000).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 250_000,
    "Each page must be at most 250,000 UTF-8 bytes.",
  ).describe("Already obtained static HTML, at most 250,000 UTF-8 bytes per page."),
})).min(1).max(8);

const multilingualClusterOutputSchema = {
  scope: z.literal("sampled_pages_only"),
  sampled_pages: z.number().int().min(0).max(16),
  eligible_pages: z.number().int().min(0).max(16),
  pages_with_alternates: z.number().int().min(0).max(16),
  locales_observed: z.number().int().nonnegative(),
  unobserved_targets: z.number().int().nonnegative(),
  invalid_declarations: z.number().int().nonnegative(),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string().max(320)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.string().max(80),
    severity: z.enum(["error", "warning"]),
    confidence: z.enum(["observed", "potential"]),
    message: z.string().max(320),
    example_urls: z.array(z.string().max(256)).max(2),
  })).max(12),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const screenshotSchema = z.object({
  viewportName: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  outputPath: z.string(),
  incompleteAssetCount: z.number().int().nonnegative().optional(),
});

const wcagReviewOutputSchema = {
  scope: z.literal("offline_sandboxed_rendered_html"),
  browser_executed: z.boolean(),
  scripts_disabled: z.literal(true),
  viewport_width: z.number().int().min(320).max(1_440),
  viewport_height: z.number().int().min(360).max(1_080),
  resources_blocked: z.number().int().nonnegative(),
  scripts_present: z.number().int().nonnegative(),
  controls_seen: z.number().int().nonnegative(),
  controls_inspected: z.number().int().nonnegative().max(MAX_WCAG_CONTROLS),
  controls_truncated: z.boolean(),
  visible_controls_without_name: z.number().int().nonnegative(),
  positive_tabindex_controls: z.number().int().nonnegative(),
  aria_hidden_focusable_controls: z.number().int().nonnegative(),
  custom_roles_without_tab_stop: z.number().int().nonnegative(),
  tab_steps: z.number().int().nonnegative().max(MAX_WCAG_TAB_STEPS),
  unique_tab_targets: z.number().int().nonnegative().max(MAX_WCAG_TAB_STEPS),
  focus_indicator_review_leads: z.number().int().nonnegative(),
  focus_outside_viewport: z.number().int().nonnegative(),
  native_summaries_tested: z.number().int().nonnegative().max(1),
  native_summaries_toggled: z.number().int().nonnegative().max(1),
  keyboard_sampling_incomplete: z.boolean(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(330)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(WCAG_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    evidence: z.enum(WCAG_EVIDENCE_TYPES),
    control: z.number().int().min(1).max(MAX_WCAG_CONTROLS),
    message: z.string().max(320),
  })).max(MAX_WCAG_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const mediaReviewOutputSchema = {
  scope: z.literal("caller_supplied_static_media_markup_only"),
  images_observed: z.number().int().nonnegative(),
  pictures_observed: z.number().int().nonnegative(),
  videos_observed: z.number().int().nonnegative(),
  source_elements_observed: z.number().int().nonnegative(),
  track_elements_observed: z.number().int().nonnegative(),
  media_elements_checked: z.number().int().nonnegative().max(MAX_MEDIA_ELEMENTS),
  media_elements_truncated: z.boolean(),
  images_without_explicit_alt: z.number().int().nonnegative(),
  images_with_empty_alt: z.number().int().nonnegative(),
  images_without_intrinsic_dimensions: z.number().int().nonnegative(),
  lazy_images_without_intrinsic_dimensions: z.number().int().nonnegative(),
  image_sources_unobserved: z.number().int().nonnegative(),
  videos_without_observed_source: z.number().int().nonnegative(),
  videos_without_caption_track: z.number().int().nonnegative(),
  picture_fallbacks_unobserved: z.number().int().nonnegative(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(360)).max(3),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum([
      "image_name_unobserved", "image_whitespace_alt", "linked_image_name_unobserved",
      "image_source_unobserved", "image_lazy_dimensions_unobserved", "image_invalid_loading",
      "image_invalid_decoding", "image_invalid_fetchpriority",
      "picture_fallback_unobserved", "picture_source_srcset_unobserved",
      "video_source_unobserved", "video_caption_track_unobserved",
      "video_caption_source_unobserved", "video_autoplay_without_muted",
    ]),
    severity: z.enum(["warning", "info"]),
    media_type: z.enum(["image", "picture", "video"]),
    element: z.number().int().min(1).max(MAX_MEDIA_ELEMENTS),
    message: z.string().max(240),
  })).max(MAX_MEDIA_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const variantFieldInputSchema = z.string().min(1).max(MAX_VARIANT_URL_BYTES)
  .refine((value) => !/[\r\n\u0000\u007f]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_VARIANT_URL_BYTES,
  "The caller-observed URL/Location/canonical field must fit 1,024 UTF-8 bytes and contain no CR/LF/NUL.");
const variantObservationInputSchema = z.object({
  url: z.string().url().max(MAX_VARIANT_URL_BYTES)
    .refine((value) => Boolean(safeVariantLabel(value)),
      "Supply an absolute HTTP(S) observation label without credentials, fragment, custom port or unsafe path.")
    .describe("Exact observed URL variant; query values are permitted for comparison but never fetched or returned."),
  status_code: z.number().int().min(100).max(599)
    .describe("Observed HTTP status, not a request result obtained by this tool."),
  method: z.enum(["GET", "HEAD"]).optional()
    .describe("Observed request method, if known; HEAD cannot supply a body fingerprint."),
  location: variantFieldInputSchema.optional()
    .describe("Optional one-step HTTP Location header value for redirects; may be relative; no redirect is followed."),
  canonicals: z.array(variantFieldInputSchema).max(MAX_VARIANT_CANONICALS).optional()
    .describe("Zero to three actual observed canonical URL declarations, absolute or relative; not Google-selected canonicals."),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/iu).optional()
    .describe("Optional caller-computed SHA-256 hex of the exact HTTP 200 response body; never returned or independently verified."),
});
const variantOutputSchema = {
  scope: z.literal("caller_supplied_url_variant_evidence_only"),
  pages_sampled: z.number().int().nonnegative().max(MAX_VARIANT_OBSERVATIONS),
  reference_observed: z.boolean(),
  reference_http_200: z.boolean(),
  scheme_variants: z.number().int().nonnegative(),
  www_variants: z.number().int().nonnegative(),
  slash_variants: z.number().int().nonnegative(),
  case_variants: z.number().int().nonnegative(),
  query_variants: z.number().int().nonnegative(),
  http_200_variants: z.number().int().nonnegative(),
  redirects_to_reference: z.number().int().nonnegative(),
  redirects_outside_family: z.number().int().nonnegative(),
  unresolved_redirects: z.number().int().nonnegative(),
  canonical_to_reference: z.number().int().nonnegative(),
  conflicting_canonical_pages: z.number().int().nonnegative(),
  matching_content_variants: z.number().int().nonnegative(),
  different_content_variants: z.number().int().nonnegative(),
  content_not_comparable_variants: z.number().int().nonnegative(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(420)).max(4),
  pages: z.array(z.object({
    page: z.number().int().min(1).max(MAX_VARIANT_OBSERVATIONS),
    is_reference: z.boolean(),
    dimensions: z.array(z.enum(VARIANT_DIMENSIONS)).max(5),
    status_code: z.number().int().min(100).max(599),
    method: z.enum(["GET", "HEAD", "unspecified"]),
    response_state: z.enum(VARIANT_RESPONSE_STATES),
    redirect_state: z.enum(VARIANT_TARGET_STATES),
    redirect_to_https: z.boolean(),
    canonical_state: z.enum(VARIANT_CANONICAL_STATES),
    canonical_declarations: z.number().int().nonnegative().max(MAX_VARIANT_CANONICALS),
    fingerprint_supplied: z.boolean(),
    content_matches_reference: z.boolean().nullable(),
    has_query: z.boolean(),
  })).max(MAX_VARIANT_OBSERVATIONS),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    page: z.number().int().min(1).max(MAX_VARIANT_OBSERVATIONS),
    severity: z.enum(["warning", "info"]),
    code: z.enum(VARIANT_FINDING_CODES),
    message: z.string().max(330),
  })).max(MAX_VARIANT_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const securityHeaderInputSchema = z.string().max(MAX_SECURITY_HEADER_BYTES)
  .refine((value) => !/[\r\n\u0000]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= MAX_SECURITY_HEADER_BYTES,
  "Header observations must not contain CR/LF/NUL or exceed 2,048 UTF-8 bytes.");
const securityPagesInputSchema = z.array(z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeHttpResourceUrl(value)),
      "Use a query-free HTTP(S) URL label without credentials, fragment or custom port.")
    .describe("Safe supplied HTTP or HTTPS page URL label, used for scheme/host comparisons only; never fetched/returned."),
  status_code: z.number().int().min(100).max(599)
    .describe("Actual observed HTTP status code; no live fetch or redirect following."),
  location: securityHeaderInputSchema.optional()
    .describe("Optional raw Location header of a 3xx HTTP(S) response; never returned."),
  strict_transport_security: z.array(securityHeaderInputSchema).max(MAX_SECURITY_HEADER_VALUES).optional()
    .describe("Up to four observed Strict-Transport-Security headers, in received order."),
  content_security_policy: z.array(securityHeaderInputSchema).max(MAX_SECURITY_HEADER_VALUES).optional()
    .describe("Up to four enforcing Content-Security-Policy response headers."),
  content_security_policy_report_only: z.array(securityHeaderInputSchema).max(MAX_SECURITY_HEADER_VALUES).optional()
    .describe("Up to four Content-Security-Policy-Report-Only response headers; these do not enforce rules."),
  referrer_policy: securityHeaderInputSchema.optional()
    .describe("Optional raw Referrer-Policy response header."),
  x_content_type_options: securityHeaderInputSchema.optional()
    .describe("Optional observed X-Content-Type-Options response header."),
  x_frame_options: securityHeaderInputSchema.optional()
    .describe("Optional observed X-Frame-Options response header."),
  htmlContent: z.string().min(1).max(MAX_SECURITY_HTML_BYTES).optional()
    .refine((value) => value === undefined || Buffer.byteLength(value, "utf8") <= MAX_SECURITY_HTML_BYTES,
      "Each supplied HTML document must fit 120,000 UTF-8 bytes.")
    .describe("Optional caller-supplied static HTML only; max 120 KB/page, 300 KB total; no CSS/JS fetched or executed."),
})).min(1).max(MAX_SECURITY_PAGES);
const securityOutputSchema = {
  scope: z.literal("caller_supplied_https_security_evidence_only"),
  pages_sampled: z.number().int().nonnegative().max(MAX_SECURITY_PAGES),
  http_observations: z.number().int().nonnegative().max(MAX_SECURITY_PAGES),
  https_observations: z.number().int().nonnegative().max(MAX_SECURITY_PAGES),
  https_redirect_declarations: z.number().int().nonnegative(),
  http_without_secure_redirect: z.number().int().nonnegative(),
  https_without_hsts_observation: z.number().int().nonnegative(),
  hsts_disabled_or_invalid: z.number().int().nonnegative(),
  enforced_csp_observations: z.number().int().nonnegative(),
  report_only_csp_observations: z.number().int().nonnegative(),
  mixed_blockable_declarations: z.number().int().nonnegative(),
  mixed_upgradable_declarations: z.number().int().nonnegative(),
  insecure_form_actions: z.number().int().nonnegative(),
  pages_with_truncated_html: z.number().int().nonnegative(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(380)).max(4),
  pages: z.array(z.object({
    page: z.number().int().min(1).max(MAX_SECURITY_PAGES),
    scheme: z.enum(["http", "https"]),
    status_code: z.number().int().min(100).max(599),
    https_redirect_declared: z.boolean(),
    insecure_redirect_declared: z.boolean(),
    unresolved_redirect: z.boolean(),
    hsts_state: z.enum(SECURITY_HSTS_STATES),
    hsts_include_subdomains: z.boolean(),
    hsts_preload_declared: z.boolean(),
    csp_state: z.enum(SECURITY_CSP_STATES),
    csp_upgrade_insecure_requests: z.boolean(),
    referrer_policy_observed: z.boolean(),
    weak_referrer_policy: z.boolean(),
    nosniff_observed: z.boolean(),
    frame_protection_observed: z.boolean(),
    html_supplied: z.boolean(),
    mixed_blockable_declarations: z.number().int().nonnegative(),
    mixed_upgradable_declarations: z.number().int().nonnegative(),
    insecure_form_actions: z.number().int().nonnegative(),
    mixed_ip_host_declarations: z.number().int().nonnegative(),
    insecure_base_href: z.boolean(),
    declarations_truncated: z.boolean(),
  })).max(MAX_SECURITY_PAGES),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    page: z.number().int().min(1).max(MAX_SECURITY_PAGES),
    code: z.enum(SECURITY_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(320),
  })).max(MAX_SECURITY_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const httpHeaderInputSchema = z.string().max(MAX_HTTP_HEADER_BYTES)
  .refine((value) => !/[\r\n\u0000]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_HTTP_HEADER_BYTES,
  "Headers may not contain CR/LF/NUL and must fit within 2,048 UTF-8 bytes.");
const httpObservationInputSchema = z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeHttpResourceUrl(value)),
      "Use a query-free HTTP(S) URL label without credentials, fragments or custom ports.")
    .describe("Safe same-origin resource URL label; never fetched or echoed."),
  status_code: z.number().int().min(100).max(599)
    .describe("Observed HTTP response status code, not a guessed crawler state."),
  method: z.enum(["HEAD", "GET"]).optional()
    .describe("Optional actual request method of this caller-supplied header observation."),
  content_type: httpHeaderInputSchema.optional()
    .describe("Optional raw Content-Type HTTP response header value."),
  content_disposition: httpHeaderInputSchema.optional()
    .describe("Optional raw Content-Disposition HTTP response header value; filenames are never returned."),
  x_robots_tag: z.array(httpHeaderInputSchema).max(MAX_HTTP_HEADER_VALUES).optional()
    .describe("Zero to eight X-Robots-Tag HTTP response header values, in received order."),
  link: z.array(httpHeaderInputSchema).max(MAX_HTTP_HEADER_VALUES).optional()
    .describe("Zero to eight Link HTTP response header values (including rel=canonical if present)."),
});
const httpDirectivesOutputSchema = {
  scope: z.literal("caller_supplied_http_headers_only"),
  resources_sampled: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  non_html_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  html_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  unknown_mime_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  non_success_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  explicit_noindex_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  googlebot_noindex_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  googlebot_noimageindex_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  conflicting_robots_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  canonical_header_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  conflicting_canonical_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  unresolved_canonical_references: z.number().int().nonnegative(),
  attachment_resources: z.number().int().nonnegative().max(MAX_HTTP_RESOURCES),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(340)).max(4),
  resources: z.array(z.object({
    resource: z.number().int().min(1).max(MAX_HTTP_RESOURCES),
    status_code: z.number().int().min(100).max(599),
    method: z.enum(["HEAD", "GET", "unspecified"]),
    mime_category: z.enum(HTTP_MIME_CATEGORIES),
    non_html: z.boolean(),
    x_robots_observed: z.boolean(),
    explicit_noindex: z.boolean(),
    googlebot_noindex: z.boolean(),
    googlebot_noimageindex: z.boolean(),
    conflicting_robots: z.boolean(),
    canonical_declarations: z.number().int().nonnegative(),
    canonical_valid_targets: z.number().int().nonnegative(),
    canonical_state: z.enum(HTTP_CANONICAL_STATES),
    attachment_declared: z.boolean(),
    header_coverage_limited: z.boolean(),
  })).max(MAX_HTTP_RESOURCES),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(HTTP_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    resource: z.number().int().min(1).max(MAX_HTTP_RESOURCES),
    message: z.string().max(300),
  })).max(MAX_HTTP_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const reportSummarySchema = z.object({
  overallScore: z.number().int().min(0).max(100).nullable(),
  htmlScore: z.number().int().min(0).max(100).nullable(),
  cssScore: z.number().int().min(0).max(100).nullable(),
  seoScore: z.number().int().min(0).max(100).nullable(),
  linkScore: z.number().int().min(0).max(100).nullable(),
  htmlErrors: z.number().int().nonnegative(),
  htmlWarnings: z.number().int().nonnegative(),
  cssErrors: z.number().int().nonnegative(),
  cssWarnings: z.number().int().nonnegative().optional(),
  cssCompatibilityLimitations: z.number().int().nonnegative(),
  seoErrors: z.number().int().nonnegative(),
  seoWarnings: z.number().int().nonnegative(),
  schemaErrors: z.number().int().nonnegative(),
  linksChecked: z.number().int().nonnegative(),
  brokenLinks: z.number().int().nonnegative(),
  unverifiedLinks: z.number().int().nonnegative(),
});

const externalReadOnlyAnnotations = {
  // These calls contact external recipients but do not modify external state.
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const localReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function result<T extends object>(
  structuredContent: T,
  content: string,
  isError = false,
): CallToolResult {
  return {
    structuredContent: structuredContent as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: content,
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function failedReport(filePath: string, error: string): ValidationReport {
  return {
    report: `Validation report could not be generated: ${error}`,
    summary: {
      overallScore: null,
      htmlScore: null,
      cssScore: null,
      seoScore: null,
      linkScore: null,
      htmlErrors: 0,
      htmlWarnings: 0,
      cssErrors: 0,
      cssWarnings: 0,
      cssCompatibilityLimitations: 0,
      seoErrors: 0,
      seoWarnings: 0,
      schemaErrors: 0,
      linksChecked: 0,
      brokenLinks: 0,
      unverifiedLinks: 0,
    },
    htmlMessages: [],
    htmlTotalMessages: 0,
    htmlTruncated: false,
    cssMessages: [],
    cssTotalMessages: 0,
    cssTruncated: false,
    seoIssues: [],
    seoTotalIssues: 0,
    seoTruncated: false,
    schemaIssues: [],
    schemaTotalIssues: 0,
    schemaTruncated: false,
    links: [],
    failedChecks: ["input"],
    errors: [`${path.basename(filePath || "document")}: ${error}`],
  };
}

interface ValidationReportDependencies {
  readTextFile: typeof readTextFile;
  validateHtmlContent: typeof validateHtmlContent;
  validateHtmlContentDetailed?: typeof validateHtmlContentDetailed;
  validateCssContent: typeof validateCssContent;
  validateCssContentDetailed?: typeof validateCssContentDetailed;
  auditSeoMetadata: typeof auditSeoMetadata;
  auditSeoMetadataDetailed?: typeof auditSeoMetadataDetailed;
  validateSchemaMarkup: typeof validateSchemaMarkup;
  validateSchemaMarkupDetailed?: typeof validateSchemaMarkupDetailed;
  checkBrokenLinks: typeof checkBrokenLinks;
}

const validationReportDependencies: ValidationReportDependencies = {
  readTextFile,
  validateHtmlContent,
  validateHtmlContentDetailed,
  validateCssContent,
  validateCssContentDetailed,
  auditSeoMetadata,
  auditSeoMetadataDetailed,
  validateSchemaMarkup,
  validateSchemaMarkupDetailed,
  checkBrokenLinks,
};

export interface GenerateValidationReportOptions {
  htmlFilePath: string;
  cssFilePath?: string;
  baseUrl?: string;
}

/** Runs independent validation checks without discarding successful results when another check fails. */
export async function generateValidationReport(
  { htmlFilePath, cssFilePath, baseUrl }: GenerateValidationReportOptions,
  dependencies: ValidationReportDependencies = validationReportDependencies,
): Promise<ValidationReport> {
  const htmlMediaType = localHtmlValidationMediaType(htmlFilePath);
  const html = await dependencies.readTextFile(htmlFilePath, HTML_MAX_BYTES, htmlMediaType);
  const failedChecks: ValidationReportCheck[] = [];
  const errors: string[] = [];
  const recordFailure = (check: ValidationReportCheck, label: string, cause: unknown): void => {
    if (!failedChecks.includes(check)) {
      failedChecks.push(check);
    }
    errors.push(`${label} was unavailable: ${getErrorMessage(cause)}`);
  };

  let css: string | undefined;
  if (cssFilePath) {
    try {
      css = await dependencies.readTextFile(cssFilePath, CSS_MAX_BYTES, "text/css");
    } catch (cause) {
      recordFailure("css", "CSS validation", cause);
    }
  }

  const htmlValidation = dependencies.validateHtmlContentDetailed
    ? dependencies.validateHtmlContentDetailed(html, htmlMediaType)
    : dependencies.validateHtmlContent(html, htmlMediaType).then((messages) => {
        const counts = { error: 0, warning: 0, info: 0 };
        for (const message of messages) counts[getW3CMessageSeverity(message)] += 1;
        return { messages, total: messages.length, truncated: false, counts };
      });
  const cssValidation = css === undefined
    ? Promise.resolve({
        messages: [],
        total: 0,
        truncated: false,
        counts: { error: 0, warning: 0, compatibilityLimitation: 0 },
      })
    : dependencies.validateCssContentDetailed
      ? dependencies.validateCssContentDetailed(css)
      : dependencies.validateCssContent(css).then((messages) => {
          const compatibilityLimitation = messages.filter(
            (message) => message.compatibility === "known-validator-limitation",
          ).length;
          const warning = messages.filter((message) => message.type.toLowerCase() === "warning").length;
          return {
            messages,
            total: messages.length,
            truncated: false,
            counts: {
              error: messages.length - warning - compatibilityLimitation,
              warning,
              compatibilityLimitation,
            },
          };
        });
  const seoValidation = dependencies.auditSeoMetadataDetailed
    ? Promise.resolve().then(() => dependencies.auditSeoMetadataDetailed!(html))
    : Promise.resolve().then(() => {
        const issues = dependencies.auditSeoMetadata(html);
        const counts = { error: 0, warning: 0, info: 0 };
        for (const issue of issues) counts[issue.severity] += 1;
        return { issues, totalIssues: issues.length, truncated: false, counts };
      });
  const schemaValidation = dependencies.validateSchemaMarkupDetailed
    ? Promise.resolve().then(() => dependencies.validateSchemaMarkupDetailed!(html))
    : Promise.resolve().then(() => {
        const issues = dependencies.validateSchemaMarkup(html);
        const counts = { error: 0, warning: 0, info: 0 };
        for (const issue of issues) counts[issue.severity] += 1;
        return { issues, totalIssues: issues.length, truncated: false, counts };
      });
  const [htmlResult, cssResult, seoResult, schemaResult, linksResult] = await Promise.allSettled([
    htmlValidation,
    cssValidation,
    seoValidation,
    schemaValidation,
    dependencies.checkBrokenLinks(html, baseUrl, 25),
  ]);

  if (htmlResult.status === "rejected") recordFailure("html", "HTML validation", htmlResult.reason);
  if (cssResult.status === "rejected") recordFailure("css", "CSS validation", cssResult.reason);
  if (seoResult.status === "rejected") recordFailure("seo", "SEO analysis", seoResult.reason);
  if (schemaResult.status === "rejected") recordFailure("schema", "JSON-LD analysis", schemaResult.reason);
  if (linksResult.status === "rejected") recordFailure("links", "Link checking", linksResult.reason);

  return createValidationReport({
    htmlFilePath,
    cssAudited: css !== undefined,
    htmlMessages: htmlResult.status === "fulfilled" ? htmlResult.value.messages : [],
    htmlTotalMessages: htmlResult.status === "fulfilled" ? htmlResult.value.total : 0,
    htmlTruncated: htmlResult.status === "fulfilled" ? htmlResult.value.truncated : false,
    htmlCounts: htmlResult.status === "fulfilled" ? htmlResult.value.counts : undefined,
    cssMessages: cssResult.status === "fulfilled" ? cssResult.value.messages : [],
    cssTotalMessages: cssResult.status === "fulfilled" ? cssResult.value.total : 0,
    cssTruncated: cssResult.status === "fulfilled" ? cssResult.value.truncated : false,
    cssCounts: cssResult.status === "fulfilled" ? cssResult.value.counts : undefined,
    seoIssues: seoResult.status === "fulfilled" ? seoResult.value.issues : [],
    seoTotalIssues: seoResult.status === "fulfilled" ? seoResult.value.totalIssues : 0,
    seoTruncated: seoResult.status === "fulfilled" ? seoResult.value.truncated : false,
    seoCounts: seoResult.status === "fulfilled" ? seoResult.value.counts : undefined,
    schemaIssues: schemaResult.status === "fulfilled" ? schemaResult.value.issues : [],
    schemaTotalIssues: schemaResult.status === "fulfilled" ? schemaResult.value.totalIssues : 0,
    schemaTruncated: schemaResult.status === "fulfilled" ? schemaResult.value.truncated : false,
    schemaCounts: schemaResult.status === "fulfilled" ? schemaResult.value.counts : undefined,
    links: linksResult.status === "fulfilled" ? linksResult.value : [],
    failedChecks,
    errors,
  });
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-web-validator", version: SERVER_VERSION },
    {
      instructions:
        "Validate only files, markup, and public URLs the user owns or is authorized to inspect. HTML and CSS validation send supplied content to W3C-operated validators. Link checks contact public links without following redirects. Screenshot capture executes page content in a sandboxed local browser and writes PNG files.",
    },
  );

  server.registerTool(
    "html.local",
    {
      title: "Validate local HTML",
      description:
        "Reads a bounded local HTML or .xhtml file and sends its markup to the W3C Nu HTML Checker. .xhtml files use application/xhtml+xml parsing semantics. Use only files the user is authorized to share.",
      inputSchema: {
        filePath: filePathSchema.describe("Absolute or workspace-relative path to an HTML or .xhtml file."),
      },
      outputSchema: {
        errors: z.array(w3cMessageSchema),
        totalMessages: z.number().int().nonnegative(),
        truncated: z.boolean(),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ filePath }) => {
      try {
        const htmlMediaType = localHtmlValidationMediaType(filePath);
        const html = await readTextFile(filePath, HTML_MAX_BYTES, htmlMediaType);
        const validation = await validateHtmlContentDetailed(
          html,
          htmlMediaType,
        );
        const messages = boundedMcpArray(validation.messages);
        const truncated = validation.truncated || messages.length < validation.messages.length;
        return result(
          { errors: messages, totalMessages: validation.total, truncated },
          htmlValidationContent(messages, undefined, validation.total, validation.counts),
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { errors: [], totalMessages: 0, truncated: false, error },
          failureContent(
            "HTML validation",
            error,
            "Confirm the file exists and is readable, then retry. If the W3C service is unavailable, try again later.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "html.url",
    {
      title: "Validate a public URL",
      description:
        "Fetches a bounded public HTTP(S) page, then sends its markup to the W3C Nu HTML Checker. Private, reserved, credentialed, and nonstandard-port destinations are rejected.",
      inputSchema: {
        url: publicUrlSchema.describe("Public HTTP(S) URL on port 80 or 443."),
      },
      outputSchema: {
        errors: z.array(w3cMessageSchema),
        totalMessages: z.number().int().nonnegative(),
        truncated: z.boolean(),
        fetchedUrl: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url }) => {
      try {
        const fetched = await fetchPublicText(url, {
          maxBytes: HTML_MAX_BYTES,
          timeoutMs: 15_000,
          maxRedirects: 3,
          acceptedContentTypes: ["text/html", "application/xhtml+xml"],
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9",
            "user-agent": `DigestSEO-Web-Validator/${SERVER_VERSION} (+https://digestseo.com/validator-mcp/)`,
          },
        });
        if (fetched.status < 200 || fetched.status >= 300) {
          throw new Error(`Target URL returned HTTP ${fetched.status}.`);
        }
        const validationMediaType = fetched.contentType
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() === "application/xhtml+xml"
          ? "application/xhtml+xml"
          : "text/html";
        const validation = await validateHtmlContentDetailed(fetched.text, validationMediaType);
        const messages = boundedMcpArray(validation.messages);
        const truncated = validation.truncated || messages.length < validation.messages.length;
        return result(
          {
            errors: messages,
            totalMessages: validation.total,
            truncated,
            fetchedUrl: fetched.url,
          },
          htmlValidationContent(messages, fetched.url, validation.total, validation.counts),
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { errors: [], totalMessages: 0, truncated: false, error },
          failureContent(
            "URL validation",
            error,
            "Confirm the URL is public, uses HTTP or HTTPS on a standard port, and returns HTML, then retry.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "css.local",
    {
      title: "Validate local CSS",
      description:
        "Reads a bounded local CSS file and sends it to the W3C Jigsaw CSS Validator. Use only files the user is authorized to share.",
      inputSchema: {
        filePath: filePathSchema.describe("Absolute or workspace-relative path to a CSS file."),
      },
      outputSchema: {
        errors: z.array(cssMessageSchema),
        warnings: z.array(cssMessageSchema).optional(),
        totalMessages: z.number().int().nonnegative(),
        truncated: z.boolean(),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ filePath }) => {
      try {
        const css = await readTextFile(filePath, CSS_MAX_BYTES, "text/css");
        const validation = await validateCssContentDetailed(css);
        const messages = boundedMcpArray(validation.messages);
        const truncated = validation.truncated || messages.length < validation.messages.length;
        return result(
          {
            errors: messages.filter((message) => message.type.toLowerCase() !== "warning"),
            warnings: messages.filter((message) => message.type.toLowerCase() === "warning"),
            totalMessages: validation.total,
            truncated,
          },
          cssValidationContent(messages, validation.total, validation.counts),
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { errors: [], warnings: [], totalMessages: 0, truncated: false, error },
          failureContent(
            "CSS validation",
            error,
            "Confirm the file exists, is readable, and is within the size limit, then retry.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "seo.metadata",
    {
      title: "Audit SEO metadata",
      description:
        "Audits supplied HTML offline for on-page SEO metadata, headings, viewport, image alternatives, and Open Graph issues. Use for a quick on-page check; use html.local/html.url for W3C HTML validation, schema.markup for JSON-LD syntax, or report.validation for a combined local-file report.",
      inputSchema: {
        htmlContent: htmlContentSchema.describe("Raw HTML markup to inspect locally."),
      },
      outputSchema: {
        issues: z.array(seoIssueSchema),
        totalIssues: z.number().int().nonnegative(),
        truncated: z.boolean(),
        counts: auditCountsSchema,
        error: z.string().optional(),
      },
      annotations: localReadOnlyAnnotations,
    },
    async ({ htmlContent }) => {
      try {
        const { issues, totalIssues, truncated, counts } = boundedMcpIssues(auditSeoMetadataDetailed(htmlContent));
        return result(
          { issues, totalIssues, truncated, counts },
          seoAuditContent(issues, totalIssues, truncated, counts),
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { issues: [], totalIssues: 0, truncated: false, counts: { error: 0, warning: 0, info: 0 }, error },
          failureContent(
            "SEO audit",
            error,
            "Confirm the supplied HTML is complete and within the size limit, then retry.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "content.duplicates",
    {
      title: "Compare same-language main content",
      description:
        "Compares static main text across one to eight HTML pages supplied by the caller. Reports high-confidence exact matches and conservative near matches only within the same language (and script). No network requests or storage. Output is limited to this sample, not site-wide uniqueness.",
      inputSchema: {
        pages: boundedHtmlPageSnapshots
          .describe("One to eight HTML pages to compare; total HTML must be at most 1 MiB."),
      },
      outputSchema: duplicateAnalysisOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ pages }) => {
      const empty = analyzeSameLanguageDuplicates([], { sampledPages: 0, coverageLimited: true });
      try {
        if (pages.reduce((total, page) => total + Buffer.byteLength(page.htmlContent, "utf8"), 0) > 1_000_000) {
          throw new Error("Total HTML input exceeds the 1,000,000-byte comparison limit.");
        }
        const analysis = analyzeSameLanguageDuplicates(pages.map(({ htmlContent, url }) =>
          observeMainContent(htmlContent, url)));
        return result(analysis, contentDuplicateContent(analysis));
      } catch {
        const error = "Main-content comparison could not be completed within its input limits.";
        return result({ ...empty, error }, failureContent(
          "Main-content comparison", error, "Use up to eight public-style URLs with bounded, valid HTML input.",
        ), true);
      }
    },
  );

  server.registerTool(
    "content.quality",
    {
      title: "Review empty, short and repeated main content",
      description:
        "Offline, evidence-limited review of empty or thin static main text and substantive repeated sentences within same-language page families. Reports possible missing standalone value, not Google rankings or a semantic quality verdict. Accepts up to eight supplied HTML pages; no network, storage, browser or LLM.",
      inputSchema: {
        pages: boundedHtmlPageSnapshots.describe(
          "One to eight authorized HTML page observations; total supplied HTML must be at most 1 MB.",
        ),
      },
      outputSchema: contentQualityOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ pages }) => {
      const empty = analyzePageContentQuality([], { sampledPages: 0, coverageLimited: true });
      try {
        if (pages.reduce((sum, page) => sum + Buffer.byteLength(page.htmlContent, "utf8"), 0) > 1_000_000) {
          throw new Error("Content-quality input exceeds 1,000,000 bytes.");
        }
        const analysis = analyzePageContentQuality(pages.map(({ htmlContent, url }) =>
          observeMainContent(htmlContent, url)));
        return result(analysis, contentQualityContent(analysis));
      } catch {
        const error = "Content-quality comparison could not be completed within its bounded input limits.";
        return result({ ...empty, error }, failureContent(
          "Content quality review", error, "Supply up to eight valid, query-free URL labels and static HTML documents.",
        ), true);
      }
    },
  );

  server.registerTool(
    "site.hreflang",
    {
      title: "Verify multilingual hreflang clusters",
      description:
        "Compares head-only hreflang and canonical declarations across up to sixteen supplied static HTML pages, including x-default, reciprocal references and same-locale target consistency. No URLs are fetched, and unsampled targets are not declared broken. Works across authorized domains; no browser, files or storage.",
      inputSchema: {
        pages: z.array(z.object({
          url: z.string().url().max(256).refine((value) => Boolean(safeMultilingualUrl(value)),
            "Use an absolute HTTP(S) URL without credentials, fragments, queries or nonstandard ports.")
            .describe("Absolute authorized page URL label; not fetched. Cross-domain alternate sites are supported."),
          htmlContent: z.string().min(1).max(125_000).refine(
            (value) => Buffer.byteLength(value, "utf8") <= 125_000,
            "Each page is limited to 125,000 UTF-8 bytes.",
          ).describe("Already obtained static HTML for that page; no network requests are made."),
        })).min(1).max(16)
          .describe("Up to sixteen page observations; total supplied HTML must be at most 1.5 MB."),
      },
      outputSchema: multilingualClusterOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ pages }) => {
      const empty = analyzeMultilingualClusters([], { sampledPages: 0, coverageLimited: true });
      try {
        const bytes = pages.reduce((total, page) => total + Buffer.byteLength(page.htmlContent, "utf8"), 0);
        if (bytes > 1_500_000) throw new Error("Supplied HTML exceeds the 1.5 MB input cap.");
        const analysis = analyzeMultilingualClusters(pages.map(({ htmlContent, url }) =>
          observeMultilingualPage(htmlContent, url)));
        return result(analysis, multilingualClusterContent(analysis));
      } catch {
        const error = "Multilingual cluster comparison could not be completed within its input limits.";
        return result({ ...empty, error }, failureContent(
          "Multilingual cluster comparison", error, "Supply up to 16 authorized HTML pages with absolute, query-free URL labels.",
        ), true);
      }
    },
  );

  server.registerTool(
    "links.broken",
    {
      title: "Check public links",
      description:
        "Resolves and checks up to 25 public HTTP(S) links in supplied HTML. Redirects are reported but not followed, and response bodies are discarded.",
      inputSchema: {
        htmlContent: htmlContentSchema.describe("Raw HTML markup containing links to check."),
        baseUrl: publicUrlSchema
          .optional()
          .describe("Optional public HTTP(S) base URL used to resolve relative links."),
        maxLinks: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(25)
          .describe("Maximum number of public HTTP(S) links to check, from 1 to 25."),
      },
      outputSchema: {
        links: z.array(linkStatusSchema),
        totalLinks: z.number().int().nonnegative(),
        truncated: z.boolean(),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ htmlContent, baseUrl, maxLinks }) => {
      try {
        const links = await checkBrokenLinks(htmlContent, baseUrl, maxLinks);
        const preview = boundedMcpArray(links);
        const truncated = preview.length < links.length;
        return result(
          { links: preview, totalLinks: links.length, truncated },
          linkCheckContent(links, baseUrl)
            + (truncated ? `\n\nOnly the first ${preview.length} of ${links.length} link records fit the MCP output budget; link-check counts include all results.` : ""),
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { links: [], totalLinks: 0, truncated: false, error },
          failureContent(
            "Link check",
            error,
            "Confirm the base URL is public and the supplied HTML is within the size limit, then retry.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "schema.markup",
    {
      title: "Validate JSON-LD syntax",
      description:
        "Parses JSON-LD blocks in supplied HTML locally and reports empty blocks or JSON syntax errors. It does not validate vocabulary semantics.",
      inputSchema: {
        htmlContent: htmlContentSchema.describe("Raw HTML containing JSON-LD script blocks."),
      },
      outputSchema: {
        issues: z.array(seoIssueSchema),
        totalIssues: z.number().int().nonnegative(),
        truncated: z.boolean(),
        counts: auditCountsSchema,
        error: z.string().optional(),
      },
      annotations: localReadOnlyAnnotations,
    },
    async ({ htmlContent }) => {
      try {
        const { issues, totalIssues, truncated, counts } = boundedMcpIssues(validateSchemaMarkupDetailed(htmlContent));
        return result(
          { issues, totalIssues, truncated, counts },
          schemaValidationContent(issues, totalIssues, truncated, htmlContent),
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { issues: [], totalIssues: 0, truncated: false, counts: { error: 0, warning: 0, info: 0 }, error },
          failureContent(
            "JSON-LD syntax",
            error,
            "Confirm the supplied HTML is complete and within the size limit, then retry.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "schema.supported",
    {
      title: "Review supported Schema.org JSON-LD structures",
      description:
        "Offline bounded structural review of explicit JSON-LD for Article/NewsArticle/BlogPosting, Product, BreadcrumbList, FAQPage, Organization and WebSite. Checks limited property shapes and review-profile recommendations; unknown contexts/types stay unverified. Does not resolve remote contexts or certify Schema.org validity, Google rich-result eligibility, content truth or rankings. Use schema.markup for existing syntax-only diagnostics.",
      inputSchema: {
        htmlContent: z.string().min(1).max(MAX_SUPPORTED_SCHEMA_HTML_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_SUPPORTED_SCHEMA_HTML_BYTES,
            "Static HTML must be at most 250,000 UTF-8 bytes.")
          .describe("Caller-supplied HTML containing JSON-LD script blocks, never fetched, at most 250 KB UTF-8."),
      },
      outputSchema: supportedSchemaOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ htmlContent }) => {
      try {
        const analysis: SupportedSchemaReview = reviewSupportedSchemaHtml(htmlContent);
        return result(analysis, supportedSchemaContent(analysis));
      } catch {
        const error = "Supported JSON-LD review could not complete within the static input limits.";
        const empty: SupportedSchemaReview = {
          scope: "bounded_jsonld_structural_profiles",
          blocks_seen: 0, blocks_checked: 0, blocks_skipped: 0, nodes_examined: 0,
          supported_nodes: 0, unsupported_nodes: 0, context_unverified_nodes: 0,
          types_checked: [], errors: 0, warnings: 0, unverified: 0,
          coverage_limited: true,
          limitations: ["The bounded JSON-LD review could not process this supplied input."],
          total_findings: 0, findings: [], findings_truncated: false,
        };
        return result({ ...empty, error }, failureContent(
          "Supported JSON-LD review", error,
          "Provide one bounded static HTML page and review unknown types with a complete standards-aware validator.",
        ), true);
      }
    },
  );

  server.registerTool(
    "report.validation",
    {
      title: "Generate a validation report",
      description:
        "Combines W3C HTML/CSS validation, local SEO/accessibility checks, JSON-LD syntax checks, and a bounded public-link check into a Markdown and structured report.",
      inputSchema: {
        htmlFilePath: filePathSchema.describe("Absolute or workspace-relative HTML or .xhtml file path."),
        cssFilePath: filePathSchema
          .optional()
          .describe("Optional absolute or workspace-relative CSS file path."),
        baseUrl: publicUrlSchema
          .optional()
          .describe("Optional public HTTP(S) base URL used to resolve relative links."),
      },
      outputSchema: {
        report: z.string(),
        summary: reportSummarySchema,
        htmlMessages: z.array(w3cMessageSchema),
        htmlTotalMessages: z.number().int().nonnegative(),
        htmlTruncated: z.boolean(),
        cssMessages: z.array(cssMessageSchema),
        cssTotalMessages: z.number().int().nonnegative(),
        cssTruncated: z.boolean(),
        seoIssues: z.array(seoIssueSchema),
        seoTotalIssues: z.number().int().nonnegative(),
        seoTruncated: z.boolean(),
        schemaIssues: z.array(seoIssueSchema),
        schemaTotalIssues: z.number().int().nonnegative(),
        schemaTruncated: z.boolean(),
        links: z.array(linkStatusSchema),
        failedChecks: z.array(z.enum(validationReportChecks)),
        errors: z.array(z.string()).optional(),
      },
      annotations: externalReadOnlyAnnotations,
    },
    async ({ htmlFilePath, cssFilePath, baseUrl }) => {
      try {
        const reportData = await generateValidationReport({
          htmlFilePath,
          cssFilePath,
          baseUrl,
        });
        const narrative = reportContent(reportData);
        const bounded = boundedMcpReport(reportData, narrative);
        return result(
          bounded,
          bounded === reportData
            ? narrative
            : narrative + "\n\nVerbose report tables and structured previews were shortened for MCP transport; all summary scores and totals remain unchanged.",
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        const reportData = failedReport(htmlFilePath, error);
        return result(
          reportData,
          failureContent(
            "Validation report",
            error,
            "Confirm the input paths are readable and any base URL is public, then regenerate the report.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "audit.history",
    {
      title: "Manage local audit history",
      description:
        "Opt-in local-only site-audit snapshot history. Save a previous hosted audit_public_site structured result as JSON, list saved IDs, or retrieve an exact version. A single compact local JSON file retains at most 10 versions; saving the 11th removes the oldest. No database, background task, or network request.",
      inputSchema: {
        action: z.enum(["save", "list", "get"]).describe("Save a snapshot, list versions, or retrieve one by ID."),
        snapshotJson: z.string().min(1).max(MAX_AUDIT_SNAPSHOT_BYTES).optional()
          .describe("For save: JSON-serialized structuredContent from hosted audit_public_site, max 60 KB. Raw HTML is not stored."),
        id: z.string().uuid().optional().describe("For get: saved version ID returned by list or save."),
      },
      outputSchema: {
        count: z.number().int().nonnegative(),
        items: z.array(z.object({
          id: z.string().uuid(),
          saved_at: z.string(),
          site_url: z.string(),
        })).max(MAX_AUDIT_HISTORY),
        snapshot_json: z.string().optional(),
        evicted_id: z.string().uuid().optional(),
        error: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, snapshotJson, id }) => {
      try {
        if (action === "save") {
          if (!snapshotJson) throw new Error("snapshotJson is required when action is save.");
          const saved = await saveAuditHistorySnapshot(snapshotJson);
          return result(saved, `Audit version saved locally. ${saved.count}/10 versions retained.${saved.evicted_id ? " Oldest version automatically deleted." : ""} Latest ID: ${saved.items[0]?.id}`);
        }
        if (action === "get") {
          if (!id) throw new Error("id is required when action is get.");
          const found = await getAuditHistorySnapshot(id);
          return result(found, `Retrieved audit history version ${id}. Use snapshot_json as a baseline or current result for compare_site_audits.`);
        }
        const listed = await listAuditHistory();
        return result(listed, `Found ${listed.count} locally saved audit versions, newest first.`);
      } catch (cause) {
        const error = getErrorMessage(cause);
        return result(
          { count: 0, items: [], error },
          failureContent("Audit history", error, "Review snapshot JSON or local history file permissions and retry."),
          true,
        );
      }
    },
  );

  server.registerTool(
    "browser.wcag",
    {
      title: "Review bounded rendered-DOM keyboard and WCAG interaction evidence",
      description:
        "Local-only inert Chromium analysis of supplied HTML: sandboxed pinned headless browser, no external resource requests, scripts disabled and stripped, DOM accessible-name heuristics, aria-hidden focus, positive tabindex, custom role focusability, up to 24 real keyboard Tab focus samples, computed focus indicator review and native summary Enter toggle. Never navigates URLs, clicks links/buttons, submits forms, stores screenshots or certifies WCAG; may provision pinned browser on first use.",
      inputSchema: {
        htmlContent: z.string().min(1).max(MAX_WCAG_HTML_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_WCAG_HTML_BYTES,
            "Supplied HTML must be at most 180,000 UTF-8 bytes.")
          .describe("Caller-supplied authorized HTML only, never a URL or file path; scripts/frames removed, external resources blocked."),
        viewportWidth: z.number().int().min(320).max(1_440).optional()
          .describe("Optional isolated desktop/mobile viewport width in CSS pixels, 320–1440; defaults to 960."),
        viewportHeight: z.number().int().min(360).max(1_080).optional()
          .describe("Optional isolated viewport height in CSS pixels, 360–1080; defaults to 720."),
        maxTabSteps: z.number().int().min(1).max(MAX_WCAG_TAB_STEPS).optional()
          .describe("Maximum real browser Tab key samples (1–24), default 24; no click, form submission or network."),
      },
      outputSchema: wcagReviewOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ htmlContent, viewportWidth, viewportHeight, maxTabSteps }) => {
      try {
        const review = await reviewWcagInteractions(htmlContent, {
          viewportWidth, viewportHeight, maxTabSteps,
        });
        return result(review, wcagInteractionsContent(review));
      } catch {
        const error = "Sandboxed Chromium interaction evidence is unavailable or the HTML exceeds its safety limits. No accessibility pass is claimed.";
        return result({ ...emptyWcagReview({ viewportWidth, viewportHeight }), error }, failureContent(
          "Browser keyboard and WCAG evidence", error,
          "Confirm the pinned headless Chromium can launch with sandboxing enabled and supply bounded HTML; do not disable the browser sandbox.",
        ), true);
      }
    },
  );

  server.registerTool(
    "media.diagnostics",
    {
      title: "Review static images, video and media-loading evidence",
      description:
        "Local-only, offline review of caller-supplied HTML image alt/name evidence, responsive picture fallbacks, intrinsic dimensions, lazy loading/decoding/fetchpriority hints, video sources and caption tracks. Bounded and redacted; never fetches or renders media, executes scripts, measures layout, validates caption contents or certifies accessibility/performance.",
      inputSchema: {
        htmlContent: z.string().min(1).max(MAX_MEDIA_HTML_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_MEDIA_HTML_BYTES,
            "Supplied static HTML must be at most 180,000 UTF-8 bytes.")
          .describe("Caller-supplied static HTML markup to inspect offline; no URL, resource or local file is fetched."),
      },
      outputSchema: mediaReviewOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ htmlContent }) => {
      try {
        const review = reviewMediaHtml(htmlContent);
        return result(review, mediaDiagnosticsContent(review));
      } catch {
        const error = "Static media declarations could not be reviewed within the input size and HTML limits.";
        return result({ ...emptyMediaDiagnostics(), error }, failureContent(
          "Static media diagnostics", error,
          "Supply nonempty HTML markup within the declared UTF-8 byte limit.",
        ), true);
      }
    },
  );

  server.registerTool(
    "http.variants",
    {
      title: "Review supplied HTTP/HTTPS, www, slash, case and query URL variants",
      description:
        "Offline, bounded comparison of one explicit query-free reference URL and 1–12 caller-observed same-path candidate responses across HTTP/HTTPS, apex/www, trailing slash, ASCII path case and query parameters. Reviews one-step Location, up to three canonical declarations and optional caller-computed 200-response SHA-256 fingerprints. No URL fetch, redirect following, Google canonical selection, query-value leakage or content equivalence assumptions.",
      inputSchema: {
        reference_url: z.string().url().max(MAX_VARIANT_URL_BYTES)
          .refine((value) => Boolean(safeVariantLabel(value)) && !value.includes("?"),
            "Use a safe query-free HTTP(S) reference URL label without credentials or fragments.")
          .describe("Explicit query-free HTTP(S) preferred URL to compare against; must also be present as one supplied response."),
        observations: z.array(variantObservationInputSchema).min(1).max(MAX_VARIANT_OBSERVATIONS)
          .describe("One to twelve already-observed URL response records in the exact reference path family; do not cause fetches."),
      },
      outputSchema: variantOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ reference_url, observations }) => {
      try {
        const review = analyzeUrlVariants(reference_url, observations);
        return result(review, urlVariantsContent(review));
      } catch {
        const error = "URL variant observations could not be compared within safe host, path, query, response or size limits.";
        return result({ ...emptyUrlVariantReview(), error }, failureContent(
          "Supplied URL variants", error,
          "Supply a query-free reference and up to twelve distinct same-family response observations; no URLs will be fetched.",
        ), true);
      }
    },
  );

  server.registerTool(
    "http.security",
    {
      title: "Review supplied HTTPS, mixed-content and HTTP security evidence",
      description:
        "Offline, bounded security-header/static-HTML observation review across 1–8 same-host HTTP/HTTPS pages. Distinguishes declared HTTP→HTTPS redirects, HSTS status, enforced vs report-only CSP, safe/weak referrer and framing policies, nosniff and static mixed-content/form/CSS declarations. No traffic, TLS certificate verification, browser execution, security certification or sensitive raw URL/header/HTML output.",
      inputSchema: {
        pages: securityPagesInputSchema
          .describe("One to eight authorized, same-host supplied HTTP(S) observations; both schemes permitted for redirect comparison; max 24 KB headers and 300 KB HTML combined."),
      },
      outputSchema: securityOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ pages }) => {
      try {
        const review = analyzeHttpsSecurity(pages, loadCheerio);
        return result(review, httpsSecurityContent(review));
      } catch {
        const error = "Supplied HTTPS security evidence could not be reviewed within URL, same-host, header or HTML safety limits.";
        return result({ ...emptyHttpsSecurityReview(), error }, failureContent(
          "HTTPS and HTTP security signals", error,
          "Supply bounded same-host HTTP(S) page labels, observed status/headers and optional HTML; no network requests are performed.",
        ), true);
      }
    },
  );

  server.registerTool(
    "http.directives",
    {
      title: "Review observed non-HTML HTTP indexing directives",
      description:
        "Offline, bounded analysis of one to eight caller-supplied same-origin HTTP response header observations, including PDF/media MIME types, X-Robots-Tag (scoped Googlebot directives and contradictions), Link rel=canonical declarations, Content-Disposition and response status. No URL fetch, binary download, robots.txt inspection, Google indexing assertion, or storage. Sensitive raw URLs, headers, filenames and query tokens are not returned.",
      inputSchema: {
        resources: z.array(httpObservationInputSchema).min(1).max(MAX_HTTP_RESOURCES)
          .describe("One to eight authorized same-origin HTTP response header observations, no live network or binary fetching; 30 KB combined header budget."),
      },
      outputSchema: httpDirectivesOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ resources }) => {
      try {
        const review = analyzeHttpDirectives(resources);
        return result(review, httpDirectivesContent(review));
      } catch {
        const error = "HTTP directive observations could not be reviewed within the URL, same-origin, status or header limits.";
        return result({ ...emptyHttpDirectiveReview(), error }, failureContent(
          "Non-HTML HTTP directives", error,
          "Supply one to eight same-origin resource URL labels and bounded observed response headers.",
        ), true);
      }
    },
  );

  server.registerTool(
    "screenshot.capture",
    {
      title: "Capture responsive screenshots",
      description:
        "Renders a local HTML file or HTTP(S) URL in a sandboxed local Chromium browser and writes PNG screenshots to the requested directory. Downloads the pinned headless browser on first use if it is not already cached. Existing matching files may be replaced. Completed PNG paths are included if a later viewport fails.",
      inputSchema: {
        targetPath: z
          .string()
          .trim()
          .min(1)
          .max(PATH_MAX_LENGTH)
          .describe("Local HTML path or HTTP(S) URL to render."),
        outputDir: filePathSchema
          .optional()
          .default(".mcp-validator/screenshots")
          .describe("Directory where PNG screenshots will be written."),
        viewports: z
          .array(
            z.object({
              name: z
                .string()
                .regex(/^[A-Za-z0-9_-]{1,50}$/)
                .describe("Safe filename label for this screenshot viewport."),
              width: z
                .number()
                .int()
                .min(200)
                .max(3_840)
                .describe("Viewport width in CSS pixels, from 200 to 3840."),
              height: z
                .number()
                .int()
                .min(200)
                .max(4_320)
                .describe("Viewport height in CSS pixels, from 200 to 4320."),
            }),
          )
          .min(1)
          .max(MAX_VIEWPORTS)
          .optional()
          .describe("Optional viewport definitions; defaults to desktop, tablet, and mobile sizes."),
      },
      outputSchema: {
        screenshots: z.array(screenshotSchema),
        outputDirectory: z.string(),
        error: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ targetPath, outputDir, viewports }) => {
      const outputDirectory = path.resolve(outputDir);
      try {
        const screenshots = await captureScreenshots(targetPath, outputDirectory, viewports);
        const affected = screenshots.filter((capture) => (capture.incompleteAssetCount ?? 0) > 0);
        if (affected.length > 0) {
          const error = `${affected.length} screenshot viewport(s) have failed or blocked visual assets; files were saved but captures may be incomplete.`;
          return result(
            { screenshots, outputDirectory, error },
            screenshotPartialCaptureContent(screenshots.length, outputDirectory, error),
            true,
          );
        }
        return result(
          { screenshots, outputDirectory },
          screenshotCaptureContent(screenshots.length, outputDirectory),
        );
      } catch (cause) {
        const error = getErrorMessage(cause);
        if (cause instanceof PartialScreenshotCaptureError) {
          return result(
            { screenshots: cause.screenshots, outputDirectory, error },
            screenshotPartialCaptureContent(cause.screenshots.length, outputDirectory, error),
            true,
          );
        }
        return result(
          { screenshots: [], outputDirectory, error },
          failureContent(
            "Screenshot capture",
            error,
            "Confirm the target is reachable or readable and the output directory is writable, then retry.",
          ),
          true,
        );
      }
    },
  );

  server.registerTool(
    "content.provenance",
    {
      title: "Verify citation, dataset and methodology evidence",
      description:
        "Offline static comparison across one to eight supplied HTML pages. Checks explicit citation IDs/URLs, dataset version and as-of claims, publication/modification dates, methodology references, and only caller-supplied freshness limits. No source is fetched, no external fact is asserted, and missing evidence remains unverified.",
      inputSchema: {
        pages: z.array(z.object({
          url: provenanceUrlSchema.describe("Safe page label; no request is made."),
          htmlContent: z.string().min(1).max(MAX_PROVENANCE_HTML_BYTES)
            .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PROVENANCE_HTML_BYTES,
              "Each static page must be at most 200,000 UTF-8 bytes.")
            .describe("Static HTML source text supplied by caller; never fetched or stored."),
        })).min(1).max(8).describe("Up to eight authorized HTML documents; combined limit 1,000,000 UTF-8 bytes."),
        evidence: provenanceEvidenceSchema.optional()
          .describe("Optional caller-supplied source/dataset/methodology metadata; not independently authoritative."),
      },
      outputSchema: provenanceOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ pages, evidence }) => {
      const empty = analyzeProvenance([], {});
      try {
        if (pages.reduce((total, page) => total + Buffer.byteLength(page.htmlContent, "utf8"), 0)
          > MAX_PROVENANCE_INPUT_BYTES) throw new Error("Combined HTML input is too large.");
        const analysis = analyzeProvenance(pages.map(({ url, htmlContent }) =>
          observeProvenancePage(htmlContent, url)), evidence ?? {});
        return result(analysis, provenanceContent(analysis));
      } catch {
        const error = "Source and methodology evidence comparison could not complete within its input limits.";
        return result({ ...empty, error }, failureContent(
          "Citation and source evidence", error,
          "Supply 1-8 bounded HTML pages and optional safe, factual reference metadata.",
        ), true);
      }
    },
  );

  server.registerTool(
    "content.metadata",
    {
      title: "Review duplicate, conflicting and mismatched page metadata",
      description:
        "Offline bounded consistency check for 1-8 caller-supplied same-origin HTML pages: duplicate/conflicting title, description and canonical declarations, Open Graph/Twitter differences, explicit robots directives and repeated titles/descriptions across distinct sampled canonical preferences. Outputs review evidence, not a Google-selected canonical, indexing or ranking verdict. No network or storage.",
      inputSchema: {
        pages: z.array(metadataPageInputSchema).min(1).max(8)
          .describe("One to eight authorized same-origin static HTML pages, distinct safe URL labels, combined maximum 900,000 UTF-8 bytes. None are fetched."),
      },
      outputSchema: metadataConsistencyOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ pages }) => {
      try {
        const bytes = pages.reduce((total, item) => total +
          Buffer.byteLength(item.htmlContent, "utf8"), 0);
        if (bytes > MAX_METADATA_TOTAL_BYTES) throw new Error("Combined HTML exceeds the size limit.");
        const analysis = analyzeMetadataConsistency(pages.map(({ url, htmlContent }) =>
          observeMetadata(htmlContent, url)));
        return result(analysis, metadataConsistencyContent(analysis));
      } catch {
        const error = "Metadata consistency could not be compared within the supplied page, URL or size limits.";
        return result({ ...emptyMetadataReview(), error }, failureContent(
          "Metadata consistency review", error,
          "Provide up to eight distinct same-origin HTML page labels with bounded authorized static content.",
        ), true);
      }
    },
  );

  server.registerTool(
    "site.links",
    {
      title: "Review contextual internal links and anchor labels",
      description:
        "Offline bounded review of one to eight caller-supplied same-origin HTML pages: contextual internal vs external links, missing accessible names, generic labels, nofollow, repeated anchors, and lexical title/H1 overlap only for supplied destinations. Unknown URLs are unverified, never called broken. No fetching, crawling, search data, JavaScript or ranking inference.",
      inputSchema: {
        pages: z.array(internalLinkPageInputSchema).min(1).max(8)
          .describe("One to eight authorized same-origin page HTML observations, combined maximum 900,000 UTF-8 bytes; all distinct URL labels."),
      },
      outputSchema: internalLinkOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ pages }) => {
      try {
        const bytes = pages.reduce((total, p) => total + Buffer.byteLength(p.htmlContent, "utf8"), 0);
        if (bytes > MAX_LINK_TOTAL_HTML_BYTES) throw new Error("Combined static HTML exceeds limit.");
        const analysis = reviewInternalLinks(pages.map(({ url, htmlContent }) =>
          observeInternalLinks(htmlContent, url)));
        return result(analysis, internalLinkContent(analysis));
      } catch {
        const error = "Sampled internal link evidence could not be reviewed within the input and same-origin limits.";
        return result({ ...emptyInternalLinkReview(), error }, failureContent(
          "Contextual internal links", error,
          "Supply 1-8 bounded HTML pages with distinct safe URL labels on the same exact origin.",
        ), true);
      }
    },
  );

  server.registerTool(
    "content.competitors",
    {
      title: "Compare sampled competitor search-intent signals",
      description:
        "Offline comparison of one primary and up to six caller-supplied competitor pages for visible, bounded informational/commercial/transactional/navigational markup signals. Optional explicitly selected search intent and query-heading lexical overlap only. Does NOT discover competitors, fetch pages, access GSC, classify the query semantically, or predict rankings.",
      inputSchema: {
        primary: intentPageInputSchema
          .describe("Caller-authorized primary page observation. No URL will be fetched."),
        competitors: z.array(intentPageInputSchema).min(1).max(6)
          .describe("One to six competitor HTML observations already obtained lawfully; each origin must be distinct."),
        expected_intent: z.enum(["informational", "commercial", "transactional", "navigational"])
          .optional().describe("Optional intent specified by the caller; never inferred from the query."),
        query: z.string().trim().min(1).max(MAX_INTENT_QUERY_BYTES).refine(
          (value) => Buffer.byteLength(value, "utf8") <= MAX_INTENT_QUERY_BYTES,
          "Query text must not exceed 160 UTF-8 bytes.",
        ).optional().describe("Optional caller-provided query for strict normalized title/H1 token overlap only; never echoed."),
      },
      outputSchema: intentComparisonOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ primary, competitors, expected_intent, query }) => {
      try {
        const records = [primary, ...competitors];
        const bytes = records.reduce((total, entry) =>
          total + Buffer.byteLength(entry.htmlContent, "utf8"), 0);
        if (bytes > MAX_INTENT_TOTAL_BYTES) throw new Error("Combined HTML exceeds bounded input.");
        const analysis = compareIntentObservations(
          observeIntentHtml(primary.htmlContent, primary.url),
          competitors.map((item) => observeIntentHtml(item.htmlContent, item.url)),
          { expectedIntent: expected_intent, query },
        );
        return result(analysis, intentComparisonContent(analysis));
      } catch {
        const error = "Competitor intent signals could not be compared within the supplied input and origin limits.";
        return result({ ...emptyIntentComparison(), error }, failureContent(
          "Competitor intent comparison", error,
          "Provide one primary and up to six distinct competitor origins with bounded authorized static HTML.",
        ), true);
      }
    },
  );

  server.registerTool(
    "product.claims",
    {
      title: "Check landing-page claims against local MCP capabilities",
      description:
        "Compare explicit local MCP product-page promises with this actual runtime's registered tool metadata. Supply HTML or one authorized public HTML URL. No arbitrary marketing semantics, no remote MCP credentials, no storage, no scripts and no claim of a successful tool invocation. Hosted tool claims must be verified by the hosted runtime.",
      inputSchema: {
        htmlContent: z.string().min(1).max(MAX_PRODUCT_CLAIM_HTML_BYTES).optional()
          .describe("Optional static landing-page HTML, bounded at 250,000 UTF-8 bytes."),
        url: z.string().url().max(512).refine((value) => Boolean(safeObservedUrl(value)),
          "Use a query-free public HTTP(S) URL without credentials or fragments.").optional()
          .describe("Alternative to HTML: one authorized public landing-page URL, fetched with existing SSRF safeguards."),
      },
      outputSchema: productClaimOutputSchema,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ htmlContent, url }) => {
      const empty = compareProductClaims({
        hasMain: false, hostedSectionFound: false, localSectionFound: false,
        hostedTools: [], localTools: [], localScreenshotClaim: false,
        hostedReadOnlyClaim: false, hostedNoScreenshotsClaim: false,
        extractionTruncated: false,
      }, [], "local");
      try {
        if (Boolean(htmlContent) === Boolean(url)) {
          throw new Error("Provide exactly one of htmlContent or url.");
        }
        const html = htmlContent ?? (await fetchPublicText(url!, {
          maxBytes: MAX_PRODUCT_CLAIM_HTML_BYTES,
          acceptedContentTypes: ["text/html", "application/xhtml+xml"],
        })).text;
        const catalog = registeredToolEvidence(
          (server as unknown as { _registeredTools?: unknown })._registeredTools,
          (schema) => z.toJSONSchema(schema as z.ZodType),
        );
        const analysis = compareProductClaims(observeProductClaims(html), catalog, "local");
        return result(analysis, productClaimContent(analysis));
      } catch {
        const error = "Landing-page promises could not be verified within the public URL or input limits.";
        return result({ ...empty, error }, failureContent(
          "Landing-page promise verification", error,
          "Provide one authorized public HTML page or bounded static HTML, not both.",
        ), true);
      }
    },
  );

  return server;
}

export async function run(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`mcp-web-validator ${SERVER_VERSION} started on stdio`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  run().catch((cause: unknown) => {
    console.error("Fatal error starting mcp-web-validator:", getErrorMessage(cause));
    process.exitCode = 1;
  });
}
