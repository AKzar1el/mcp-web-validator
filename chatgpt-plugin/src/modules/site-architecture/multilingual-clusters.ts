/**
 * M02 Worker façade: use the same deterministic multilingual engine as the
 * local stdio MCP. This layer intentionally has no crawler or browser code.
 */
export {
  analyzeMultilingualClusters,
  observeMultilingualPage,
  normalizeHreflangLocale,
  MAX_MULTILINGUAL_PAGES,
  MAX_HREFLANG_LOCALES,
  MAX_MULTILINGUAL_FINDINGS,
} from "../../../../src/modules/site-architecture/multilingual-clusters.js";
export type {
  MultilingualPageObservation,
  MultilingualClusterAnalysis,
  MultilingualFinding,
} from "../../../../src/modules/site-architecture/multilingual-clusters.js";
