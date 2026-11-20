// V04 - pure shared redirect/canonical-chain analyzer for the Cloudflare Worker.
export {
  analyzeRedirectCanonicalChains, emptyRedirectCanonicalReview, canonicalHrefsFromLinkHeader,
  MAX_CHAIN_HOPS, MAX_CHAIN_FINDINGS, MAX_CHAIN_CANONICALS,
  MAX_CHAIN_HTML_BYTES, MAX_CHAIN_TOTAL_HTML_BYTES,
  CHAIN_REDIRECT_STATES, CHAIN_TARGET_STATES, CHAIN_CANONICAL_STATES,
  CHAIN_INDEXING_STATES, CHAIN_FINDING_CODES,
} from "../../../../src/modules/http-crawl/redirect-canonical-chains";
export type {
  RedirectCanonicalInput, RedirectChainObservation,
  RedirectCanonicalReview, RedirectCanonicalHop, RedirectCanonicalFinding,
} from "../../../../src/modules/http-crawl/redirect-canonical-chains";
