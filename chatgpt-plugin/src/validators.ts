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
const MIN_CSS_VALIDATION_INTERVAL_MS = 1_000;
let nextCssValidationAt = 0;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATOR_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCssValidationSlot(): Promise<void> {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextCssValidationAt);
  nextCssValidationAt = scheduledAt + MIN_CSS_VALIDATION_INTERVAL_MS;
  const delay = scheduledAt - now;
  if (delay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
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
      "user-agent": "DigestSEO-Web-Validator/0.1 (+https://digestseo.com/validator-mcp/)",
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

/** Sends supplied CSS to the W3C Jigsaw validator and returns capped diagnostics. */
export async function validateCss(css: string): Promise<CssValidationMessage[]> {
  const query = new URLSearchParams({
    text: css,
    output: "json",
    warning: "0",
    profile: "css3svg",
  });
  // The public Jigsaw API requests a pause between batch documents. This is an
  // in-isolate guard; platform-level abuse controls remain the host's job.
  await waitForCssValidationSlot();
  // The public Jigsaw API documents its text mode as a query-string request.
  const response = await fetchWithTimeout(
    `https://jigsaw.w3.org/css-validator/validator?${query.toString()}`,
    { method: "GET" },
  );
  if (!response.ok) throw new Error(`The W3C CSS validator returned HTTP ${response.status}.`);

  const data = (await response.json()) as {
    cssvalidation?: {
      errors?: Array<{ line?: number; message?: string; context?: string }>;
    };
  };
  return (data.cssvalidation?.errors ?? []).slice(0, 200).map((item) => ({
    line: item.line ?? 0,
    message: item.message?.trim() || "Validator returned an unspecified message.",
    context: item.context?.trim() || undefined,
  }));
}
