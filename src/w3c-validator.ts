import {
  cancelResponseBody,
  getErrorMessage,
  readResponseText,
} from "./network.js";
import { PACKAGE_VERSION } from "./version.js";

export interface W3CMessage {
  type: string;
  lastLine?: number;
  lastColumn?: number;
  firstLine?: number;
  firstColumn?: number;
  message: string;
  extract?: string;
}

export interface CSSMessage {
  line: number;
  type: string;
  message: string;
  context?: string;
}

const VALIDATOR_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 2_000_000;
export const MAX_CSS_VALIDATION_BYTES = 128_000;
const MAX_VALIDATOR_RESPONSE_BYTES = 5_000_000;
const USER_AGENT = `mcp-web-validator/${PACKAGE_VERSION} (+https://digestseo.com/validator-mcp/)`;
export const MAX_VALIDATION_MESSAGES = 200;

function assertContentSize(content: string, maxBytes: number, label: string): void {
  const size = Buffer.byteLength(content, "utf8");
  if (size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte validation limit`);
  }
}

/**
 * Validates HTML using the W3C Nu HTML Checker API
 */
export async function validateHtmlContent(htmlContent: string): Promise<W3CMessage[]> {
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
      return [];
    }
    if (!Array.isArray(data.messages)) {
      throw new Error("W3C HTML validator returned an invalid response shape");
    }
    return data.messages.filter((message): message is W3CMessage => {
      if (typeof message !== "object" || message === null) {
        return false;
      }
      const candidate = message as Partial<W3CMessage>;
      return typeof candidate.type === "string" && typeof candidate.message === "string";
    }).slice(0, MAX_VALIDATION_MESSAGES);
  } catch (error: unknown) {
    throw new Error(`HTML validation failed: ${getErrorMessage(error)}`);
  }
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

    const errors = data.cssvalidation?.errors || [];
    return errors.slice(0, MAX_VALIDATION_MESSAGES).map(err => ({
      line: err.line || 0,
      type: "error",
      message: err.message ? err.message.trim() : "Unknown CSS validation error",
      context: err.context || undefined
    }));
  } catch (error: unknown) {
    throw new Error(`CSS validation failed: ${getErrorMessage(error)}`);
  }
}
