/**
 * P1-04: explicit first-party landing-page promises versus the MCP runtime's
 * actual registered tool metadata. This intentionally does not claim that a
 * listed tool has succeeded on a particular URL or that prose can be judged
 * semantically from a few keywords.
 */
export type ProductSurface = "hosted" | "local";

export interface ToolCatalogEvidence {
  name: string;
  readOnlyHint?: boolean;
  maxPages?: number;
  maxLinks?: number;
}

export interface ProductClaimObservation {
  hasMain: boolean;
  hostedSectionFound: boolean;
  localSectionFound: boolean;
  hostedTools: string[];
  localTools: string[];
  siteBatchLimit?: number;
  localScreenshotClaim: boolean;
  hostedReadOnlyClaim: boolean;
  hostedNoScreenshotsClaim: boolean;
  extractionTruncated: boolean;
}

export type ProductClaimCode =
  | "product.tool_missing"
  | "product.site_batch_overclaim"
  | "product.site_batch_limit_unknown"
  | "product.local_screenshot_unverified"
  | "product.hosted_screenshot_conflict"
  | "product.read_only_conflict"
  | "product.read_only_unverified";

export interface ProductClaimFinding {
  code: ProductClaimCode;
  severity: "warning" | "info";
  verdict: "contradicted" | "unverifiable";
  claim: string;
  message: string;
  evidence_tool?: string;
}

export interface ProductClaimResult {
  scope: "landing_html_vs_registered_mcp_metadata";
  surface: ProductSurface;
  catalog_available: boolean;
  registered_tools: number;
  tool_claims_checked: number;
  checked_claims: number;
  consistent_claims: number;
  contradicted_claims: number;
  unverified_claims: number;
  advertised_tools: Array<{ name: string; registered: boolean }>;
  site_batch_limit?: { advertised: number; registered?: number };
  coverage_limited: boolean;
  limitations: string[];
  total_findings: number;
  findings: ProductClaimFinding[];
  findings_truncated: boolean;
}

export const MAX_PRODUCT_CLAIM_HTML_BYTES = 250_000;
export const MAX_PRODUCT_CLAIM_TOOLS = 20;
export const MAX_PRODUCT_CLAIM_FINDINGS = 10;
const MAX_CATALOG_TOOLS = 64;
const MAX_TOOL_ID_CHARS = 64;

export function isPublicToolName(value: string): boolean {
  return value.length > 2 && value.length <= MAX_TOOL_ID_CHARS &&
    /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/.test(value);
}

/**
 * Take a snapshot of the SDK's runtime registration map. The Zod-to-JSON
 * converter is supplied by each runtime, avoiding dependencies in this core.
 * Missing metadata stays unknown; it must never become a fabricated limit.
 */
export function registeredToolEvidence(
  registrations: unknown,
  toJsonSchema: (schema: unknown) => unknown,
): ToolCatalogEvidence[] {
  if (!registrations || typeof registrations !== "object") return [];
  const entries = Object.entries(registrations as Record<string, unknown>);
  if (entries.length > MAX_CATALOG_TOOLS) return [];
  const tools: ToolCatalogEvidence[] = [];
  for (const [name, raw] of entries) {
    if (!isPublicToolName(name) || !raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (record.enabled === false) continue;
    const value: ToolCatalogEvidence = { name };
    const annotations = record.annotations;
    if (annotations && typeof annotations === "object") {
      const hint = (annotations as Record<string, unknown>).readOnlyHint;
      if (typeof hint === "boolean") value.readOnlyHint = hint;
    }
    try {
      const schema = toJsonSchema(record.inputSchema);
      if (schema && typeof schema === "object") {
        const properties = (schema as Record<string, unknown>).properties;
        if (properties && typeof properties === "object") {
          const object = properties as Record<string, unknown>;
          for (const [property, key] of [
            ["max_pages", "maxPages"], ["max_links", "maxLinks"],
          ] as const) {
            const element = object[property];
            if (!element || typeof element !== "object") continue;
            const maximum = (element as Record<string, unknown>).maximum;
            if (typeof maximum === "number" && Number.isSafeInteger(maximum) &&
              maximum > 0 && maximum < 100_000) value[key] = maximum;
          }
        }
      }
    } catch {
      // SDK/Zod versions differ in JSON-schema support; absence is unverified.
    }
    tools.push(value);
  }
  return tools;
}

/**
 * This check establishes registry consistency only. Do not invent tool
 * behavior, credentials, live health, data-access rights, or page quality.
 */
export function compareProductClaims(
  observation: ProductClaimObservation,
  registered: readonly ToolCatalogEvidence[],
  surface: ProductSurface,
): ProductClaimResult {
  const catalogAvailable = registered.length > 0 && registered.length <= MAX_CATALOG_TOOLS;
  const known = new Map(registered.filter((tool) => isPublicToolName(tool.name))
    .map((tool) => [tool.name, tool]));
  const claimed = surface === "hosted" ? observation.hostedTools : observation.localTools;
  const advertisedTools = [...new Set(claimed)].slice(0, MAX_PRODUCT_CLAIM_TOOLS)
    .filter(isPublicToolName).map((name) => ({ name, registered: known.has(name) }));
  const findings: ProductClaimFinding[] = [];
  let checked = 0;
  let consistent = 0;
  let contradicted = 0;
  let unverified = 0;
  function count(verdict: "consistent" | "contradicted" | "unverifiable",
    finding?: ProductClaimFinding) {
    checked += 1;
    if (verdict === "consistent") consistent += 1;
    else if (verdict === "contradicted") contradicted += 1;
    else unverified += 1;
    if (finding) findings.push(finding);
  }
  for (const { name, registered: exists } of advertisedTools) {
    if (!catalogAvailable) {
      count("unverifiable");
    } else if (exists) {
      count("consistent");
    } else {
      count("contradicted", {
        code: "product.tool_missing", severity: "warning", verdict: "contradicted",
        claim: name, evidence_tool: name,
        message: "The landing page lists this MCP tool but it is absent from the current runtime tool registry.",
      });
    }
  }

  let siteBatchLimit: ProductClaimResult["site_batch_limit"];
  if (surface === "hosted" && observation.siteBatchLimit !== undefined) {
    const advertised = observation.siteBatchLimit;
    const actual = known.get("audit_public_site")?.maxPages;
    siteBatchLimit = { advertised, ...(actual ? { registered: actual } : {}) };
    if (!catalogAvailable || !actual) count("unverifiable", {
      code: "product.site_batch_limit_unknown", severity: "info", verdict: "unverifiable",
      claim: "site batch limit", evidence_tool: "audit_public_site",
      message: "The advertised site-batch size cannot be checked against the registered tool input-schema maximum.",
    });
    else if (advertised > actual) count("contradicted", {
      code: "product.site_batch_overclaim", severity: "warning", verdict: "contradicted",
      claim: "site batch limit", evidence_tool: "audit_public_site",
      message: "The advertised site-batch size exceeds the maximum accepted by the registered MCP tool.",
    });
    else count("consistent");
  }
  if (surface === "local" && observation.localScreenshotClaim) {
    if (!catalogAvailable) count("unverifiable");
    else if (known.has("screenshot.capture")) count("consistent");
    else count("contradicted", {
      code: "product.local_screenshot_unverified", severity: "warning",
      verdict: "contradicted", claim: "local responsive screenshots",
      evidence_tool: "screenshot.capture",
      message: "The landing page promises local screenshots, but the screenshot capture tool is not registered.",
    });
  }
  if (surface === "hosted" && observation.hostedNoScreenshotsClaim) {
    if (!catalogAvailable) count("unverifiable");
    else if (!known.has("screenshot.capture")) count("consistent");
    else count("contradicted", {
      code: "product.hosted_screenshot_conflict", severity: "warning",
      verdict: "contradicted", claim: "hosted screenshots unavailable",
      evidence_tool: "screenshot.capture",
      message: "The landing page excludes hosted screenshot capture, but the hosted runtime registers a screenshot tool.",
    });
  }
  if (surface === "hosted" && observation.hostedReadOnlyClaim) {
    if (!catalogAvailable || registered.some((tool) => tool.readOnlyHint === undefined)) {
      count("unverifiable", {
        code: "product.read_only_unverified", severity: "info", verdict: "unverifiable",
        claim: "hosted tools read-only",
        message: "The registered MCP tools do not all declare read-only metadata, so this promise needs behavioral review.",
      });
    } else if (registered.some((tool) => tool.readOnlyHint !== true)) {
      count("contradicted", {
        code: "product.read_only_conflict", severity: "warning", verdict: "contradicted",
        claim: "hosted tools read-only",
        message: "At least one hosted tool advertises a non-read-only annotation; reconcile the landing-page promise.",
      });
    } else count("consistent");
  }

  const sectionFound = surface === "hosted"
    ? observation.hostedSectionFound : observation.localSectionFound;
  const coverageLimited = !catalogAvailable || !observation.hasMain
    || observation.extractionTruncated || !sectionFound
    || checked === 0 || unverified > 0;
  const limitations = [
    "Only explicit tool names and selected bounded/surface promises are checked against observed MCP registration metadata, not arbitrary marketing semantics.",
    "Registration and input-schema compatibility do NOT prove a successful tool call, live service health, screenshots, Google indexing, or functional correctness.",
    ...(!sectionFound ? ["No explicit tool listing for this runtime was found in the visible main-content section."] : []),
    ...(!catalogAvailable ? ["Runtime tool-registration metadata is unavailable; unsupported claims cannot be determined."] : []),
    ...(observation.extractionTruncated ? ["The landing-page claim extraction reached its hard limit; some claims were not checked."] : []),
  ];
  const ordered = findings.sort((a, b) => (a.severity === "warning" ? 0 : 1)
    - (b.severity === "warning" ? 0 : 1) || a.code.localeCompare(b.code) || a.claim.localeCompare(b.claim));
  return {
    scope: "landing_html_vs_registered_mcp_metadata",
    surface, catalog_available: catalogAvailable, registered_tools: registered.length,
    tool_claims_checked: advertisedTools.length, checked_claims: checked,
    consistent_claims: consistent, contradicted_claims: contradicted,
    unverified_claims: unverified, advertised_tools: advertisedTools,
    ...(siteBatchLimit ? { site_batch_limit: siteBatchLimit } : {}),
    coverage_limited: coverageLimited,
    limitations, total_findings: ordered.length,
    findings: ordered.slice(0, MAX_PRODUCT_CLAIM_FINDINGS),
    findings_truncated: ordered.length > MAX_PRODUCT_CLAIM_FINDINGS,
  };
}
