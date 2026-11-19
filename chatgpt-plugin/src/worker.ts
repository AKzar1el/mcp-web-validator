import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
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
import { fetchPublicHtml, PublicHtmlFetchError, type HtmlMediaType } from "./network";
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
        "Use this when raw HTML markup is supplied. Sends that markup to the Nu HTML Checker hosted at validator.nu and returns validation messages. For a live URL, use audit_public_webpage.",
      inputSchema: { html: htmlInput },
      outputSchema: {
        messages: z.array(validationMessageSchema),
        total_messages: z.number().int().nonnegative(),
        truncated: z.boolean(),
        overview: overviewSchema,
        error: z.string().optional(),
      },
      annotations: externalReadOnlyAnnotations,
      ...withNoAuthWidget({ invoking: "Validating HTML…", invoked: "HTML validation complete." }),
    },
    async ({ html }) => {
      try {
        const result = await validateHtmlDetailed(html);
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
          detail: result.total === 0
            ? "The Nu HTML Checker returned no diagnostics."
            : `${plural(result.total, "diagnostic")} returned${result.truncated ? `; showing the first ${messages.length}` : ""}.`,
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
          },
          content: contentForOverview(overview, validationFindings(messages)),
        };
    } catch (cause) {
      console.error(
        "W3C HTML validation failed:",
        cause instanceof Error ? cause.message : "Unknown upstream error",
      );
      const error = "HTML validation is temporarily unavailable. Please try again shortly.";
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
