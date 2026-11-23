/** Privacy-preserving reduction of optional axe-core evidence. */
export const MAX_AXE_RULES = 12;

export interface AxeRuleSummary {
  rule: string;
  impact: "minor" | "moderate" | "serious" | "critical" | "unknown";
  nodes: number;
}
export interface AxeSummary {
  status: "complete" | "unavailable";
  engine_version?: string;
  violations: number;
  incomplete: number;
  rules: AxeRuleSummary[];
  rules_truncated: boolean;
  coverage_limited: true;
}

interface AxeRecord {
  id?: unknown;
  impact?: unknown;
  nodes?: unknown;
}
export function reduceAxeEvidence(raw: unknown): AxeSummary {
  if (!raw || typeof raw !== "object") throw new Error("Invalid axe evidence");
  const input = raw as { version?: unknown; violations?: unknown; incomplete?: unknown };
  if (!Array.isArray(input.violations) || !Array.isArray(input.incomplete)) {
    throw new Error("axe evidence missing result lists");
  }
  const rules: AxeRuleSummary[] = [];
  for (const source of input.violations.slice(0, 1_024)) {
    const rule = source as AxeRecord;
    if (!rule || typeof rule !== "object"
      || typeof rule.id !== "string" || !/^[a-z][a-z0-9-]{0,59}$/.test(rule.id)
      || !Number.isSafeInteger(rule.nodes) || Number(rule.nodes) < 0) {
      throw new Error("Invalid axe rule evidence");
    }
    const impact = ["minor", "moderate", "serious", "critical"].includes(String(rule.impact))
      ? rule.impact as AxeRuleSummary["impact"] : "unknown";
    if (rules.length < MAX_AXE_RULES) {
      rules.push({ rule: rule.id, impact, nodes: Number(rule.nodes) });
    }
  }
  const version = typeof input.version === "string" && /^\d+\.\d+\.\d+$/.test(input.version)
    ? input.version : undefined;
  return {
    status: "complete",
    ...(version ? { engine_version: version } : {}),
    violations: input.violations.length,
    incomplete: input.incomplete.length,
    rules,
    rules_truncated: input.violations.length > MAX_AXE_RULES,
    coverage_limited: true,
  };
}
export function unavailableAxeEvidence(): AxeSummary {
  return { status: "unavailable", violations: 0, incomplete: 0,
    rules: [], rules_truncated: false, coverage_limited: true };
}
