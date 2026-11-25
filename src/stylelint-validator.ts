import { MAX_CSS_VALIDATION_BYTES, MAX_VALIDATION_MESSAGES, type CssValidationResult } from "./w3c-validator.js";

const RULES = {
  "block-no-empty": true,
  "color-no-invalid-hex": true,
  "declaration-block-no-duplicate-properties": true,
  "font-family-no-duplicate-names": true,
  "function-no-unknown": true,
  "property-no-unknown": true,
  "selector-pseudo-class-no-unknown": true,
  "selector-pseudo-element-no-unknown": true,
  "unit-no-unknown": true,
  "media-feature-name-no-unknown": true,
} as const;

/**
 * Explicit local-only CSS linting. These rules do not establish W3C validity.
 * No config files, network resources, autofixes or CSS source excerpts are emitted.
 */
export async function lintCssLocally(css: string): Promise<CssValidationResult> {
  if (Buffer.byteLength(css, "utf8") > MAX_CSS_VALIDATION_BYTES) {
    throw new Error("CSS exceeds the local lint byte limit");
  }
  let stylelint: typeof import("stylelint").default;
  try {
    ({ default: stylelint } = await import("stylelint"));
  } catch {
    throw new Error("Optional local Stylelint engine is not installed");
  }
  const run = await stylelint.lint({
    code: css,
    config: { rules: RULES },
  });
  if (!Array.isArray(run.results) || run.results.length !== 1
    || !Array.isArray(run.results[0].warnings) || run.results[0].ignored) {
    throw new Error("Local Stylelint did not produce complete diagnostic evidence");
  }
  const warnings = run.results[0].warnings;
  if (run.errored && warnings.length === 0) {
    throw new Error("Local Stylelint failed without structured diagnostic evidence");
  }
  const counts = { error: 0, warning: 0, compatibilityLimitation: 0 };
  const messages = warnings.slice(0, MAX_VALIDATION_MESSAGES).map((item) => {
    const severity = item.severity === "warning" ? "warning" : "error";
    counts[severity] += 1;
    // Only fixed configured rule IDs and generic text, never source CSS or selectors.
    const rule = typeof item.rule === "string" && Object.hasOwn(RULES, item.rule)
      ? item.rule : "syntax-review";
    return {
      line: Number.isSafeInteger(item.line) && item.line >= 0 ? item.line : 0,
      type: severity,
      message: "Local Stylelint: " + rule + " requires review",
    };
  });
  for (const item of warnings.slice(MAX_VALIDATION_MESSAGES)) {
    counts[item.severity === "warning" ? "warning" : "error"] += 1;
  }
  return {
    messages,
    total: warnings.length,
    truncated: warnings.length > MAX_VALIDATION_MESSAGES,
    counts,
  };
}
