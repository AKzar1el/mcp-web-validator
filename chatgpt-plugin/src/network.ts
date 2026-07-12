import { HTML_MAX_LENGTH, SERVICE_USER_AGENT } from "./constants";
import { toPublicHttpUrl } from "./audits";

const MAX_PUBLIC_URL_LENGTH = 2_048;
const MAX_PUBLIC_HTML_BYTES = 1024 * 1024;
const MAX_PUBLIC_HTML_REDIRECTS = 3;
const PUBLIC_HTML_TIMEOUT_MS = 12_000;
const SERVICE_HOSTNAME = "web-validator-mcp.digestseo.com";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchedPublicHtml {
  html: string;
  requestedUrl: string;
  finalUrl: string;
  redirectsFollowed: number;
  status: number;
  contentType: "text/html";
}

export interface FetchedPublicText {
  text: string;
  requestedUrl: string;
  finalUrl: string;
  redirectsFollowed: number;
  status: number;
  contentType: string;
}

export interface FetchPublicHtmlOptions {
  /** Restricts the requested URL and every redirect to this exact origin. */
  allowedOrigin?: string;
}

export interface FetchPublicTextOptions {
  /** Restricts the requested URL and every redirect to this exact origin. */
  allowedOrigin: string;
  acceptedContentTypes: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
}

export type PublicHtmlFetchErrorCode =
  | "invalid_url"
  | "blocked_url"
  | "scope"
  | "redirect"
  | "http_status"
  | "content_type"
  | "too_large"
  | "timeout"
  | "empty"
  | "fetch_failed";

export class PublicHtmlFetchError extends Error {
  override readonly name = "PublicHtmlFetchError";

  constructor(
    readonly code: PublicHtmlFetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function requirePublicPageUrl(value: string, baseUrl?: string): URL {
  if (value.length === 0 || value.length > MAX_PUBLIC_URL_LENGTH) {
    throw new PublicHtmlFetchError(
      "invalid_url",
      `URL must contain between 1 and ${MAX_PUBLIC_URL_LENGTH} characters.`,
    );
  }

  const url = toPublicHttpUrl(value, baseUrl);
  if (!url) {
    throw new PublicHtmlFetchError(
      "blocked_url",
      "Use a public HTTP(S) URL without credentials or a custom port.",
    );
  }
  if (url.hostname.toLowerCase() === SERVICE_HOSTNAME) {
    throw new PublicHtmlFetchError("blocked_url", "The MCP service cannot fetch itself.");
  }

  url.hash = "";
  return url;
}

function requireAllowedOrigin(url: URL, allowedOrigin: string | undefined): void {
  if (allowedOrigin && url.origin !== allowedOrigin) {
    throw new PublicHtmlFetchError(
      "scope",
      "Crawl resources must remain on the authorized website origin.",
    );
  }
}

async function cancelQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort connection cleanup; the stream may already be closed.
  }
}

/** Reads a response body without ever buffering more than the configured cap. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await cancelQuietly(response);
    throw new Error(tooLargeMessage);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(tooLargeMessage);
        throw new Error(tooLargeMessage);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Fetches one bounded public HTML document while validating every redirect. */
export async function fetchPublicHtml(
  value: string,
  options: FetchPublicHtmlOptions = {},
): Promise<FetchedPublicHtml> {
  const requestedUrl = requirePublicPageUrl(value);
  requireAllowedOrigin(requestedUrl, options.allowedOrigin);
  let currentUrl = requestedUrl;
  const visited = new Set<string>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_HTML_TIMEOUT_MS);

  try {
    for (let redirectsFollowed = 0; ; redirectsFollowed += 1) {
      requireAllowedOrigin(currentUrl, options.allowedOrigin);
      if (visited.has(currentUrl.href)) {
        throw new PublicHtmlFetchError("redirect", "The page returned a redirect loop.");
      }
      visited.add(currentUrl.href);

      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "text/html",
          "user-agent": SERVICE_USER_AGENT,
        },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await cancelQuietly(response);
        if (!location) {
          throw new PublicHtmlFetchError("redirect", "The page returned a redirect without a destination.");
        }
        if (redirectsFollowed >= MAX_PUBLIC_HTML_REDIRECTS) {
          throw new PublicHtmlFetchError(
            "redirect",
            `The page exceeded the ${MAX_PUBLIC_HTML_REDIRECTS}-redirect limit.`,
          );
        }

        const nextUrl = requirePublicPageUrl(location, currentUrl.href);
        requireAllowedOrigin(nextUrl, options.allowedOrigin);
        if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
          throw new PublicHtmlFetchError("redirect", "An HTTPS-to-HTTP redirect was blocked.");
        }
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        const status = response.status;
        await cancelQuietly(response);
        throw new PublicHtmlFetchError("http_status", `The page returned HTTP ${status}.`);
      }

      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "text/html") {
        await cancelQuietly(response);
        throw new PublicHtmlFetchError(
          "content_type",
          "The URL must return an HTML page with a text/html content type.",
        );
      }

      let html: string;
      try {
        html = await readBoundedResponseText(
          response,
          MAX_PUBLIC_HTML_BYTES,
          "The page exceeds the 1 MiB download limit.",
        );
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes("1 MiB")) {
          throw new PublicHtmlFetchError("too_large", cause.message);
        }
        throw cause;
      }
      if (!html.trim()) {
        throw new PublicHtmlFetchError("empty", "The page returned empty HTML.");
      }
      if (html.length > HTML_MAX_LENGTH) {
        throw new PublicHtmlFetchError(
          "too_large",
          `The page exceeds the ${HTML_MAX_LENGTH.toLocaleString("en-US")}-character HTML limit.`,
        );
      }

      return {
        html,
        requestedUrl: requestedUrl.href,
        finalUrl: currentUrl.href,
        redirectsFollowed,
        status: response.status,
        contentType: "text/html",
      };
    }
  } catch (cause) {
    if (cause instanceof PublicHtmlFetchError) throw cause;
    if (controller.signal.aborted) {
      throw new PublicHtmlFetchError("timeout", "The page fetch timed out after 12 seconds.");
    }
    throw new PublicHtmlFetchError("fetch_failed", "The public page could not be fetched.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches a small public text resource (for example robots.txt or a sitemap)
 * with the same URL, redirect, credential, timeout, and response-size guards
 * as the public HTML fetcher. Callers must lock requests to a crawl origin.
 */
export async function fetchPublicText(
  value: string,
  options: FetchPublicTextOptions,
): Promise<FetchedPublicText> {
  const requestedUrl = requirePublicPageUrl(value);
  requireAllowedOrigin(requestedUrl, options.allowedOrigin);
  let currentUrl = requestedUrl;
  const visited = new Set<string>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PUBLIC_HTML_TIMEOUT_MS);

  try {
    for (let redirectsFollowed = 0; ; redirectsFollowed += 1) {
      requireAllowedOrigin(currentUrl, options.allowedOrigin);
      if (visited.has(currentUrl.href)) {
        throw new PublicHtmlFetchError("redirect", "The resource returned a redirect loop.");
      }
      visited.add(currentUrl.href);

      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: options.acceptedContentTypes.join(", "),
          "user-agent": SERVICE_USER_AGENT,
        },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await cancelQuietly(response);
        if (!location) {
          throw new PublicHtmlFetchError("redirect", "The resource returned a redirect without a destination.");
        }
        if (redirectsFollowed >= MAX_PUBLIC_HTML_REDIRECTS) {
          throw new PublicHtmlFetchError(
            "redirect",
            `The resource exceeded the ${MAX_PUBLIC_HTML_REDIRECTS}-redirect limit.`,
          );
        }

        const nextUrl = requirePublicPageUrl(location, currentUrl.href);
        requireAllowedOrigin(nextUrl, options.allowedOrigin);
        if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
          throw new PublicHtmlFetchError("redirect", "An HTTPS-to-HTTP redirect was blocked.");
        }
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        const status = response.status;
        await cancelQuietly(response);
        throw new PublicHtmlFetchError("http_status", `The resource returned HTTP ${status}.`);
      }

      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase() ?? "";
      if (!options.acceptedContentTypes.includes(contentType)) {
        await cancelQuietly(response);
        throw new PublicHtmlFetchError("content_type", "The resource returned an unsupported content type.");
      }

      let text: string;
      try {
        text = await readBoundedResponseText(
          response,
          options.maxBytes,
          "The resource exceeds the configured download limit.",
        );
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes("configured download limit")) {
          throw new PublicHtmlFetchError("too_large", cause.message);
        }
        throw cause;
      }
      if (!text.trim()) {
        throw new PublicHtmlFetchError("empty", "The resource was empty.");
      }

      return {
        text,
        requestedUrl: requestedUrl.href,
        finalUrl: currentUrl.href,
        redirectsFollowed,
        status: response.status,
        contentType,
      };
    }
  } catch (cause) {
    if (cause instanceof PublicHtmlFetchError) throw cause;
    if (controller.signal.aborted) {
      throw new PublicHtmlFetchError("timeout", "The resource fetch timed out after 12 seconds.");
    }
    throw new PublicHtmlFetchError("fetch_failed", "The public resource could not be fetched.");
  } finally {
    clearTimeout(timer);
  }
}
