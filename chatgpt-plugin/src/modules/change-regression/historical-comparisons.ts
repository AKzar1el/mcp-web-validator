// P2-01 hosted Worker-safe adapter: exactly the dependency-free M05
// longitudinal analyzer used by the local read-only saved-ID tool.
export {
  analyzeHistoricalAudits,
  emptyHistoricalReview,
  MAX_HISTORICAL_VERSIONS,
  MAX_HISTORICAL_SNAPSHOT_BYTES,
  MAX_HISTORICAL_TOTAL_BYTES,
  MAX_HISTORICAL_PAGES,
  MAX_HISTORICAL_GROUPS,
  MAX_HISTORICAL_FINDINGS,
  HISTORICAL_STATUSES,
  HISTORICAL_FINDING_CODES,
} from "../../../../src/modules/change-regression/historical-comparisons";
export type {
  HistoricalVersion,
  HistoricalSnapshot,
  HistoricalPage,
  HistoricalIssueGroup,
  HistoricalPoint,
  HistoricalStep,
  HistoricalFinding,
  HistoricalReview,
  HistoricalStatus,
  HistoricalFindingCode,
} from "../../../../src/modules/change-regression/historical-comparisons";
