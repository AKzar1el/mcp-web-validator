import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { load as loadCheerio } from "cheerio";
import { auditSeoMetadata, checkBrokenLinksDetailed, isHttpRedirectStatus, isUnverifiedLinkStatus, validateSchemaMarkup } from "./audits";
import {
  CSS_MAX_LENGTH,
  HOSTED_MAX_LINKS,
  HTML_MAX_LENGTH,
  SERVER_VERSION,
  SITE_AUDIT_DEFAULT_MAX_PAGES,
  SITE_AUDIT_MAX_PAGES,
  SITE_AUDIT_MAX_SITEMAP_URLS,
} from "./constants";
import { fetchPublicHtml, probePublicHttp, PublicHtmlFetchError, PublicHttpProbeBudgetError, type HtmlMediaType } from "./network";
import {
  contentForOverview,
  overviewSchema,
  plural,
  type OverviewMetric,
  type PresentableFinding,
  type ResultOverview,
} from "./presentation";
import { validateCss, validateHtmlDetailed } from "./validators";
import { auditPublicSite } from "./site-audit";
import { compareSiteAudits } from "./site-comparison";
import {
  analyzeHistoricalAudits,
  emptyHistoricalReview,
  MAX_HISTORICAL_VERSIONS,
  MAX_HISTORICAL_FINDINGS,
  MAX_HISTORICAL_SNAPSHOT_BYTES,
  MAX_HISTORICAL_TOTAL_BYTES,
  HISTORICAL_STATUSES,
  HISTORICAL_FINDING_CODES,
} from "./modules/change-regression/historical-comparisons";
import {
  previewRegressionAlerts,
  emptyMonitorPreview,
  MONITOR_RULES,
  MONITOR_DECISIONS,
  MONITOR_STATUSES,
  MONITOR_REASON_CODES,
} from "./modules/change-regression/regression-alerts";
import {
  compareProductClaims,
  observeProductClaims,
  registeredToolEvidence,
  MAX_PRODUCT_CLAIM_HTML_BYTES,
} from "./modules/content-schema/product-claims";
import { safeObservedUrl } from "../../src/modules/content-schema/same-language-duplicates";
import {
  analyzeProvenance,
  observeProvenancePage,
  MAX_PROVENANCE_HTML_BYTES,
  MAX_PROVENANCE_INPUT_BYTES,
} from "./modules/content-schema/citation-methodology-consistency";
import {
  normalizedEvidenceDate,
  safeDatasetVersion,
  safeProvenanceId,
  safeProvenanceUrl,
} from "../../src/modules/content-schema/citation-methodology-consistency";
import {
  compareIntentObservations,
  emptyIntentComparison,
  observeIntentHtml,
  safeIntentUrl,
  MAX_INTENT_HTML_BYTES,
  MAX_INTENT_TOTAL_BYTES,
  MAX_INTENT_QUERY_BYTES,
} from "./modules/content-schema/competitor-intent-comparison";
import {
  reviewSupportedSchemaHtml,
  reviewSupportedJsonLd,
  MAX_SUPPORTED_SCHEMA_HTML_BYTES,
} from "./modules/content-schema/structured-data-validation";
import {
  MAX_SUPPORTED_SCHEMA_FINDINGS,
  SUPPORTED_SCHEMA_TYPES,
} from "../../src/modules/content-schema/structured-data-validation";
import {
  reviewInternalLinks,
  emptyInternalLinkReview,
  safeLinkPageUrl,
  observeInternalLinks,
  MAX_LINK_HTML_BYTES,
  MAX_LINK_TOTAL_HTML_BYTES,
  MAX_LINK_FINDINGS,
} from "./modules/site-architecture/internal-link-quality";
import {
  analyzeMetadataConsistency,
  emptyMetadataReview,
  safeMetadataLabel,
  observeMetadata,
  MAX_METADATA_HTML_BYTES,
  MAX_METADATA_TOTAL_BYTES,
  MAX_METADATA_FINDINGS,
} from "./modules/content-schema/metadata-consistency";
import { METADATA_FIELDS } from "../../src/modules/content-schema/metadata-consistency";
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
} from "./modules/http-crawl/non-html-directives";
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
} from "./modules/http-crawl/https-security";
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
} from "./modules/http-crawl/url-variants";
import {
  analyzeHttpDelivery,
  emptyDeliveryReview,
  MAX_DELIVERY_HOPS,
  MAX_DELIVERY_FINDINGS,
  MAX_DELIVERY_HEADER_VALUE_BYTES,
  DELIVERY_HEADER_NAMES,
  DELIVERY_FINDING_CODES,
} from "./modules/http-crawl/http-delivery";
import {
  analyzeAvailabilityHistory,
  emptyAvailabilityReview,
  MAX_AVAILABILITY_OBSERVATIONS,
  MAX_AVAILABILITY_FINDINGS,
  AVAILABILITY_FAILURE_CODES,
  AVAILABILITY_STATES,
  AVAILABILITY_FINDING_CODES,
} from "./modules/http-crawl/availability-observations";
import { collectPublicAvailability } from "./modules/http-crawl/availability-probe";
import {
  analyzeCrawlerAccess, emptyCrawlerAccessReview, CRAWLER_PROFILES,
  CRAWLER_ACCESS_STATES, CRAWLER_INDEXING_STATES, CRAWLER_FINDING_CODES,
  MAX_CRAWLER_PAGES, MAX_CRAWLER_FINDINGS, MAX_CRAWLER_ROBOTS_BYTES,
  MAX_CRAWLER_HTML_BYTES,
} from "./modules/http-crawl/crawler-access";
import { probeCrawlerAccess } from "./modules/http-crawl/crawler-access-probe";
import {
  analyzeRedirectCanonicalChains, emptyRedirectCanonicalReview,
  MAX_CHAIN_HOPS, MAX_CHAIN_CANONICALS, MAX_CHAIN_HTML_BYTES,
  MAX_CHAIN_FINDINGS, CHAIN_REDIRECT_STATES, CHAIN_TARGET_STATES,
  CHAIN_CANONICAL_STATES, CHAIN_INDEXING_STATES, CHAIN_FINDING_CODES,
} from "./modules/http-crawl/redirect-canonical-chains";
import { probeRedirectCanonicalChain } from "./modules/http-crawl/redirect-canonical-probe";
import {
  analyzeSitemapInventory, emptySitemapInventoryReview,
  MAX_SITEMAP_DOCUMENTS, MAX_SITEMAP_DOCUMENT_BYTES,
  MAX_SITEMAP_DISCOVERED, MAX_SITEMAP_PAGE_OBSERVATIONS,
  MAX_SITEMAP_FINDINGS, SITEMAP_DOCUMENT_KINDS, SITEMAP_FINDING_CODES,
} from "./modules/http-crawl/sitemap-inventory";
import { probeSitemapInventory } from "./modules/http-crawl/sitemap-inventory-probe";
import { LEGACY_WIDGET_URI, WIDGET_HTML, WIDGET_URI } from "./widget";

const MCP_BODY_MAX_BYTES = 2 * 1024 * 1024;
const TRUSTED_BROWSER_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
  "https://digestseo.com",
  "https://web-validator-mcp.digestseo.com",
]);
// The SDK handler intentionally does not validate Host/Origin; enforce both
// before its protocol parser so hostile browser and DNS-rebinding requests fail.
const ALLOWED_REQUEST_HOSTS = new Set([
  "web-validator-mcp.digestseo.com",
  "localhost",
  "127.0.0.1",
]);
const PREFLIGHT_HEADERS =
  "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Mcp-Method, Mcp-Name";
const GLAMA_CONNECTOR_METADATA = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  maintainers: [{ email: "tomi.seregi99@gmail.com" }],
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
  url: deliveryInputUrl,
  status_code: z.number().int().min(100).max(599),
  method: z.enum(["GET", "HEAD"]).optional(),
  headers: deliveryHeaderSchema.optional(),
});
const deliveryOutputSchema = z.object({
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
  overview: overviewSchema,
});

const availabilityObservationSchema = z.object({
  observed_at: z.string().datetime({ offset: true }).max(40),
  status_code: z.number().int().min(100).max(599).optional(),
  failure: z.enum(AVAILABILITY_FAILURE_CODES).optional(),
  cf_challenge: z.boolean().optional(),
  elapsed_ms: z.number().int().min(0).max(120_000).optional(),
}).strict();
const availabilityOutputSchema = z.object({
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
  overview: overviewSchema,
});

const crawlerPageInputSchema = z.object({
  url: deliveryInputUrl,
  status_code: z.number().int().min(100).max(599).optional(),
  html: z.string().max(MAX_CRAWLER_HTML_BYTES).optional(),
  x_robots_tag: z.array(z.string().max(512)).max(8).optional(),
}).strict();
const crawlerProfileInput = z.array(z.enum(CRAWLER_PROFILES))
  .min(1).max(CRAWLER_PROFILES.length).optional();
const crawlerOutputSchema = z.object({
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
  overview: overviewSchema,
});

const chainLabelSchema = z.string().url().max(1024)
  .refine((value) => Boolean(safeVariantLabel(value)),
    "Use an HTTP(S) URL without credentials, fragments, custom ports or unsafe paths.");
const chainObservationSchema = z.object({
  url: chainLabelSchema,
  status_code: z.number().int().min(100).max(599),
  location: z.string().max(1024).optional(),
  canonicals: z.array(z.string().max(1024)).max(MAX_CHAIN_CANONICALS).optional(),
  html: z.string().max(MAX_CHAIN_HTML_BYTES).optional(),
  x_robots_tag: z.array(z.string().max(512)).max(8).optional(),
  robots_allowed: z.boolean().optional(),
}).strict();
const chainOutputSchema = z.object({
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
  overview: overviewSchema,
});

const sitemapDocInputSchema = z.object({
  sitemap_url: deliveryInputUrl,
  content: z.string().max(MAX_SITEMAP_DOCUMENT_BYTES),
  content_type: z.enum(["application/xml", "text/xml", "text/plain"]).optional(),
  status_code: z.number().int().min(100).max(599).optional(),
}).strict();
const sitemapPageInputSchema = z.object({
  url: chainLabelSchema,
  status_code: z.number().int().min(100).max(599).optional(),
  canonical_url: chainLabelSchema.optional(),
  noindex: z.boolean().optional(),
  robots_allowed: z.boolean().optional(),
  modified_at: z.string().max(40).optional(),
}).strict();
const sitemapOutputSchema = z.object({
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
  overview: overviewSchema,
});

const validationMessageSchema = z.object({
  type: z.enum(["error", "warning", "info"]),
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
});

const cssMessageSchema = z.object({
  line: z.number(),
  message: z.string(),
  context: z.string().optional(),
});

const auditIssueSchema = z.object({
  code: z.string().describe("Stable machine-readable audit rule identifier."),
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["SEO", "Schema", "Accessibility"]),
  message: z.string(),
});

const auditResultSchema = {
  issues: z.array(auditIssueSchema),
  total_issues: z.number().int().nonnegative(),
  truncated: z.boolean(),
  overview: overviewSchema,
  error: z.string().optional(),
};

const linkStatusSchema = z.object({
  url: z.string(),
  status: z.union([z.number(), z.enum(["blocked", "failed"])]),
  ok: z.boolean(),
  message: z.string().optional(),
});

const siteFindingSchema = z.object({
  code: z.string().describe("Stable machine-readable audit rule identifier when available.").optional(),
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["HTML", "SEO", "Schema", "Accessibility"]),
  message: z.string(),
});

const sitePageSchema = z.object({
  url: z.string(),
  fetched_url: z.string().optional(),
  status: z.enum(["passed", "needs_attention", "partial", "failed", "skipped"]),
  http_status: z.number().int().min(200).max(299).optional(),
  redirects_followed: z.number().int().min(0).max(3).optional(),
  page_fetched: z.boolean(),
  html_validation_status: z.enum(["completed", "timeout", "unavailable", "not_run"]),
  html_errors: z.number().int().nonnegative(),
  html_warnings: z.number().int().nonnegative(),
  seo_errors: z.number().int().nonnegative(),
  seo_warnings: z.number().int().nonnegative(),
  schema_errors: z.number().int().nonnegative(),
  schema_warnings: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  health_score: z.number().int().min(0).max(100).optional(),
  failure_code: z.string().optional(),
  top_findings: z.array(siteFindingSchema),
  indexability: z.object({
    canonical_state: z.enum(["missing", "usable", "ambiguous", "unverifiable"]),
    canonical_url: z.string().optional(),
    noindex_observed: z.boolean(),
    title: z.string().max(150).optional(),
    hreflang: z.array(z.object({
      language: z.string(),
      url: z.string(),
    })).max(16),
    hreflang_truncated: z.boolean(),
  }).optional(),
});

const siteIssueGroupSchema = siteFindingSchema.extend({
  affected_pages: z.number().int().nonnegative(),
  example_urls: z.array(z.string()),
});

const indexabilityFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  confidence: z.enum(["observed", "potential"]),
  message: z.string(),
  example_urls: z.array(z.string()),
});

const siteIndexabilityGraphSchema = z.object({
  scope: z.literal("sampled_pages_only"),
  sampled_pages: z.number().int().nonnegative(),
  sitemap_pages_sampled: z.number().int().nonnegative(),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string()),
  findings: z.array(indexabilityFindingSchema),
  findings_truncated: z.boolean(),
});

const contentDuplicateSchema = z.object({
  scope: z.literal("sampled_pages_only"),
  sampled_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  eligible_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  skipped_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  coverage_limited: z.boolean(),
  limitations: z.array(z.string().max(300)).max(4),
  total_pairs: z.number().int().nonnegative(),
  pairs: z.array(z.object({
    first_url: z.string().max(512),
    second_url: z.string().max(512),
    language: z.string().max(16),
    kind: z.enum(["exact", "near"]),
    confidence: z.enum(["observed", "potential"]),
    similarity_percent: z.number().int().min(0).max(100),
    first_words: z.number().int().nonnegative(),
    second_words: z.number().int().nonnegative(),
  })).max(8),
  pairs_truncated: z.boolean(),
});

const contentQualitySchema = z.object({
  scope: z.literal("sampled_pages_only"),
  sampled_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  eligible_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  skipped_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  families_compared: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  empty_main_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  short_main_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  repeated_boilerplate_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
  possible_low_value_pages: z.number().int().nonnegative().max(SITE_AUDIT_MAX_PAGES),
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
});

const productClaimSchema = z.object({
  scope: z.literal("landing_html_vs_registered_mcp_metadata"),
  surface: z.enum(["hosted", "local"]),
  catalog_available: z.boolean(),
  registered_tools: z.number().int().nonnegative().max(64),
  tool_claims_checked: z.number().int().nonnegative().max(20),
  checked_claims: z.number().int().nonnegative(),
  consistent_claims: z.number().int().nonnegative(),
  contradicted_claims: z.number().int().nonnegative(),
  unverified_claims: z.number().int().nonnegative(),
  advertised_tools: z.array(z.object({ name: z.string().max(64), registered: z.boolean() })).max(20),
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const provenanceIdSchema = z.string().min(1).max(64)
  .refine((value) => Boolean(safeProvenanceId(value)), "Use a safe ASCII reference identifier.");
const provenanceUrlSchema = z.string().url().max(512)
  .refine((value) => Boolean(safeProvenanceUrl(value)),
    "Use a query-free HTTP(S) URL without credentials, fragment or nonstandard port.");
const provenanceDateSchema = z.string().max(48)
  .refine((value) => Boolean(normalizedEvidenceDate(value)), "Use a valid ISO date or timezone-qualified timestamp.");
const provenanceManifestSchema = z.object({
  as_of: provenanceDateSchema.optional(),
  sources: z.array(z.object({ id: provenanceIdSchema, url: provenanceUrlSchema })).max(24).optional(),
  datasets: z.array(z.object({
    id: provenanceIdSchema,
    version: z.string().min(1).max(64)
      .refine((value) => Boolean(safeDatasetVersion(value))).optional(),
    as_of: provenanceDateSchema.optional(),
    max_age_days: z.number().int().min(0).max(3650).optional(),
    methodology_id: provenanceIdSchema.optional(),
  })).max(16).optional(),
  methodologies: z.array(z.object({ id: provenanceIdSchema, url: provenanceUrlSchema })).max(16).optional(),
});
const provenanceOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const intentPageInputSchema = z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeIntentUrl(value)),
      "Use a query-free HTTP(S) URL without credentials, fragments or nonstandard port."),
  htmlContent: z.string().min(1).max(MAX_INTENT_HTML_BYTES)
    .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_INTENT_HTML_BYTES,
      "Each page must not exceed 150,000 UTF-8 bytes."),
});
const intentSignalsSchema = z.object({
  informational: z.array(z.string().max(40)).max(5),
  commercial: z.array(z.string().max(40)).max(5),
  transactional: z.array(z.string().max(40)).max(5),
  navigational: z.array(z.string().max(40)).max(5),
});
const intentSignalCountsSchema = z.object({
  informational: z.number().int().min(0).max(5),
  commercial: z.number().int().min(0).max(5),
  transactional: z.number().int().min(0).max(5),
  navigational: z.number().int().min(0).max(5),
});
const intentPageOutputSchema = z.object({
  origin: z.string().max(200),
  title_present: z.boolean(), h1_present: z.boolean(), main_found: z.boolean(),
  signals: intentSignalsSchema,
  signal_counts: intentSignalCountsSchema,
  intent_signal_count: z.number().int().min(0).max(5).optional(),
  query_title_coverage_percent: z.number().int().min(0).max(100).optional(),
  query_h1_coverage_percent: z.number().int().min(0).max(100).optional(),
  extraction_limited: z.boolean(),
});
const competitorIntentOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const supportedSchemaOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const internalLinkPageInputSchema = z.object({
  url: z.string().url().max(512).refine((value) => Boolean(safeLinkPageUrl(value)),
    "Use a query-free HTTP(S) URL without credentials, fragments or nonstandard ports."),
  htmlContent: z.string().min(1).max(MAX_LINK_HTML_BYTES)
    .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_LINK_HTML_BYTES,
      "Each supplied HTML page must be at most 160,000 UTF-8 bytes."),
});
const internalLinkOutputPageSchema = z.object({
  page: z.number().int().min(1).max(8),
  main_present: z.boolean(),
  internal_links: z.number().int().nonnegative(),
  external_links: z.number().int().nonnegative(),
  linked_sample_pages: z.number().int().min(0).max(8),
  unmatched_internal_links: z.number().int().nonnegative(),
  missing_anchor_labels: z.number().int().nonnegative(),
  generic_anchor_links: z.number().int().nonnegative(),
  nofollow_internal_links: z.number().int().nonnegative(),
  self_links: z.number().int().nonnegative(),
  fragment_only_links: z.number().int().nonnegative(),
  extraction_limited: z.boolean(),
});
const internalLinkOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const metadataPageInputSchema = z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeMetadataLabel(value)),
      "Use an absolute query-free HTTP(S) page label without credentials or fragments."),
  htmlContent: z.string().min(1).max(MAX_METADATA_HTML_BYTES)
    .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_METADATA_HTML_BYTES,
      "Each HTML page must be at most 180,000 UTF-8 bytes."),
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
const metadataConsistencyOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const variantFieldInputSchema = z.string().min(1).max(MAX_VARIANT_URL_BYTES)
  .refine((value) => !/[\r\n\u0000\u007f]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_VARIANT_URL_BYTES,
  "Caller-observed URL/Location/canonical values must fit 1,024 UTF-8 bytes without CR/LF/NUL.");
const variantObservationInputSchema = z.object({
  url: z.string().url().max(MAX_VARIANT_URL_BYTES)
    .refine((value) => Boolean(safeVariantLabel(value)),
      "Supply an absolute HTTP(S) variant label without credentials, fragment, custom port or unsafe path.")
    .describe("Exact caller-observed URL including optional query values, which are never fetched or returned."),
  status_code: z.number().int().min(100).max(599)
    .describe("Actual caller-observed HTTP response code; tool makes no HTTP requests."),
  method: z.enum(["GET", "HEAD"]).optional()
    .describe("Actual observed request method; HEAD cannot provide a body fingerprint."),
  location: variantFieldInputSchema.optional()
    .describe("Optional raw one-step HTTP Location redirect target; relative references allowed; no redirects followed."),
  canonicals: z.array(variantFieldInputSchema).max(MAX_VARIANT_CANONICALS).optional()
    .describe("Zero to three caller-observed canonical declarations, absolute or relative; not Google's chosen canonical."),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/iu).optional()
    .describe("Optional caller-computed exact HTTP 200 response-body SHA-256 hex; never returned or verified here."),
});
const variantOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const securityHeaderInputSchema = z.string().max(MAX_SECURITY_HEADER_BYTES)
  .refine((value) => !/[\r\n\u0000]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_SECURITY_HEADER_BYTES,
  "Header observations must not contain CR/LF/NUL or exceed 2,048 UTF-8 bytes.");
const securityPagesInputSchema = z.array(z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeHttpResourceUrl(value)),
      "Use a query-free HTTP(S) URL label without credentials, fragment or custom port.")
    .describe("Safe caller-observed HTTP or HTTPS page label, not fetched or returned."),
  status_code: z.number().int().min(100).max(599)
    .describe("Observed HTTP response code; no live fetch or redirect following."),
  location: securityHeaderInputSchema.optional()
    .describe("Optional actual Location header from HTTP response, not returned."),
  strict_transport_security: z.array(securityHeaderInputSchema).max(MAX_SECURITY_HEADER_VALUES).optional()
    .describe("Up to four observed Strict-Transport-Security response header values."),
  content_security_policy: z.array(securityHeaderInputSchema).max(MAX_SECURITY_HEADER_VALUES).optional()
    .describe("Up to four enforcing Content-Security-Policy response header values."),
  content_security_policy_report_only: z.array(securityHeaderInputSchema).max(MAX_SECURITY_HEADER_VALUES).optional()
    .describe("Up to four Content-Security-Policy-Report-Only headers, not enforced by the browser."),
  referrer_policy: securityHeaderInputSchema.optional()
    .describe("Optional observed Referrer-Policy response header."),
  x_content_type_options: securityHeaderInputSchema.optional()
    .describe("Optional observed X-Content-Type-Options response header."),
  x_frame_options: securityHeaderInputSchema.optional()
    .describe("Optional observed X-Frame-Options response header."),
  htmlContent: z.string().min(1).max(MAX_SECURITY_HTML_BYTES).optional()
    .refine((value) => value === undefined || new TextEncoder().encode(value).byteLength <= MAX_SECURITY_HTML_BYTES,
      "Each supplied HTML document must fit 120,000 UTF-8 bytes.")
    .describe("Optional supplied static HTML, max 120 KB/page and 300 KB combined; no resources fetched or executed."),
})).min(1).max(MAX_SECURITY_PAGES);
const securityOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const httpHeaderInputSchema = z.string().max(MAX_HTTP_HEADER_BYTES)
  .refine((value) => !/[\r\n\u0000]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_HTTP_HEADER_BYTES,
  "Observed header values must not contain CR/LF/NUL and must be at most 2,048 UTF-8 bytes.");
const httpObservationInputSchema = z.object({
  url: z.string().url().max(512)
    .refine((value) => Boolean(safeHttpResourceUrl(value)),
      "Use a query-free HTTP(S) resource label without credentials, fragment or custom port.")
    .describe("Safe HTTP(S) URL label for this response, not fetched or echoed."),
  status_code: z.number().int().min(100).max(599)
    .describe("HTTP status observed by the caller, not a crawler/indexing verdict."),
  method: z.enum(["HEAD", "GET"]).optional()
    .describe("Actual method used for the supplied header observation when known."),
  content_type: httpHeaderInputSchema.optional()
    .describe("Optional raw Content-Type response header value."),
  content_disposition: httpHeaderInputSchema.optional()
    .describe("Optional raw Content-Disposition header; filenames will not be returned."),
  x_robots_tag: z.array(httpHeaderInputSchema).max(MAX_HTTP_HEADER_VALUES).optional()
    .describe("Up to eight X-Robots-Tag HTTP header values, supplied in order."),
  link: z.array(httpHeaderInputSchema).max(MAX_HTTP_HEADER_VALUES).optional()
    .describe("Up to eight Link HTTP header values, including rel=canonical declarations."),
});
const httpDirectivesOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const multilingualClusterSchema = z.object({
  scope: z.literal("sampled_pages_only"),
  sampled_pages: z.number().int().nonnegative().max(16),
  eligible_pages: z.number().int().nonnegative().max(16),
  pages_with_alternates: z.number().int().nonnegative().max(16),
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
});

const siteAuditOutputSchema = {
  site_url: z.string(),
  sitemap_url: z.string().optional(),
  discovery: z.enum(["sitemap", "root_only", "partial"]),
  discovery_error: z.enum(["robots_unavailable", "sitemap_unavailable", "sitemap_invalid", "sitemap_query_unsupported"]).optional(),
  pages_discovered: z.number().int().nonnegative(),
  pages_selected: z.number().int().nonnegative(),
  pages_audited: z.number().int().nonnegative(),
  pages_partial: z.number().int().nonnegative(),
  pages_failed: z.number().int().nonnegative(),
  pages_skipped_robots: z.number().int().nonnegative(),
  truncated: z.boolean(),
  next_page_offset: z.number().int().nonnegative().optional(),
  discovery_fingerprint: z.string(),
  audit_health_score: z.number().int().min(0).max(100).optional(),
  score_coverage_percent: z.number().int().min(0).max(100),
  pages: z.array(sitePageSchema),
  issue_groups: z.array(siteIssueGroupSchema),
  issue_groups_truncated: z.boolean(),
  indexability_graph: siteIndexabilityGraphSchema.optional(),
  content_duplicates: contentDuplicateSchema.optional(),
  content_quality: contentQualitySchema.optional(),
  multilingual_clusters: multilingualClusterSchema.optional(),
  overview: overviewSchema,
  error: z.string().optional(),
};

const siteAuditSnapshotSchema = z.object({
  ...siteAuditOutputSchema,
  site_url: z.string().url().max(2_048),
  discovery_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pages: z.array(sitePageSchema).max(SITE_AUDIT_MAX_PAGES),
  issue_groups: z.array(siteIssueGroupSchema).max(50),
  overview: overviewSchema.optional(),
  error: z.string().optional(),
});

const monitorPolicyInputSchema = z.object({
  min_regressed_pages: z.number().int().min(1).max(8).optional()
    .describe("Minimum regressed pages for an unsent preview in the latest fully comparable sampled pair (default 1)."),
  min_net_error_increase: z.number().int().min(1).max(10_000).optional()
    .describe("Minimum positive net error-count increase across matched completed pages (default 1)."),
  min_net_warning_increase: z.number().int().min(1).max(10_000).optional()
    .describe("Minimum positive net warning-count increase across matched completed pages (default 1)."),
  min_coverage_lost_pages: z.number().int().min(1).max(8).optional()
    .describe("Minimum completed pages losing coverage to trigger a review-only observation (default 1)."),
  consecutive_regressing_steps: z.number().int().min(1).max(4).optional()
    .describe("How many fully comparable consecutive regressing samples are required for the page-regression rule (default 1)."),
  review_coverage_loss: z.boolean().optional()
    .describe("Whether to preview validator coverage loss as a review-only observation (default true)."),
  review_sitemap_drift: z.boolean().optional()
    .describe("Whether to preview sitemap fingerprint drift as a review-only observation (default true)."),
}).strict();
const monitorOutputSchema = z.object({
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
  policy: monitorPolicyInputSchema.required(),
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const historicalVersionsInputSchema = z.array(z.object({
  saved_at: z.string().datetime({ offset: true }).max(40)
    .describe("Actual snapshot timestamp with explicit UTC offset; versions must be ordered oldest first."),
  snapshot: siteAuditSnapshotSchema
    .describe("Complete previously observed audit_public_site snapshot (compact site-audit fields), not a URL to fetch."),
})).min(2).max(MAX_HISTORICAL_VERSIONS)
  .refine((versions) => {
    try {
      let total = 0;
      const encoder = new TextEncoder();
      for (const version of versions) {
        const size = encoder.encode(JSON.stringify(version.snapshot)).byteLength;
        if (size > MAX_HISTORICAL_SNAPSHOT_BYTES) return false;
        total += size;
        if (total > MAX_HISTORICAL_TOTAL_BYTES) return false;
      }
      return true;
    } catch { return false; }
  }, "Each supplied historical version must fit 60 KB and the aggregate 610 KB limit.");
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
const historicalOutputSchema = z.object({
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
  overview: overviewSchema,
  error: z.string().optional(),
});

const comparedPageSchema = z.object({
  url: z.string(),
  kind: z.enum(["regressed", "improved", "mixed", "unchanged", "coverage_lost", "coverage_recovered", "unverified"]),
  before_status: sitePageSchema.shape.status,
  after_status: sitePageSchema.shape.status,
  error_delta: z.number().int().optional(),
  warning_delta: z.number().int().optional(),
  health_score_delta: z.number().int().optional(),
  redirect_changed: z.boolean(),
});

const changedIssueGroupSchema = siteFindingSchema.extend({
  affected_pages: z.number().int().nonnegative(),
});
const expandedIssueGroupSchema = siteFindingSchema.extend({
  before_affected_pages: z.number().int().nonnegative(),
  after_affected_pages: z.number().int().nonnegative(),
  delta_pages: z.number().int(),
});

const siteComparisonOutputSchema = {
  status: z.enum(["comparable", "partial", "not_comparable"]),
  baseline_site_url: z.string(),
  current_site_url: z.string(),
  baseline_selected_pages: z.number().int().nonnegative(),
  current_selected_pages: z.number().int().nonnegative(),
  pages_compared: z.number().int().nonnegative(),
  regressed_pages: z.number().int().nonnegative(),
  improved_pages: z.number().int().nonnegative(),
  mixed_pages: z.number().int().nonnegative(),
  coverage_lost_pages: z.number().int().nonnegative(),
  coverage_recovered_pages: z.number().int().nonnegative(),
  newly_selected_urls: z.array(z.string()),
  no_longer_selected_urls: z.array(z.string()),
  page_changes: z.array(comparedPageSchema),
  issue_group_comparison_available: z.boolean(),
  newly_observed_issue_groups: z.array(changedIssueGroupSchema),
  no_longer_observed_issue_groups: z.array(changedIssueGroupSchema),
  expanding_issue_groups: z.array(expandedIssueGroupSchema),
  shrinking_issue_groups: z.array(expandedIssueGroupSchema),
  limitations: z.array(z.string()),
  overview: overviewSchema,
};

const reportOutputSchema = {
  html_errors: z.number().int().nonnegative(),
  css_errors: z.number().int().nonnegative(),
  seo_issues: z.number().int().nonnegative(),
  schema_issues: z.number().int().nonnegative(),
  links_checked: z.number().int().nonnegative(),
  eligible_links: z.number().int().nonnegative(),
  links_truncated: z.boolean(),
  broken_links: z.number().int().nonnegative(),
  unverified_links: z.number().int().nonnegative(),
  html_warnings: z.number().int().nonnegative(),
  html_info: z.number().int().nonnegative(),
  html_messages: z.array(validationMessageSchema),
  css_messages: z.array(cssMessageSchema),
  seo_findings: z.array(auditIssueSchema),
  schema_findings: z.array(auditIssueSchema),
  links: z.array(linkStatusSchema),
  seo_truncated: z.boolean(),
  schema_truncated: z.boolean(),
  html_total_messages: z.number().int().nonnegative(),
  html_truncated: z.boolean(),
  schema_blocks_checked: z.number().int().nonnegative(),
  healthy_links: z.number().int().nonnegative(),
  redirects: z.number().int().nonnegative(),
  unreachable_links: z.number().int().nonnegative(),
  links_requested: z.boolean(),
  css_checked: z.boolean(),
  failed_checks: z.array(z.enum(["fetch", "html", "css", "links"])),
  overview: overviewSchema,
  error: z.string().optional(),
};

const htmlInput = z
  .string()
  .min(1)
  .max(HTML_MAX_LENGTH)
  .describe("Raw HTML markup supplied by the user; this is not a webpage URL.");
const cssInput = z
  .string()
  .min(1)
  .max(CSS_MAX_LENGTH)
  .describe("Raw CSS source supplied by the user.");
const publicPageUrlInput = z
  .string()
  .url()
  .max(2_048)
  .describe("One authorized public HTTP(S) webpage URL; private pages, credentials, and custom ports are rejected.");
const externalReadOnlyAnnotations = {
  // These tools contact external recipients but never modify external state.
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;
const localReadOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

function noAuthSecuritySchemes() {
  return [{ type: "noauth" as const }];
}

function withWidget(statusText: { invoking: string; invoked: string }) {
  return {
    securitySchemes: noAuthSecuritySchemes(),
    ui: { resourceUri: WIDGET_URI },
    "openai/toolInvocation/invoking": statusText.invoking,
    "openai/toolInvocation/invoked": statusText.invoked,
  };
}

function withNoAuthWidget(statusText: { invoking: string; invoked: string }) {
  return {
    securitySchemes: noAuthSecuritySchemes(),
    _meta: withWidget(statusText),
  };
}

function withNoAuthPlainTool(statusText: { invoking: string; invoked: string }) {
  return {
    securitySchemes: noAuthSecuritySchemes(),
    _meta: {
      securitySchemes: noAuthSecuritySchemes(),
      "openai/toolInvocation/invoking": statusText.invoking,
      "openai/toolInvocation/invoked": statusText.invoked,
    },
  };
}

function withExactCors(response: Response, origin?: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("access-control-allow-origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "Mcp-Session-Id");
    const vary = headers.get("vary");
    if (!vary) headers.set("vary", "Origin");
    else if (vary !== "*" && !vary.toLowerCase().split(",").map((value) => value.trim()).includes("origin")) {
      headers.set("vary", `${vary}, Origin`);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withCanonicalToolSecuritySchemes(payload: unknown): unknown | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;

  return {
    ...(payload as Record<string, unknown>),
    result: {
      ...(result as Record<string, unknown>),
      tools: tools.map((tool) => {
        if (!tool || typeof tool !== "object") return tool;
        const meta = (tool as { _meta?: unknown })._meta;
        const securitySchemes = meta && typeof meta === "object"
          ? (meta as { securitySchemes?: unknown }).securitySchemes
          : undefined;
        return Array.isArray(securitySchemes)
          ? { ...(tool as Record<string, unknown>), securitySchemes }
          : tool;
      }),
    },
  };
}

async function addCanonicalToolSecuritySchemes(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || (!contentType.includes("application/json") && !contentType.includes("text/event-stream"))) {
    return response;
  }

  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (contentType.includes("text/event-stream")) {
    const normalized = body.replace(/^data: (.+)$/gm, (line, data) => {
      try {
        const payload = withCanonicalToolSecuritySchemes(JSON.parse(data));
        return payload === undefined ? line : `data: ${JSON.stringify(payload)}`;
      } catch {
        return line;
      }
    });
    return new Response(normalized, { status: response.status, statusText: response.statusText, headers });
  }

  try {
    const payload = withCanonicalToolSecuritySchemes(JSON.parse(body));
    if (payload === undefined) return new Response(body, { status: response.status, statusText: response.statusText, headers });
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
}

function jsonRpcHttpError(status: number, message: string, origin?: string, extraHeaders?: HeadersInit): Response {
  const response = Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers: extraHeaders },
  );
  return withExactCors(response, origin);
}

async function requestBodyExceedsLimit(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const bytes = Number(contentLength);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > MCP_BODY_MAX_BYTES) return true;
  }
  if (!request.body) return false;

  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      bytes += value.byteLength;
      if (bytes > MCP_BODY_MAX_BYTES) {
        await reader.cancel("MCP request body exceeded the configured limit.");
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function rateLimitKey(request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  const sessionId = request.headers.get("mcp-session-id")?.trim();
  const actor = ip
    ? `ip:${ip}`
    : sessionId
      ? `session:${sessionId.slice(0, 128)}`
      : `anonymous:${request.headers.get("user-agent")?.slice(0, 128) ?? "unknown"}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(actor));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function logRequest(event: string, fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ event, ...fields }));
}

function validationFindings(
  messages: Array<{ type: "error" | "warning" | "info"; message: string; line?: number; column?: number }>,
): PresentableFinding[] {
  return messages.map((message) => ({
    severity: message.type,
    message: message.message,
    line: message.line,
    column: message.column,
  }));
}

function auditFindings(
  issues: Array<{ severity: "error" | "warning" | "info"; category: string; message: string }>,
): PresentableFinding[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    message: issue.message,
    label: issue.category,
  }));
}

function failedOverview(
  kind: ResultOverview["kind"],
  title: string,
  headline: string,
  detail: string,
): ResultOverview {
  return {
    kind,
    status: "failed",
    title,
    headline,
    detail,
    total: 0,
    shown: 0,
    truncated: false,
    counts: [],
    next_action: "Try again shortly. If the problem continues, run the remaining checks separately.",
  };
}

function metric(
  key: string,
  label: string,
  value: number,
  tone: OverviewMetric["tone"],
): OverviewMetric {
  return { key, label, value, tone };
}

function summarizeSeverities(counts: { errors: number; warnings: number; info: number }): string {
  const parts = [
    counts.errors > 0 ? plural(counts.errors, "error") : undefined,
    counts.warnings > 0 ? plural(counts.warnings, "warning") : undefined,
    counts.info > 0 ? plural(counts.info, "informational note") : undefined,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return "no findings";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function linkCounts(links: Array<{ status: number | "blocked" | "failed"; ok: boolean }>) {
  const redirects = links.filter((link) => isHttpRedirectStatus(link.status)).length;
  const unverified = links.filter((link) => !link.ok && isUnverifiedLinkStatus(link.status)).length;
  const unreachable = links.filter((link) => !link.ok && !isUnverifiedLinkStatus(link.status)).length;
  return {
    checked: links.length,
    healthy: links.length - redirects - unreachable - unverified,
    redirects,
    unreachable,
    unverified,
  };
}

type ReportCheck = "html" | "css" | "links";

interface ValidationReportOptions {
  html: string;
  htmlMediaType?: HtmlMediaType;
  css?: string;
  checkLinks: boolean;
  baseUrl?: string;
  xRobotsTag?: string;
  maxLinks: number;
  title: "Validation report" | "Public webpage audit";
  sourceDetail?: string;
}

function reportNextAction(errors: number, warnings: number, rerunLabel: string): string | undefined {
  if (errors > 0 && warnings > 0) {
    return `Fix errors first, review warnings, then ${rerunLabel}.`;
  }
  if (errors > 0) return `Fix the errors, then ${rerunLabel}.`;
  if (warnings > 0) return `Review the warnings, then ${rerunLabel}.`;
  return undefined;
}

async function runValidationReport({
  html,
  htmlMediaType,
  css,
  checkLinks,
  baseUrl,
  xRobotsTag,
  maxLinks,
  title,
  sourceDetail,
}: ValidationReportOptions) {
  const cssChecked = css !== undefined;
  const [htmlResult, cssResult, linksResult] = await Promise.allSettled([
    validateHtmlDetailed(html, htmlMediaType),
    cssChecked ? Promise.resolve().then(() => validateCss(css)) : Promise.resolve([]),
    checkLinks ? checkBrokenLinksDetailed(html, baseUrl, maxLinks)
      : Promise.resolve({ links: [], eligibleLinks: 0, truncated: false }),
  ]);
  const seoResult = auditSeoMetadata(html, { xRobotsTag });
  const schemaResult = validateSchemaMarkup(html);
  const failedChecks: ReportCheck[] = [];
  const failureDetails: string[] = [];

  if (htmlResult.status === "rejected") {
    failedChecks.push("html");
    failureDetails.push("HTML validation was unavailable");
  }
  if (cssChecked && cssResult.status === "rejected") {
    failedChecks.push("css");
    failureDetails.push("CSS validation was unavailable");
  }
  if (checkLinks && linksResult.status === "rejected") {
    failedChecks.push("links");
    failureDetails.push(
      linksResult.reason instanceof Error
        ? linksResult.reason.message
        : "Link checking could not be completed",
    );
  }

  const htmlValidation = htmlResult.status === "fulfilled"
    ? htmlResult.value
    : { messages: [], total: 0, truncated: false, counts: { error: 0, warning: 0, info: 0 } };
  const htmlMessages = htmlValidation.messages;
  const cssMessages = cssResult.status === "fulfilled" ? cssResult.value : [];
  const links = linksResult.status === "fulfilled" ? linksResult.value.links : [];
  const eligibleLinks = linksResult.status === "fulfilled" ? linksResult.value.eligibleLinks : 0;
  const linksTruncated = linksResult.status === "fulfilled" && linksResult.value.truncated;
  const htmlCounts = {
    errors: htmlValidation.counts.error,
    warnings: htmlValidation.counts.warning,
    info: htmlValidation.counts.info,
  };
  const seoCounts = {
    errors: seoResult.counts.error,
    warnings: seoResult.counts.warning,
    info: seoResult.counts.info,
  };
  const schemaCounts = {
    errors: schemaResult.counts.error,
    warnings: schemaResult.counts.warning,
    info: schemaResult.counts.info,
  };
  const linkSummary = linkCounts(links);
  const reportCounts = {
    errors: htmlCounts.errors + cssMessages.length + seoCounts.errors + schemaCounts.errors + linkSummary.unreachable,
    warnings: htmlCounts.warnings + seoCounts.warnings + schemaCounts.warnings + linkSummary.redirects + linkSummary.unverified,
    info: htmlCounts.info + seoCounts.info + schemaCounts.info,
  };
  const passedChecks = [
    htmlResult.status === "fulfilled" && htmlCounts.errors === 0 && htmlCounts.warnings === 0,
    cssChecked && cssResult.status === "fulfilled" && cssMessages.length === 0,
    seoCounts.errors === 0 && seoCounts.warnings === 0,
    schemaResult.blocksChecked > 0 && schemaCounts.errors === 0 && schemaCounts.warnings === 0,
    checkLinks && linkSummary.checked > 0 && linkSummary.redirects === 0 && linkSummary.unreachable === 0 && linkSummary.unverified === 0,
  ].filter(Boolean).length;
  const totalFindings = htmlValidation.total
    + cssMessages.length
    + seoResult.total
    + schemaResult.total
    + linkSummary.redirects
    + linkSummary.unreachable
    + linkSummary.unverified;
  const shownFindings = htmlMessages.length
    + cssMessages.length
    + seoResult.issues.length
    + schemaResult.issues.length
    + linkSummary.redirects
    + linkSummary.unreachable
    + linkSummary.unverified;
  const truncated = htmlValidation.truncated || seoResult.truncated || schemaResult.truncated || linksTruncated;
  const hasFailures = failedChecks.length > 0;
  const needsAttention = reportCounts.errors > 0 || reportCounts.warnings > 0;
  const linksDetail = checkLinks
    ? failedChecks.includes("links")
      ? "Link checking did not complete."
      : `${linksTruncated ? `${linkSummary.checked} of ${eligibleLinks} eligible links` : plural(linkSummary.checked, "link")} checked${linkSummary.unverified > 0 ? `; ${plural(linkSummary.unverified, "check")} unverified` : ""}${linksTruncated ? "; unchecked links are not covered" : ""}.`
    : "Links were not requested.";
  const cssDetail = cssChecked ? "CSS was checked." : "Linked and external CSS were not checked.";
  const nextAction = hasFailures
    ? "Review the completed findings, then retry the unavailable checks."
    : linkSummary.unverified > 0
      ? "Review confirmed failures and redirects; retry rate-limited or failed link checks later."
    : linksTruncated
      ? "Check the remaining links separately; this report covers only the first bounded set."
    : reportNextAction(reportCounts.errors, reportCounts.warnings, `run ${title.toLowerCase()} again`);
  const overview: ResultOverview = {
    kind: "report",
    status: hasFailures || linkSummary.unverified > 0 || linksTruncated ? "partial" : needsAttention ? "needs_attention" : "passed",
    title,
    headline: hasFailures
      ? `${title} is partial: ${plural(failedChecks.length, "check")} could not complete.`
      : linkSummary.unverified > 0
        ? `${title} is partial: ${plural(linkSummary.unverified, "link check")} ${linkSummary.unverified === 1 ? "remains" : "remain"} unverified.`
      : linksTruncated
        ? `${title} is partial: ${linkSummary.checked} of ${eligibleLinks} eligible links checked.`
      : needsAttention
        ? `${title} is ready: ${summarizeSeverities({ ...reportCounts, info: 0 })} need attention.`
        : `${title} is clear: no errors or warnings were found.`,
    detail: `${sourceDetail ? `${sourceDetail} ` : ""}Completed checks found ${summarizeSeverities(reportCounts)}. ${cssDetail} ${linksDetail}`,
    total: totalFindings,
    shown: shownFindings,
    truncated,
    counts: [
      metric("errors", "Errors", reportCounts.errors, "error"),
      metric("warnings", "Warnings", reportCounts.warnings, "warning"),
      metric("notes", "Notes", reportCounts.info, "info"),
      metric("checks_passed", "Checks passed", passedChecks, "success"),
    ],
    ...(nextAction ? { next_action: nextAction } : {}),
  };
  const reportFindings: PresentableFinding[] = [
    ...validationFindings(htmlMessages),
    ...cssMessages.map((message) => ({
      severity: "error" as const,
      message: message.message,
      line: message.line || undefined,
      label: "CSS",
    })),
    ...auditFindings(seoResult.issues),
    ...auditFindings(schemaResult.issues),
    ...links.flatMap<PresentableFinding>((link): PresentableFinding[] => {
      if (!link.ok) {
        return [{
          severity: isUnverifiedLinkStatus(link.status) ? "warning" as const : "error" as const,
          message: `${link.url} — ${link.message ?? `returned status ${link.status}`}`,
          label: "Link",
        }];
      }
      if (isHttpRedirectStatus(link.status)) {
        return [{
          severity: "warning" as const,
          message: `${link.url} returned redirect status ${link.status}.`,
          label: "Link",
        }];
      }
      return [];
    }),
  ];
  const error = failureDetails.length > 0 ? `${failureDetails.join("; ")}.` : undefined;
  const structuredContent = {
    html_errors: htmlCounts.errors,
    css_errors: cssResult.status === "fulfilled" ? cssMessages.length : 0,
    seo_issues: seoResult.total,
    schema_issues: schemaResult.total,
    links_checked: linkSummary.checked,
    eligible_links: eligibleLinks,
    links_truncated: linksTruncated,
    broken_links: linkSummary.unreachable,
    unverified_links: linkSummary.unverified,
    html_warnings: htmlCounts.warnings,
    html_info: htmlCounts.info,
    html_messages: htmlMessages,
    css_messages: cssMessages,
    seo_findings: seoResult.issues,
    schema_findings: schemaResult.issues,
    links,
    seo_truncated: seoResult.truncated,
    schema_truncated: schemaResult.truncated,
    html_total_messages: htmlValidation.total,
    html_truncated: htmlValidation.truncated,
    schema_blocks_checked: schemaResult.blocksChecked,
    healthy_links: linkSummary.healthy,
    redirects: linkSummary.redirects,
    unreachable_links: linkSummary.unreachable,
    links_requested: checkLinks,
    css_checked: cssChecked,
    failed_checks: failedChecks,
    overview,
    ...(error ? { error } : {}),
  };

  return {
    structuredContent,
    content: contentForOverview(overview, reportFindings),
  };
}

function failedPublicPageAudit(error: string, linksRequested: boolean) {
  const overview = failedOverview(
    "report",
    "Public webpage audit",
    "The public webpage could not be audited.",
    error,
  );
  return {
    structuredContent: {
      html_errors: 0,
      css_errors: 0,
      seo_issues: 0,
      schema_issues: 0,
      links_checked: 0,
      eligible_links: 0,
      links_truncated: false,
      broken_links: 0,
      unverified_links: 0,
      html_warnings: 0,
      html_info: 0,
      html_messages: [],
      css_messages: [],
      seo_findings: [],
      schema_findings: [],
      links: [],
      seo_truncated: false,
      schema_truncated: false,
      html_total_messages: 0,
      html_truncated: false,
      schema_blocks_checked: 0,
      healthy_links: 0,
      redirects: 0,
      unreachable_links: 0,
      links_requested: linksRequested,
      css_checked: false,
      failed_checks: ["fetch"],
      page_fetched: false,
      overview,
      error,
    },
    content: contentForOverview(overview),
    isError: true,
  };
}

function siteAuditFindings(
  groups: Array<{ severity: "error" | "warning" | "info"; category: string; message: string }>,
): PresentableFinding[] {
  return groups.map((group) => ({
    severity: group.severity,
    label: group.category,
    message: group.message,
  }));
}

function siteAuditOverview(result: Awaited<ReturnType<typeof auditPublicSite>>): ResultOverview {
  const totals = result.pages.reduce(
    (current, page) => ({
      errors: current.errors + page.html_errors + page.seo_errors + page.schema_errors,
      warnings: current.warnings + page.html_warnings + page.seo_warnings + page.schema_warnings,
      notes: current.notes + page.notes,
    }),
    { errors: 0, warnings: 0, notes: 0 },
  );
  const completed = result.pages_audited;
  const indexabilityFindings = result.indexability_graph.findings;
  const hasIndexabilityFindings = indexabilityFindings.length > 0;
  const duplicatePairs = result.content_duplicates.pairs;
  const duplicatePairCount = result.content_duplicates.total_pairs;
  const qualityFindingCount = result.content_quality.total_findings;
  const multilingualFindingCount = result.multilingual_clusters.total_findings;
  const hasCoverageGap = result.discovery_error !== undefined
    || result.indexability_graph.coverage_limited
    || result.pages_partial > 0
    || result.pages_failed > 0
    || result.pages_skipped_robots > 0
    || result.truncated;
  const status: ResultOverview["status"] = completed === 0 && result.pages_partial === 0
    ? "failed"
    : hasCoverageGap
      ? "partial"
      : totals.errors > 0 || totals.warnings > 0 || hasIndexabilityFindings || duplicatePairCount > 0 || multilingualFindingCount > 0 || qualityFindingCount > 0
        ? "needs_attention"
        : "passed";
  const headline = status === "failed"
    ? "Public site audit could not complete an eligible page audit."
    : status === "partial"
      ? `Public site audit is partial: ${plural(completed, "page")} completed with coverage limits.`
      : totals.errors > 0 || totals.warnings > 0
        ? `Public site audit found ${summarizeSeverities({ errors: totals.errors, warnings: totals.warnings, info: 0 })}${hasIndexabilityFindings ? ` plus ${plural(indexabilityFindings.length, "sampled cross-page finding")}` : ""}${duplicatePairCount ? ` and ${plural(duplicatePairCount, "same-language duplicate-content pair")}` : ""}${multilingualFindingCount ? ` and ${plural(multilingualFindingCount, "multilingual cluster finding")}` : ""}${qualityFindingCount ? ` and ${plural(qualityFindingCount, "content-quality review finding")}` : ""}.`
      : hasIndexabilityFindings
        ? `Public site audit found ${plural(indexabilityFindings.length, "sampled cross-page indexability finding")}${multilingualFindingCount ? ` and ${plural(multilingualFindingCount, "multilingual cluster finding")}` : ""}.`
      : duplicatePairCount
        ? `Public site audit found ${plural(duplicatePairCount, "same-language duplicate-content pair")} in the selected pages.`
      : multilingualFindingCount
        ? `Public site audit found ${plural(multilingualFindingCount, "multilingual cluster finding")} in the selected pages.`
      : qualityFindingCount
        ? `Public site audit found ${plural(qualityFindingCount, "potential content-quality issue")} in the selected pages.`
      : "Public site audit found no errors or warnings in the completed checks.";
  const scoreDetail = result.audit_health_score === undefined
    ? "No full HTML-and-metadata score was available."
    : `Audit health score: ${result.audit_health_score}/100 across ${result.score_coverage_percent}% of selected pages.`;
  const discoveryDetail = result.discovery_error === "sitemap_query_unsupported"
    ? "Discovery skipped query-bearing sitemap sources or page entries instead of silently requesting different URLs; selected-page coverage is not site-wide coverage. "
    : result.discovery_error
      ? `Discovery was incomplete (${result.discovery_error}); selected-page coverage is not site-wide coverage. `
      : "";
  const detail = `Sitemap-first discovery found ${plural(result.pages_discovered, "same-origin candidate page")}; ${plural(result.pages_selected, "page")} were selected. ${discoveryDetail}${scoreDetail} Main-content duplication comparison covered ${result.content_duplicates.eligible_pages}/${result.content_duplicates.sampled_pages} selected pages. Main-text quality review observed ${result.content_quality.eligible_pages}/${result.content_quality.sampled_pages} pages; short text and repetition are review signals, not rankings or usefulness verdicts. Hreflang/canonical analysis observed ${result.multilingual_clusters.eligible_pages}/${result.multilingual_clusters.sampled_pages} selected pages; unvisited alternate targets are unverified. These checks concern sampled static HTML only. Link checks are intentionally not run by this bounded site tool; no Google indexing decision is inferred.`;
  const incompletePageGuidance = result.pages_partial > 0 || result.pages_failed > 0
    ? " Review partial and failed page coverage, then retry affected batches after resolving failures."
    : "";
  const nextAction = result.next_page_offset !== undefined
    ? `Continue with page_offset ${result.next_page_offset} and expected_discovery_fingerprint ${result.discovery_fingerprint} to audit the same sitemap snapshot; restart at offset 0 if discovery changes.${incompletePageGuidance}`
    : result.discovery_error === "sitemap_query_unsupported"
      ? "Provide public same-origin sitemap and page URLs without query parameters, then rerun discovery; skipped URLs were not audited."
    : result.discovery_error
      ? "Check robots.txt and sitemap availability, then retry discovery before treating this as a complete site audit."
    : result.pages_skipped_robots > 0
      ? "Review robots.txt exclusions with the site owner; excluded pages were not audited and must not be crawled unless the rules change."
    : result.truncated
      ? "Discovery or page selection reached a coverage limit; review the sitemap and continue permitted batches before claiming a site-wide audit."
    : result.indexability_graph.coverage_limited
      ? "Review the indexability graph limitations and incomplete observations; do not treat missing graph findings as a complete site pass."
    : totals.errors > 0 || totals.warnings > 0 || hasIndexabilityFindings || duplicatePairCount > 0 || multilingualFindingCount > 0 || qualityFindingCount > 0
      ? "Review on-page, sampled canonical/hreflang, duplicate-content, and main-text quality evidence; inspect actual rendered pages before changing content or canonicals."
      : result.pages_partial > 0 || result.pages_failed > 0
        ? "Review partial and failed page coverage, then retry the affected batch."
        : undefined;
  return {
    kind: "site",
    status,
    title: "Public site audit",
    headline,
    detail,
    total: totals.errors + totals.warnings + totals.notes + indexabilityFindings.length + duplicatePairCount + multilingualFindingCount + qualityFindingCount,
    shown: result.issue_groups.length + indexabilityFindings.length + duplicatePairs.length + result.multilingual_clusters.findings.length + result.content_quality.findings.length,
    truncated: result.truncated || result.issue_groups_truncated || result.indexability_graph.findings_truncated || result.content_duplicates.pairs_truncated || result.multilingual_clusters.findings_truncated || result.content_quality.findings_truncated,
    counts: [
      metric("pages_audited", "Pages audited", result.pages_audited, "success"),
      metric("pages_partial", "Pages partial", result.pages_partial, "warning"),
      metric("pages_failed", "Pages failed", result.pages_failed, "error"),
      metric("pages_skipped_robots", "Pages excluded by robots", result.pages_skipped_robots, "warning"),
      metric("errors", "Errors", totals.errors, "error"),
      metric("warnings", "Warnings", totals.warnings, "warning"),
      metric("indexability_findings", "Cross-page signals", indexabilityFindings.length, "warning"),
      metric("content_duplicate_pairs", "Duplicate content pairs", duplicatePairCount, "warning"),
      metric("content_quality_findings", "Content quality review findings", qualityFindingCount, "warning"),
      metric("multilingual_cluster_findings", "Multilingual findings", multilingualFindingCount, "warning"),
      ...(result.audit_health_score === undefined
        ? []
        : [metric("audit_health_score", "Audit health score", result.audit_health_score, "success")]),
    ],
    ...(nextAction ? { next_action: nextAction } : {}),
  };
}

function failedPublicSiteAudit(error: string) {
  const overview = failedOverview(
    "site",
    "Public site audit",
    "The public site could not be audited.",
    error,
  );
  return {
    structuredContent: {
      site_url: "",
      discovery: "root_only" as const,
      pages_discovered: 0,
      pages_selected: 0,
      pages_audited: 0,
      pages_partial: 0,
      pages_failed: 0,
      pages_skipped_robots: 0,
      truncated: false,
      score_coverage_percent: 0,
      pages: [],
      issue_groups: [],
      issue_groups_truncated: false,
      overview,
      error,
    },
    content: contentForOverview(overview),
    isError: true,
  };
}

function createServer(env: Env, siteAuditRateLimitKey: string) {
  const server = new McpServer(
    { name: "web-validator-by-digestseo", version: SERVER_VERSION },
    {
      instructions:
        "Use this app only for markup and public webpages the user owns or is authorized to inspect. For one live public page, use audit_public_webpage. For a bounded sitemap-first public-site audit, use audit_public_site; it audits at most eight same-origin pages per call, respects robots.txt, does not recursively follow HTML links, and never runs site-wide link checks. For pasted markup, use the focused markup tools or generate_validation_report. No tool modifies user data. HTML validation sends markup to the Nu HTML Checker hosted at validator.nu; CSS syntax, SEO, and JSON-LD checks run inside the Worker. Link checking is optional only on the focused markup/page tools, contacts eligible public links, and never follows redirects. Do not submit credentials, health data, payment data, or other sensitive personal data.",
    },
  );

  function registerWidgetResource(name: string, uri: string) {
    registerAppResource(server, name, uri, {}, async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: WIDGET_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              domain: "https://web-validator-mcp.digestseo.com",
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            "openai/widgetDescription":
              "Shows a markup, public-webpage, or bounded public-site audit's status, key counts, highest-priority next step, and expandable validation findings.",
          },
        },
      ],
    }));
  }

  registerWidgetResource("web-validator-results", WIDGET_URI);
  registerWidgetResource("web-validator-results-legacy", LEGACY_WIDGET_URI);

  registerAppTool(
    server,
    "validate_html",
    {
      title: "Validate HTML",
      description:
        "Validate supplied HTML markup or a single authorized public webpage URL with the Nu HTML Checker. Provide html for markup, or url for a live page. A standalone HTTP(S) URL in html is also fetched rather than treated as HTML. For combined SEO and JSON-LD checks on a live page, use audit_public_webpage.",
      inputSchema: {
        html: htmlInput.optional().describe("Raw HTML markup or one standalone HTTP(S) webpage URL; omit when providing url."),
        url: publicPageUrlInput.optional().describe("Public webpage to fetch and validate as HTML; omit when providing html."),
      },
      outputSchema: {
        messages: z.array(validationMessageSchema),
        total_messages: z.number().int().nonnegative(),
        truncated: z.boolean(),
        overview: overviewSchema,
        fetched_url: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthWidget({ invoking: "Validating HTML…", invoked: "HTML validation complete." }),
    },
    async ({ html, url }) => {
      try {
        if (Boolean(html) === Boolean(url)) {
          throw new PublicHtmlFetchError("invalid_url", "Provide either HTML markup or one public webpage URL, not both.");
        }
        // Some MCP clients put a URL in the legacy html argument. Never pass
        // that string to Nu as if it were a document: fetch it with the same
        // public URL and redirect protections as audit_public_webpage.
        const standaloneUrl = html && /^https?:\/\/\S+$/i.test(html.trim()) ? html.trim() : undefined;
        const fetched = url || standaloneUrl ? await fetchPublicHtml(url ?? standaloneUrl!) : undefined;
        const result = await validateHtmlDetailed(fetched?.html ?? html!, fetched?.contentType);
        const messages = result.messages;
        const counts = {
          errors: result.counts.error,
          warnings: result.counts.warning,
          info: result.counts.info,
        };
        const needsAttention = counts.errors > 0 || counts.warnings > 0;
        const nextAction = reportNextAction(counts.errors, counts.warnings, "run HTML validation again");
        const headline = needsAttention
          ? `HTML needs attention: ${summarizeSeverities({ ...counts, info: 0 })}.`
          : counts.info > 0
            ? `HTML passes with no errors or warnings. ${plural(counts.info, "informational note")} returned.`
            : "HTML passes validation with no errors or warnings.";
        const overview: ResultOverview = {
          kind: "html",
          status: needsAttention ? "needs_attention" : "passed",
          title: "HTML validation",
          headline,
          detail: `${fetched ? `Fetched and validated ${fetched.finalUrl}. ` : ""}${result.total === 0
            ? "The Nu HTML Checker returned no diagnostics."
            : `${plural(result.total, "diagnostic")} returned${result.truncated ? `; showing the first ${messages.length}` : ""}.`}`,
          total: result.total,
          shown: messages.length,
          truncated: result.truncated,
          counts: [
            metric("errors", "Errors", counts.errors, "error"),
            metric("warnings", "Warnings", counts.warnings, "warning"),
            metric("notes", "Notes", counts.info, "info"),
          ],
          ...(nextAction ? { next_action: nextAction } : {}),
        };
        return {
          structuredContent: {
            messages,
            total_messages: result.total,
            truncated: result.truncated,
            overview,
            ...(fetched ? { fetched_url: fetched.finalUrl } : {}),
          },
          content: contentForOverview(overview, validationFindings(messages)),
        };
    } catch (cause) {
      console.error(
        "W3C HTML validation failed:",
        cause instanceof Error ? cause.message : "Unknown upstream error",
      );
      const error = cause instanceof PublicHtmlFetchError
        ? cause.message
        : "HTML validation is temporarily unavailable. Please try again shortly.";
      const overview = failedOverview("html", "HTML validation", "HTML validation could not be completed.", error);
      return {
        structuredContent: { messages: [], total_messages: 0, truncated: false, overview, error },
        content: contentForOverview(overview),
        isError: true,
      };
    }
    },
  );

  registerAppTool(
    server,
    "validate_css",
    {
      title: "Validate CSS",
      description:
        "Use this when raw CSS source is supplied. Parses it inside the Worker and returns syntax messages without contacting an external service.",
      inputSchema: { css: cssInput },
      outputSchema: {
        errors: z.array(cssMessageSchema),
        overview: overviewSchema,
        error: z.string().optional(),
      },
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({ invoking: "Validating CSS…", invoked: "CSS validation complete." }),
    },
    async ({ css }) => {
      try {
        const errors = await validateCss(css);
        const needsAttention = errors.length > 0;
        const headline = needsAttention
          ? `CSS needs attention: ${plural(errors.length, "syntax error")}.`
          : "CSS parses successfully with no syntax errors.";
        const overview: ResultOverview = {
          kind: "css",
          status: needsAttention ? "needs_attention" : "passed",
          title: "CSS validation",
          headline,
          detail: needsAttention
            ? "The local parser stopped at the first invalid syntax it encountered."
            : "The local syntax parser completed without contacting an external service.",
          total: errors.length,
          shown: errors.length,
          truncated: false,
          counts: [metric("syntax_errors", "Syntax errors", errors.length, "error")],
          ...(needsAttention ? { next_action: "Correct the syntax error, then run CSS validation again." } : {}),
        };
        return {
          structuredContent: { errors, overview },
          content: contentForOverview(
            overview,
            errors.map((message) => ({
              severity: "error" as const,
              message: message.message,
              line: message.line || undefined,
            })),
          ),
        };
    } catch (cause) {
      console.error("Local CSS validation failed:", cause instanceof Error ? cause.message : "Unknown error");
      const error = "CSS validation is temporarily unavailable. Please try again shortly.";
      const overview = failedOverview("css", "CSS validation", "CSS validation could not be completed.", error);
      return {
        structuredContent: { errors: [], overview, error },
        content: contentForOverview(overview),
        isError: true,
      };
    }
    },
  );

  registerAppTool(
    server,
    "audit_seo_metadata",
    {
      title: "Audit SEO metadata",
      description:
        "Use this for a focused SEO/accessibility-signal check of supplied HTML. It does not fetch a live webpage; use audit_public_webpage for a URL.",
      inputSchema: { html: htmlInput },
      outputSchema: auditResultSchema,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({ invoking: "Auditing SEO metadata…", invoked: "SEO audit complete." }),
    },
    async ({ html }) => {
      try {
        const result = auditSeoMetadata(html);
        const counts = {
          errors: result.counts.error,
          warnings: result.counts.warning,
          info: result.counts.info,
        };
        const needsAttention = counts.errors > 0 || counts.warnings > 0;
        const nextAction = reportNextAction(counts.errors, counts.warnings, "run the SEO audit again");
        const headline = needsAttention
          ? `SEO audit found ${summarizeSeverities(counts)}.`
          : result.total > 0
            ? `SEO metadata and accessibility checks passed with ${plural(counts.info, "informational note")}.`
            : "SEO metadata and accessibility checks passed with no actionable issues.";
        const overview: ResultOverview = {
          kind: "seo",
          status: needsAttention ? "needs_attention" : "passed",
          title: "SEO metadata audit",
          headline,
          detail: result.truncated
            ? `${plural(result.total, "finding")} identified; showing the first ${result.issues.length}.`
            : `${plural(result.total, "finding")} identified across SEO and accessibility checks.`,
          total: result.total,
          shown: result.issues.length,
          truncated: result.truncated,
          counts: [
            metric("errors", "Errors", counts.errors, "error"),
            metric("warnings", "Warnings", counts.warnings, "warning"),
            metric("notes", "Notes", counts.info, "info"),
          ],
          ...(nextAction ? { next_action: nextAction } : {}),
        };
        return {
          structuredContent: {
            issues: result.issues,
            total_issues: result.total,
            truncated: result.truncated,
            overview,
          },
          content: contentForOverview(overview, auditFindings(result.issues)),
        };
      } catch (cause) {
        console.error("Local SEO audit failed:", cause instanceof Error ? cause.message : "Unknown error");
        const error = "The SEO metadata audit could not be completed. Please try again shortly.";
        const overview = failedOverview("seo", "SEO metadata audit", "SEO audit could not be completed.", error);
        return {
          structuredContent: { issues: [], total_issues: 0, truncated: false, overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "validate_schema_markup",
    {
      title: "Validate JSON-LD syntax",
      description: "Use this for a focused JSON-LD syntax check of supplied HTML. It parses JSON only and does not validate Schema.org vocabulary semantics.",
      inputSchema: { html: htmlInput },
      outputSchema: { ...auditResultSchema, blocks_checked: z.number().int().nonnegative() },
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({ invoking: "Checking JSON-LD…", invoked: "JSON-LD check complete." }),
    },
    async ({ html }) => {
      try {
        const result = validateSchemaMarkup(html);
        const counts = {
          errors: result.counts.error,
          warnings: result.counts.warning,
          info: result.counts.info,
        };
        const needsAttention = counts.errors > 0 || counts.warnings > 0;
        const noBlocks = result.blocksChecked === 0;
        const headline = noBlocks
          ? "No JSON-LD blocks were found in the supplied HTML."
          : needsAttention
            ? `JSON-LD syntax check found ${summarizeSeverities(counts)} in ${plural(result.blocksChecked, "block")}.`
            : result.blocksChecked === 1
              ? "The JSON-LD block contains valid JSON syntax."
              : `All ${result.blocksChecked} JSON-LD blocks contain valid JSON syntax.`;
        const overview: ResultOverview = {
          kind: "schema",
          status: noBlocks ? "not_applicable" : needsAttention ? "needs_attention" : "passed",
          title: "JSON-LD syntax check",
          headline,
          detail: result.truncated
            ? `${plural(result.total, "finding")} identified; showing the first ${result.issues.length}. This check validates JSON syntax only.`
            : "This check validates JSON syntax only; it does not validate schema.org vocabulary or eligibility.",
          total: result.total,
          shown: result.issues.length,
          truncated: result.truncated,
          counts: [
            metric(
              "valid_blocks",
              "Valid blocks",
              Math.max(0, result.blocksChecked - counts.errors - counts.warnings),
              "success",
            ),
            metric("errors", "Errors", counts.errors, "error"),
            metric("warnings", "Warnings", counts.warnings, "warning"),
          ],
          ...(needsAttention ? { next_action: "Correct invalid or empty JSON-LD blocks, then run the syntax check again." } : {}),
        };
        return {
          structuredContent: {
            issues: result.issues,
            total_issues: result.total,
            truncated: result.truncated,
            blocks_checked: result.blocksChecked,
            overview,
          },
          content: contentForOverview(overview, auditFindings(result.issues)),
        };
      } catch (cause) {
        console.error("Local JSON-LD check failed:", cause instanceof Error ? cause.message : "Unknown error");
        const error = "The JSON-LD syntax check could not be completed. Please try again shortly.";
        const overview = failedOverview("schema", "JSON-LD syntax check", "JSON-LD check could not be completed.", error);
        return {
          structuredContent: {
            issues: [],
            total_issues: 0,
            truncated: false,
            blocks_checked: 0,
            overview,
            error,
          },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "check_broken_links",
    {
      title: "Check public links",
      description:
        `Use this for a focused check of up to ${HOSTED_MAX_LINKS} public HTTP(S) links found in supplied HTML. It does not fetch base_url, follow redirects, or retain response bodies.`,
      inputSchema: {
        html: htmlInput,
        base_url: z
          .string()
          .url()
          .optional()
          .describe("Only resolves relative links; it does not fetch this webpage."),
        max_links: z
          .number()
          .int()
          .min(1)
          .max(HOSTED_MAX_LINKS)
          .default(15)
          .describe(`Maximum links to check, from 1 to ${HOSTED_MAX_LINKS}.`),
      },
      outputSchema: {
        links: z.array(linkStatusSchema),
        links_checked: z.number().int().nonnegative(),
        eligible_links: z.number().int().nonnegative(),
        links_truncated: z.boolean(),
        healthy_links: z.number().int().nonnegative(),
        redirects: z.number().int().nonnegative(),
        unreachable_links: z.number().int().nonnegative(),
        unverified_links: z.number().int().nonnegative(),
        overview: overviewSchema,
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthWidget({ invoking: "Checking public links…", invoked: "Link check complete." }),
    },
    async ({ html, base_url, max_links }) => {
      try {
        const { links, eligibleLinks, truncated } = await checkBrokenLinksDetailed(html, base_url, max_links);
        const counts = linkCounts(links);
        const needsAttention = counts.redirects > 0 || counts.unreachable > 0;
        const headline = counts.checked === 0
          ? "No eligible public HTTP(S) links were found to check."
          : `Checked ${plural(counts.checked, "link")}: ${plural(counts.healthy, "healthy link")}, ${plural(counts.redirects, "redirect")}, and ${plural(counts.unreachable, "unreachable link")}${counts.unverified > 0 ? `; ${plural(counts.unverified, "check")} unverified` : ""}.`;
        const overview: ResultOverview = {
          kind: "links",
          status: counts.checked === 0 ? "not_applicable" : counts.unverified > 0 || truncated ? "partial" : needsAttention ? "needs_attention" : "passed",
          title: "Public link check",
          headline,
          detail: counts.checked === 0
            ? "Only eligible public HTTP(S) links are checked; fragments and non-web links are skipped."
            : `${truncated ? `${counts.checked} of ${eligibleLinks} eligible links checked; remaining links were not checked. ` : ""}Redirects are reported but not followed, and response bodies are not downloaded.`,
          total: eligibleLinks,
          shown: links.length,
          truncated,
          counts: [
            metric("checked", "Checked", counts.checked, "info"),
            metric("healthy", "Healthy", counts.healthy, "success"),
            metric("redirects", "Redirects", counts.redirects, "warning"),
            metric("unreachable", "Unreachable", counts.unreachable, "error"),
            ...(counts.unverified > 0 ? [metric("unverified", "Unverified", counts.unverified, "warning")] : []),
          ],
          ...(needsAttention || counts.unverified > 0 || truncated
            ? { next_action: counts.unreachable > 0
              ? "Fix unreachable links first, then confirm that each redirect is intentional."
              : counts.unverified > 0
                ? "Review access restrictions and retry rate-limited or failed checks later; unverified does not prove a broken destination."
                : truncated
                  ? "Check the remaining links separately; the current result covers only the first bounded set."
                : "Confirm that each redirect is intentional and points to the preferred destination." }
            : {}),
        };
        const findings = links.flatMap<PresentableFinding>((link): PresentableFinding[] => {
          if (!link.ok) {
            return [{
              severity: isUnverifiedLinkStatus(link.status) ? "warning" as const : "error" as const,
              message: `${link.url} — ${link.message ?? `returned status ${link.status}`}`,
              label: String(link.status),
            }];
          }
          if (isHttpRedirectStatus(link.status)) {
            return [{
              severity: "warning" as const,
              message: `${link.url} returned redirect status ${link.status}; the redirect was not followed.`,
              label: String(link.status),
            }];
          }
          return [];
        });
        return {
          structuredContent: {
            links,
            links_checked: counts.checked,
            eligible_links: eligibleLinks,
            links_truncated: truncated,
            healthy_links: counts.healthy,
            redirects: counts.redirects,
            unreachable_links: counts.unreachable,
            unverified_links: counts.unverified,
            overview,
          },
          content: contentForOverview(overview, findings),
        };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : "Link checking could not be completed.";
        const overview = failedOverview("links", "Public link check", "Link checking could not be completed.", error);
        return {
          structuredContent: {
            links: [],
            links_checked: 0,
            eligible_links: 0,
            links_truncated: false,
            healthy_links: 0,
            redirects: 0,
            unreachable_links: 0,
            unverified_links: 0,
            overview,
            error,
          },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "generate_validation_report",
    {
      title: "Generate validation report",
      description:
        "Use this when HTML markup is already supplied. Combines Nu HTML validation with local CSS, SEO, accessibility-signal, and JSON-LD syntax checks. It does not fetch a webpage from base_url; use audit_public_webpage for a live URL.",
      inputSchema: {
        html: htmlInput,
        css: z
          .string()
          .max(CSS_MAX_LENGTH)
          .optional()
          .describe("Optional raw CSS source. Linked stylesheets are not fetched."),
        check_links: z
          .boolean()
          .default(false)
          .describe("Whether to contact eligible public links found in the supplied HTML."),
        base_url: z
          .string()
          .url()
          .optional()
          .describe("Only resolves relative links when check_links is true; it does not fetch this webpage."),
        max_links: z
          .number()
          .int()
          .min(1)
          .max(HOSTED_MAX_LINKS)
          .default(15)
          .describe(`Maximum links to check, from 1 to ${HOSTED_MAX_LINKS}.`),
      },
      outputSchema: reportOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthWidget({ invoking: "Generating validation report…", invoked: "Validation report complete." }),
    },
    async ({ html, css, check_links, base_url, max_links }) => runValidationReport({
      html,
      css,
      checkLinks: check_links,
      baseUrl: base_url,
      maxLinks: max_links,
      title: "Validation report",
    }),
  );

  registerAppTool(
    server,
    "audit_public_webpage",
    {
      title: "Audit public webpage",
      description:
        "Use this when the user provides one live public webpage URL. Fetches one bounded static HTML response, then runs HTML validation, SEO/accessibility-signal, and JSON-LD syntax checks. It checks links only when requested and does not crawl, execute JavaScript, authenticate, or fetch linked stylesheets. Use only URLs the user owns or is authorized to inspect.",
      inputSchema: {
        url: publicPageUrlInput,
        check_links: z
          .boolean()
          .default(false)
          .describe("Whether to contact eligible public links found on the fetched page."),
        max_links: z
          .number()
          .int()
          .min(1)
          .max(HOSTED_MAX_LINKS)
          .default(15)
          .describe(`Maximum links to check, from 1 to ${HOSTED_MAX_LINKS}.`),
      },
      outputSchema: {
        ...reportOutputSchema,
        requested_url: z.string().optional(),
        fetched_url: z.string().optional(),
        redirects_followed: z.number().int().min(0).max(3).optional(),
        http_status: z.number().int().min(200).max(299).optional(),
        content_type: z.enum(["text/html", "application/xhtml+xml"]).optional(),
        page_fetched: z.boolean(),
      },
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Fetching and auditing webpage…",
        invoked: "Public webpage audit complete.",
      }),
    },
    async ({ url, check_links, max_links }) => {
      try {
        const fetched = await fetchPublicHtml(url);
        const report = await runValidationReport({
          html: fetched.html,
          htmlMediaType: fetched.contentType,
          checkLinks: check_links,
          baseUrl: fetched.finalUrl,
          xRobotsTag: fetched.xRobotsTag,
          maxLinks: max_links,
          title: "Public webpage audit",
          sourceDetail: fetched.redirectsFollowed > 0
            ? `Audited ${fetched.finalUrl} after ${plural(fetched.redirectsFollowed, "redirect")}.`
            : `Audited ${fetched.finalUrl}.`,
        });
        return {
          ...report,
          structuredContent: {
            ...report.structuredContent,
            requested_url: fetched.requestedUrl,
            fetched_url: fetched.finalUrl,
            redirects_followed: fetched.redirectsFollowed,
            http_status: fetched.status,
            content_type: fetched.contentType,
            page_fetched: true,
          },
        };
      } catch (cause) {
        const code = cause instanceof PublicHtmlFetchError ? cause.code : "audit_failed";
        console.error(JSON.stringify({ event: "public_webpage_audit_failed", code }));
        const error = cause instanceof PublicHtmlFetchError
          ? cause.message
          : "The public webpage audit could not be completed. Please try again shortly.";
        return failedPublicPageAudit(error, check_links);
      }
    },
  );

  registerAppTool(
    server,
    "audit_public_site",
    {
      title: "Audit public site",
      description:
        `Use this for a bounded, sitemap-first audit of a public website the user owns or is authorized to inspect. It fetches at most ${SITE_AUDIT_MAX_PAGES} same-origin HTML pages per call, respects robots.txt, and returns compact page summaries plus deduplicated findings, a sampled canonical/noindex graph, same-language duplicate main-content pairs, evidence-limited empty/short/repeated-boilerplate main-text review, and 16-locale hreflang/canonical clusters. Content quality results are static-text review signals, not usefulness or Google ranking verdicts. Unvisited alternate targets remain unverified; use the local site.hreflang tool with supplied HTML for up to 16 pages. It does not recursively follow HTML links, authenticate, execute JavaScript, fetch assets, or run site-wide link checks. To continue a batch, pass both the returned page offset and discovery fingerprint; changed sitemaps require restarting at offset 0.`,
      inputSchema: {
        site_url: publicPageUrlInput.describe("Authorized public website URL. The final public origin becomes the crawl boundary."),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(SITE_AUDIT_MAX_PAGES)
          .default(SITE_AUDIT_DEFAULT_MAX_PAGES)
          .describe(`Maximum same-origin pages to audit in this call, from 1 to ${SITE_AUDIT_MAX_PAGES}.`),
        page_offset: z
          .number()
          .int()
          .min(0)
          .max(SITE_AUDIT_MAX_SITEMAP_URLS)
          .default(0)
          .describe("Zero-based sitemap-page offset for continuing a capped audit batch."),
        expected_discovery_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
          .describe("Fingerprint from the first batch. Required when page_offset > 0 to reject sitemap drift."),
      },
      outputSchema: siteAuditOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Discovering and auditing public sitemap pages…",
        invoked: "Public site audit complete.",
      }),
    },
    async ({ site_url, max_pages, page_offset, expected_discovery_fingerprint }) => {
      try {
        const rateLimit = await env.SITE_AUDIT_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
        if (!rateLimit.success) {
          return failedPublicSiteAudit("Site audits are temporarily rate limited. Please retry shortly.");
        }
      } catch {
        return failedPublicSiteAudit("Site auditing is temporarily unavailable. Please retry shortly.");
      }

      try {
        const result = await auditPublicSite({
          siteUrl: site_url,
          maxPages: max_pages,
          pageOffset: page_offset,
          expectedDiscoveryFingerprint: expected_discovery_fingerprint,
        });
        const overview = siteAuditOverview(result);
        return {
          structuredContent: { ...result, overview },
          content: contentForOverview(overview, [
            ...siteAuditFindings(result.issue_groups),
            ...result.indexability_graph.findings.map((finding) => ({
              severity: finding.severity,
              label: "Indexability",
              message: finding.message,
            })),
            ...result.content_duplicates.pairs.map((pair) => ({
              severity: "warning" as const,
              label: "Main content",
              message: `${pair.kind === "exact" ? "Exact" : "Near"} same-language duplicate (${pair.similarity_percent}%, ${pair.language}): ${pair.first_url} and ${pair.second_url}. Static sample only.`,
            })),
            ...result.content_quality.findings.map((finding) => ({
              severity: finding.severity,
              label: "Content quality",
              message: finding.message,
            })),
            ...result.multilingual_clusters.findings.map((finding) => ({
              severity: finding.severity,
              label: "Multilingual",
              message: finding.message,
            })),
          ]),
        };
      } catch (cause) {
        const isContinuationError = cause instanceof Error && (
          cause.message.startsWith("Stale site audit continuation:")
          || cause.message.startsWith("Invalid site audit continuation:")
        );
        const error = cause instanceof PublicHtmlFetchError || isContinuationError
          ? cause.message
          : "The public site audit could not be completed. Please try again shortly.";
        console.error(JSON.stringify({
          event: "public_site_audit_failed",
          code: cause instanceof PublicHtmlFetchError ? cause.code : "audit_failed",
        }));
        return failedPublicSiteAudit(error);
      }
    },
  );

  registerAppTool(
    server,
    "preview_regression_alerts",
    {
      title: "Preview configurable regression alerts (manual dry-run only)",
      description:
        "Fully offline P2-02 MANUAL alert preview for two to ten caller-supplied historical audit snapshots. Configurable sampled-page regression, net error/warning thresholds and up to four consecutive comparable regression steps. Incomplete coverage and changed sitemap are review-only; incomplete or ambiguous defect evidence is suppressed. Output is a preview, NOT a sent notification. No scheduler, network fetch, stored state, webhook, email, Google Search Console or Analytics integration.",
      inputSchema: {
        versions: historicalVersionsInputSchema
          .describe("Two to ten already-observed timestamped compact site-audit snapshots, oldest first; no URLs are fetched and no history is stored."),
        dry_run: z.literal(true).default(true)
          .describe("Must remain true; no delivery, automatic polling or schedules exist."),
        policy: monitorPolicyInputSchema.optional()
          .describe("Bounded manual-only rule thresholds; no destination addresses or automation settings are accepted."),
      },
      outputSchema: monitorOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Simulating regression alert rules without sending...",
        invoked: "Dry-run regression preview complete; no alerts sent.",
      }),
    },
    async ({ versions, policy }) => {
      try {
        const history = analyzeHistoricalAudits(versions, "caller_supplied_snapshots");
        const preview = previewRegressionAlerts(history, policy);
        const overview: ResultOverview = {
          kind: "site",
          status: preview.candidate_count > 0 ? "needs_attention" : "partial",
          title: "Unsent manual regression alert preview",
          headline: preview.candidate_count + " unsent alert candidate(s), " +
            preview.review_only_count + " review-only observation(s), " +
            preview.suppressed_count + " suppressed rule(s) from the latest " +
            preview.latest_completed_pairs + " completed matched page pair(s).",
          detail: "Manual dry-run only. No notifications, email/webhook, background scheduler, " +
            "source fetch, storage or external analytics. A zero-candidate result is not a full-site health verdict.",
          total: preview.rules.length,
          shown: preview.rules.length,
          truncated: false,
          counts: [
            metric("candidates", "Unsent candidate alerts", preview.candidate_count, "warning"),
            metric("review_only", "Coverage/discovery reviews", preview.review_only_count, "info"),
            metric("suppressed", "Suppressed uncertain rules", preview.suppressed_count, "info"),
            metric("complete_pages", "Comparable latest page pairs", preview.latest_completed_pairs, "info"),
          ],
          next_action: "Manually verify matched fully checked source pages and policy thresholds. " +
            "No automated notifications or live monitoring are enabled; do not infer traffic, rankings or sitewide results.",
        };
        return {
          structuredContent: { ...preview, overview },
          content: contentForOverview(overview, preview.rules
            .filter((rule) => rule.review_required)
            .map((rule) => ({
              severity: rule.decision === "preview_candidate" ? "warning" as const : "info" as const,
              label: rule.rule + " (not sent)",
              message: rule.message,
            }))),
        };
      } catch {
        const error = "Manual monitoring preview could not safely evaluate the supplied historical versions, chronology or bounded policy; no messages were sent.";
        const overview = failedOverview("site", "Regression alert dry-run",
          "The manual-only preview could not be evaluated.", error);
        return {
          structuredContent: { ...emptyMonitorPreview("caller_supplied_snapshots"), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "compare_historical_audits",
    {
      title: "Compare two to ten supplied site audit versions",
      description:
        "Pure, offline historical trends for 2–10 supplied timestamped compact audit_public_site results in oldest-first order. Compares adjacent and first/last observations and error/warning trends for the exact page cohort fully checked in every version. Distinguishes coverage loss from improvements and gates disappearing issue groups on fully checked identical sitemap samples. No hosted storage, saved IDs, scheduled monitoring, network requests, raw site URLs/messages, or ranking/indexing assertions.",
      inputSchema: {
        versions: historicalVersionsInputSchema.describe(
          "Two to ten caller-supplied timestamped compact site-audit results, oldest first; <=60 KB each and 610 KB combined. Hosted service never reads a local archive or stores versions.",
        ),
      },
      outputSchema: historicalOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Comparing historical audit snapshots...",
        invoked: "Historical comparison complete.",
      }),
    },
    async ({ versions }) => {
      try {
        const review = analyzeHistoricalAudits(versions, "caller_supplied_snapshots");
        const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
        const overview: ResultOverview = {
          kind: "site",
          status: warnings ? "needs_attention" : "partial",
          title: "Historical site-audit trends",
          headline: review.versions_compared + " supplied versions and " +
            review.comparisons_made + " consecutive comparisons: " +
            review.comparable_transitions + " comparable, " +
            review.partial_transitions + " partial and " +
            review.not_comparable_transitions + " nonoverlapping transitions.",
          detail: review.total_regressed_page_transitions + " regressed and " +
            review.total_improved_page_transitions + " improved fully checked page transitions; " +
            review.total_coverage_lost_transitions + " observed coverage losses. " +
            review.complete_stable_cohort_pages +
            " pages have full checks in every version. Not a website-wide or Google canonical/ranking conclusion.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("versions", "Supplied versions", review.versions_compared, "info"),
            metric("stable_cohort", "Consistently completed pages", review.complete_stable_cohort_pages, "info"),
            metric("regressions", "Sampled page regressions", review.total_regressed_page_transitions, "warning"),
            metric("improvements", "Sampled page improvements", review.total_improved_page_transitions, "info"),
            metric("coverage_lost", "Lost checks", review.total_coverage_lost_transitions, "warning"),
          ],
          next_action: "Review comparable page-cohort evidence and re-audit missing checks. Only fully observed matched pages support changes; disappearance of a finding under partial coverage is not proof of repair.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code + " (version " + finding.version + ")",
            message: finding.message,
          }))),
        };
      } catch {
        const error = "Historical snapshots cannot be safely compared within origin, chronology, page-coverage or evidence size limits.";
        const overview = failedOverview("site", "Historical site-audit trends",
          "The supplied historical evidence could not be compared.", error);
        return {
          structuredContent: { ...emptyHistoricalReview("caller_supplied_snapshots"), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "compare_site_audits",
    {
      title: "Compare site audit snapshots",
      description:
        "Compare the structured results of two earlier audit_public_site runs entirely offline. Identify changed page issue counts, unavailable checks, sitemap drift, and newly/no-longer observed grouped findings only within the same fully checked selected-page sample (not site-wide). This is not a Google indexing, ranking, or traffic-causality test. No webpages are fetched and results are not stored.",
      inputSchema: {
        baseline: siteAuditSnapshotSchema.describe("Earlier structuredContent from audit_public_site, without editing its page list."),
        current: siteAuditSnapshotSchema.describe("Later structuredContent from audit_public_site, ideally the same sitemap batch."),
      },
      outputSchema: siteComparisonOutputSchema,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Comparing site audit snapshots…",
        invoked: "Site audit comparison complete.",
      }),
    },
    async ({ baseline, current }) => {
      const comparison = compareSiteAudits(baseline, current);
      const actionable = comparison.regressed_pages + comparison.coverage_lost_pages
        + comparison.newly_observed_issue_groups.length + comparison.expanding_issue_groups.length;
      const status: ResultOverview["status"] = comparison.status === "not_comparable"
        ? "failed"
        : comparison.status === "partial"
          ? "partial"
          : actionable > 0 ? "needs_attention" : "passed";
      const overview: ResultOverview = {
        kind: "site",
        status,
        title: "Site audit comparison",
        headline: comparison.status === "not_comparable"
          ? "These site audit snapshots cannot be compared safely."
          : comparison.status === "partial"
            ? `Compared ${plural(comparison.pages_compared, "matching page")} with coverage limitations; missing findings are not proven fixes.`
            : actionable > 0
              ? `Comparison found ${plural(comparison.regressed_pages, "regressed page")} and ${plural(comparison.newly_observed_issue_groups.length, "newly observed issue group")}.`
              : "No new issues were observed across these comparable audit snapshots.",
        detail: "This compares recorded static-page audit evidence only. It does not establish Google indexing, ranking changes, or the cause of a traffic change.",
        total: comparison.page_changes.length,
        shown: comparison.page_changes.length,
        truncated: false,
        counts: [
          metric("pages_compared", "Pages compared", comparison.pages_compared, "info"),
          metric("regressed_pages", "Regressed pages", comparison.regressed_pages, "error"),
          metric("mixed_pages", "Mixed changes", comparison.mixed_pages, "warning"),
          metric("coverage_lost", "Coverage lost", comparison.coverage_lost_pages, "warning"),
          metric("new_issue_groups", "New issue groups", comparison.newly_observed_issue_groups.length, "error"),
        ],
        ...(comparison.status !== "comparable"
          ? { next_action: comparison.limitations.join(" ") }
          : actionable > 0
            ? { next_action: "Review affected URLs and newly observed findings, fix verified defects, then rerun the same site audit." }
            : { next_action: "Keep the current snapshot as the new comparison baseline after reviewing the change evidence." }),
      };
      return {
        structuredContent: { ...comparison, overview },
        content: contentForOverview(
          overview,
          comparison.newly_observed_issue_groups.map((group) => ({
            severity: group.severity,
            label: group.category,
            message: group.message,
          })),
        ),
      };
    },
  );

  registerAppTool(
    server,
    "verify_product_claims",
    {
      title: "Verify product claims against registered hosted MCP tools",
      description:
        "Compare visible explicit ChatGPT-tool promises and bounded site-batch claims from authorized landing-page HTML or a single public URL against this Worker runtime's actually registered MCP tool names, input bounds, and read-only annotations. This is registry consistency, not proof that every tool call succeeds or that arbitrary marketing copy is true. No login, browser rendering or site-wide crawl.",
      inputSchema: {
        html: z.string().min(1).max(MAX_PRODUCT_CLAIM_HTML_BYTES).optional()
          .describe("Static landing-page HTML, at most 250,000 UTF-8 bytes. Supply this or public_url, not both."),
        public_url: z.string().url().max(512)
          .refine((value) => Boolean(safeObservedUrl(value)),
            "Use a public HTTP(S) URL without credentials, query parameters or fragments.").optional()
          .describe("Alternative to HTML: one authorized public landing page, using the existing safe single-page fetch."),
      },
      outputSchema: productClaimSchema.shape,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Checking documented tool promises…",
        invoked: "Product claim comparison complete.",
      }),
    },
    async ({ html, public_url }) => {
      try {
        if (Boolean(html) === Boolean(public_url)) {
          throw new Error("Provide exactly one HTML document or public landing-page URL.");
        }
        const text = html ?? (await fetchPublicHtml(public_url!, {})).html;
        const catalog = registeredToolEvidence(
          (server as unknown as { _registeredTools?: unknown })._registeredTools,
          (schema) => z.toJSONSchema(schema as z.ZodType),
        );
        const analysis = compareProductClaims(observeProductClaims(text), catalog, "hosted");
        const overview: ResultOverview = {
          kind: "report",
          status: analysis.contradicted_claims > 0
            ? "needs_attention" : analysis.coverage_limited ? "partial" : "passed",
          title: "Product promises versus registered MCP capabilities",
          headline: analysis.checked_claims
            ? analysis.consistent_claims + " promises consistent with the registered hosted tools; "
              + analysis.contradicted_claims + " contradicted and " + analysis.unverified_claims + " unverified."
            : "No explicit hosted capability promises could be verified in this page sample.",
          detail: "Compares visible explicit claims against this runtime's tools/list registration metadata, not the result of executing each tool or the semantic truth of arbitrary marketing language.",
          total: analysis.checked_claims,
          shown: analysis.findings.length,
          truncated: analysis.findings_truncated || analysis.coverage_limited,
          counts: [
            metric("claims_checked", "Promises checked", analysis.checked_claims, "info"),
            metric("registry_consistent", "Registry consistent", analysis.consistent_claims, "success"),
            metric("contradicted", "Registry conflicts", analysis.contradicted_claims, "error"),
            metric("unverified", "Unverified promises", analysis.unverified_claims, "warning"),
          ],
          next_action: analysis.contradicted_claims > 0
            ? "Reconcile listed tools and numeric limits with the current MCP registry, then invoke affected tools before changing product copy."
            : "Use functional MCP canaries to verify behavior; registry consistency alone cannot prove successful execution.",
        };
        return {
          structuredContent: { ...analysis, overview },
          content: contentForOverview(overview,
            analysis.findings.map((finding) => ({
              severity: finding.severity,
              label: finding.claim,
              message: finding.message,
            }))),
        };
      } catch {
        const error = "Product claims could not be compared within the public URL and input limits.";
        const overview = failedOverview("report", "Product promise verification",
          "Product promises could not be verified.", error);
        return {
          structuredContent: {
            ...compareProductClaims({
              hasMain: false, hostedSectionFound: false, localSectionFound: false,
              hostedTools: [], localTools: [], localScreenshotClaim: false,
              hostedReadOnlyClaim: false, hostedNoScreenshotsClaim: false,
              extractionTruncated: false,
            }, [], "hosted"),
            overview, error,
          },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "verify_content_provenance",
    {
      title: "Verify citation, dataset freshness and methodology evidence",
      description:
        "Compare up to eight already-supplied static HTML pages with optional caller-supplied citation, dataset and methodology metadata. Verify explicit URL/ID agreement, dataset versions and as-of dates, publication chronology, and only caller-defined freshness windows. The Worker does not fetch sources, datasets or pages, and missing evidence is unverified rather than a fabricated factual verdict.",
      inputSchema: {
        pages: z.array(z.object({
          url: provenanceUrlSchema.describe("Safe public-style URL label only; never fetched."),
          htmlContent: z.string().min(1).max(MAX_PROVENANCE_HTML_BYTES)
            .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_PROVENANCE_HTML_BYTES,
              "Each page is limited to 200,000 UTF-8 bytes."),
        })).min(1).max(8)
          .describe("One to eight authorized static HTML page observations, combined cap 1 MB."),
        evidence: provenanceManifestSchema.optional()
          .describe("Optional caller-provided source URLs and dataset/method metadata; not independently fact-checked."),
      },
      outputSchema: provenanceOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Checking source and methodology evidence...",
        invoked: "Provenance evidence comparison complete.",
      }),
    },
    async ({ pages, evidence }) => {
      try {
        if (pages.reduce((total, page) => total + new TextEncoder().encode(page.htmlContent).byteLength, 0)
          > MAX_PROVENANCE_INPUT_BYTES) throw new Error("Combined HTML input too large.");
        const analysis = analyzeProvenance(pages.map(({ url, htmlContent }) =>
          observeProvenancePage(htmlContent, url)), evidence ?? {});
        const overview: ResultOverview = {
          kind: "report",
          status: analysis.conflicting_declarations > 0
            ? "needs_attention" : analysis.coverage_limited ? "partial" : "passed",
          title: "Citation, dataset freshness and methodology consistency",
          headline: analysis.consistent_declarations + " evidence agreements, "
            + analysis.conflicting_declarations + " discrepancies and "
            + analysis.unverified_declarations + " unverified declarations.",
          detail: "Compared explicit static HTML declarations with optional caller-supplied metadata across "
            + analysis.pages_eligible + "/" + analysis.pages_sampled
            + " eligible pages. This does not independently retrieve or authenticate external sources.",
          total: analysis.checked_declarations,
          shown: analysis.findings.length,
          truncated: analysis.findings_truncated || analysis.coverage_limited,
          counts: [
            metric("citations_observed", "Citations", analysis.citations_observed, "info"),
            metric("datasets_observed", "Dataset claims", analysis.datasets_observed, "info"),
            metric("consistent_evidence", "Agreements", analysis.consistent_declarations, "success"),
            metric("conflicting_evidence", "Discrepancies", analysis.conflicting_declarations, "warning"),
            metric("unverified_evidence", "Unverified", analysis.unverified_declarations, "warning"),
          ],
          next_action: "Inspect discrepancies and confirm source publication, dataset release and methodology independently; no actual remote-source validity was checked.",
        };
        return {
          structuredContent: { ...analysis, overview },
          content: contentForOverview(overview, analysis.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code,
            message: finding.message,
          }))),
        };
      } catch {
        const error = "Provenance evidence could not be compared within its bounded supplied HTML input.";
        const overview = failedOverview("report", "Provenance evidence comparison",
          "Source evidence could not be assessed.", error);
        return {
          structuredContent: { ...analyzeProvenance([], {}), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "compare_competitor_intent",
    {
      title: "Compare supplied competitor search-intent signals",
      description:
        "Bounded offline analysis of one primary and up to six caller-supplied competitor HTML pages. Compares explicit static informational/commercial/transactional/navigational signals and optional caller-selected intent or lexical query-heading overlap. No page, competitor, SERP, GSC or ranking requests; not a semantic SEO verdict.",
      inputSchema: {
        primary: intentPageInputSchema
          .describe("Primary static HTML observation; the URL is a label, never fetched."),
        competitors: z.array(intentPageInputSchema).min(1).max(6)
          .describe("One to six caller-authorized competitor observations with distinct origins; none are fetched."),
        expected_intent: z.enum(["informational", "commercial", "transactional", "navigational"])
          .optional().describe("Optional target intent selected by the caller, not inferred by the model or the query."),
        query: z.string().trim().min(1).max(MAX_INTENT_QUERY_BYTES)
          .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_INTENT_QUERY_BYTES,
            "Query cannot exceed 160 UTF-8 bytes.")
          .optional().describe("Optional caller-supplied query for exact normalized heading-token overlap; not echoed."),
      },
      outputSchema: competitorIntentOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Comparing sampled competitor intent signals...",
        invoked: "Competitor intent evidence comparison complete.",
      }),
    },
    async ({ primary, competitors, expected_intent, query }) => {
      try {
        const total = [primary, ...competitors].reduce((bytes, item) =>
          bytes + new TextEncoder().encode(item.htmlContent).byteLength, 0);
        if (total > MAX_INTENT_TOTAL_BYTES) throw new Error("Combined input is over the bound.");
        const analysis = compareIntentObservations(
          observeIntentHtml(primary.htmlContent, primary.url),
          competitors.map((item) => observeIntentHtml(item.htmlContent, item.url)),
          { expectedIntent: expected_intent, query },
        );
        const overview: ResultOverview = {
          kind: "report",
          status: analysis.findings.some((f) => f.severity === "warning")
            ? "needs_attention" : "partial",
          title: "Sampled competitor search-intent signals",
          headline: analysis.competitors_eligible + " supplied competitors compared; "
            + analysis.total_findings + " review leads from static markup.",
          detail: "Only explicit HTML/JSON-LD and lexical title/H1 signals are checked. These are not a classification of search intent, organic rankings or search-engine demand.",
          total: analysis.competitors_submitted,
          shown: analysis.competitors_eligible,
          truncated: analysis.coverage_limited,
          counts: [
            metric("competitors", "Competitor pages", analysis.competitors_eligible, "info"),
            metric("intent_signals", "Competitors with chosen intent signals",
              analysis.competitors_with_intent_signals, "info"),
            metric("review_findings", "Review leads", analysis.total_findings, "warning"),
          ],
          next_action: "Review flagged page elements and verify page purpose and search performance independently with authorized data.",
        };
        return {
          structuredContent: { ...analysis, overview },
          content: contentForOverview(overview,
            analysis.findings.map((finding) => ({
              severity: finding.severity,
              label: finding.code,
              message: finding.message,
            }))),
        };
      } catch {
        const error = "Competitor intent signals could not be compared within the authorized static input and distinct-origin limits.";
        const overview = failedOverview("report", "Competitor intent evidence",
          "Competitor comparison could not be completed.", error);
        return {
          structuredContent: { ...emptyIntentComparison(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "validate_supported_schema",
    {
      title: "Review supported Schema.org JSON-LD structures",
      description:
        "Bounded offline JSON-LD structure review for Article, NewsArticle, BlogPosting, Product, BreadcrumbList, FAQPage, Organization and WebSite. Reports limited property/profile findings without fetching remote contexts or validating rich-result eligibility. Existing validate_schema_markup remains the independent syntax-only check. Unknown types and contexts remain unverified.",
      inputSchema: {
        html: z.string().min(1).max(MAX_SUPPORTED_SCHEMA_HTML_BYTES)
          .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_SUPPORTED_SCHEMA_HTML_BYTES,
            "Static HTML must not exceed 250,000 UTF-8 bytes.")
          .describe("Caller-supplied HTML containing explicit JSON-LD scripts, 250 KB UTF-8 maximum; never fetched."),
      },
      outputSchema: supportedSchemaOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Reviewing supported JSON-LD structures...",
        invoked: "Supported JSON-LD structural review complete.",
      }),
    },
    async ({ html }) => {
      try {
        const analysis = reviewSupportedSchemaHtml(html);
        const overview: ResultOverview = {
          kind: "schema",
          status: analysis.errors > 0 || analysis.warnings > 0 ? "needs_attention" : "partial",
          title: "Supported JSON-LD structural review",
          headline: analysis.supported_nodes + " supported node profiles inspected; "
            + analysis.errors + " syntax/document errors, " + analysis.warnings +
            " review warnings and " + analysis.unverified + " unresolved signals.",
          detail: "Only a fixed JSON-LD subset and selected property shapes are reviewed across "
            + analysis.blocks_checked + "/" + analysis.blocks_seen
            + " supplied blocks. Google rich-result eligibility, truthful content, remote contexts and rankings are not assessed.",
          total: analysis.total_findings,
          shown: analysis.findings.length,
          truncated: analysis.findings_truncated || analysis.coverage_limited,
          counts: [
            metric("blocks_checked", "JSON-LD blocks inspected", analysis.blocks_checked, "info"),
            metric("supported_nodes", "Recognized profiles", analysis.supported_nodes, "success"),
            metric("syntax_errors", "Syntax/document errors", analysis.errors, "error"),
            metric("review_warnings", "Review warnings", analysis.warnings, "warning"),
            metric("unverified", "Unverified context/type signals", analysis.unverified, "info"),
          ],
          next_action: "Review the flagged fields and confirm eligibility and content relevance with official supported-type documentation and the Google Rich Results Test.",
        };
        return {
          structuredContent: { ...analysis, overview },
          content: contentForOverview(overview, analysis.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code,
            message: finding.message,
          }))),
        };
      } catch {
        const error = "Supported JSON-LD review could not complete within the bounded static input.";
        const overview = failedOverview("schema", "Supported JSON-LD structural review",
          "The supplied structured data could not be reviewed.", error);
        return {
          structuredContent: { ...reviewSupportedJsonLd([]), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_internal_links",
    {
      title: "Review sampled internal links and accessible anchor labels",
      description:
        "Offline, bounded analysis of 1-8 caller-supplied same-origin HTML pages. Looks at contextual same-origin links, missing accessible names, generic anchors, repeated target labels, internal nofollow, and lexical overlap with supplied target titles/H1. Unknown URLs remain unverified, not broken. No requests, crawls, search analytics, JavaScript or ranking inference.",
      inputSchema: {
        pages: z.array(internalLinkPageInputSchema).min(1).max(8)
          .describe("One to eight authorized same-origin static HTML page samples, distinct URL labels and combined limit 900,000 UTF-8 bytes; none are fetched."),
      },
      outputSchema: internalLinkOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Reviewing contextual internal link evidence...",
        invoked: "Sampled internal link review complete.",
      }),
    },
    async ({ pages }) => {
      try {
        const bytes = pages.reduce((total, p) =>
          total + new TextEncoder().encode(p.htmlContent).byteLength, 0);
        if (bytes > MAX_LINK_TOTAL_HTML_BYTES) throw new Error("Combined static HTML too large.");
        const analysis = reviewInternalLinks(pages.map(({ url, htmlContent }) =>
          observeInternalLinks(htmlContent, url)));
        const overview: ResultOverview = {
          kind: "report",
          status: analysis.missing_anchor_labels > 0 ? "needs_attention" : "partial",
          title: "Sampled contextual link and anchor evidence",
          headline: analysis.internal_links_observed + " internal main-content links, " +
            analysis.missing_anchor_labels + " without observed accessible names, " +
            analysis.generic_anchor_links + " generic labels.",
          detail: "Reviewed " + analysis.pages_sampled + " caller-supplied same-origin pages. " +
            analysis.unmatched_internal_links + " target links could not be checked against the supplied page set. " +
            "This is not live link checking, PageRank or semantic relevance.",
          total: analysis.internal_links_observed,
          shown: analysis.findings.length,
          truncated: analysis.findings_truncated || analysis.pages.some((p) => p.extraction_limited),
          counts: [
            metric("internal_links", "Contextual internal links", analysis.internal_links_observed, "info"),
            metric("sampled_targets", "Referenced sampled targets", analysis.linked_sample_targets, "info"),
            metric("missing_names", "Missing accessible names", analysis.missing_anchor_labels, "warning"),
            metric("generic_anchors", "Generic anchors", analysis.generic_anchor_links, "info"),
            metric("unverified_targets", "Unobserved targets", analysis.unmatched_internal_links, "info"),
          ],
          next_action: "Review on-page anchor context, accessible link names and target relevance; supply other authorized pages to expand sampled coverage. No destination was fetched.",
        };
        return {
          structuredContent: { ...analysis, overview },
          content: contentForOverview(overview,
            analysis.findings.map((finding) => ({
              severity: finding.severity,
              label: finding.code + " (page " + finding.source_page + ")",
              message: finding.message,
            }))),
        };
      } catch {
        const error = "Internal link review could not complete within the supplied HTML and same-origin limits.";
        const overview = failedOverview("report", "Contextual internal links",
          "Sampled link evidence could not be compared.", error);
        return {
          structuredContent: { ...emptyInternalLinkReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_metadata_consistency",
    {
      title: "Review sampled metadata duplication and conflicting declarations",
      description:
        "Offline, bounded comparison of 1-8 caller-supplied same-origin static HTML pages. Reviews repeated/conflicting titles, descriptions and canonical preferences; Open Graph/Twitter text differences; explicit robots directives; and duplicate titles/descriptions across distinct sampled canonical preferences. No network requests, Google-selected canonical verification, rendering, ranking inference, or storage.",
      inputSchema: {
        pages: z.array(metadataPageInputSchema).min(1).max(8)
          .describe("One to eight authorized same-origin static HTML pages with distinct safe URL labels; 900,000 UTF-8 bytes combined, none fetched."),
      },
      outputSchema: metadataConsistencyOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Reviewing metadata consistency...",
        invoked: "Sampled metadata consistency review complete.",
      }),
    },
    async ({ pages }) => {
      try {
        const bytes = pages.reduce((total, p) =>
          total + new TextEncoder().encode(p.htmlContent).byteLength, 0);
        if (bytes > MAX_METADATA_TOTAL_BYTES) throw new Error("Combined HTML exceeds limit.");
        const analysis = analyzeMetadataConsistency(pages.map(({ url, htmlContent }) =>
          observeMetadata(htmlContent, url)));
        const overview: ResultOverview = {
          kind: "report",
          status: analysis.conflicting_declaration_fields > 0 ? "needs_attention" : "partial",
          title: "Sampled metadata consistency review",
          headline: analysis.conflicting_declaration_fields + " conflicting field groups and " +
            analysis.duplicate_declaration_fields + " repeated equivalent fields across " +
            analysis.pages_sampled + " supplied pages.",
          detail: analysis.cross_field_review_leads + " social/canonical review leads and " +
            (analysis.duplicate_title_groups + analysis.duplicate_description_groups) +
            " cross-page duplicate metadata groups. These are not live Google indexing or ranking judgments.",
          total: analysis.total_findings,
          shown: analysis.findings.length,
          truncated: analysis.findings_truncated,
          counts: [
            metric("conflicting_fields", "Conflicting declarations", analysis.conflicting_declaration_fields, "warning"),
            metric("duplicate_fields", "Repeated equivalent fields", analysis.duplicate_declaration_fields, "info"),
            metric("cross_field", "Cross-field review leads", analysis.cross_field_review_leads, "info"),
            metric("cross_page", "Cross-page metadata groups",
              analysis.duplicate_title_groups + analysis.duplicate_description_groups, "info"),
          ],
          next_action: "Review the reported declarations in the sampled HTML and verify site intent; social metadata differences and repeated titles can be deliberate.",
        };
        return {
          structuredContent: { ...analysis, overview },
          content: contentForOverview(overview,
            analysis.findings.map((finding) => ({
              severity: finding.severity,
              label: finding.code + " (page " + finding.source_page + ")",
              message: finding.message,
            }))),
        };
      } catch {
        const error = "Metadata consistency could not be reviewed within the supplied URL, same-origin and size limits.";
        const overview = failedOverview("report", "Metadata consistency",
          "The supplied metadata sample could not be compared.", error);
        return {
          structuredContent: { ...emptyMetadataReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_sitemap_inventory",
    {
      title: "Review sitemap inventory, coverage and indexability conflicts",
      description:
        "V05: compare up to eight caller-supplied XML/text sitemap documents, independently discovered URLs and page status/robots/noindex/canonical evidence; or fetch one safe public sitemap and up to two same-origin child sitemaps. Reports malformed, duplicated, missing or external entries, lastmod anomalies and observed indexability conflicts without pretending sampled URLs prove full coverage or Google indexing. No raw URLs, XML source, external storage, crawler impersonation, page crawling or production writes.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Live: one authorized query-free public site URL; sitemap defaults to /sitemap.xml."),
        sitemap_url: deliveryInputUrl.optional()
          .describe("Live: optional same-origin query-free sitemap URL."),
        site_url: deliveryInputUrl.optional()
          .describe("Offline: public site whose sitemaps are provided."),
        documents: z.array(sitemapDocInputSchema).min(1).max(MAX_SITEMAP_DOCUMENTS).optional()
          .describe("Offline: 1–8 previously acquired XML or plain-text sitemap contents."),
        discovered_urls: z.array(chainLabelSchema).max(MAX_SITEMAP_DISCOVERED).optional()
          .describe("Optional independent discovered URLs, not fetched in this call."),
        page_observations: z.array(sitemapPageInputSchema)
          .max(MAX_SITEMAP_PAGE_OBSERVATIONS).optional()
          .describe("Optional HTTP/indexing evidence for up to 250 known pages."),
        documents_complete: z.boolean().optional(),
        discovered_complete: z.boolean().optional(),
        observed_at: z.string().max(40).optional(),
      },
      outputSchema: sitemapOutputSchema.shape,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Reviewing sitemap documents and sampled page evidence...",
        invoked: "Sitemap inventory review complete.",
      }),
    },
    async ({ url, sitemap_url, site_url, documents, discovered_urls, page_observations,
      documents_complete, discovered_complete, observed_at }) => {
      try {
        if (url
          ? Boolean(site_url || documents || discovered_urls || page_observations
            || documents_complete !== undefined || discovered_complete !== undefined
            || observed_at !== undefined)
          : !(site_url && documents) || sitemap_url !== undefined) {
          throw new Error("Select one live URL or complete offline sitemap evidence.");
        }
        const review = url
          ? await probeSitemapInventory(url, sitemap_url, async () => {
            const allowed = await env.SITE_AUDIT_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
            if (!allowed.success) throw new PublicHttpProbeBudgetError("Sitemap public HTTP budget exceeded.");
          })
          : analyzeSitemapInventory({
            site_url: site_url!, documents: documents!,
            ...(discovered_urls ? { discovered_urls } : {}),
            ...(page_observations ? { page_observations } : {}),
            ...(documents_complete === undefined ? {} : { documents_complete }),
            ...(discovered_complete === undefined ? {} : { discovered_complete }),
            ...(observed_at ? { observed_at } : {}),
          });
        const attention = review.known_indexability_conflicts > 0
          || review.invalid_url_entries > 0 || review.lastmod_invalid_count > 0;
        const overview: ResultOverview = {
          kind: "report",
          status: attention ? "needs_attention" : "partial",
          title: "Sitemap inventory (V05)",
          headline: review.documents_observed + " sampled document(s), "
            + review.distinct_page_urls + " distinct page URL(s), "
            + review.missing_child_documents + " missing child sitemap(s).",
          detail: review.duplicate_url_entries + " duplicate(s), "
            + review.invalid_url_entries + " invalid URL(s), "
            + review.lastmod_invalid_count + " invalid lastmod(s), "
            + review.known_indexability_conflicts + " observed indexability conflict(s). "
            + (review.inventory_complete
              ? "Caller-provided document coverage marked complete."
              : "Full document coverage is not established.")
            + " No Google indexing/crawling status is inferred.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("invalid_urls", "Invalid URLs", review.invalid_url_entries, "warning"),
            metric("missing_children", "Unseen child sitemaps", review.missing_child_documents, "info"),
            metric("indexability_conflicts", "Indexability conflicts",
              review.known_indexability_conflicts, "warning"),
          ],
          next_action: "Verify the complete sitemap index, important page statuses/canonical directives, and independent crawl coverage before treating any inventory as comprehensive.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code + " (document " + finding.document + ")",
            message: finding.message,
          }))),
        };
      } catch {
        const error = "Sitemap inventory could not be evaluated within public URL, bounded XML/text or request limits.";
        const overview = failedOverview("report", "Sitemap inventory (V05)",
          "No trustworthy sitemap inventory comparison could be completed.", error);
        return {
          structuredContent: { ...emptySitemapInventoryReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_redirect_canonical_chains",
    {
      title: "Review HTTP redirect chains and canonical destination conflicts",
      description:
        "V04: review up to eight supplied ordered HTTP response hops with redirects and static HTML/HTTP canonical plus X-Robots-Tag evidence; or probe a bounded same-origin public GET chain and static HTML destination. Detects loops, chain mismatches, missing or unsafe Location, 4xx/5xx/noindex destinations, conflicting/cyclic canonical declarations and non-matching explicit expected targets. Does not impersonate Googlebot, retrieve Google indexing decisions, store response bodies or echo raw URLs/tokens. Hosted live mode charges rate limit per outgoing request.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("One authorized query-free public URL for a bounded live GET chain."),
        source_url: chainLabelSchema.optional()
          .describe("Offline mode: source URL label; first supplied observation must match."),
        observations: z.array(chainObservationSchema).min(1).max(MAX_CHAIN_HOPS).optional()
          .describe("Offline: one to eight ordered observed redirect/status/canonical records."),
        expected_destination: chainLabelSchema.optional()
          .describe("Optional expected final URL to identify an observed destination mismatch."),
      },
      outputSchema: chainOutputSchema.shape,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Reviewing redirect hops and canonical destination evidence...",
        invoked: "Redirect/canonical chain diagnostics complete.",
      }),
    },
    async ({ url, source_url, observations, expected_destination }) => {
      try {
        if (url
          ? Boolean(source_url || observations)
          : !(source_url && observations)) {
          throw new Error("Select either live URL or complete offline observations.");
        }
        const review = url
          ? await probeRedirectCanonicalChain(url, expected_destination, async () => {
            const allowed = await env.SITE_AUDIT_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
            if (!allowed.success) throw new PublicHttpProbeBudgetError("Public HTTP request budget exceeded.");
          })
          : analyzeRedirectCanonicalChains({
            source_url: source_url!, observations: observations!,
            ...(expected_destination ? { expected_destination } : {}),
          });
        const warnings = review.findings.filter((item) => item.severity === "warning");
        const overview: ResultOverview = {
          kind: "report",
          status: warnings.length > 0 ? "needs_attention" : "partial",
          title: "Redirect and canonical chains (V04)",
          headline: review.hops_observed + " HTTP response(s), "
            + review.redirects_observed + " redirect(s), "
            + review.conflicting_canonical_hops + " conflicting-canonical hop(s).",
          detail: review.canonical_cycles + " canonical cycle(s), "
            + (review.chain_complete ? "observed chain complete." : "observed chain incomplete.")
            + (review.nonindexable_destination
              ? " Sampled destination has an HTTP, noindex or robots-block signal." : "")
            + " No Google-selected canonical or search indexing status was verified.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("redirects", "Redirect hops", review.redirects_observed, "info"),
            metric("canonical_conflicts", "Canonical conflicts",
              review.conflicting_canonical_hops, "warning"),
            metric("canonical_cycles", "Canonical cycles", review.canonical_cycles, "warning"),
          ],
          next_action: warnings.length > 0
            ? "Inspect the response Location and canonical declarations in the site's configuration; verify important destinations in Search Console or crawler logs separately."
            : "Compare against the explicitly expected destination and verified crawler responses if the issue recurs.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code + " (hop " + finding.hop + ")",
            message: finding.message,
          }))),
        };
      } catch {
        const error = "The redirect/canonical evidence could not be evaluated within safe public URL, input and request limits.";
        const overview = failedOverview("report", "Redirect and canonical chains (V04)",
          "No trustworthy redirect/canonical comparison could be completed.", error);
        return {
          structuredContent: { ...emptyRedirectCanonicalReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_crawler_access",
    {
      title: "Review crawler robots access and indexing directive matrix",
      description:
        "V03: compare up to eight user-provided same-origin page observations, static HTML meta robots and X-Robots-Tag against crawler-specific robots.txt rules for Googlebot desktop/smartphone/news/image, Bingbot and GPTBot. Alternatively fetch a single public page and robots.txt with the service's own User-Agent, applying public URL and robots guards and charging per outgoing GET. Crawl permission is NOT an indexing verdict; this does not impersonate or authenticate search crawlers, execute JS, store HTML or inspect crawler logs.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("Live: one authorized public query-free page URL; omit offline fields."),
        site_url: deliveryInputUrl.optional()
          .describe("Offline: origin URL to compare with the supplied pages."),
        robots_txt: z.string().max(MAX_CRAWLER_ROBOTS_BYTES).optional()
          .describe("Offline: previously acquired robots.txt text, maximum 64 KB."),
        robots_status_code: z.number().int().min(100).max(599).optional()
          .describe("Offline: actual observed robots.txt status; 429 and 5xx remain unknown."),
        pages: z.array(crawlerPageInputSchema).min(1).max(MAX_CRAWLER_PAGES).optional()
          .describe("Offline: one to eight page URL, HTTP, static HTML and header samples."),
        profiles: crawlerProfileInput.describe("Optional distinct profiles, six available and all checked by default."),
      },
      outputSchema: crawlerOutputSchema.shape,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Reviewing crawler rules and indexing directives...",
        invoked: "Crawler-access matrix complete.",
      }),
    },
    async ({ url, site_url, robots_txt, robots_status_code, pages, profiles }) => {
      try {
        if (url
          ? Boolean(site_url || pages || robots_txt !== undefined || robots_status_code !== undefined)
          : !(site_url && pages)) {
          throw new Error("Choose only live URL or complete offline evidence.");
        }
        const review = url
          ? await probeCrawlerAccess(url, profiles, async () => {
            const allowed = await env.SITE_AUDIT_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
            if (!allowed.success) throw new PublicHttpProbeBudgetError("Site audit rate limit reached.");
          })
          : analyzeCrawlerAccess({
            site_url: site_url!, pages: pages!,
            ...(robots_txt === undefined ? {} : { robots_txt }),
            ...(robots_status_code === undefined ? {} : { robots_status_code }),
            ...(profiles ? { profiles } : {}),
          });
        const overview: ResultOverview = {
          kind: "report",
          status: review.crawler_disallowed_rows > 0 || review.noindex_declared_rows > 0
            ? "needs_attention" : "partial",
          title: "Crawler access matrix (V03)",
          headline: review.rows_checked + " observed profile/page combinations; "
            + review.crawler_disallowed_rows + " robots-disallowed and "
            + review.noindex_declared_rows + " with declared noindex.",
          detail: review.unknown_access_rows + " unknown robots decisions and "
            + review.unknown_indexing_rows + " unknown indexing observations. "
            + "These are static, declared or sampled signals, not real Googlebot/Bingbot responses or confirmed index state.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("robots_disallow", "Robots disallow", review.crawler_disallowed_rows, "warning"),
            metric("noindex", "Noindex declared", review.noindex_declared_rows, "warning"),
            metric("unknown_access", "Unknown crawl access", review.unknown_access_rows, "info"),
          ],
          next_action: "Verify the applicable robots.txt and actual response headers in verified crawler logs and Search Console before attributing an indexing decline.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code + " (page " + finding.page + ", " + finding.profile + ")",
            message: finding.message,
          }))),
        };
      } catch {
        const error = "Crawler access cannot be assessed within public URL, source-evidence and request-rate safety limits.";
        const overview = failedOverview("report", "Crawler access matrix (V03)",
          "The crawler-access sample or offline comparison could not be completed.", error);
        return {
          structuredContent: { ...emptyCrawlerAccessReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_availability_history",
    {
      title: "Compare observed availability history and repeat HTTP delivery samples",
      description:
        "V02: compare two to 48 caller-supplied chronological HTTP/transport outcomes, or take two to three bounded live public GET observations. Counts intermittent success/non-success, HTTP 429/5xx, explicit challenges, timeouts and status transitions. Sample rate is not continuous uptime. No cloud persistence, scheduler, Googlebot verification, JavaScript, response bodies or raw URL/header output.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("One authorized public, query-free URL for a short live 2–3 GET burst."),
        checks: z.number().int().min(2).max(3).optional()
          .describe("Two or three live GET observations, default three; omit for offline input."),
        observations: z.array(availabilityObservationSchema).min(2)
          .max(MAX_AVAILABILITY_OBSERVATIONS).optional()
          .describe("Previously collected chronological HTTP or transport outcomes; no network requests."),
      },
      outputSchema: availabilityOutputSchema.shape,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Comparing availability response observations...",
        invoked: "Availability comparison complete.",
      }),
    },
    async ({ url, checks, observations }) => {
      try {
        if (Boolean(url) === Boolean(observations) || (observations && checks !== undefined)) {
          throw new Error("Exactly one input mode is required.");
        }
        const requestedChecks = checks ?? 3;
        const review = analyzeAvailabilityHistory(
          observations ?? await collectPublicAvailability(url!, requestedChecks,
            async () => (await env.SITE_AUDIT_RATE_LIMITER.limit({
              key: siteAuditRateLimitKey,
            })).success),
          url ? "live_bounded_burst" : "caller_supplied_history",
        );
        const warns = review.findings.filter((finding) => finding.severity === "warning");
        const overview: ResultOverview = {
          kind: "report",
          status: warns.length > 0 ? "needs_attention" : "partial",
          title: "Availability observations (V02)",
          headline: review.observed_successes + "/" + review.observations_count
            + " sampled requests returned HTTP 2xx (" + review.observed_success_percent + "% of samples).",
          detail: review.observed_http_5xx + " HTTP 5xx, " + review.observed_rate_limits
            + " HTTP 429, " + review.observed_transport_failures
            + " no-response events, " + review.http_status_changes
            + " response status changes. These samples do not establish continuous uptime or actual outage duration.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("non_2xx", "Non-2xx samples",
              review.observations_count - review.observed_successes, "warning"),
            metric("transport_errors", "No-response samples", review.observed_transport_failures, "warning"),
            metric("status_transitions", "Status changes", review.http_status_changes, "info"),
          ],
          next_action: warns.length > 0
            ? "Correlate the sampled timestamps with server/CDN logs and verified crawler records. Repeat at planned intervals for genuine history."
            : "Store samples externally or locally with the separate local MCP; repeat observations to establish a useful time series.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code,
            message: finding.message,
          }))),
        };
      } catch {
        const error = "Availability history could not be evaluated within the public URL, chronology, sample and rate limits.";
        const overview = failedOverview("report", "Availability observations (V02)",
          "The availability sample or comparison could not be completed.", error);
        return {
          structuredContent: { ...emptyAvailabilityReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "diagnose_http_delivery",
    {
      title: "Diagnose HTTP delivery, redirects, cache and edge challenges",
      description:
        "V01: bounded single public HTTP GET (up to three same-origin redirects) or up to four already-supplied HTTP response hops. Identifies 403, 429, 5xx, incomplete redirects, cache-state flags, Retry-After, and cf-mitigated challenge evidence. No response body, scripts, cookies, authenticated browser, Googlebot identity verification, historical monitoring or raw header/URL-token output.",
      inputSchema: {
        url: deliveryInputUrl.optional()
          .describe("One authorized public query-free HTTP(S) URL to probe once (GET)."),
        observations: z.array(deliveryObservationSchema).min(1).max(MAX_DELIVERY_HOPS).optional()
          .describe("One to four already-observed ordered response hops instead of making an HTTP request."),
      },
      outputSchema: deliveryOutputSchema.shape,
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthPlainTool({
        invoking: "Diagnosing HTTP delivery response evidence...",
        invoked: "HTTP delivery diagnostics complete.",
      }),
    },
    async ({ url, observations }) => {
      try {
        if (Boolean(url) === Boolean(observations)) throw new Error("Exactly one input mode is required.");
        if (url) {
          const allowed = await env.SITE_AUDIT_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
          if (!allowed.success) throw new Error("Rate limited");
        }
        const review = analyzeHttpDelivery(
          observations ?? await probePublicHttp(url!),
          url ? "live_public_http_probe" : "caller_supplied_http_observations",
        );
        const warnings = review.findings.filter((finding) => finding.severity === "warning");
        const overview: ResultOverview = {
          kind: "report",
          status: warnings.length ? "needs_attention" : "partial",
          title: "HTTP delivery diagnostics (V01)",
          headline: review.hops_observed + " HTTP response(s), "
            + review.errors_observed + " HTTP error(s), "
            + review.challenges_observed + " explicit Cloudflare challenge signal(s).",
          detail: review.redirects_observed + " redirect(s) observed; "
            + (review.redirect_chain_complete ? "the sampled chain completed." : "the sampled redirect chain was incomplete.")
            + " Single observation only; search crawler behavior and edge/origin causality were not verified.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("http_errors", "HTTP errors", review.errors_observed, "warning"),
            metric("challenges", "Explicit challenges", review.challenges_observed, "warning"),
            metric("redirects", "Observed redirects", review.redirects_observed, "info"),
          ],
          next_action: warnings.length > 0
            ? "Inspect affected hops in origin and Cloudflare logs and compare with verified crawler records; do not infer Googlebot was blocked from this probe."
            : "Repeat with authorized observations when the issue recurs and compare with server/crawler logs.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code + " (hop " + finding.hop + ")",
            message: finding.message,
          }))),
        };
      } catch {
        const error = "HTTP delivery could not be assessed within the public URL, input and rate limits.";
        const overview = failedOverview("report", "HTTP delivery diagnostics (V01)",
          "The HTTP delivery sample could not be completed.", error);
        return {
          structuredContent: { ...emptyDeliveryReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_url_variants",
    {
      title: "Review observed URL variants and canonical/redirect evidence",
      description:
        "Fully offline comparison of one explicit query-free reference and 1–12 caller-observed same-path HTTP(S), apex/www, slash, ASCII case and query URL variants. Uses supplied response status, one-step Location, up to three canonical declarations and optional caller-computed 200-body SHA-256 fingerprints. No website fetch, redirect following, content/Google canonical equivalence assumptions, stored history or URL/query/secret leakage.",
      inputSchema: {
        reference_url: z.string().url().max(MAX_VARIANT_URL_BYTES)
          .refine((value) => Boolean(safeVariantLabel(value)) && !value.includes("?"),
            "Reference must be a safe query-free HTTP(S) URL without credentials or fragments.")
          .describe("Explicit query-free HTTP(S) preferred reference URL, also required among supplied observations."),
        observations: z.array(variantObservationInputSchema).min(1).max(MAX_VARIANT_OBSERVATIONS)
          .describe("One to twelve actual same-family response observations; no network or browser requests are made."),
      },
      outputSchema: variantOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Comparing supplied URL variant observations...",
        invoked: "URL variant evidence review complete.",
      }),
    },
    async ({ reference_url, observations }) => {
      try {
        const review = analyzeUrlVariants(reference_url, observations);
        const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
        const overview: ResultOverview = {
          kind: "report",
          status: warnings ? "needs_attention" : "partial",
          title: "Sampled URL variant comparison",
          headline: review.pages_sampled + " supplied same-path HTTP response observations compared " +
            "with one explicit reference URL.",
          detail: review.scheme_variants + " scheme, " + review.www_variants + " apex/www, " +
            review.slash_variants + " trailing slash, " + review.case_variants + " path-case and " +
            review.query_variants + " query variations. " +
            review.redirects_to_reference + " direct redirect declarations and " +
            review.matching_content_variants + " caller-hash-identical HTTP 200 variants. " +
            "No URL requests, redirect following or Google-selected canonical conclusions.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("scheme_variants", "Scheme variants", review.scheme_variants, "info"),
            metric("www_variants", "Apex/www variants", review.www_variants, "info"),
            metric("query_variants", "Query variations", review.query_variants, "info"),
            metric("redirects_to_reference", "Declared redirects to reference", review.redirects_to_reference, "info"),
            metric("matching_bodies", "Hash-matching HTTP 200 variants", review.matching_content_variants, "warning"),
          ],
          next_action: "Verify intended query and path-case semantics, redirect chains and canonical hints with authorized live responses and Google Search Console. SHA-256 matches alone do not establish indexing or canonical selection.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code + " (observation " + finding.page + ")",
            message: finding.message,
          }))),
        };
      } catch {
        const error = "Supplied URL variant evidence could not be compared within reference, host, path, query, status or input-size limits.";
        const overview = failedOverview("report", "Sampled URL variants",
          "The caller-observed URL variant responses could not be reviewed.", error);
        return {
          structuredContent: { ...emptyUrlVariantReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_https_security",
    {
      title: "Review supplied HTTPS, mixed-content and HTTP security evidence",
      description:
        "Offline bounded security-header and static HTML review across 1–8 same-host HTTP/HTTPS caller observations. HTTP→HTTPS Location declarations, HSTS status, enforcing versus report-only CSP, referrer/nosniff/frame protections and potential mixed-content/script/style/media/form declarations. No site fetch, TLS/certificate verification, browser execution, resource requests or leakage of raw URLs/headers/HTML. Not a production security verdict.",
      inputSchema: {
        pages: securityPagesInputSchema
          .describe("One to eight same-host HTTP/HTTPS supplied observations with response codes, optional headers and HTML; max 24 KB header and 300 KB HTML budgets."),
      },
      outputSchema: securityOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Reviewing observed HTTPS and security signals...",
        invoked: "Security evidence review complete.",
      }),
    },
    async ({ pages }) => {
      try {
        const review = analyzeHttpsSecurity(pages, loadCheerio);
        const warnings = review.findings.filter((finding) => finding.severity === "warning").length;
        const overview: ResultOverview = {
          kind: "report",
          status: warnings ? "needs_attention" : "partial",
          title: "Sampled HTTPS and HTTP security signals",
          headline: review.pages_sampled + " supplied same-host response observations; " +
            review.https_observations + " HTTPS and " + review.http_observations + " HTTP.",
          detail: review.https_redirect_declarations + " declared HTTPS redirects; " +
            review.https_without_hsts_observation + " HTTPS responses without supplied HSTS; " +
            review.mixed_blockable_declarations + " potentially blockable mixed resource declarations, " +
            review.mixed_upgradable_declarations + " upgradable candidates and " +
            review.insecure_form_actions + " insecure form action declarations. No network or TLS verification.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("https", "HTTPS observations", review.https_observations, "info"),
            metric("https_redirects", "Declared HTTPS redirects", review.https_redirect_declarations, "info"),
            metric("missing_hsts", "HTTPS missing supplied HSTS", review.https_without_hsts_observation, "info"),
            metric("mixed_blockable", "Potentially blockable HTTP resources", review.mixed_blockable_declarations, "warning"),
            metric("insecure_forms", "HTTP form action declarations", review.insecure_form_actions, "warning"),
          ],
          next_action: "Verify against authorized live HTTP/HTTPS requests, TLS certificates and browser DevTools. Static header/HTML samples do not prove security policy enforcement or actual mixed-content loading.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview, review.findings.map((finding) => ({
            severity: finding.severity,
            label: finding.code + " (page " + finding.page + ")",
            message: finding.message,
          }))),
        };
      } catch {
        const error = "The supplied HTTPS security observations exceeded URL, same-host, header or HTML evidence limits.";
        const overview = failedOverview("report", "HTTPS and HTTP security signals",
          "The supplied response/HTML evidence could not be reviewed.", error);
        return {
          structuredContent: { ...emptyHttpsSecurityReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "review_http_directives",
    {
      title: "Review observed non-HTML HTTP indexing directives",
      description:
        "Offline, bounded analysis of one to eight caller-supplied same-origin HTTP response header observations for PDFs and media: MIME, X-Robots-Tag scopes and conflicts, HTTP Link rel=canonical, attachment disposition and response status. No binary fetch, robots.txt request, storage, Google indexing assertion or raw URL/header leakage.",
      inputSchema: {
        resources: z.array(httpObservationInputSchema).min(1).max(MAX_HTTP_RESOURCES)
          .describe("One to eight authorized same-origin supplied HTTP response observations, up to 30 KB combined header values; no network requests are made."),
      },
      outputSchema: httpDirectivesOutputSchema.shape,
      annotations: localReadOnlyAnnotations,
      ...withNoAuthWidget({
        invoking: "Reviewing non-HTML HTTP directives...",
        invoked: "HTTP directive review complete.",
      }),
    },
    async ({ resources }) => {
      try {
        const review = analyzeHttpDirectives(resources);
        const contradictory = review.conflicting_robots_resources + review.conflicting_canonical_resources;
        const overview: ResultOverview = {
          kind: "report",
          status: contradictory ? "needs_attention" : "partial",
          title: "Sampled non-HTML HTTP directive review",
          headline: review.non_html_resources + " non-HTML response observations in " +
            review.resources_sampled + " supplied HTTP metadata records.",
          detail: review.googlebot_noindex_resources + " Googlebot-applicable noindex declarations, " +
            review.canonical_header_resources + " HTTP canonical header records, " +
            review.googlebot_noimageindex_resources + " image-specific noindex declarations and " +
            contradictory + " contradictory directive groups. No resource fetched or indexing inferred.",
          total: review.total_findings,
          shown: review.findings.length,
          truncated: review.findings_truncated,
          counts: [
            metric("non_html", "Non-HTML resources", review.non_html_resources, "info"),
            metric("googlebot_noindex", "Declared Googlebot noindex", review.googlebot_noindex_resources, "warning"),
            metric("googlebot_noimageindex", "Declared image noindex", review.googlebot_noimageindex_resources, "info"),
            metric("canonical_headers", "Canonical header records", review.canonical_header_resources, "info"),
            metric("directive_conflicts", "Contradictory declarations", contradictory, "warning"),
          ],
          next_action: "Compare supplied HEAD/GET headers against authorized live responses, robots.txt and Search Console. Absent noindex is not proof of indexing; Link canonicals are not Google selections.",
        };
        return {
          structuredContent: { ...review, overview },
          content: contentForOverview(overview,
            review.findings.map((finding) => ({
              severity: finding.severity,
              label: finding.code + " (resource " + finding.resource + ")",
              message: finding.message,
            }))),
        };
      } catch {
        const error = "HTTP response metadata could not be reviewed within the supplied URL, origin, status or header limits.";
        const overview = failedOverview("report", "Non-HTML HTTP directives",
          "The supplied HTTP response observations could not be compared.", error);
        return {
          structuredContent: { ...emptyHttpDirectiveReview(), overview, error },
          content: contentForOverview(overview),
          isError: true,
        };
      }
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("Web Validator by DigestSEO MCP server. Connect with streamable HTTP at /mcp.\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (url.pathname === "/.well-known/glama.json") {
      return Response.json(GLAMA_CONNECTOR_METADATA);
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not found\n", { status: 404 });
    }

    const startedAt = Date.now();
    const origin = request.headers.get("origin") ?? undefined;
    try {
      const suppliedHost = request.headers.get("host");
      if (!ALLOWED_REQUEST_HOSTS.has(url.hostname.toLowerCase())
        || (suppliedHost !== null && suppliedHost.toLowerCase() !== url.host.toLowerCase())) {
        return jsonRpcHttpError(403, "Forbidden: unexpected Host header.");
      }
      if (origin && !TRUSTED_BROWSER_ORIGINS.has(origin)) {
        logRequest("mcp_request_rejected", {
          reason: "untrusted_origin",
          method: request.method,
          status: 403,
        });
        return jsonRpcHttpError(403, "Forbidden: untrusted Origin header.");
      }

      if (request.method === "OPTIONS") {
        return withExactCors(new Response(null, {
          status: 200,
          headers: {
            "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
            "access-control-allow-headers": PREFLIGHT_HEADERS,
            "access-control-expose-headers": "Mcp-Session-Id",
            "access-control-max-age": "86400",
          },
        }), origin);
      }

      const siteAuditRateLimitKey = request.method === "OPTIONS" ? "options" : await rateLimitKey(request);
      if (request.method !== "OPTIONS") {
        const { success } = await env.MCP_RATE_LIMITER.limit({ key: siteAuditRateLimitKey });
        if (!success) {
          logRequest("mcp_request_rejected", {
            reason: "rate_limited",
            method: request.method,
            status: 429,
          });
          return jsonRpcHttpError(429, "Too many requests. Please retry shortly.", origin, {
            "retry-after": "60",
          });
        }
      }

      if (await requestBodyExceedsLimit(request)) {
        logRequest("mcp_request_rejected", {
          reason: "body_too_large",
          method: request.method,
          status: 413,
        });
        return jsonRpcHttpError(413, "MCP request body exceeds the 2 MiB limit.", origin);
      }

      const handler = createMcpHandler(() => createServer(env, siteAuditRateLimitKey), {
        legacy: "stateless",
        responseMode: "sse",
        maxRequestBodySize: MCP_BODY_MAX_BYTES,
      });
      const response = await addCanonicalToolSecuritySchemes(withExactCors(await handler.fetch(request), origin));
      logRequest("mcp_request", {
        method: request.method,
        status: response.status,
        duration_ms: Date.now() - startedAt,
        browser_origin: Boolean(origin),
      });
      return response;
    } catch (cause) {
      console.error(JSON.stringify({
        event: "mcp_request_failed",
        method: request.method,
        duration_ms: Date.now() - startedAt,
        error_type: cause instanceof Error ? cause.name : "UnknownError",
      }));
      const corsOrigin = origin && TRUSTED_BROWSER_ORIGINS.has(origin) ? origin : undefined;
      return jsonRpcHttpError(500, "The MCP request could not be completed.", corsOrigin);
    }
  },
} satisfies ExportedHandler<Env>;
