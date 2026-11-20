import { fetchPublicHttp, readResponseText } from "../../network.js";
import { safeHttpResourceUrl } from "./non-html-directives.js";
import {
  analyzeRedirectCanonicalChains, canonicalHrefsFromLinkHeader,
  MAX_CHAIN_HOPS, MAX_CHAIN_HTML_BYTES,
  type RedirectChainObservation, type RedirectCanonicalReview,
} from "./redirect-canonical-chains.js";

/**
 * Live V04: a bounded single URL chain, safely resolved with DNS-pinned
 * outbound HTTP. Bodies are read only on a final 2xx HTML response.
 */
export async function probeRedirectCanonicalChain(
  url: string,
  expected_destination?: string,
): Promise<RedirectCanonicalReview> {
  const safe = safeHttpResourceUrl(url);
  if (!safe) throw new Error("The live chain source must be a safe query-free public URL.");
  const initial = new URL(safe);
  const observations: RedirectChainObservation[] = [];
  let htmlEvidenceLimited = false;
  try {
    const { response, url: final } = await fetchPublicHttp(safe, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "user-agent": "mcp-web-validator-redirect-diagnostics/1",
      },
      timeoutMs: 12_000,
      maxRedirects: Math.min(5, MAX_CHAIN_HOPS - 1),
      allowRedirect: (next, current) =>
        next.origin === initial.origin && Boolean(safeHttpResourceUrl(next.href)) &&
        !(current.protocol === "https:" && next.protocol === "http:"),
      onResponse: (location, fetched) => {
        observations.push({
          url: location.href,
          status_code: fetched.status,
          ...(fetched.headers.has("location")
            ? { location: fetched.headers.get("location") ?? "" } : {}),
          canonicals: canonicalHrefsFromLinkHeader(fetched.headers.get("link")),
          x_robots_tag: fetched.headers.has("x-robots-tag")
            ? [fetched.headers.get("x-robots-tag") ?? ""] : [],
        });
      },
    });
    try {
      const mime = response.headers.get("content-type")
        ?.split(";", 1)[0].trim().toLowerCase();
      const finalRecord = observations.at(-1);
      if (finalRecord && finalRecord.url === final.href &&
        response.status >= 200 && response.status <= 299 &&
        (mime === "text/html" || mime === "application/xhtml+xml")) {
        try {
          finalRecord.html = await readResponseText(response, MAX_CHAIN_HTML_BYTES);
        } catch {
          htmlEvidenceLimited = true;
        }
      }
    } finally {
      try { await response.body?.cancel(); } catch { /* Response already closed. */ }
    }
    const result = analyzeRedirectCanonicalChains({
      source_url: safe, observations,
      ...(expected_destination ? { expected_destination } : {}),
    }, "live_public_redirect_probe");
    if (htmlEvidenceLimited) {
      result.error = "Final HTML could not be inspected within the 1 MiB text/encoding cap.";
    }
    return result;
  } catch {
    if (!observations.length) {
      throw new Error("The public HTTP redirect probe failed before any response was observed.");
    }
    const partial = analyzeRedirectCanonicalChains({
      source_url: safe, observations,
      ...(expected_destination ? { expected_destination } : {}),
    }, "live_public_redirect_probe");
    partial.error = "The response sequence could not be completed within the public URL, DNS and timeout limits.";
    partial.chain_complete = false;
    partial.final_status_code = undefined;
    partial.expected_destination_match = undefined;
    return partial;
  }
}
