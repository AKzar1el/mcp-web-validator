import { lookup } from "node:dns/promises";
import * as fs from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import * as path from "node:path";
import { getEncoding } from "encoding-sniffer/sniffer";
import { Agent } from "undici";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DNS_TIMEOUT_MS = 5_000;
const MAX_URL_LENGTH = 8_192;
const HTML_ENCODING_SNIFF_BYTES = 1_024;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
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
  ["3fff::", 20],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");

// IANA's 192.0.0.0/24 IETF Protocol Assignments block is not globally
// reachable by default. Only these two anycast addresses are currently
// marked globally reachable in the IANA IPv4 Special-Purpose Address Registry.
const ietfProtocolAssignmentsIpv4 = new BlockList();
ietfProtocolAssignmentsIpv4.addSubnet("192.0.0.0", 24, "ipv4");

const publicIetfProtocolAssignmentsIpv4 = new BlockList();
publicIetfProtocolAssignmentsIpv4.addAddress("192.0.0.9", "ipv4");
publicIetfProtocolAssignmentsIpv4.addAddress("192.0.0.10", "ipv4");

// IANA's 2001::/23 IETF Protocol Assignments block is not globally reachable
// by default. Only the more-specific allocations below are currently marked
// globally reachable in the IANA IPv6 Special-Purpose Address Registry.
const ietfProtocolAssignments = new BlockList();
ietfProtocolAssignments.addSubnet("2001::", 23, "ipv6");

const publicIetfProtocolAssignments = new BlockList();
for (const [network, prefix] of [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
] as const) {
  publicIetfProtocolAssignments.addSubnet(network, prefix, "ipv6");
}

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
  acceptedContentTypes?: readonly string[];
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

export interface ResolvedPublicHttpUrl {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
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
    if (
      ietfProtocolAssignmentsIpv4.check(address, "ipv4")
      && !publicIetfProtocolAssignmentsIpv4.check(address, "ipv4")
    ) {
      return false;
    }
    return !blockedAddresses.check(address, "ipv4");
  }

  if (family === 6) {
    if (
      ietfProtocolAssignments.check(address, "ipv6")
      && !publicIetfProtocolAssignments.check(address, "ipv6")
    ) {
      return false;
    }
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
export async function resolvePublicHttpUrl(input: string | URL): Promise<ResolvedPublicHttpUrl> {
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
  // URL normalizes matching defaults (HTTP :80 / HTTPS :443) to an empty port.
  // Any remaining port is custom or mismatched to the scheme and must be rejected.
  if (parsed.port) {
    throw new PublicUrlError("Only default HTTP and HTTPS ports are allowed");
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

  return { url: parsed, addresses: resolvedAddresses };
}

export async function assertPublicHttpUrl(input: string | URL): Promise<URL> {
  return (await resolvePublicHttpUrl(input)).url;
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

function getDeclaredCharacterEncoding(contentType: string | null): string | undefined {
  if (!contentType) {
    return undefined;
  }

  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  if (!match) {
    return undefined;
  }
  return (match[1] ?? match[2] ?? "").trim();
}

function isSupportedCharacterEncoding(encoding: string): boolean {
  try {
    new TextDecoder(encoding);
    return true;
  } catch {
    return false;
  }
}

function getXmlBomCharacterEncoding(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
      return "utf-32be";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
      return "utf-32le";
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return "utf-16be";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return "utf-16le";
    }
  }
  return undefined;
}

function getXmlCharacterEncoding(bytes: Uint8Array): string {
  const bomEncoding = getXmlBomCharacterEncoding(bytes);
  if (bomEncoding) {
    return bomEncoding;
  }
  if (bytes.length >= 4) {
    if (bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] === 0x3f) {
      return "utf-16be";
    }
    if (bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00) {
      return "utf-16le";
    }
  }

  const declarationBytes = bytes.subarray(0, HTML_ENCODING_SNIFF_BYTES);
  let declaration = "";
  for (const byte of declarationBytes) {
    declaration += byte < 0x80 ? String.fromCharCode(byte) : "\ufffd";
  }
  const match = /^<\?xml\s+[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/i.exec(declaration);
  return match?.[2].trim() || "utf-8";
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  encoding?: string,
  sniffHtmlEncoding = false,
  sniffXmlEncoding = false,
  preferXmlBom = false,
): Promise<string> {
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
  let totalBytes = 0;
  let text = "";
  let decoder: TextDecoder | undefined;
  let pendingChunks: Uint8Array[] = [];
  let pendingBytes = 0;

  const createDecoder = async (encodingLabel: string): Promise<TextDecoder> => {
    try {
      return new TextDecoder(encodingLabel);
    } catch {
      await reader.cancel();
      throw new Error(`Unsupported response character encoding "${encodingLabel}"`);
    }
  };

  const startDecoder = async (): Promise<void> => {
    if (decoder) return;
    let encodingLabel = encoding ?? "utf-8";
    if ((encoding === undefined && (sniffHtmlEncoding || sniffXmlEncoding)) || preferXmlBom) {
      const sniffLength = Math.min(pendingBytes, HTML_ENCODING_SNIFF_BYTES);
      const sniffBytes = new Uint8Array(sniffLength);
      let copied = 0;
      for (const chunk of pendingChunks) {
        if (copied >= sniffLength) break;
        const length = Math.min(chunk.byteLength, sniffLength - copied);
        sniffBytes.set(chunk.subarray(0, length), copied);
        copied += length;
      }
      if (preferXmlBom) {
        encodingLabel = getXmlBomCharacterEncoding(sniffBytes) ?? encodingLabel;
      } else {
        encodingLabel = sniffXmlEncoding
          ? getXmlCharacterEncoding(sniffBytes)
          : getEncoding(sniffBytes, {
              maxBytes: HTML_ENCODING_SNIFF_BYTES,
              defaultEncoding: "utf-8",
            });
      }
    }
    decoder = await createDecoder(encodingLabel);
    for (const chunk of pendingChunks) {
      text += decoder.decode(chunk, { stream: true });
    }
    pendingChunks = [];
    pendingBytes = 0;
  };

  if (!preferXmlBom && (encoding !== undefined || (!sniffHtmlEncoding && !sniffXmlEncoding))) {
    await startDecoder();
  }

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

      if (!decoder) {
        pendingChunks.push(value);
        pendingBytes += value.byteLength;
        if (pendingBytes >= HTML_ENCODING_SNIFF_BYTES) {
          await startDecoder();
        }
      } else {
        text += decoder.decode(value, { stream: true });
      }
    }
    await startDecoder();
    if (!decoder) {
      throw new Error("Response decoder was not initialized");
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function createPinnedDispatcher(
  resolvedAddresses: ReadonlyArray<{ address: string; family: number }>,
): Agent {
  const addresses = resolvedAddresses.map((record) => ({ ...record }));

  return new Agent({
    // Every validated request gets its own non-reused connection so a later DNS
    // answer cannot replace the address set approved for this hop.
    pipelining: 0,
    connect: {
      lookup: (_hostname, options, callback) => {
        const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
        const candidates = requestedFamily
          ? addresses.filter((record) => record.family === requestedFamily)
          : addresses;

        if (candidates.length === 0) {
          const error = new Error("No validated address is available for the requested IP family") as NodeJS.ErrnoException;
          error.code = "ENOTFOUND";
          callback(error, []);
          return;
        }

        if (options.all) {
          callback(null, candidates);
          return;
        }

        const selected = candidates[0];
        callback(null, selected.address, selected.family);
      },
    },
  });
}

function beginClosingDispatcher(dispatcher: Agent): void {
  // close() waits for the active response stream to finish, so starting it here
  // releases the request-scoped Agent without interrupting callers reading the body.
  void dispatcher.close().catch(() => {});
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

  let currentTarget = await resolvePublicHttpUrl(input);
  for (let redirectCount = 0; ; redirectCount += 1) {
    const dispatcher = createPinnedDispatcher(currentTarget.addresses);
    let response: Response;
    try {
      response = await fetch(currentTarget.url, {
        method: options.method ?? "GET",
        headers: options.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (error) {
      await dispatcher.close();
      throw error;
    }

    if (!redirectStatuses.has(response.status)) {
      beginClosingDispatcher(dispatcher);
      return { response, url: currentTarget.url };
    }

    const location = response.headers.get("location");
    if (!location) {
      beginClosingDispatcher(dispatcher);
      return { response, url: currentTarget.url };
    }

    if (redirectCount >= maxRedirects) {
      beginClosingDispatcher(dispatcher);
      return { response, url: currentTarget.url };
    }

    await cancelResponseBody(response);
    await dispatcher.close();
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, currentTarget.url);
    } catch {
      throw new PublicUrlError("Redirect target is not a valid URL");
    }
    currentTarget = await resolvePublicHttpUrl(redirectUrl);
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

  const contentTypeHeader = response.headers.get("content-type");
  const contentType = contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase() || null;
  if (
    options.acceptedContentTypes
    && !options.acceptedContentTypes.some((accepted) => accepted.trim().toLowerCase() === contentType)
  ) {
    await cancelResponseBody(response);
    throw new Error(`URL returned unsupported content type ${contentType ?? "missing"}`);
  }

  const declaredEncoding = getDeclaredCharacterEncoding(contentTypeHeader);
  const shouldSniffHtmlEncoding = contentType === "text/html"
    && (declaredEncoding === undefined || !isSupportedCharacterEncoding(declaredEncoding));
  const isXmlContentType = contentType !== null
    && (contentType === "application/xml" || contentType === "text/xml" || contentType.endsWith("+xml"));
  const shouldSniffXmlEncoding = declaredEncoding === undefined
    && isXmlContentType;
  const shouldPreferXmlBom = declaredEncoding !== undefined && isXmlContentType;
  return {
    text: await readResponseText(
      response,
      maxBytes,
      shouldSniffHtmlEncoding || shouldSniffXmlEncoding ? undefined : declaredEncoding,
      shouldSniffHtmlEncoding,
      shouldSniffXmlEncoding,
      shouldPreferXmlBom,
    ),
    url: url.href,
    status: response.status,
    contentType: contentTypeHeader,
  };
}

/** Reads a bounded regular text file, optionally applying HTML/XHTML encoding sniffing. */
export async function readTextFile(
  filePath: string,
  maxBytes: number,
  markupMediaType?: "text/html" | "application/xhtml+xml",
): Promise<string> {
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

  if (markupMediaType === undefined) {
    return contents.toString("utf8");
  }

  const sniffBytes = contents.subarray(0, HTML_ENCODING_SNIFF_BYTES);
  const encoding = markupMediaType === "application/xhtml+xml"
    ? getXmlCharacterEncoding(sniffBytes)
    : getEncoding(sniffBytes, {
        maxBytes: HTML_ENCODING_SNIFF_BYTES,
        defaultEncoding: "utf-8",
      });
  try {
    return new TextDecoder(encoding).decode(contents);
  } catch {
    throw new Error(`Unsupported local markup character encoding "${encoding}"`);
  }
}
