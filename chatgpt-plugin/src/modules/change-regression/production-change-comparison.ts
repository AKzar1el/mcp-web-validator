// V10: one shared pure analyzer for both local and hosted MCP runtimes.
export {
  analyzeProductionChange,
  emptyProductionChangeReview,
  MAX_CHANGE_HTML_BYTES,
  MAX_CHANGE_TOTAL_BYTES,
  MAX_CHANGE_FINDINGS,
  CHANGE_STATUSES,
  CHANGE_FINDING_CODES,
} from "../../../../src/modules/change-regression/production-change-comparison";
export type {
  ProductionChangeInput,
  ChangeVersion,
  ProductionChangeReview,
  ChangeFinding,
  PageFingerprint,
} from "../../../../src/modules/change-regression/production-change-comparison";
