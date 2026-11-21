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
  analyzeRawRendered, emptyRawRenderedReview,
  MAX_RENDER_HTML_BYTES, MAX_RENDER_FINDINGS, RENDER_FINDING_CODES,
} from "./modules/browser-ux/raw-rendered-diff.js";
import { renderInlineHtml, reviewPublicInlineDom } from "./modules/browser-ux/raw-rendered-probe.js";
import {
  analyzeResourceFailures, emptyResourceFailureReview,
  MAX_RESOURCE_OBSERVATIONS, MAX_RESOURCE_FINDINGS,
  RESOURCE_TYPES, RESOURCE_OUTCOMES, RESOURCE_FAILURE_REASONS,
  RESOURCE_ORIGINS, RESOURCE_FINDING_CODES,
} from "./modules/browser-ux/resource-failures.js";
import { inspectPublicResourceLoading } from "./modules/browser-ux/resource-failures-probe.js";
import {
  emptyViewportParityReview, MAX_PARITY_HTML_BYTES, MAX_PARITY_FINDINGS,
  MOBILE_VIEWPORT, DESKTOP_VIEWPORT, PARITY_FINDING_CODES,
} from "./modules/browser-ux/viewport-parity.js";
import {
  inspectViewportParity, inspectPublicViewportParity,
} from "./modules/browser-ux/viewport-parity-probe.js";
import {
  emptyLighthouseLabReview, MAX_LAB_HTML_BYTES, MAX_LAB_FINDINGS,
  LAB_FACTORS, LAB_STATUSES, LAB_FINDING_CODES,
} from "./modules/browser-ux/lighthouse-lab.js";
import {
  inspectOfflineLighthouseLab, lighthouseSupportedNode,
} from "./modules/browser-ux/lighthouse-lab-probe.js";
import {
  analyzeCruxField, emptyCruxFieldReview, validateCruxQuery,
  CRUX_FORMS, CRUX_MODES, CRUX_SOURCES,
  CRUX_FINDING_CODES, MAX_CRUX_FINDINGS, MAX_CRUX_HISTORY_PERIODS,
  MAX_CRUX_RETURNED_PERIODS, MAX_CRUX_RESPONSE_BYTES,
} from "./modules/external-metrics/crux-field.js";
import { queryCruxField, CruxRequestError } from "./modules/external-metrics/crux-field-probe.js";
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
  analyzeHttpDelivery,
  emptyDeliveryReview,
  MAX_DELIVERY_HOPS,
  MAX_DELIVERY_FINDINGS,
  MAX_DELIVERY_HEADER_VALUE_BYTES,
  DELIVERY_HEADER_NAMES,
  DELIVERY_FINDING_CODES,
} from "./modules/http-crawl/http-delivery.js";
import { probeHttpDelivery } from "./modules/http-crawl/http-delivery-probe.js";
import {
  analyzeAvailabilityHistory,
  emptyAvailabilityReview,
  MAX_AVAILABILITY_OBSERVATIONS,
  MAX_AVAILABILITY_FINDINGS,
  AVAILABILITY_FAILURE_CODES,
  AVAILABILITY_STATES,
  AVAILABILITY_FINDING_CODES,
} from "./modules/http-crawl/availability-observations.js";
import { collectPublicAvailability } from "./modules/http-crawl/availability-probe.js";
import {
  getAvailabilityHistory, saveAvailabilityObservation,
  MAX_AVAILABILITY_HISTORY,
} from "./modules/change-regression/availability-history-store.js";
import {
  analyzeCrawlerAccess, emptyCrawlerAccessReview, CRAWLER_PROFILES,
  CRAWLER_ACCESS_STATES, CRAWLER_INDEXING_STATES, CRAWLER_FINDING_CODES,
  MAX_CRAWLER_PAGES, MAX_CRAWLER_FINDINGS, MAX_CRAWLER_ROBOTS_BYTES,
  MAX_CRAWLER_HTML_BYTES,
} from "./modules/http-crawl/crawler-access.js";
import { probeCrawlerAccess } from "./modules/http-crawl/crawler-access-probe.js";
import {
  analyzeRedirectCanonicalChains, emptyRedirectCanonicalReview,
  MAX_CHAIN_HOPS, MAX_CHAIN_CANONICALS, MAX_CHAIN_HTML_BYTES,
  MAX_CHAIN_FINDINGS, CHAIN_REDIRECT_STATES, CHAIN_TARGET_STATES,
  CHAIN_CANONICAL_STATES, CHAIN_INDEXING_STATES, CHAIN_FINDING_CODES,
} from "./modules/http-crawl/redirect-canonical-chains.js";
import { probeRedirectCanonicalChain } from "./modules/http-crawl/redirect-canonical-probe.js";
import {
  analyzeSitemapInventory, emptySitemapInventoryReview,
  MAX_SITEMAP_DOCUMENTS, MAX_SITEMAP_DOCUMENT_BYTES,
  MAX_SITEMAP_DISCOVERED, MAX_SITEMAP_PAGE_OBSERVATIONS,
  MAX_SITEMAP_FINDINGS, MAX_SITEMAP_URL_BYTES,
  SITEMAP_DOCUMENT_KINDS, SITEMAP_FINDING_CODES,
} from "./modules/http-crawl/sitemap-inventory.js";
import { probeSitemapInventory } from "./modules/http-crawl/sitemap-inventory-probe.js";
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
  httpDeliveryContent,
  browserResourceContent,
  sitemapInventoryContent,
  crawlerAccessContent,
  redirectCanonicalContent,
  availabilityReviewContent,
  httpDirectivesContent,
  httpsSecurityContent,
  urlVariantsContent,
  historicalComparisonContent,
  productionChangeContent,
  lighthouseLabContent,
  cruxFieldContent,
  crawlerLogContent,
  regressionPreviewContent,
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
  analyzeInternalLinkGraph, emptyInternalLinkGraphReview,
  MAX_GRAPH_PAGES, MAX_GRAPH_HTML_BYTES, MAX_GRAPH_TOTAL_HTML_BYTES,
  MAX_GRAPH_CATALOG_URLS, MAX_GRAPH_FINDINGS, GRAPH_FINDING_CODES,
} from "./modules/site-architecture/internal-link-graph.js";
import { probeInternalLinkGraph } from "./modules/site-architecture/internal-link-graph-probe.js";
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
  getAuditHistoryVersions,
  listAuditHistory,
  saveAuditHistorySnapshot,
} from "./audit-history.js";
import {
  analyzeHistoricalAudits,
  emptyHistoricalReview,
  MAX_HISTORICAL_VERSIONS,
  MAX_HISTORICAL_FINDINGS,
  HISTORICAL_STATUSES,
  HISTORICAL_FINDING_CODES,
} from "./modules/change-regression/historical-comparisons.js";
import {
  analyzeCrawlerLogs, emptyCrawlerLogReview,
  safeLogOrigin,
  MAX_CRAWL_LOG_RECORDS, MAX_CRAWL_LOG_TOTAL_BYTES,
  MAX_CRAWL_IMPORTANT_URLS, MAX_CRAWL_FINDINGS,
  CRAWL_LOG_FORMATS, CRAWL_PROFILES, CRAWL_FINDING_CODES,
} from "./modules/change-regression/crawler-log-correlation.js";
import { fetchOfficialGoogleCommonRanges } from "./modules/change-regression/google-common-crawler-ip.js";
import {
  analyzeProductionChange,
  emptyProductionChangeReview,
  MAX_CHANGE_HTML_BYTES,
  MAX_CHANGE_FINDINGS,
  CHANGE_STATUSES,
  CHANGE_FINDING_CODES,
} from "./modules/change-regression/production-change-comparison.js";
import {
  previewRegressionAlerts,
  emptyMonitorPreview,
  MONITOR_RULES,
  MONITOR_DECISIONS,
  MONITOR_STATUSES,
  MONITOR_REASON_CODES,
} from "./modules/change-regression/regression-alerts.js";
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

const graphLabelSchema = z.string().url().max(512)
  .refine((value) => Boolean(safeLinkPageUrl(value)),
    "Use a safe same-origin query-free HTTP(S) URL without credentials, fragment or port.");
const graphPageInputSchema = z.object({
  url: graphLabelSchema.describe("Observed page URL; only the supplied label is compared."),
  html: z.string().max(MAX_GRAPH_HTML_BYTES).refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_GRAPH_HTML_BYTES,
    "Observed static HTML must fit the 1 MiB UTF-8 cap.").optional()
    .describe("Optional static HTML of this page; absent HTML never certifies an empty link graph."),
  status_code: z.number().int().min(200).max(599).optional()
    .describe("Optional independently observed HTTP response status."),
  robots_allowed: z.boolean().optional()
    .describe("Optional independently observed crawler access; unknown when absent."),
  noindex: z.boolean().optional()
    .describe("Optional independently observed Google-applicable noindex declaration."),
  canonical_url: graphLabelSchema.optional()
    .describe("Optional observed preferred canonical target, not Google's selected canonical."),
}).strict();
const graphOutputPageSchema = z.object({
  page: z.number().int().min(1).max(MAX_GRAPH_PAGES),
  html_examined: z.boolean(),
  status_code: z.number().int().min(100).max(599).optional(),
  robots_access: z.enum(["allowed", "disallowed", "unknown"]),
  noindex_state: z.enum(["declared", "not_observed", "unknown"]),
  canonical_state: z.enum(["self", "different", "ambiguous", "unknown"]),
  links_observed: z.number().int().nonnegative(),
  internal_links: z.number().int().nonnegative(),
  external_links: z.number().int().nonnegative(),
  fragment_links: z.number().int().nonnegative(),
  query_links_excluded: z.number().int().nonnegative(),
  unsafe_links_excluded: z.number().int().nonnegative(),
  self_links: z.number().int().nonnegative(),
  nofollow_internal: z.number().int().nonnegative(),
  sampled_targets: z.number().int().nonnegative(),
  unobserved_internal_targets: z.number().int().nonnegative(),
  incoming_sampled_sources: z.number().int().nonnegative(),
  depth_from_entry: z.number().int().min(0).max(MAX_GRAPH_PAGES).nullable(),
  potential_orphan_in_sample: z.boolean(),
  extraction_limited: z.boolean(),
});
const graphOutputShape = {
  scope: z.enum(["caller_supplied_link_graph", "live_bounded_public_link_graph"]),
  pages_observed: z.number().int().min(0).max(MAX_GRAPH_PAGES),
  html_pages_examined: z.number().int().nonnegative(),
  entry_pages_observed: z.number().int().nonnegative(),
  entry_pages_missing: z.number().int().nonnegative(),
  pages_reachable_within_sample: z.number().int().nonnegative(),
  pages_unreachable_within_sample: z.number().int().nonnegative(),
  deepest_observed_sample_depth: z.number().int().min(0).max(MAX_GRAPH_PAGES).nullable(),
  deep_pages_at_three_or_more: z.number().int().nonnegative(),
  potential_orphans_within_sample: z.number().int().nonnegative(),
  unique_observed_sample_edges: z.number().int().nonnegative(),
  internal_links_observed: z.number().int().nonnegative(),
  external_links_observed: z.number().int().nonnegative(),
  nofollow_internal_links: z.number().int().nonnegative(),
  distinct_unsampled_link_targets: z.number().int().nonnegative(),
  unsafe_or_query_links_excluded: z.number().int().nonnegative(),
  pages_with_truncated_links: z.number().int().nonnegative(),
  linked_http_error_pages: z.number().int().nonnegative(),
  linked_robots_blocked_pages: z.number().int().nonnegative(),
  linked_declared_noindex_pages: z.number().int().nonnegative(),
  linked_noncanonical_pages: z.number().int().nonnegative(),
  sitemap_urls_provided: z.number().int().nonnegative(),
  sitemap_urls_without_page_sample: z.number().int().nonnegative(),
  sampled_pages_not_in_sitemap: z.number().int().nonnegative(),
  robots_unknown_pages: z.number().int().nonnegative(),
  status_unknown_pages: z.number().int().nonnegative(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(350)).max(4),
  pages: z.array(graphOutputPageSchema).max(MAX_GRAPH_PAGES),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(GRAPH_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    page: z.number().int().min(0).max(MAX_GRAPH_PAGES),
    target_page: z.number().int().min(1).max(MAX_GRAPH_PAGES).optional(),
    count: z.number().int().nonnegative(),
    message: z.string().max(360),
  })).max(MAX_GRAPH_FINDINGS),
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

const viewportSummaryOutputSchema = z.object({
  width: z.number().int().min(320).max(1_440),
  height: z.number().int().min(360).max(1_080),
  effective_layout_width: z.number().int().nonnegative().max(5_000),
  viewport_meta_present: z.boolean(),
  title_present: z.boolean(),
  description_present: z.boolean(),
  h1_count: z.number().int().nonnegative(),
  main_dom_words: z.number().int().nonnegative(),
  main_visible_words: z.number().int().nonnegative(),
  internal_links: z.number().int().nonnegative(),
  visible_links: z.number().int().nonnegative(),
  visible_nav_links: z.number().int().nonnegative(),
  canonical: z.enum(["missing", "self", "different", "unverified"]),
  noindex_declared: z.boolean(),
  jsonld_blocks: z.number().int().nonnegative(),
  controls_seen: z.number().int().nonnegative(),
  visible_controls: z.number().int().nonnegative(),
  keyboard_focusable_controls: z.number().int().nonnegative(),
  small_visible_controls: z.number().int().nonnegative(),
  observed_keyboard_targets: z.number().int().min(0).max(12),
  keyboard_incomplete: z.boolean(),
  disclosure_toggled: z.boolean().nullable(),
  horizontal_overflow_px: z.number().int().nonnegative(),
  sample_truncated: z.boolean(),
});
const viewportParityOutputShape = {
  scope: z.enum(["isolated_supplied_html_viewports", "isolated_public_html_viewports"]),
  browser_executed: z.boolean(),
  scripts_disabled: z.literal(true),
  mobile: viewportSummaryOutputSchema,
  desktop: viewportSummaryOutputSchema,
  titles_equivalent: z.boolean(),
  descriptions_equivalent: z.boolean(),
  h1_equivalent: z.boolean(),
  canonicals_equivalent: z.boolean(),
  robots_equivalent: z.boolean(),
  structured_data_count_equivalent: z.boolean(),
  mobile_missing_dom_tokens: z.number().int().nonnegative(),
  mobile_missing_visible_tokens: z.number().int().nonnegative(),
  mobile_missing_internal_links: z.number().int().nonnegative(),
  mobile_missing_visible_links: z.number().int().nonnegative(),
  blocked_resources: z.number().int().nonnegative().max(1_000),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(400)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(PARITY_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    count: z.number().int().positive(),
    message: z.string().max(320),
  })).max(MAX_PARITY_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const lighthouseLabOutputShape = {
  scope: z.literal("isolated_caller_supplied_html_lighthouse_lab"),
  status: z.enum(LAB_STATUSES),
  form_factor: z.enum(LAB_FACTORS),
  browser_executed: z.boolean(),
  scripts_disabled: z.literal(true),
  network_isolated: z.literal(true),
  lighthouse_version: z.string().max(50).nullable(),
  performance_score_percent: z.number().int().min(0).max(100).nullable(),
  metrics: z.object({
    fcp_ms: z.number().min(0).max(600_000).nullable(),
    lcp_ms: z.number().min(0).max(600_000).nullable(),
    tbt_ms: z.number().min(0).max(600_000).nullable(),
    speed_index_ms: z.number().min(0).max(600_000).nullable(),
    cls: z.number().min(0).max(100).nullable(),
  }),
  requests_blocked: z.number().int().min(0).max(80),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(420)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(LAB_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(320),
  })).max(MAX_LAB_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const cruxMetricOutputSchema = z.object({
  largest_contentful_paint: z.number().min(-600_000).max(600_000).nullable(),
  interaction_to_next_paint: z.number().min(-600_000).max(600_000).nullable(),
  cumulative_layout_shift: z.number().min(-100).max(100).nullable(),
  first_contentful_paint: z.number().min(-600_000).max(600_000).nullable(),
  experimental_time_to_first_byte: z.number().min(-600_000).max(600_000).nullable(),
});
const cruxVerdictOutputSchema = z.object({
  largest_contentful_paint: z.enum(["good","needs_improvement","poor","unavailable"]),
  interaction_to_next_paint: z.enum(["good","needs_improvement","poor","unavailable"]),
  cumulative_layout_shift: z.enum(["good","needs_improvement","poor","unavailable"]),
  first_contentful_paint: z.enum(["good","needs_improvement","poor","unavailable"]),
  experimental_time_to_first_byte: z.enum(["good","needs_improvement","poor","unavailable"]),
});
const cruxFieldOutputShape = {
  scope: z.literal("crux_real_user_field_p75"),
  mode: z.enum(CRUX_MODES),
  source: z.enum(CRUX_SOURCES),
  granularity: z.enum(["origin","url"]),
  form_factor: z.enum(CRUX_FORMS),
  status: z.enum(["complete","partial","unavailable"]),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  p75: cruxMetricOutputSchema,
  metric_verdicts: cruxVerdictOutputSchema,
  core_web_vitals: z.enum(["good","needs_improvement","poor","insufficient_data"]),
  periods_available: z.number().int().min(0).max(MAX_CRUX_HISTORY_PERIODS),
  periods_returned: z.number().int().min(0).max(MAX_CRUX_RETURNED_PERIODS),
  history_points: z.array(z.object({
    period: z.number().int().min(1).max(MAX_CRUX_HISTORY_PERIODS),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    p75: cruxMetricOutputSchema,
    core_web_vitals: z.enum(["good","needs_improvement","poor","insufficient_data"]),
  })).max(MAX_CRUX_RETURNED_PERIODS),
  first_last_delta: cruxMetricOutputSchema,
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(370)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(CRUX_FINDING_CODES),
    severity: z.enum(["warning","info"]),
    message: z.string().max(320),
  })).max(MAX_CRUX_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const crawlerLogPeriodOutputSchema = z.object({
  requests: z.number().int().nonnegative().max(MAX_CRAWL_LOG_RECORDS),
  http_2xx: z.number().int().nonnegative(),
  redirects_3xx: z.number().int().nonnegative(),
  block_401_403: z.number().int().nonnegative(),
  rate_limited_429: z.number().int().nonnegative(),
  missing_404_410: z.number().int().nonnegative(),
  server_5xx: z.number().int().nonnegative(),
  other_4xx: z.number().int().nonnegative(),
  problem_responses: z.number().int().nonnegative(),
  failure_rate_percent: z.number().min(0).max(100).nullable(),
});
const crawlerLogOutputShape = {
  scope: z.literal("caller_supplied_access_log_sample"),
  format: z.enum(CRAWL_LOG_FORMATS),
  status: z.enum(["comparable_sample","partial","not_comparable"]),
  important_urls_supplied: z.number().int().min(0).max(MAX_CRAWL_IMPORTANT_URLS),
  source_records: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  parsed_records: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  invalid_records: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  ignored_methods: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  unmatched_requests: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  query_variants_observed: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  matched_requests: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  before: crawlerLogPeriodOutputSchema,
  after: crawlerLogPeriodOutputSchema,
  failure_rate_delta_percentage_points: z.number().min(-100).max(100).nullable(),
  per_url: z.array(z.object({
    url_index: z.number().int().min(1).max(MAX_CRAWL_IMPORTANT_URLS),
    before_requests: z.number().int().nonnegative(),
    after_requests: z.number().int().nonnegative(),
    after_problem_responses: z.number().int().nonnegative(),
    after_block_401_403: z.number().int().nonnegative(),
    after_rate_limited_429: z.number().int().nonnegative(),
    after_server_5xx: z.number().int().nonnegative(),
  })).max(MAX_CRAWL_IMPORTANT_URLS),
  claimed_crawler_profiles: z.array(z.object({
    profile: z.enum(CRAWL_PROFILES),
    before_requests: z.number().int().nonnegative(),
    after_requests: z.number().int().nonnegative(),
    after_problem_responses: z.number().int().nonnegative(),
  })).max(CRAWL_PROFILES.length),
  googlebot_ip_evidence: z.object({
    status: z.enum(["not_requested","checked_current_official_ranges","unavailable"]),
    claimed_requests: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
    matched_current_ranges: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
    outside_current_ranges: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
    missing_or_invalid_ip: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
    matched_before: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
    matched_after: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
    matched_after_problem_responses: z.number().int().min(0).max(MAX_CRAWL_LOG_RECORDS),
  }),
  crawler_identities_verified: z.literal(false),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(380)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(CRAWL_FINDING_CODES),
    severity: z.enum(["warning","info"]),
    url_index: z.number().int().min(1).max(MAX_CRAWL_IMPORTANT_URLS).optional(),
    message: z.string().max(330),
  })).max(MAX_CRAWL_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const browserResourceInputSchema = z.object({
  resource_type: z.enum(RESOURCE_TYPES)
    .describe("Browser observed resource class, such as script, stylesheet, image or fetch."),
  origin: z.enum(RESOURCE_ORIGINS)
    .describe("Same-origin, third-party or unknown request classification; do not supply a URL."),
  outcome: z.enum(RESOURCE_OUTCOMES)
    .describe("Observed HTTP response, transport failure, explicit tool block, or still-pending request."),
  status_code: z.number().int().min(100).max(599).optional()
    .describe("Only for outcome=http: actual HTTP response status including 4xx/5xx."),
  failure_reason: z.enum(RESOURCE_FAILURE_REASONS).optional()
    .describe("Only for transport_failed: redacted DNS/timeout/TLS/connection/cancel/other category."),
  duration_ms: z.number().min(0).max(600_000).optional()
    .describe("Optional observed elapsed request time in milliseconds."),
}).strict();
const browserResourceOutputShape = {
  scope: z.enum(["caller_supplied_resource_observations", "guarded_public_browser_resources"]),
  browser_executed: z.boolean(),
  requests_recorded: z.number().int().min(0).max(MAX_RESOURCE_OBSERVATIONS),
  http_responses: z.number().int().nonnegative(),
  http_2xx_3xx: z.number().int().nonnegative(),
  http_4xx: z.number().int().nonnegative(),
  http_5xx: z.number().int().nonnegative(),
  http_429: z.number().int().nonnegative(),
  transport_failures: z.number().int().nonnegative(),
  tool_blocked_requests: z.number().int().nonnegative(),
  pending_requests: z.number().int().nonnegative(),
  additional_budget_blocked: z.number().int().nonnegative(),
  critical_resource_failures: z.number().int().nonnegative(),
  api_failures: z.number().int().nonnegative(),
  image_failures: z.number().int().nonnegative(),
  third_party_failures: z.number().int().nonnegative(),
  slow_requests: z.number().int().nonnegative(),
  navigation_completed: z.boolean().nullable(),
  resource_types: z.array(z.object({
    resource_type: z.enum(RESOURCE_TYPES),
    attempted: z.number().int().nonnegative(),
    http_responses: z.number().int().nonnegative(),
    http_4xx: z.number().int().nonnegative(),
    http_5xx: z.number().int().nonnegative(),
    transport_failures: z.number().int().nonnegative(),
    blocked_by_tool: z.number().int().nonnegative(),
    still_pending: z.number().int().nonnegative(),
  })).length(RESOURCE_TYPES.length),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(340)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(RESOURCE_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    count: z.number().int().positive(),
    message: z.string().max(310),
  })).max(MAX_RESOURCE_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const domSnapshotOutputSchema = z.object({
  title_present: z.boolean(),
  title_characters: z.number().int().nonnegative(),
  description_present: z.boolean(),
  description_characters: z.number().int().nonnegative(),
  h1_count: z.number().int().nonnegative(),
  main_words: z.number().int().nonnegative(),
  same_origin_link_targets: z.number().int().nonnegative(),
  query_links_excluded: z.number().int().nonnegative(),
  external_link_targets: z.number().int().nonnegative(),
  canonicals: z.enum(["missing", "self", "different", "ambiguous"]),
  noindex_declared: z.boolean(),
  jsonld_blocks: z.number().int().nonnegative(),
  external_script_tags: z.number().int().nonnegative(),
  inline_script_tags: z.number().int().nonnegative(),
  sample_truncated: z.boolean(),
});
const domDiffOutputShape = {
  scope: z.enum(["caller_supplied_rendered_snapshot",
    "isolated_inline_script_chromium", "isolated_public_html_inline_script_sample"]),
  browser_executed: z.boolean(),
  inline_scripts_attempted: z.boolean(),
  external_resources_blocked: z.number().int().nonnegative(),
  script_errors_observed: z.number().int().nonnegative(),
  raw: domSnapshotOutputSchema,
  rendered: domSnapshotOutputSchema,
  title_changed: z.boolean(),
  h1_changed: z.boolean(),
  canonical_changed: z.boolean(),
  noindex_changed: z.boolean(),
  shared_main_words: z.number().int().nonnegative(),
  main_words_removed: z.number().int().nonnegative(),
  main_words_added: z.number().int().nonnegative(),
  link_targets_removed: z.number().int().nonnegative(),
  link_targets_added: z.number().int().nonnegative(),
  unchanged_link_targets: z.number().int().nonnegative(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(320)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(RENDER_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(320),
  })).max(MAX_RENDER_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const productionFingerprintSchema = z.object({
  http_status: z.number().int().min(200).max(599).nullable(),
  html_bytes: z.number().int().nonnegative().max(MAX_CHANGE_HTML_BYTES),
  html_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  main_text_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  main_words: z.number().int().nonnegative().nullable(),
  same_origin_link_targets: z.number().int().nonnegative().nullable(),
  title_present: z.boolean().nullable(),
  description_present: z.boolean().nullable(),
  h1_count: z.number().int().nonnegative().nullable(),
  canonical_state: z.enum(["missing", "self", "different", "ambiguous"]).nullable(),
  noindex_declared: z.boolean().nullable(),
  jsonld_blocks: z.number().int().nonnegative().nullable(),
  sample_truncated: z.boolean(),
});
const productionChangeOutputSchema = {
  scope: z.literal("two_caller_supplied_html_observations"),
  status: z.enum(CHANGE_STATUSES),
  time_order_ambiguous: z.boolean(),
  baseline: productionFingerprintSchema,
  current: productionFingerprintSchema,
  http_status_changed: z.boolean().nullable(),
  html_fingerprint_changed: z.boolean().nullable(),
  main_text_fingerprint_changed: z.boolean().nullable(),
  title_changed: z.boolean().nullable(),
  description_changed: z.boolean().nullable(),
  h1_changed: z.boolean().nullable(),
  canonical_changed: z.boolean().nullable(),
  robots_changed: z.boolean().nullable(),
  noindex_added: z.boolean().nullable(),
  noindex_removed: z.boolean().nullable(),
  main_words_added: z.number().int().nonnegative().nullable(),
  main_words_removed: z.number().int().nonnegative().nullable(),
  links_added: z.number().int().nonnegative().nullable(),
  links_removed: z.number().int().nonnegative().nullable(),
  jsonld_blocks_changed: z.boolean().nullable(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(340)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(CHANGE_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(320),
  })).max(MAX_CHANGE_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

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

const monitorPolicyInputSchema = z.object({
  min_regressed_pages: z.number().int().min(1).max(8).optional()
    .describe("Minimum number of regressed matched pages in the latest fully comparable sample (default 1)."),
  min_net_error_increase: z.number().int().min(1).max(10_000).optional()
    .describe("Minimum positive net change in observed error counts across matching completed pages (default 1)."),
  min_net_warning_increase: z.number().int().min(1).max(10_000).optional()
    .describe("Minimum positive net change in observed warning counts across matching completed pages (default 1)."),
  min_coverage_lost_pages: z.number().int().min(1).max(8).optional()
    .describe("Minimum previously completed pages now missing a complete check for a review-only observation (default 1)."),
  consecutive_regressing_steps: z.number().int().min(1).max(4).optional()
    .describe("Consecutive fully comparable regression transitions needed for the regressed-pages candidate (default 1)."),
  review_coverage_loss: z.boolean().optional()
    .describe("Include review-only validator coverage-loss observations without treating them as defects (default true)."),
  review_sitemap_drift: z.boolean().optional()
    .describe("Include review-only discovery fingerprint changes, never as defect alarms (default true)."),
}).strict();
const monitorPolicyOutputSchema = monitorPolicyInputSchema.required();
const monitorOutputSchema = {
  scope: z.literal("manual_sampled_regression_alert_preview_only"),
  source: z.enum(["local_saved_ids", "caller_supplied_snapshots"]),
  status: z.enum(MONITOR_STATUSES),
  dry_run: z.literal(true),
  manually_invoked: z.literal(true),
  scheduler_enabled: z.literal(false),
  delivery_enabled: z.literal(false),
  notifications_sent: z.literal(0),
  external_integrations_used: z.literal(false),
  latest_baseline_version: z.number().int().min(0).max(MAX_HISTORICAL_VERSIONS),
  latest_current_version: z.number().int().min(0).max(MAX_HISTORICAL_VERSIONS),
  latest_comparability: z.enum(HISTORICAL_STATUSES),
  latest_compared_pages: z.number().int().nonnegative().max(8),
  latest_completed_pairs: z.number().int().nonnegative().max(8),
  candidate_count: z.number().int().nonnegative().max(MONITOR_RULES.length),
  review_only_count: z.number().int().nonnegative().max(MONITOR_RULES.length),
  suppressed_count: z.number().int().nonnegative().max(MONITOR_RULES.length),
  coverage_limited: z.literal(true),
  policy: monitorPolicyOutputSchema,
  rules: z.array(z.object({
    rule: z.enum(MONITOR_RULES),
    decision: z.enum(MONITOR_DECISIONS),
    reason_code: z.enum(MONITOR_REASON_CODES),
    latest_observed_value: z.number().int(),
    threshold: z.number().int().min(1).max(10_000),
    review_required: z.boolean(),
    message: z.string().max(290),
  })).max(MONITOR_RULES.length),
  limitations: z.array(z.string().max(360)).max(4),
  error: z.string().optional(),
};

const historicalStepSchema = z.object({
  baseline_version: z.number().int().min(1).max(MAX_HISTORICAL_VERSIONS),
  current_version: z.number().int().min(1).max(MAX_HISTORICAL_VERSIONS),
  status: z.enum(HISTORICAL_STATUSES),
  shared_pages: z.number().int().nonnegative().max(8),
  completely_checked_pairs: z.number().int().nonnegative().max(8),
  regressed_pages: z.number().int().nonnegative().max(8),
  improved_pages: z.number().int().nonnegative().max(8),
  mixed_pages: z.number().int().nonnegative().max(8),
  unchanged_pages: z.number().int().nonnegative().max(8),
  coverage_lost_pages: z.number().int().nonnegative().max(8),
  coverage_recovered_pages: z.number().int().nonnegative().max(8),
  unverified_pages: z.number().int().nonnegative().max(8),
  errors_delta_checked: z.number().int(),
  warnings_delta_checked: z.number().int(),
  changed_sample: z.boolean(), sitemap_changed: z.boolean(),
  issue_group_comparison_available: z.boolean(),
  newly_observed_groups: z.number().int().nonnegative().nullable(),
  no_longer_observed_groups: z.number().int().nonnegative().nullable(),
  expanding_groups: z.number().int().nonnegative().nullable(),
  shrinking_groups: z.number().int().nonnegative().nullable(),
});
const historicalOutputSchema = {
  scope: z.literal("historical_compact_audit_versions_only"),
  source: z.enum(["local_saved_ids", "caller_supplied_snapshots"]),
  status: z.enum(HISTORICAL_STATUSES),
  versions_compared: z.number().int().nonnegative().max(MAX_HISTORICAL_VERSIONS),
  comparisons_made: z.number().int().nonnegative().max(MAX_HISTORICAL_VERSIONS - 1),
  comparable_transitions: z.number().int().nonnegative(),
  partial_transitions: z.number().int().nonnegative(),
  not_comparable_transitions: z.number().int().nonnegative(),
  stable_cohort_pages: z.number().int().nonnegative().max(8),
  complete_stable_cohort_pages: z.number().int().nonnegative().max(8),
  cohort_metrics_available: z.boolean(),
  time_order_ambiguous: z.boolean(),
  total_regressed_page_transitions: z.number().int().nonnegative(),
  total_improved_page_transitions: z.number().int().nonnegative(),
  total_coverage_lost_transitions: z.number().int().nonnegative(),
  historical_points: z.array(z.object({
    version: z.number().int().min(1).max(MAX_HISTORICAL_VERSIONS),
    sampled_pages: z.number().int().nonnegative().max(8),
    completed_pages: z.number().int().nonnegative().max(8),
    sample_limited: z.boolean(),
    cohort_completed_pages: z.number().int().nonnegative().max(8),
    cohort_errors: z.number().int().nonnegative().nullable(),
    cohort_warnings: z.number().int().nonnegative().nullable(),
    cohort_mean_health_score: z.number().min(0).max(100).nullable(),
  })).max(MAX_HISTORICAL_VERSIONS),
  consecutive_changes: z.array(historicalStepSchema).max(MAX_HISTORICAL_VERSIONS - 1),
  first_last_change: historicalStepSchema.nullable(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(360)).max(4),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    version: z.number().int().min(1).max(MAX_HISTORICAL_VERSIONS),
    code: z.enum(HISTORICAL_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(330),
  })).max(MAX_HISTORICAL_FINDINGS),
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

const deliveryInputUrl = z.string().url().max(512)
  .refine((value) => Boolean(safeHttpResourceUrl(value)),
    "Use a query-free HTTP(S) URL without credentials, fragment or custom port.");
const deliveryHeaderSchema = z.record(z.string(), z.string().max(MAX_DELIVERY_HEADER_VALUE_BYTES))
  .refine((headers) => Object.entries(headers).every(([name, value]) =>
    DELIVERY_HEADER_NAMES.includes(name.toLowerCase() as typeof DELIVERY_HEADER_NAMES[number])
    && !/[\r\n\u0000]/u.test(value)),
  "Only V01 allowlisted HTTP headers with single-line values may be supplied.");
const deliveryObservationSchema = z.object({
  url: deliveryInputUrl.describe("Safe query-free URL label of this already-observed HTTP hop; never echoed."),
  status_code: z.number().int().min(100).max(599)
    .describe("Observed HTTP response status code from this hop, never inferred."),
  method: z.enum(["GET", "HEAD"]).optional()
    .describe("Actual HTTP request method used for this observed response."),
  headers: deliveryHeaderSchema.optional()
    .describe("Optional allowlisted response-header observations, not returned verbatim."),
});
const deliveryOutputSchema = {
  scope: z.enum(["live_public_http_probe", "caller_supplied_http_observations"]),
  hops_observed: z.number().int().min(0).max(MAX_DELIVERY_HOPS),
  redirects_observed: z.number().int().nonnegative().max(MAX_DELIVERY_HOPS),
  final_http_status: z.number().int().min(100).max(599).optional(),
  errors_observed: z.number().int().nonnegative().max(MAX_DELIVERY_HOPS),
  challenges_observed: z.number().int().nonnegative().max(MAX_DELIVERY_HOPS),
  redirect_chain_complete: z.boolean(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(260)).max(4),
  hops: z.array(z.object({
    hop: z.number().int().min(1).max(MAX_DELIVERY_HOPS),
    status_code: z.number().int().min(100).max(599),
    status: z.enum(["success", "redirect", "forbidden", "rate_limited", "server_error", "client_error", "other"]),
    method: z.enum(["GET", "HEAD", "unspecified"]),
    https: z.boolean(),
    redirect_target: z.enum(["none", "same_origin", "cross_origin", "https_downgrade", "query_target", "invalid", "missing"]),
    next_hop_observed: z.boolean(),
    cache_state: z.enum(["hit", "miss", "bypass", "dynamic", "expired", "stale", "other", "unknown"]),
    cache_no_store: z.boolean(),
    cache_no_cache: z.boolean(),
    cache_private: z.boolean(),
    cache_max_age_seconds: z.number().int().nonnegative().optional(),
    age_seconds: z.number().int().nonnegative().optional(),
    retry_after_present: z.boolean(),
    retry_after_seconds: z.number().int().nonnegative().optional(),
    cf_challenge: z.boolean(),
    cf_ray_present: z.boolean(),
    cloudflare_server: z.boolean(),
    content_type_html: z.boolean(),
  })).max(MAX_DELIVERY_HOPS),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    hop: z.number().int().min(1).max(MAX_DELIVERY_HOPS),
    code: z.enum(DELIVERY_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(260),
  })).max(MAX_DELIVERY_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const availabilityObservationSchema = z.object({
  observed_at: z.string().datetime({ offset: true }).max(40)
    .describe("Real observation timestamp with explicit UTC offset, in strictly increasing order."),
  status_code: z.number().int().min(100).max(599).optional()
    .describe("Actual HTTP response code, mutually exclusive with failure."),
  failure: z.enum(AVAILABILITY_FAILURE_CODES).optional()
    .describe("Explicit no-response failure class, mutually exclusive with status_code."),
  cf_challenge: z.boolean().optional()
    .describe("Whether this HTTP response explicitly reported a Cloudflare challenge header."),
  elapsed_ms: z.number().int().min(0).max(120_000).optional()
    .describe("Elapsed duration of this observed request in integer milliseconds, if measured."),
}).strict();
const availabilityReviewOutputShape = {
  scope: z.enum(["caller_supplied_history", "live_bounded_burst", "local_saved_history"]),
  observations_count: z.number().int().min(0).max(MAX_AVAILABILITY_OBSERVATIONS),
  first_observed_at: z.string().datetime({ offset: true }).optional(),
  last_observed_at: z.string().datetime({ offset: true }).optional(),
  sampled_window_minutes: z.number().nonnegative(),
  max_observation_gap_minutes: z.number().nonnegative(),
  observed_successes: z.number().int().nonnegative(),
  observed_redirects: z.number().int().nonnegative(),
  observed_http_4xx: z.number().int().nonnegative(),
  observed_http_5xx: z.number().int().nonnegative(),
  observed_timeouts: z.number().int().nonnegative(),
  observed_transport_failures: z.number().int().nonnegative(),
  observed_rate_limits: z.number().int().nonnegative(),
  observed_challenges: z.number().int().nonnegative(),
  observed_success_percent: z.number().int().min(0).max(100),
  http_status_changes: z.number().int().nonnegative(),
  outcome_changes: z.number().int().nonnegative(),
  intermittent_non_success: z.boolean(),
  longest_non_success_streak: z.number().int().nonnegative(),
  current_non_success_streak: z.number().int().nonnegative(),
  latest_observed_state: z.enum(AVAILABILITY_STATES).optional(),
  latest_http_status: z.number().int().min(100).max(599).optional(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(260)).max(4),
  samples: z.array(z.object({
    observation: z.number().int().min(1).max(MAX_AVAILABILITY_OBSERVATIONS),
    observed_at: z.string().datetime({ offset: true }),
    status_code: z.number().int().min(100).max(599).optional(),
    state: z.enum(AVAILABILITY_STATES),
    cf_challenge: z.boolean(),
    elapsed_ms: z.number().int().min(0).max(120_000).optional(),
  })).max(MAX_AVAILABILITY_OBSERVATIONS),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(AVAILABILITY_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(260),
  })).max(MAX_AVAILABILITY_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};
const availabilityHistoryOutputShape = {
  action: z.enum(["capture", "list", "compare"]),
  count: z.number().int().nonnegative().max(MAX_AVAILABILITY_HISTORY),
  records: z.array(z.object({
    id: z.string().uuid(),
    saved_at: z.string().datetime({ offset: true }),
    observation: availabilityObservationSchema,
  })).max(MAX_AVAILABILITY_HISTORY),
  saved_id: z.string().uuid().optional(),
  evicted_id: z.string().uuid().optional(),
  review: z.object(availabilityReviewOutputShape).optional(),
  error: z.string().optional(),
};

const crawlerPageInputSchema = z.object({
  url: deliveryInputUrl.describe("Exact same-origin query-free page URL label, never returned."),
  status_code: z.number().int().min(100).max(599).optional()
    .describe("Observed page HTTP status, if known."),
  html: z.string().max(MAX_CRAWLER_HTML_BYTES).optional()
    .describe("Optional static raw HTML (150 KB byte cap); scripts are not executed or stored."),
  x_robots_tag: z.array(z.string().max(512)).max(8).optional()
    .describe("Observed X-Robots-Tag response header values; [] means checked and absent."),
}).strict();
const crawlerProfileInput = z.array(z.enum(CRAWLER_PROFILES))
  .min(1).max(CRAWLER_PROFILES.length).optional();
const crawlerAccessOutputShape = {
  scope: z.enum(["caller_supplied_crawler_evidence", "live_public_crawler_probe"]),
  pages_observed: z.number().int().min(0).max(MAX_CRAWLER_PAGES),
  profiles_checked: z.number().int().nonnegative().max(CRAWLER_PROFILES.length),
  rows_checked: z.number().int().nonnegative().max(MAX_CRAWLER_PAGES * CRAWLER_PROFILES.length),
  robots_status_code: z.number().int().min(100).max(599).optional(),
  robots_rules_used: z.number().int().nonnegative(),
  robots_rules_truncated: z.boolean(),
  robots_unavailable: z.boolean(),
  crawler_disallowed_rows: z.number().int().nonnegative(),
  noindex_declared_rows: z.number().int().nonnegative(),
  unknown_access_rows: z.number().int().nonnegative(),
  unknown_indexing_rows: z.number().int().nonnegative(),
  scope_ambiguous_rows: z.number().int().nonnegative(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(260)).max(5),
  rows: z.array(z.object({
    page: z.number().int().min(1).max(MAX_CRAWLER_PAGES),
    profile: z.enum(CRAWLER_PROFILES),
    robots_access: z.enum(CRAWLER_ACCESS_STATES),
    robots_rule: z.enum(["allow", "disallow", "none", "unknown"]),
    robots_group_matched: z.boolean(),
    indexing_state: z.enum(CRAWLER_INDEXING_STATES),
    indexing_source: z.enum(["meta", "header", "both", "none"]),
    explicit_index_directive: z.boolean(),
    conflicting_index_directives: z.boolean(),
    x_robots_scope_ambiguous: z.boolean(),
    page_http_status: z.number().int().min(100).max(599).optional(),
    static_html_examined: z.boolean(),
    effective_access: z.enum(["crawl_disallowed", "crawl_allowed_noindex_declared",
      "crawl_allowed_no_noindex_observed", "unverified"]),
  })).max(MAX_CRAWLER_PAGES * CRAWLER_PROFILES.length),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    code: z.enum(CRAWLER_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    page: z.number().int().min(1).max(MAX_CRAWLER_PAGES),
    profile: z.enum(CRAWLER_PROFILES),
    message: z.string().max(260),
  })).max(MAX_CRAWLER_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const chainLabelSchema = z.string().url().max(1024)
  .refine((value) => safeVariantLabel(value) !== null,
    "Use a safe HTTP(S) URL without credentials, fragments or a custom port.");
const chainObservationSchema = z.object({
  url: chainLabelSchema.describe("Observed HTTP URL label, not echoed in the report."),
  status_code: z.number().int().min(100).max(599)
    .describe("Observed HTTP status code from this response hop."),
  location: z.string().max(1024).optional()
    .describe("Observed Location header when HTTP returned a redirect."),
  canonicals: z.array(z.string().max(1024)).max(MAX_CHAIN_CANONICALS).optional()
    .describe("Previously observed canonical href values, including HTTP Link declarations."),
  html: z.string().max(MAX_CHAIN_HTML_BYTES).optional()
    .describe("Optional static source HTML (150 KB UTF-8 cap), never executed or returned."),
  x_robots_tag: z.array(z.string().max(512)).max(8).optional()
    .describe("Optional observed X-Robots-Tag fields; [] means inspected and absent."),
  robots_allowed: z.boolean().optional()
    .describe("Optional independent robots-access evidence; never inferred from the HTTP status."),
}).strict();
const chainReviewOutputShape = {
  scope: z.enum(["caller_supplied_redirect_evidence", "live_public_redirect_probe"]),
  hops_observed: z.number().int().min(0).max(MAX_CHAIN_HOPS),
  redirects_observed: z.number().int().min(0).max(MAX_CHAIN_HOPS),
  permanent_redirects: z.number().int().nonnegative(),
  temporary_redirects: z.number().int().nonnegative(),
  chain_complete: z.boolean(),
  loop_detected: z.boolean(),
  final_status_code: z.number().int().min(100).max(599).optional(),
  expected_destination_match: z.boolean().optional(),
  conflicting_canonical_hops: z.number().int().nonnegative(),
  canonical_cycles: z.number().int().nonnegative(),
  canonical_chain_edges: z.number().int().nonnegative(),
  nonindexable_destination: z.boolean(),
  destination_indexing_state: z.enum(CHAIN_INDEXING_STATES),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(260)).max(4),
  hops: z.array(z.object({
    hop: z.number().int().min(1).max(MAX_CHAIN_HOPS),
    status_code: z.number().int().min(100).max(599),
    redirect_state: z.enum(CHAIN_REDIRECT_STATES),
    redirect_target: z.enum(CHAIN_TARGET_STATES),
    next_hop_observed: z.boolean(),
    canonical_state: z.enum(CHAIN_CANONICAL_STATES),
    canonical_declarations: z.number().int().nonnegative(),
    canonical_target_sampled: z.boolean(),
    googlebot_indexing_state: z.enum(CHAIN_INDEXING_STATES),
    robots_allowed: z.enum(["allowed", "disallowed", "unknown"]),
    static_html_examined: z.boolean(),
    x_robots_header_examined: z.boolean(),
  })).max(MAX_CHAIN_HOPS),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    hop: z.number().int().min(1).max(MAX_CHAIN_HOPS),
    code: z.enum(CHAIN_FINDING_CODES),
    severity: z.enum(["warning", "info"]),
    message: z.string().max(260),
  })).max(MAX_CHAIN_FINDINGS),
  findings_truncated: z.boolean(),
  error: z.string().optional(),
};

const sitemapDocInputSchema = z.object({
  sitemap_url: deliveryInputUrl.describe("Same-origin, query-free sitemap URL; never echoed."),
  content: z.string().max(MAX_SITEMAP_DOCUMENT_BYTES)
    .describe("Observed XML or plain-text sitemap document, UTF-8 byte bounded."),
  content_type: z.enum(["application/xml", "text/xml", "text/plain"]).optional()
    .describe("Observed document content type; defaults to XML."),
  status_code: z.number().int().min(100).max(599).optional()
    .describe("Observed HTTP status for this sitemap, if known."),
}).strict();
const sitemapPageEvidenceInputSchema = z.object({
  url: chainLabelSchema.describe("Independently observed same-origin page URL."),
  status_code: z.number().int().min(100).max(599).optional()
    .describe("Observed page HTTP response status."),
  canonical_url: chainLabelSchema.optional()
    .describe("Observed page canonical preference, not Google-selected canonical."),
  noindex: z.boolean().optional()
    .describe("Observed robots meta or X-Robots-Tag noindex declaration."),
  robots_allowed: z.boolean().optional()
    .describe("Independently observed crawler robots permission, not inferred."),
  modified_at: z.string().max(40).optional()
    .describe("Independently established significant modification date in W3C format."),
}).strict();
const sitemapOutputShape = {
  scope: z.enum(["caller_supplied_sitemap_evidence", "live_public_sitemap_sample"]),
  documents_observed: z.number().int().min(0).max(MAX_SITEMAP_DOCUMENTS),
  documents_complete: z.boolean(),
  discovered_complete: z.boolean(),
  inventory_complete: z.boolean(),
  documents_truncated: z.boolean(),
  total_entries_seen: z.number().int().nonnegative(),
  distinct_sitemap_urls: z.number().int().nonnegative(),
  distinct_page_urls: z.number().int().nonnegative(),
  distinct_child_sitemaps: z.number().int().nonnegative(),
  missing_child_documents: z.number().int().nonnegative(),
  duplicate_url_entries: z.number().int().nonnegative(),
  invalid_url_entries: z.number().int().nonnegative(),
  external_url_entries: z.number().int().nonnegative(),
  lastmod_values_seen: z.number().int().nonnegative(),
  lastmod_invalid_count: z.number().int().nonnegative(),
  lastmod_future_count: z.number().int().nonnegative(),
  lastmod_conflicting_count: z.number().int().nonnegative(),
  independently_discovered_urls: z.number().int().nonnegative(),
  discovered_in_sitemaps: z.number().int().nonnegative(),
  discovered_missing_from_sitemaps: z.number().int().nonnegative(),
  sitemap_urls_not_in_discovery: z.number().int().nonnegative(),
  page_observations: z.number().int().nonnegative(),
  sitemap_urls_with_page_evidence: z.number().int().nonnegative(),
  status_conflicts: z.number().int().nonnegative(),
  noindex_conflicts: z.number().int().nonnegative(),
  robots_conflicts: z.number().int().nonnegative(),
  canonical_conflicts: z.number().int().nonnegative(),
  lastmod_observation_conflicts: z.number().int().nonnegative(),
  known_indexability_conflicts: z.number().int().nonnegative(),
  unknown_page_indexability: z.number().int().nonnegative(),
  coverage_limited: z.literal(true),
  limitations: z.array(z.string().max(260)).max(5),
  documents: z.array(z.object({
    document: z.number().int().min(1).max(MAX_SITEMAP_DOCUMENTS),
    kind: z.enum(SITEMAP_DOCUMENT_KINDS),
    status_code: z.number().int().min(100).max(599).optional(),
    entries_seen: z.number().int().nonnegative(),
    valid_url_entries: z.number().int().nonnegative(),
    child_sitemaps: z.number().int().nonnegative(),
    invalid_entries: z.number().int().nonnegative(),
    external_entries: z.number().int().nonnegative(),
    duplicate_entries: z.number().int().nonnegative(),
    lastmod_present: z.number().int().nonnegative(),
    lastmod_invalid: z.number().int().nonnegative(),
    lastmod_future: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })).max(MAX_SITEMAP_DOCUMENTS),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(z.object({
    document: z.number().int().min(0).max(MAX_SITEMAP_DOCUMENTS),
    entry: z.number().int().positive().optional(),
    severity: z.enum(["warning", "info"]),
    code: z.enum(SITEMAP_FINDING_CODES),
    message: z.string().max(260),
  })).max(MAX_SITEMAP_FINDINGS),
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
    "audit.monitor",
    {
      title: "Dry-run regression monitoring of existing local audit history",
      description:
        "Manual, offline, read-only P2-02 regression/optional-alert PREVIEW for two to ten existing saved audit.history IDs in oldest-first order. Configurable 1–8 sampled regressed pages, net error/warning increases, 1–4 step regression streak and review-only coverage loss/sitemap drift. Candidate alerts require complete comparable observations with unambiguous chronology; nothing is sent, scheduled, persisted, fetched or connected to GSC/GA4.",
      inputSchema: {
        ids: z.array(z.string().uuid()).min(2).max(MAX_HISTORICAL_VERSIONS)
          .describe("Two to ten already-saved distinct local history version IDs, oldest to newest; the archive is never modified by monitoring."),
        dry_run: z.literal(true).default(true)
          .describe("Strictly manual simulation. Only true is accepted; no alert delivery or scheduling exists."),
        policy: monitorPolicyInputSchema.optional()
          .describe("Optional bounded manual-only thresholds and review toggles, not persisted or scheduled."),
      },
      outputSchema: monitorOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ ids, policy }) => {
      try {
        const versions = await getAuditHistoryVersions(ids);
        const history = analyzeHistoricalAudits(versions, "local_saved_ids");
        const preview = previewRegressionAlerts(history, policy);
        return result(preview, regressionPreviewContent(preview));
      } catch {
        const error = "Manual regression preview cannot safely evaluate the saved versions, chronology, scope, policy or audit coverage. No notifications, schedules, or history changes occurred.";
        return result({ ...emptyMonitorPreview("local_saved_ids"), error }, failureContent(
          "Manual regression alert preview", error,
          "List audit.history, supply two to ten existing IDs oldest first and valid bounded policy thresholds; no alerts can be sent.",
        ), true);
      }
    },
  );

  server.registerTool(
    "crawler.logs",
    {
      title: "Correlate supplied crawler access-log failures around a cutover",
      description:
        "V12/V13 local-only: correlate 1–16 important URLs across 500 supplied access observations, grouping failures and claimed crawlers. Optional verify_googlebot_ip_ranges=true downloads one fixed Google official common-crawler CIDR list and compares caller-supplied source IPs locally. Default is offline. No IPs, UAs, paths, logs, query or timestamps returned; no target-site fetch, log-provider connection, storage, DNS verification, Search Console or Google ranking causation.",
      inputSchema: {
        site_origin: z.string().min(1).max(300)
          .refine(value => Boolean(safeLogOrigin(value)),
            "Supply a safe public HTTPS origin with no path, query, private hostname or credentials.")
          .describe("Public HTTPS origin shared by all important URLs and log paths, used only for local matching; never contacted."),
        important_urls: z.array(z.string().min(1).max(512))
          .min(1).max(MAX_CRAWL_IMPORTANT_URLS)
          .describe("One to sixteen explicit same-origin public important URL labels without query/fragment; output uses index numbers, not URLs."),
        cutover_at: z.string().min(20).max(40)
          .describe("Offset-aware ISO cutover timestamp dividing supplied request evidence into before versus after; never echoed."),
        format: z.enum(CRAWL_LOG_FORMATS)
          .describe("Use structured observations or Apache/Nginx combined access-log lines; exactly one source must be supplied."),
        observations: z.array(z.object({
          timestamp: z.string().min(1).max(40)
            .describe("Request timestamp with explicit timezone offset or Z; invalid values reduce coverage rather than being guessed."),
          method: z.string().min(1).max(12)
            .describe("HTTP method as observed; only GET/HEAD are correlated for crawl evidence."),
          path: z.string().min(1).max(1024)
            .describe("Observed same-origin request path including optional query, never echoed. Unsafe encoded separators are excluded."),
          status: z.number().int().min(200).max(599)
            .describe("Actual caller-observed HTTP response status."),
          user_agent: z.string().max(300).optional()
            .describe("Optional unverified User-Agent text, classified only as claimed crawler profile and never echoed."),
          client_ip: z.string().max(64).optional()
            .describe("Optional source client IP for Googlebot range matching. Use trusted visitor IP, not reverse-proxy edge IP; never returned."),
        })).min(1).max(MAX_CRAWL_LOG_RECORDS).optional()
          .describe("Only structured mode: 1–500 previously captured HTTP observations, not fetched or saved."),
        access_log: z.string().min(1).max(MAX_CRAWL_LOG_TOTAL_BYTES)
          .refine(value => Buffer.byteLength(value,"utf8") <= MAX_CRAWL_LOG_TOTAL_BYTES)
          .optional()
          .describe("Only combined_access: up to 256 KB of Apache/Nginx combined access lines, max 500; IPs/referers/URLs/UA are not returned or stored."),
        verify_googlebot_ip_ranges: z.boolean().default(false)
          .describe("False by default. True requests one bounded GET of the current common-crawlers.json from fixed developers.google.com URL. All log IPs stay local; no other sites contacted, historical source IPs cannot be proven by current ranges."),
      },
      outputSchema: crawlerLogOutputShape,
      annotations: localReadOnlyAnnotations,
    },
    async ({site_origin,important_urls,cutover_at,format,observations,access_log,verify_googlebot_ip_ranges}) => {
      try {
        const sample={
          site_origin, important_urls, cutover_at, format,
          observations, access_log,
        };
        let review=analyzeCrawlerLogs(sample);
        if(verify_googlebot_ip_ranges){
          let ranges;
          try{ranges=await fetchOfficialGoogleCommonRanges();}catch{ /* Preserve offline results if Google is unavailable. */ }
          review=analyzeCrawlerLogs(sample,{requested:true,ranges});
        }
        return result(review,crawlerLogContent(review));
      }catch{
        const error="Crawler access logs could not be safely correlated within same-origin, timestamp, format, record-count or privacy limits.";
        return result({ ...emptyCrawlerLogReview(format),error },failureContent(
          "Supplied crawler log correlation",error,
          "Provide 1–16 safe important URL labels and up to 500 authorized structured/combined request observations around a valid offset-aware cutover. No source data was changed.",
        ),true);
      }
    },
  );

  server.registerTool(
    "audit.production_change",
    {
      title: "Compare two captured production HTML versions",
      description:
        "V10 offline exact-page comparison of two explicitly supplied timestamped HTML observations: SHA-256 HTML/main-text fingerprints, title/description/H1/canonical/robots, JSON-LD block counts and bounded internal-link and main-word changes. Non-200 delivery and incomplete evidence suppress content-change claims. No live fetches, storage, deployment, source-text output, Google indexing or ranking causation.",
      inputSchema: {
        page_url: z.string().max(512).refine((value) => Boolean(safeMetadataLabel(value)))
          .describe("Exact safe page URL without query, fragment, credentials or custom port; not fetched."),
        baseline: z.object({
          observed_at: z.string().min(20).max(40)
            .describe("Earlier offset-aware ISO capture timestamp; supplied by caller, not independently verified."),
          http_status: z.number().int().min(200).max(599).optional()
            .describe("Earlier observed HTTP response status; omit if unknown."),
          html: z.string().max(MAX_CHANGE_HTML_BYTES)
            .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_CHANGE_HTML_BYTES)
            .describe("Earlier captured HTML body, up to 180,000 UTF-8 bytes; empty only for a failed response."),
        }).describe("Earlier caller-supplied captured response. A non-200 status can have empty HTML."),
        current: z.object({
          observed_at: z.string().min(20).max(40)
            .describe("Later offset-aware ISO capture timestamp; supplied by caller, not independently verified."),
          http_status: z.number().int().min(200).max(599).optional()
            .describe("Later observed HTTP response status; omit if unknown."),
          html: z.string().max(MAX_CHANGE_HTML_BYTES)
            .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_CHANGE_HTML_BYTES)
            .describe("Later captured HTML body, up to 180,000 UTF-8 bytes; empty only for a failed response."),
        }).describe("Later caller-supplied captured response. Timestamps are validated but not verified."),
      },
      outputSchema: productionChangeOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async (input) => {
      try {
        const review = await analyzeProductionChange(input);
        return result(review, productionChangeContent(review));
      } catch {
        const error = "Production HTML versions could not be compared within URL, timestamp, delivery and evidence limits.";
        return result({ ...emptyProductionChangeReview(), error }, failureContent(
          "Production HTML change comparison", error,
          "Supply one safe page URL and two bounded, oldest-first HTML observations; no network requests or saved data were changed.",
        ), true);
      }
    },
  );

  server.registerTool(
    "audit.trends",
    {
      title: "Compare two to ten locally saved site-audit history versions",
      description:
        "Read-only, offline longitudinal comparison of 2–10 previously saved local audit.history version IDs (oldest first). Uses only the existing compact audit archive, compares adjacent and first/last snapshots plus an exact fully-checked all-version cohort, separates coverage loss from real changes and gates issue-group disappearance on identical complete selected samples. No new site requests, archive mutations, scheduled checks or Google-indexing claims. Returns only redacted numeric evidence, never page URLs, issue messages or stored snapshots.",
      inputSchema: {
        ids: z.array(z.string().uuid()).min(2).max(MAX_HISTORICAL_VERSIONS)
          .describe("Two to ten distinct IDs of already-saved audit.history versions in oldest-to-newest storage order. An evicted or missing version fails closed without changing the archive."),
      },
      outputSchema: historicalOutputSchema,
      annotations: localReadOnlyAnnotations,
    },
    async ({ ids }) => {
      try {
        const versions = await getAuditHistoryVersions(ids);
        const review = analyzeHistoricalAudits(versions, "local_saved_ids");
        return result(review, historicalComparisonContent(review));
      } catch {
        const error = "Saved audit versions cannot be safely compared: check the IDs, stored chronology, site origin, snapshot completeness and evidence limits. No stored data were changed.";
        return result({ ...emptyHistoricalReview("local_saved_ids"), error }, failureContent(
          "Historical saved audit versions", error,
          "Use audit.history list to find two to ten existing IDs and supply them in oldest-to-newest order; missing or evicted versions are not reconstructed.",
        ), true);
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
    "performance.crux_field",
    {
      title: "Analyze Chrome UX Report real-user Core Web Vitals and trends",
      description:
        "V11-FIELD local: offline analyze an already-obtained Google CrUX daily or history JSON record, or make ONE explicitly requested free Google Chrome UX Report API query using an existing local CRUX_API_KEY environment variable. Reports origin/page, device-class p75 LCP/INP/CLS/FCP/TTFB and bounded historical points. Missing eligible data stays null. No GSC, GA4, visitor tracking, storage, scheduled requests, URL fetch, API-key echo or Google ranking/traffic causation.",
      inputSchema: {
        source_mode: z.enum(["supplied_record","live_crux"])
          .describe("Use caller-provided JSON entirely offline or explicitly authorize one fixed-endpoint Google CrUX API request with local CRUX_API_KEY."),
        mode: z.enum(CRUX_MODES).default("daily")
          .describe("Daily 28-day aggregated p75 data or up to 40 overlapping historical 28-day weekly windows."),
        granularity: z.enum(["origin","url"])
          .describe("Origin aggregates eligible Chrome experiences across the whole origin; url requests one exact page."),
        target: z.string().min(1).max(512)
          .describe("Safe public HTTPS origin or exact page label; query strings, fragments, private hosts and credentials are rejected. Never fetched directly."),
        form_factor: z.enum(CRUX_FORMS).default("ALL")
          .describe("ALL aggregated devices, PHONE, DESKTOP or TABLET. Missing device data is not treated as zero."),
        record_json: z.string().min(2).max(MAX_CRUX_RESPONSE_BYTES)
          .refine(value => Buffer.byteLength(value,"utf8") <= MAX_CRUX_RESPONSE_BYTES)
          .optional()
          .describe("Only supplied_record: original CrUX API JSON (max 300 KB UTF-8), containing matching record identity, metrics and collection period. Never stored or echoed."),
      },
      outputSchema: cruxFieldOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({source_mode,mode,granularity,target,form_factor,record_json}) => {
      const source=source_mode==="live_crux"?"verified_crux_api":"caller_supplied";
      try {
        const query=validateCruxQuery({mode,granularity,target,form_factor});
        if (source_mode==="live_crux" ? record_json!==undefined : !record_json) {
          throw new Error("CrUX input modes must be exclusive");
        }
        const review=source_mode==="live_crux"
          ? await queryCruxField(query)
          : analyzeCruxField(JSON.parse(record_json!),query,source);
        return result(review,cruxFieldContent(review));
      }catch(cause){
        const code=cause instanceof CruxRequestError?cause.code:"invalid_response";
        const error=code==="missing_key"
          ? "Live CrUX requires a locally configured CRUX_API_KEY; no requests were sent."
          : code==="rate_limited" ? "CrUX request was rate-limited; no retries were made."
          : code==="access_denied" ? "The CrUX API rejected the configured access key or project authorization."
          : code==="api_unavailable" ? "The single fixed-endpoint CrUX request could not complete."
          : "CrUX record identity, time series, bounds or source mode could not be safely validated.";
        return result({
          ...emptyCruxFieldReview(mode,source,granularity,form_factor),error,
        },failureContent(
          "CrUX field Core Web Vitals",error,
          "For offline analysis supply a matching CrUX record; for opt-in live mode configure CRUX_API_KEY for the free Google Chrome UX Report API.",
        ),true);
      }
    },
  );

  server.registerTool(
    "browser.lighthouse_lab",
    {
      title: "Run isolated Lighthouse performance lab on supplied static HTML",
      description:
        "V11-LAB local-only: run the real Lighthouse engine once in pinned sandboxed Chromium against caller-supplied HTML served at a synthetic, isolated local proxy origin. Reports redacted Lighthouse performance score, FCP, LCP, TBT, Speed Index and CLS. All supplied executable page scripts and embedded frames are stripped, and all outbound resource requests are denied; no production URL, remote CSS/JS, CrUX field INP, ranking or indexing verdict. Chrome/Lighthouse may incur CPU and memory load; fixed 75-second deadline and 180 KB HTML cap.",
      inputSchema: {
        html: z.string().min(1).max(MAX_LAB_HTML_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_LAB_HTML_BYTES,
            "The static HTML sample must be within 180,000 UTF-8 bytes.")
          .describe("Authorized static HTML markup for the isolated lab. It is not fetched or stored."),
        form_factor: z.enum(LAB_FACTORS).default("mobile")
          .describe("Run one real Lighthouse performance-only lab simulation using mobile or desktop viewport emulation."),
      },
      outputSchema: lighthouseLabOutputShape,
      annotations: localReadOnlyAnnotations,
    },
    async ({ html, form_factor }) => {
      try {
        const review = await inspectOfflineLighthouseLab(html, form_factor);
        return result(review, lighthouseLabContent(review), review.status === "failed");
      } catch {
        const error = !lighthouseSupportedNode()
          ? "V11 Lighthouse lab requires Node.js 22.19 or newer; existing non-Lighthouse tools retain the Node 22.12 minimum."
          : "The sandboxed Lighthouse lab could not run within the fixed HTML, Chromium, network and time limits.";
        return result({ ...emptyLighthouseLabReview(form_factor), error }, failureContent(
          "Lighthouse isolated lab", error,
          "Supply static HTML within 180 KB and verify the pinned Chromium sandbox is available; do not disable browser sandboxing.",
        ), true);
      }
    },
  );

  server.registerTool(
    "browser.viewport_parity",
    {
      title: "Compare isolated mobile and desktop rendering and native interaction evidence",
      description:
        "V09 local-only: compare the SAME authorized HTML in two fresh, network-denied Chromium viewports (375x812 touch/mobile and 1440x900 desktop), or fetch one robots-allowed public HTML 200 response for that isolated comparison. Detects mobile main content hidden vs absent in DOM, visible navigation/link differences, title/description/H1/robots/canonical/JSON-LD counts, horizontal overflow, bounded keyboard tab targets, small control dimensions and one safe native details tap/Enter. All page scripts and external CSS/JS/API assets are disabled, no arbitrary links/buttons clicked or forms submitted. Fixed counts/codes only, no raw text, URLs, IDs or screenshots in output. Not Google WRS, full-site SEO parity, full accessibility certification, or real hydrated browser behavior.",
      inputSchema: {
        mode: z.enum(["supplied_html", "public_html"])
          .describe("Supplied HTML is rendered twice offline; public mode first fetches one robots-allowed page HTML response then compares it offline."),
        page_url: z.string().url().max(512).refine((value) =>
          Boolean(safeHttpResourceUrl(value)),
          "Supply a safe query-free public HTTP(S) page label without credentials or fragments.")
          .optional()
          .describe("Only supplied_html: public same-origin page URL label for resolving links/canonicals; never fetched."),
        html: z.string().min(1).max(MAX_PARITY_HTML_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PARITY_HTML_BYTES,
            "HTML must fit the bounded 400 KB UTF-8 limit.")
          .optional()
          .describe("Only supplied_html: static/inline-CSS markup evaluated without scripts, network or remote assets."),
        url: deliveryInputUrl.optional()
          .describe("Only public_html: safe query-free HTTP(S) URL; robots.txt checked before a single public HTML GET."),
      },
      outputSchema: viewportParityOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ mode, page_url, html, url }) => {
      try {
        if (mode === "public_html"
          ? !url || page_url !== undefined || html !== undefined
          : !page_url || !html || url !== undefined) {
          throw new Error("Choose one complete local HTML or public read-only sampling mode.");
        }
        const report = mode === "public_html"
          ? await inspectPublicViewportParity(url!)
          : await inspectViewportParity(html!, page_url!);
        return result(report,
          "V09 isolated viewport parity: "
          + MOBILE_VIEWPORT.width + "px mobile touch vs "
          + DESKTOP_VIEWPORT.width + "px desktop; "
          + report.mobile.main_dom_words + " mobile and " + report.desktop.main_dom_words
          + " desktop DOM words; "
          + report.mobile_missing_dom_tokens + " desktop-only distinct DOM words, "
          + report.mobile_missing_visible_tokens + " desktop-only visibly rendered words, "
          + report.mobile_missing_internal_links + " desktop-only same-origin link targets, "
          + report.mobile.horizontal_overflow_px + "px mobile horizontal overflow, "
          + report.mobile.observed_keyboard_targets + " mobile vs "
          + report.desktop.observed_keyboard_targets + " desktop keyboard targets observed. "
          + "External assets and all page JavaScript are disabled: no Googlebot or full hydration verdict.");
      } catch {
        const error = "Mobile/desktop parity could not be evaluated within safe URL, robots, HTML and isolated Chromium limits.";
        const scope = mode === "public_html"
          ? "isolated_public_html_viewports"
          : "isolated_supplied_html_viewports";
        return result({ ...emptyViewportParityReview(scope), error }, failureContent(
          "Mobile versus desktop parity", error,
          "Provide one authorized public HTML page or bounded markup and a safe page label; do not disable the pinned browser sandbox.",
        ), true);
      }
    },
  );

  server.registerTool(
    "browser.resource_failures",
    {
      title: "Inspect bounded browser resource responses and loading failures",
      description:
        "V08 local-only: analyze up to 64 observed browser HTTP/network outcomes or navigate one robots-allowed public URL in fresh sandboxed Chromium with DNS-pinned proxy. Distinguishes real HTTP 4xx/5xx resource responses from transport failures, pending requests, and explicit tool-policy blocks. Groups script/CSS/document/API/image/font issues without returning URLs, headers, error text, response bodies or credentials. Browser allows same-origin assets by default, never private IPs; optional public third-party resource access is capped. Does not impersonate Google WRS or establish actual indexing, user experience, performance guarantees or causation.",
      inputSchema: {
        mode: z.enum(["analyze_observations", "live_browser"])
          .describe("Choose offline caller-supplied resource observations or a guarded public browser network sample."),
        url: deliveryInputUrl.optional()
          .describe("Only live_browser: one safe public query-free page URL; robots.txt is checked before browser navigation."),
        include_third_party: z.boolean().optional()
          .describe("Only live_browser: explicitly permit public third-party assets from up to three additional origins; default false blocks them without calling them website failures."),
        observations: z.array(browserResourceInputSchema).min(1).max(MAX_RESOURCE_OBSERVATIONS).optional()
          .describe("Only analyze_observations: 1–64 fixed-shape browser outcomes; no raw URLs or headers."),
        additional_budget_blocked: z.number().int().min(0).max(1_000_000).optional()
          .describe("Offline only: number of extra requests explicitly blocked when the browser observation limit was exceeded."),
        navigation_completed: z.boolean().optional()
          .describe("Offline only: whether an independently observed navigation completed before the sampling deadline."),
      },
      outputSchema: browserResourceOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ mode, url, include_third_party, observations,
      additional_budget_blocked, navigation_completed }) => {
      try {
        if (mode === "live_browser"
          ? !url || observations !== undefined || additional_budget_blocked !== undefined ||
              navigation_completed !== undefined
          : observations === undefined || url !== undefined || include_third_party !== undefined) {
          throw new Error("Supply one guarded live URL or one offline observation set, not both.");
        }
        const review = mode === "live_browser"
          ? await inspectPublicResourceLoading(url!, { includeThirdParty: include_third_party })
          : analyzeResourceFailures({
            observations: observations!,
            ...(additional_budget_blocked === undefined ? {} : { additional_budget_blocked }),
            ...(navigation_completed === undefined ? {} : { navigation_completed }),
          });
        return result(review, browserResourceContent(review));
      } catch {
        const error = "Browser resource evidence could not be inspected within public URL, robots, event or isolated Chromium limits.";
        const scope = mode === "live_browser"
          ? "guarded_public_browser_resources"
          : "caller_supplied_resource_observations";
        return result({ ...emptyResourceFailureReview(scope), error }, failureContent(
          "Browser resource loading", error,
          "Supply fixed offline HTTP/network outcomes or one authorized public URL, with the pinned browser sandbox enabled.",
        ), true);
      }
    },
  );

  server.registerTool(
    "browser.dom_diff",
    {
      title: "Compare HTTP source HTML and sandboxed rendered DOM SEO signals",
      description:
        "V07 local-only: compare two caller-supplied raw/rendered HTML snapshots offline, or render caller-supplied HTML in fresh network-denied Chromium with inline scripts only, or fetch one robots-allowed public HTML page and sample its inline-script DOM. Detects changed/missing title, description, H1, text, same-origin anchor links, canonical, noindex and JSON-LD declarations using bounded redacted evidence. Does not load external JS/CSS/assets, impersonate Google WRS, access GSC/GA4, claim indexing or save content. Inline modes execute untrusted JS only inside fresh browser sandbox; external requests are denied.",
      inputSchema: {
        mode: z.enum(["compare_snapshots", "inline_sandbox", "live_inline_sandbox"])
          .describe("Choose offline caller snapshots, local Chromium inline-script execution, or a guarded public HTML fetch followed by the same isolated browser render."),
        url: deliveryInputUrl.optional()
          .describe("Only for live_inline_sandbox: safe public query-free HTTP(S) page URL; robots.txt permission checked before GET."),
        page_url: z.string().url().max(512)
          .refine((value) => Boolean(safeLinkPageUrl(value)),
            "An offline page label must be query-free HTTP(S) without credentials or fragments.")
          .optional()
          .describe("For offline modes, the page URL label for resolving relative links and canonicals; never fetched."),
        raw_html: z.string().min(1).max(MAX_RENDER_HTML_BYTES).refine(
          (value) => Buffer.byteLength(value, "utf8") <= MAX_RENDER_HTML_BYTES,
          "Raw HTML must be 512 KiB UTF-8 or less.").optional()
          .describe("Caller-observed source HTML. Inline mode executes only its inline scripts in a fresh, offline Chromium sandbox."),
        rendered_html: z.string().min(1).max(MAX_RENDER_HTML_BYTES).refine(
          (value) => Buffer.byteLength(value, "utf8") <= MAX_RENDER_HTML_BYTES,
          "Rendered HTML must be 512 KiB UTF-8 or less.").optional()
          .describe("Only compare_snapshots: rendered HTML already obtained by an authorized browser or source; never executed or fetched."),
      },
      outputSchema: domDiffOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ mode, url, page_url, raw_html, rendered_html }) => {
      try {
        const compare = mode === "compare_snapshots";
        const inline = mode === "inline_sandbox";
        const live = mode === "live_inline_sandbox";
        if (live
          ? !url || Boolean(page_url || raw_html || rendered_html)
          : !page_url || !raw_html || Boolean(url)
            || (compare ? !rendered_html : !inline || Boolean(rendered_html))) {
          throw new Error("Provide exactly one declared browser or offline evidence mode.");
        }
        const review = live
          ? await reviewPublicInlineDom(url!)
          : compare
            ? analyzeRawRendered({
              page_url: page_url!, raw_html: raw_html!, rendered_html: rendered_html!,
            })
            : await renderInlineHtml(raw_html!, page_url!);
        return result(review,
          "V07 source/render comparison: "
          + review.raw.main_words + " source and " + review.rendered.main_words
          + " rendered main-text words; " + review.link_targets_removed + " source links removed, "
          + review.link_targets_added + " rendered links added, "
          + (review.title_changed ? "title changed; " : "title unchanged; ")
          + (review.canonical_changed ? "canonical declarations changed; " : "")
          + (review.noindex_changed ? "noindex declarations changed; " : "")
          + review.script_errors_observed + " script-error events observed. "
          + "Only " + (review.browser_executed ? "inline JavaScript with all network blocked" :
            "caller-supplied snapshots") + " was assessed; Google WRS/indexing was not verified.");
      } catch {
        const error = "Raw/rendered DOM evidence is unavailable within the bounded HTML, public URL or sandboxed Chromium limits.";
        const scope = mode === "live_inline_sandbox"
          ? "isolated_public_html_inline_script_sample"
          : mode === "inline_sandbox"
            ? "isolated_inline_script_chromium"
            : "caller_supplied_rendered_snapshot";
        return result({ ...emptyRawRenderedReview(scope), error }, failureContent(
          "Browser source versus rendered DOM", error,
          "Supply authorized small HTML snapshots or a safe public URL, and ensure pinned sandboxed Chromium can launch without disabling its security controls.",
        ), true);
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
    "site.sitemaps",
    {
      title: "Review sitemap inventory, lastmod consistency and indexability conflicts",
      description:
        "V05: compare up to eight previously observed XML/text sitemap documents with independent discovered URLs and page response/indexability evidence, or sample one authorized public sitemap plus up to two same-origin children. Finds malformed/duplicate/cross-origin URLs, missing child documents, invalid/future/inconsistent lastmod, independent discovery gaps and sampled redirect/noindex/canonical/robots conflicts. The bounded live sample never fetches listed pages, stores source documents, returns raw URLs, claims full search-engine inventory or guarantees Google indexing.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Live mode: one authorized query-free public site URL; sitemap defaults to /sitemap.xml."),
        sitemap_url: deliveryInputUrl.optional()
          .describe("Live mode optional same-origin sitemap URL, otherwise uses /sitemap.xml."),
        site_url: deliveryInputUrl.optional()
          .describe("Offline mode: public site URL whose sitemap documents were observed."),
        documents: z.array(sitemapDocInputSchema).min(1).max(MAX_SITEMAP_DOCUMENTS).optional()
          .describe("Offline: 1–8 previously observed XML or plain-text sitemap bodies."),
        discovered_urls: z.array(chainLabelSchema).max(MAX_SITEMAP_DISCOVERED).optional()
          .describe("Optional independently discovered same-origin URLs; no site crawl is performed."),
        page_observations: z.array(sitemapPageEvidenceInputSchema)
          .max(MAX_SITEMAP_PAGE_OBSERVATIONS).optional()
          .describe("Optional independent HTTP/indexability observations for up to 250 pages."),
        documents_complete: z.boolean().optional()
          .describe("Caller-verified completeness of all linked sitemap documents."),
        discovered_complete: z.boolean().optional()
          .describe("Caller-verified completeness of independent site discovery."),
        observed_at: z.string().max(40).optional()
          .describe("Optional W3C date/datetime clock for lastmod verification, defaults to now."),
      },
      outputSchema: sitemapOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url, sitemap_url, site_url, documents, discovered_urls, page_observations,
      documents_complete, discovered_complete, observed_at }) => {
      try {
        if (url
          ? Boolean(site_url || documents || discovered_urls || page_observations
            || documents_complete !== undefined || discovered_complete !== undefined
            || observed_at !== undefined)
          : !(site_url && documents) || sitemap_url !== undefined) {
          throw new Error("Select one live site URL or complete offline sitemap document evidence.");
        }
        const review = url
          ? await probeSitemapInventory(url, sitemap_url)
          : analyzeSitemapInventory({
            site_url: site_url!, documents: documents!,
            ...(discovered_urls ? { discovered_urls } : {}),
            ...(page_observations ? { page_observations } : {}),
            ...(documents_complete === undefined ? {} : { documents_complete }),
            ...(discovered_complete === undefined ? {} : { discovered_complete }),
            ...(observed_at ? { observed_at } : {}),
          });
        return result(review, sitemapInventoryContent(review));
      } catch {
        const error = "Sitemap inventory evidence could not be inspected within public URL, safe XML, byte and request limits.";
        return result({ ...emptySitemapInventoryReview(), error }, failureContent(
          "Sitemap inventory", error,
          "Supply a safe live sitemap URL or up to eight bounded same-origin XML/text sitemap observations.",
        ), true);
      }
    },
  );

  server.registerTool(
    "http.redirect_chain",
    {
      title: "Analyze observed HTTP redirects and canonical destination chains",
      description:
        "V04: review up to eight ordered HTTP response hops, Location redirects, static HTML/HTTP Link canonical declarations, and Googlebot-applicable noindex/robots observations, or probe a bounded public query-free HTTP(S) URL. Detects redirect loops, incomplete/mismatched chains, HTTP errors, canonical conflicts/cycles/chains and non-indexable sampled destinations. A destination is called wrong only relative to an explicitly supplied expected URL. Reports no raw URLs, HTML, headers, credentials, authenticated crawler observations or Google-selected canonical/indexing verdict.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Live mode: one authorized public query-free URL; bounded GET/redirect chain."),
        source_url: chainLabelSchema.optional()
          .describe("Offline mode: source URL, equal to the first supplied HTTP observation."),
        observations: z.array(chainObservationSchema).min(1).max(MAX_CHAIN_HOPS).optional()
          .describe("Offline mode: one to eight ordered observed HTTP responses. No requests made."),
        expected_destination: chainLabelSchema.optional()
          .describe("Optional caller-defined expected final URL, compared only on a complete observed chain."),
      },
      outputSchema: chainReviewOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url, source_url, observations, expected_destination }) => {
      try {
        if (url
          ? Boolean(source_url || observations)
          : !(source_url && observations)) {
          throw new Error("Select live URL mode or complete offline evidence, not both.");
        }
        const review = url
          ? await probeRedirectCanonicalChain(url, expected_destination)
          : analyzeRedirectCanonicalChains({
            source_url: source_url!, observations: observations!,
            ...(expected_destination ? { expected_destination } : {}),
          });
        return result(review, redirectCanonicalContent(review));
      } catch {
        const error = "Redirect/canonical evidence could not be assessed within public URL, response and source limits.";
        return result({ ...emptyRedirectCanonicalReview(), error }, failureContent(
          "Redirect/canonical chain", error,
          "Provide one authorized public URL or a source and one to eight ordered HTTP response observations.",
        ), true);
      }
    },
  );

  server.registerTool(
    "crawler.access",
    {
      title: "Review crawler access, robots rules and indexing directives by profile",
      description:
        "V03: compare up to eight supplied pages against robots.txt group precedence and static meta/X-Robots-Tag directives for Googlebot smartphone/desktop/news/image, Bingbot and GPTBot; or probe one public page and robots.txt using only the service's own User-Agent. Distinguishes crawl disallow from explicit noindex and unavailable/ambiguous evidence. Live probe obeys site robots for this service; it does NOT impersonate/verify real crawlers, request indexing, crawl historical logs, or claim a page is indexed. Raw URLs, source and response headers are not returned.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Live mode: one authorized public query-free HTML page; cannot be combined with supplied evidence."),
        site_url: deliveryInputUrl.optional()
          .describe("Offline mode: public site origin URL matching all supplied pages."),
        robots_txt: z.string().max(MAX_CRAWLER_ROBOTS_BYTES).optional()
          .describe("Offline: previously obtained robots.txt body, max 64,000 UTF-8 bytes."),
        robots_status_code: z.number().int().min(100).max(599).optional()
          .describe("Offline: observed robots.txt HTTP status; 429/5xx are unknown, not allow."),
        pages: z.array(crawlerPageInputSchema).min(1).max(MAX_CRAWLER_PAGES).optional()
          .describe("Offline: one to eight same-origin static page and HTTP indexing observations."),
        profiles: crawlerProfileInput.describe("Optional distinct crawler product profiles; all six by default."),
      },
      outputSchema: crawlerAccessOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url, site_url, robots_txt, robots_status_code, pages, profiles }) => {
      try {
        if (url
          ? Boolean(site_url || pages || robots_txt !== undefined || robots_status_code !== undefined)
          : !(site_url && pages)) {
          throw new Error("Choose only a live URL or a complete offline observation set.");
        }
        const review = url
          ? await probeCrawlerAccess(url, profiles)
          : analyzeCrawlerAccess({
            site_url: site_url!, pages: pages!,
            ...(robots_txt === undefined ? {} : { robots_txt }),
            ...(robots_status_code === undefined ? {} : { robots_status_code }),
            ...(profiles ? { profiles } : {}),
          });
        return result(review, crawlerAccessContent(review));
      } catch {
        const error = "Crawler access could not be reviewed within public URL, robots, source and sampling limits.";
        return result({ ...emptyCrawlerAccessReview(), error }, failureContent(
          "Crawler access matrix", error,
          "Supply one safe public URL or same-origin static page observations with optional robots.txt and X-Robots-Tag evidence.",
        ), true);
      }
    },
  );

  server.registerTool(
    "http.availability",
    {
      title: "Analyze observed availability changes and short repeat-fetch reliability",
      description:
        "V02: compare two to 48 ordered, caller-supplied timestamped HTTP/transport outcomes, or make two to three bounded sequential public GET probes. Flags intermittent non-2xx, status transitions, 429/5xx, explicit challenge and network failures, and sampling gaps. The percentages are only ratios of sampled responses, never guaranteed uptime or actual outage duration. No scheduler, history storage, Googlebot verification or response bodies; use availability.history separately to opt into local storage.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Authorized public query-free HTTP(S) URL for a short live repeat-fetch sample; omit for offline analysis."),
        checks: z.number().int().min(2).max(3).optional()
          .describe("Live checks per call, two or three (default three); ignored for neither/invalid modes."),
        observations: z.array(availabilityObservationSchema).min(2).max(MAX_AVAILABILITY_OBSERVATIONS).optional()
          .describe("Two to 48 real timestamped HTTP or transport outcomes, ordered oldest to newest; offline."),
      },
      outputSchema: availabilityReviewOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url, checks, observations }) => {
      try {
        if (Boolean(url) === Boolean(observations) || (observations && checks !== undefined)) {
          throw new Error("Select either live URL checks or supplied observations, not both.");
        }
        const review = analyzeAvailabilityHistory(
          observations ?? await collectPublicAvailability(url!, checks ?? 3),
          url ? "live_bounded_burst" : "caller_supplied_history",
        );
        return result(review, availabilityReviewContent(review));
      } catch {
        const error = "Availability cannot be evaluated within the public URL, chronology, sample and network safety limits.";
        return result({ ...emptyAvailabilityReview(), error }, failureContent(
          "Availability observations", error,
          "Supply two to 48 chronologically ordered observations, or one authorized URL for two to three live checks.",
        ), true);
      }
    },
  );

  server.registerTool(
    "availability.history",
    {
      title: "Capture and compare local availability history (ten records maximum)",
      description:
        "V02 local-only opt-in compact availability archive. 'capture' makes one public HTTP GET and saves only its HTTP/transport outcome and timestamp. 'list' and 'compare' read existing outcomes for exactly one authorized URL. A single 24 KB JSON archive retains a maximum of ten total observations and automatically evicts the oldest; no scheduler, Cloudflare/Google access, cloud storage, secret headers or response bodies. Capture writes local state and may evict old data.",
      inputSchema: {
        action: z.enum(["capture", "list", "compare"])
          .describe("Explicitly capture one HTTP observation into local storage, list saved outcomes, or compare at least two saved outcomes."),
        url: deliveryInputUrl
          .describe("Exact safe query-free URL whose local observations should be captured or read."),
      },
      outputSchema: availabilityHistoryOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, url }) => {
      try {
        const archive = action === "capture"
          ? await saveAvailabilityObservation(url, (await collectPublicAvailability(url, 1))[0])
          : await getAvailabilityHistory(url);
        const review = archive.records.length >= 2 && action !== "list"
          ? analyzeAvailabilityHistory(archive.records.map((record) => record.observation),
            "local_saved_history")
          : undefined;
        const output = {
          action, count: archive.count, records: archive.records,
          ...(archive.saved_id ? { saved_id: archive.saved_id } : {}),
          ...(archive.evicted_id ? { evicted_id: archive.evicted_id } : {}),
          ...(review ? { review } : {}),
        };
        return result(output,
          "Local availability history: " + archive.count + "/" + MAX_AVAILABILITY_HISTORY
          + " outcomes retained for this URL. "
          + (action === "capture" ? "One point-in-time GET outcome was saved. " : "")
          + (archive.evicted_id ? "The oldest stored observation was evicted. " : "")
          + (review
            ? "Observed 2xx on " + review.observed_successes + "/" + review.observations_count
              + " sampled requests; this is not continuous uptime."
            : "At least two observations are needed before a comparison can be made."));
      } catch {
        const error = "Local availability capture/history cannot be completed within the guarded URL, file and chronological limits.";
        return result({
          action, count: 0, records: [], error,
        }, failureContent(
          "Local availability history", error,
          "Check the authorized URL and writable workspace; corrupt or symlinked history files are never overwritten.",
        ), true);
      }
    },
  );

  server.registerTool(
    "http.delivery",
    {
      title: "Diagnose live or supplied HTTP delivery and edge responses",
      description:
        "V01: one bounded public HTTP GET probe (up to three same-origin redirects), or one to four ordered caller-supplied response observations. Diagnose 403/429/5xx, redirect completeness, HTTP cache flags, Retry-After and Cloudflare challenge evidence. No body download, JS execution, Googlebot identity verification, monitoring, raw header values or query-bearing URL output. Supply exactly one of url or observations.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Authorized public query-free HTTP(S) URL to probe once (GET)."),
        observations: z.array(deliveryObservationSchema).min(1).max(MAX_DELIVERY_HOPS).optional()
          .describe("One to four caller-observed response hops instead of live network traffic."),
      },
      outputSchema: deliveryOutputSchema,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url, observations }) => {
      try {
        if (Boolean(url) === Boolean(observations)) {
          throw new Error("Choose exactly one input mode.");
        }
        const review = observations
          ? analyzeHttpDelivery(observations)
          : await probeHttpDelivery(url!);
        return result(review, httpDeliveryContent(review), Boolean(review.error));
      } catch {
        const error = "HTTP delivery could not be assessed within the safe URL, response and input limits.";
        return result({ ...emptyDeliveryReview(), error }, failureContent(
          "HTTP delivery diagnostics", error,
          "Supply one authorized query-free public URL or a bounded list of ordered response observations.",
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
    "site.link_graph",
    {
      title: "Review sampled internal-link graph, depth and possible orphans",
      description:
        "V06: evaluate one to eight caller-supplied same-origin static HTML/page observations and up to 256 previously observed sitemap labels, or perform a guarded public sample of one robots.txt and up to three HTML pages. Counts standard anchor links including navigation, computes shortest sample-only entry paths, and flags nofollow-only, missing inbound, unobserved URL, blocked/HTTP-error, noindex and noncanonical targets. Orphan candidates are not verified site-wide orphans. No raw URLs/HTML, JavaScript, full crawl, Googlebot impersonation, PageRank, GSC or production changes.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Live mode: one authorized public query-free entry URL, at most three bounded same-origin HTML GETs after robots.txt permission."),
        site_url: graphLabelSchema.optional()
          .describe("Offline mode: site URL used as the exact-origin comparison scope."),
        pages: z.array(graphPageInputSchema).min(1).max(MAX_GRAPH_PAGES).optional()
          .describe("Offline mode: one to eight distinct page observations with optional already obtained HTML, no requests."),
        entry_urls: z.array(graphLabelSchema).max(MAX_GRAPH_PAGES).optional()
          .describe("Optional explicit entry roots; when absent, the site homepage is used only if supplied."),
        sitemap_urls: z.array(graphLabelSchema).max(MAX_GRAPH_CATALOG_URLS).optional()
          .describe("Optional already observed sitemap page labels; URLs not in the page sample are unverified, never called orphans."),
      },
      outputSchema: graphOutputShape,
      annotations: externalReadOnlyAnnotations,
    },
    async ({ url, site_url, pages, entry_urls, sitemap_urls }) => {
      try {
        if (url
          ? Boolean(site_url || pages || entry_urls || sitemap_urls)
          : !(site_url && pages)) {
          throw new Error("Choose one guarded live URL or complete caller-supplied graph evidence.");
        }
        const review = url
          ? await probeInternalLinkGraph(url)
          : analyzeInternalLinkGraph({
            site_url: site_url!, pages: pages!,
            ...(entry_urls ? { entry_urls } : {}),
            ...(sitemap_urls ? { sitemap_urls } : {}),
          });
        return result(review,
          "Sampled link graph: " + review.pages_observed + " pages, "
          + review.unique_observed_sample_edges + " unique observed page-to-page edges, "
          + review.pages_reachable_within_sample + " reachable within this sample, "
          + review.pages_unreachable_within_sample + " without an observed entry path, "
          + review.potential_orphans_within_sample + " possible orphan candidates, "
          + review.distinct_unsampled_link_targets + " unverified link destinations. "
          + "Deepest observed sample path: "
          + (review.deepest_observed_sample_depth ?? "unknown") + ". "
          + "No full-site orphan, PageRank, Googlebot crawl or Google indexing conclusion is implied.");
      } catch {
        const error = "Internal-link graph could not be evaluated within bounded HTML, same-origin, robots and network limits.";
        return result({ ...emptyInternalLinkGraphReview(), error }, failureContent(
          "Internal-link graph", error,
          "Provide a guarded live entry URL or up to eight same-origin static HTML/page observations.",
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
