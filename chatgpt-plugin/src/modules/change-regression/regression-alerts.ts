// P2-02 Worker-safe adapter to the exact shared, dependency-free M05
// manual regression/alert-preview evaluator. No scheduler, webhook, email or
// stateful integration is imported or enabled by this module.
export {
  previewRegressionAlerts,
  normalizeMonitorPolicy,
  emptyMonitorPreview,
  DEFAULT_MONITOR_POLICY,
  MONITOR_RULES,
  MONITOR_DECISIONS,
  MONITOR_STATUSES,
  MONITOR_REASON_CODES,
} from "../../../../src/modules/change-regression/regression-alerts";
export type {
  MonitorPolicyInput,
  MonitorPolicy,
  MonitorRule,
  MonitorDecision,
  MonitorStatus,
  MonitorReasonCode,
  MonitorRuleResult,
  MonitorPreview,
} from "../../../../src/modules/change-regression/regression-alerts";
