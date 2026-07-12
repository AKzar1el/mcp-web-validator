import postcss, { CssSyntaxError } from "postcss";

export interface ValidationMessage {
  type: "error" | "warning" | "info";
  message: string;
  line?: number;
  column?: number;
}

export interface CssValidationMessage {
  line: number;
  message: string;
  context?: string;
}

export interface HtmlValidationResult {
  messages: ValidationMessage[];
  total: number;
  truncated: boolean;
  counts: Record<ValidationMessage["type"], number>;
}

const VALIDATOR_TIMEOUT_MS = 15_000;
const MAX_VALIDATION_MESSAGES = 200;
const VALIDATOR_USER_AGENT = "DigestSEO-Web-Validator/0.3.0 (+https://digestseo.com/validator-mcp/)";

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATOR_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Sends supplied markup to the Nu HTML Checker and retains cap metadata. */
export async function validateHtmlDetailed(html: string): Promise<HtmlValidationResult> {
  // The Nu endpoint accepts server-side validation requests over Cloudflare's
  // production transport while returning the same standard Nu JSON format.
  const response = await fetchWithTimeout("https://html5.validator.nu/?out=json", {
    method: "POST",
    headers: {
      "content-type": "text/html; charset=utf-8",
      "user-agent": VALIDATOR_USER_AGENT,
    },
    body: html,
  });
  if (!response.ok) throw new Error(`The W3C HTML validator returned HTTP ${response.status}.`);

  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The Nu HTML Checker returned an invalid JSON payload.");
  }

  const rawMessages = (data as { messages?: unknown }).messages ?? [];
  if (!Array.isArray(rawMessages)) {
    throw new Error("The Nu HTML Checker returned an invalid messages payload.");
  }

  const messages: ValidationMessage[] = [];
  const counts: HtmlValidationResult["counts"] = { error: 0, warning: 0, info: 0 };
  for (const rawItem of rawMessages) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new Error("The Nu HTML Checker returned a malformed validation message.");
    }
    const item = rawItem as {
      type?: unknown;
      subType?: unknown;
      message?: unknown;
      lastLine?: unknown;
      lastColumn?: unknown;
    };
    const type: ValidationMessage["type"] =
      item.type === "error" || item.type === "non-document-error"
        ? "error"
        : item.type === "warning" || item.subType === "warning"
          ? "warning"
          : "info";
    counts[type] += 1;
    if (messages.length >= MAX_VALIDATION_MESSAGES) continue;

    messages.push({
      type,
      message: typeof item.message === "string" && item.message.trim()
        ? item.message
        : "Validator returned an unspecified message.",
      line: typeof item.lastLine === "number" && Number.isFinite(item.lastLine)
        ? item.lastLine
        : undefined,
      column: typeof item.lastColumn === "number" && Number.isFinite(item.lastColumn)
        ? item.lastColumn
        : undefined,
    });
  }

  return {
    messages,
    total: rawMessages.length,
    truncated: rawMessages.length > MAX_VALIDATION_MESSAGES,
    counts,
  };
}

/** Backwards-compatible convenience API returning capped diagnostics only. */
export async function validateHtml(html: string): Promise<ValidationMessage[]> {
  return (await validateHtmlDetailed(html)).messages;
}

/** Parses supplied CSS locally and returns syntax diagnostics without a network request. */
export function validateCss(css: string): CssValidationMessage[] {
  try {
    postcss.parse(css);
    return [];
  } catch (cause) {
    if (cause instanceof CssSyntaxError) {
      return [{
        line: cause.line ?? 0,
        message: cause.reason || "CSS syntax error.",
        context: "Local CSS syntax parser",
      }];
    }
    throw cause;
  }
}
