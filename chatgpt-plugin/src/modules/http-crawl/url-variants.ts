// P1-14: hosted Worker-safe adapter to the exact shared, dependency-free M01
// URL-variant analyzer. No fetch, parser or cross-package runtime dependency.
export {
  analyzeUrlVariants,
  emptyUrlVariantReview,
  safeVariantLabel,
  MAX_VARIANT_OBSERVATIONS,
  MAX_VARIANT_FINDINGS,
  MAX_VARIANT_URL_BYTES,
  MAX_VARIANT_CANONICALS,
  MAX_VARIANT_TOTAL_BYTES,
  VARIANT_DIMENSIONS,
  VARIANT_RESPONSE_STATES,
  VARIANT_TARGET_STATES,
  VARIANT_CANONICAL_STATES,
  VARIANT_FINDING_CODES,
} from "../../../../src/modules/http-crawl/url-variants";
export type {
  UrlVariantObservation,
  UrlVariantPageEvidence,
  UrlVariantFinding,
  UrlVariantReview,
  VariantDimension,
  VariantResponseState,
  VariantTargetState,
  VariantCanonicalState,
  VariantFindingCode,
} from "../../../../src/modules/http-crawl/url-variants";
