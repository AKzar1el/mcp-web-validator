import { lookup } from "node:dns/promises";
import * as fs from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import * as path from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DNS_TIMEOUT_MS = 5_000;
const MAX_URL_LENGTH = 8_192;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const blockedHostnameSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export interface PublicFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface PublicTextOptions extends PublicFetchOptions {
  maxBytes?: number;
}

export interface PublicTextResult {
  text: string;
  url: string;
  status: number;
  contentType: string | null;
}

export interface PublicHttpResult {
  response: Response;
  url: URL;
}

export class PublicUrlError extends Error {
  override readonly name = "PublicUrlError";
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Request timed out";
    }
    return error.message || error.name;
  }

  return typeof error === "string" && error.trim() ? error : "Unknown error";
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.replace(/\.$/, "").toLowerCase();
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) {
    return !blockedAddresses.check(address, "ipv4");
  }

  if (family === 6) {
    return publicIpv6Addresses.check(address, "ipv6")
      && !blockedAddresses.check(address, "ipv6");
  }

  return false;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Parses an HTTP(S) URL and rejects hostnames that resolve to local, private,
 * documentation, multicast, or otherwise non-public address space.
 */
export async function assertPublicHttpUrl(input: string | URL): Promise<URL> {
  const rawUrl = input instanceof URL ? input.href : input;
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    throw new PublicUrlError(`URL must contain between 1 and ${MAX_URL_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PublicUrlError("URL must be an absolute HTTP or HTTPS URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PublicUrlError("Only HTTP and HTTPS URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new PublicUrlError("URLs containing credentials are not allowed");
  }
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new PublicUrlError("Only standard HTTP ports 80 and 443 are allowed");
  }

  parsed.hash = "";
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new PublicUrlError("URL hostname is required");
  }
  if (
    blockedHostnames.has(hostname)
    || blockedHostnameSuffixes.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new PublicUrlError(`URL hostname "${hostname}" is not public`);
  }

  const literalFamily = isIP(hostname);
  const resolvedAddresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await withTimeout(
      lookup(hostname, { all: true, verbatim: true }),
      DNS_TIMEOUT_MS,
      "DNS lookup",
    ).catch((error: unknown) => {
      throw new PublicUrlError(`Unable to resolve URL hostname: ${getErrorMessage(error)}`);
    });

  if (resolvedAddresses.length === 0) {
    throw new PublicUrlError("URL hostname did not resolve to an address");
  }

  for (const record of resolvedAddresses) {
    if (!isPublicAddress(record.address, record.family)) {
      throw new PublicUrlError(`URL hostname resolves to non-public address ${record.address}`);
    }
  }

  return parsed;
}

export async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // The stream may already be closed or consumed; there is nothing left to release.
  }
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  assertPositiveInteger(maxBytes, "maxBytes");

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`Response exceeds the ${maxBytes}-byte limit`);
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${maxBytes}-byte limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Fetches a public HTTP(S) URL while validating every redirect target. */
export async function fetchPublicHttp(
  input: string | URL,
  options: PublicFetchOptions = {},
): Promise<PublicHttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertPositiveInteger(timeoutMs, "timeoutMs");
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("maxRedirects must be an integer between 0 and 10");
  }

  let currentUrl = await assertPublicHttpUrl(input);
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      method: options.method ?? "GET",
      headers: options.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!redirectStatuses.has(response.status)) {
      return { response, url: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { response, url: currentUrl };
    }

    if (redirectCount >= maxRedirects) {
      return { response, url: currentUrl };
    }

    await cancelResponseBody(response);
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, currentUrl);
    } catch {
      throw new PublicUrlError("Redirect target is not a valid URL");
    }
    currentUrl = await assertPublicHttpUrl(redirectUrl);
  }
}

/** Fetches bounded text from a public URL and rejects non-success responses. */
export async function fetchPublicText(
  input: string | URL,
  options: PublicTextOptions = {},
): Promise<PublicTextResult> {
  const maxBytes = options.maxBytes ?? 2_000_000;
  assertPositiveInteger(maxBytes, "maxBytes");

  const { response, url } = await fetchPublicHttp(input, {
    method: "GET",
    headers: options.headers,
    timeoutMs: options.timeoutMs,
    maxRedirects: options.maxRedirects,
  });

  if (!response.ok) {
    const status = response.status;
    await cancelResponseBody(response);
    throw new Error(`URL returned HTTP status ${status}`);
  }

  return {
    text: await readResponseText(response, maxBytes),
    url: url.href,
    status: response.status,
    contentType: response.headers.get("content-type"),
  };
}

/** Reads a UTF-8 file only when it is a regular file within the requested cap. */
export async function readTextFile(filePath: string, maxBytes: number): Promise<string> {
  assertPositiveInteger(maxBytes, "maxBytes");
  const resolvedPath = path.resolve(filePath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${resolvedPath}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes}-byte limit: ${resolvedPath}`);
  }

  const contents = await fs.readFile(resolvedPath);
  if (contents.byteLength > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes}-byte limit: ${resolvedPath}`);
  }
  return contents.toString("utf8");
}
