import { z } from "zod";

export const resultKindSchema = z.enum(["html", "css", "seo", "schema", "links", "report", "site"]);
export const resultStatusSchema = z.enum([
  "passed",
  "needs_attention",
  "partial",
  "failed",
  "not_applicable",
]);

export const metricToneSchema = z.enum(["error", "warning", "info", "success"]);
export const overviewMetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().int().nonnegative(),
  tone: metricToneSchema,
});

export const overviewSchema = z.object({
  kind: resultKindSchema,
  status: resultStatusSchema,
  title: z.string(),
  headline: z.string(),
  detail: z.string(),
  total: z.number().int().nonnegative(),
  shown: z.number().int().nonnegative(),
  truncated: z.boolean(),
  counts: z.array(overviewMetricSchema),
  next_action: z.string().optional(),
});

export type ResultKind = z.infer<typeof resultKindSchema>;
export type ResultStatus = z.infer<typeof resultStatusSchema>;
export type OverviewMetric = z.infer<typeof overviewMetricSchema>;
export type ResultOverview = z.infer<typeof overviewSchema>;

export interface PresentableFinding {
  severity: "error" | "warning" | "info";
  message: string;
  line?: number;
  column?: number;
  label?: string;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const MAX_FINDINGS_IN_CONTENT = 3;
const MAX_MESSAGE_LENGTH = 220;

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function compactText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_MESSAGE_LENGTH
    ? compact
    : `${compact.slice(0, MAX_MESSAGE_LENGTH - 1).trimEnd()}…`;
}

function findingLocation(finding: PresentableFinding): string | undefined {
  if (finding.line !== undefined && finding.column !== undefined) {
    return `Line ${finding.line}, column ${finding.column}`;
  }
  if (finding.line !== undefined) return `Line ${finding.line}`;
  return finding.label;
}

/** Builds concise model-facing Markdown while detailed data stays in structuredContent. */
export function contentForOverview(
  overview: ResultOverview,
  findings: PresentableFinding[] = [],
) {
  const sections = [overview.headline];
  if (overview.detail && overview.detail !== overview.headline) sections.push(overview.detail);

  const actionable = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.severity !== "info")
    .sort(
      (left, right) =>
        SEVERITY_ORDER[left.finding.severity] - SEVERITY_ORDER[right.finding.severity]
        || left.index - right.index,
    )
    .slice(0, MAX_FINDINGS_IN_CONTENT)
    .map(({ finding }) => {
      const severity = finding.severity === "error" ? "Error" : "Warning";
      const location = findingLocation(finding);
      const prefix = location ? `${severity} · ${location}` : severity;
      return `- **${prefix}:** ${compactText(finding.message)}`;
    });

  if (actionable.length > 0) sections.push(`**Fix first**\n${actionable.join("\n")}`);
  if (overview.next_action) sections.push(`**Next step:** ${overview.next_action}`);

  return [{ type: "text" as const, text: sections.join("\n\n") }];
}
