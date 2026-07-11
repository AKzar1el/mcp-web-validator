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

const VALIDATOR_TIMEOUT_MS = 15_000;
const VALIDATOR_USER_AGENT = "DigestSEO-Web-Validator/0.1 (+https://digestseo.com/validator-mcp/)";

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATOR_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Sends supplied markup to the W3C Nu HTML Checker and returns capped diagnostics. */
export async function validateHtml(html: string): Promise<ValidationMessage[]> {
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

  const data = (await response.json()) as {
    messages?: Array<{
      type?: string;
      message?: string;
      lastLine?: number;
      lastColumn?: number;
    }>;
  };
  return (data.messages ?? []).slice(0, 200).map((item) => ({
    type: item.type === "error" ? "error" : item.type === "info" ? "info" : "warning",
    message: item.message ?? "Validator returned an unspecified message.",
    line: item.lastLine,
    column: item.lastColumn,
  }));
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
