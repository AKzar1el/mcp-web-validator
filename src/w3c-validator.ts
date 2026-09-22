import {
  cancelResponseBody,
  getErrorMessage,
  readResponseText,
} from "./network.js";
import { PACKAGE_VERSION } from "./version.js";

export interface W3CMessage {
  type: string;
  subType?: string;
  lastLine?: number;
  lastColumn?: number;
  firstLine?: number;
  firstColumn?: number;
  message: string;
  extract?: string;
}

export type W3CMessageSeverity = "error" | "warning" | "info";

export interface HtmlValidationResult {
  messages: W3CMessage[];
  total: number;
  truncated: boolean;
  counts: Record<W3CMessageSeverity, number>;
}

export function getW3CMessageSeverity(
  message: Pick<W3CMessage, "type" | "subType">,
): W3CMessageSeverity {
  const type = message.type.trim().toLowerCase();
  if (type === "error" || type === "non-document-error") return "error";
  if (type === "warning" || (type === "info" && message.subType?.trim().toLowerCase() === "warning")) {
    return "warning";
  }
  return "info";
}

export interface CSSMessage {
  line: number;
  type: string;
  message: string;
  context?: string;
  compatibility?: "known-validator-limitation";
}

const VALIDATOR_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 2_000_000;
export const MAX_CSS_VALIDATION_BYTES = 128_000;
const MAX_VALIDATOR_RESPONSE_BYTES = 5_000_000;
const USER_AGENT = `mcp-web-validator/${PACKAGE_VERSION} (+https://digestseo.com/validator-mcp/)`;
export const MAX_VALIDATION_MESSAGES = 200;

function isKnownCssValidatorLimitation(type: string | undefined, message: string): boolean {
  if (type?.trim().toLowerCase() !== "at-rule") return false;
  const normalized = message.trim().toLowerCase().replace(/[“”"'‘’]/g, "");
  return normalized === "unrecognized at-rule @container";
}

function assertContentSize(content: string, maxBytes: number, label: string): void {
  const size = Buffer.byteLength(content, "utf8");
  if (size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte validation limit`);
  }
}

function normalizeW3CMessage(message: unknown): W3CMessage {
  if (typeof message !== "object" || message === null) {
    throw new Error("W3C HTML validator returned a malformed message");
  }

  const candidate = message as Record<string, unknown>;
  if (typeof candidate.type !== "string" || typeof candidate.message !== "string") {
    throw new Error("W3C HTML validator returned a malformed message");
  }

  const normalized: W3CMessage = {
    type: candidate.type,
    message: candidate.message,
  };

  for (const field of ["lastLine", "lastColumn", "firstLine", "firstColumn"] as const) {
    if (typeof candidate[field] === "number" && Number.isInteger(candidate[field])) {
      normalized[field] = candidate[field];
    }
  }

  if (typeof candidate.extract === "string") {
    normalized.extract = candidate.extract;
  }

  if (typeof candidate.subType === "string") {
    normalized.subType = candidate.subType;
  }

  return normalized;
}

/** Validates HTML using the W3C Nu HTML Checker API and retains bounded-output metadata. */
export async function validateHtmlContentDetailed(htmlContent: string): Promise<HtmlValidationResult> {
  const url = "https://validator.w3.org/nu/?out=json";

  try {
    assertContentSize(htmlContent, MAX_HTML_BYTES, "HTML content");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "User-Agent": USER_AGENT,
      },
      body: htmlContent,
      redirect: "error",
      signal: AbortSignal.timeout(VALIDATOR_TIMEOUT_MS),
    });

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`W3C HTML validator returned HTTP status ${response.status}`);
    }

    const text = await readResponseText(response, MAX_VALIDATOR_RESPONSE_BYTES);
    const data = JSON.parse(text) as { messages?: unknown };
    if (data.messages === undefined) {
      throw new Error("W3C HTML validator returned an invalid response shape");
    }
    if (!Array.isArray(data.messages)) {
      throw new Error("W3C HTML validator returned an invalid response shape");
    }
    const normalized = data.messages.map(normalizeW3CMessage);
    const counts: HtmlValidationResult["counts"] = { error: 0, warning: 0, info: 0 };
    for (const message of normalized) {
      counts[getW3CMessageSeverity(message)] += 1;
    }
    return {
      messages: normalized.slice(0, MAX_VALIDATION_MESSAGES),
      total: normalized.length,
      truncated: normalized.length > MAX_VALIDATION_MESSAGES,
      counts,
    };
  } catch (error: unknown) {
    throw new Error(`HTML validation failed: ${getErrorMessage(error)}`);
  }
}

/** Backwards-compatible convenience API returning capped diagnostics only. */
export async function validateHtmlContent(htmlContent: string): Promise<W3CMessage[]> {
  return (await validateHtmlContentDetailed(htmlContent)).messages;
}

/**
 * Validates CSS using the W3C Jigsaw CSS Validator API
 */
export async function validateCssContent(cssContent: string): Promise<CSSMessage[]> {
  const url = "https://jigsaw.w3.org/css-validator/validator";

  try {
    assertContentSize(cssContent, MAX_CSS_VALIDATION_BYTES, "CSS content");
    const form = new FormData();
    form.set("text", cssContent);
    form.set("output", "json");
    form.set("warning", "0");
    form.set("profile", "css3svg");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
      },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(VALIDATOR_TIMEOUT_MS),
    });

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`W3C CSS validator returned HTTP status ${response.status}`);
    }

    const text = await readResponseText(response, MAX_VALIDATOR_RESPONSE_BYTES);

    // An empty upstream response is indeterminate and must never be presented as a clean result.
    if (!text || text.trim() === "") {
      throw new Error("W3C CSS validator returned an empty response");
    }

    const data = JSON.parse(text) as {
      cssvalidation?: {
        errors?: Array<{
          line: number;
          message: string;
          context?: string;
          type?: string;
        }>;
        warnings?: Array<{
          line: number;
          message: string;
          context?: string;
          type?: string;
        }>;
      };
    };

    if (!data.cssvalidation || typeof data.cssvalidation !== "object") {
      throw new Error("W3C CSS validator returned an invalid response shape");
    }

    const errors = data.cssvalidation.errors || [];
    return errors.slice(0, MAX_VALIDATION_MESSAGES).map((err) => {
      const message = err.message ? err.message.trim() : "Unknown CSS validation error";
      return {
        line: err.line || 0,
        type: "error",
        message,
        context: err.context || undefined,
        ...(isKnownCssValidatorLimitation(err.type, message)
          ? { compatibility: "known-validator-limitation" as const }
          : {}),
      };
    });
  } catch (error: unknown) {
    throw new Error(`CSS validation failed: ${getErrorMessage(error)}`);
  }
}
