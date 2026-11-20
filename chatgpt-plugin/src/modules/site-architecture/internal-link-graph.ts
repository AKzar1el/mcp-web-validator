// Reexport the same pure V06 graph implementation in the hosted Worker.
export {
  analyzeInternalLinkGraph, emptyInternalLinkGraphReview,
  extractGraphLinks, graphLiveTargets,
  MAX_GRAPH_PAGES, MAX_GRAPH_HTML_BYTES, MAX_GRAPH_TOTAL_HTML_BYTES,
  MAX_GRAPH_LINKS_PER_PAGE, MAX_GRAPH_CATALOG_URLS,
  MAX_GRAPH_FINDINGS, MAX_GRAPH_LIVE_PAGES, GRAPH_FINDING_CODES,
} from "../../../../src/modules/site-architecture/internal-link-graph";
export type {
  GraphPageInput, GraphPageReport, GraphFinding, GraphFindingCode,
  InternalLinkGraphInput, InternalLinkGraphReview,
} from "../../../../src/modules/site-architecture/internal-link-graph";
