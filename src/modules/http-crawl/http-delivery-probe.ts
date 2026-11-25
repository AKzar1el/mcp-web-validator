import { fetchPublicHttp } from "../../network.js";
import { analyzeHttpDelivery, deliveryResponseHeaders, type DeliveryInputHop, type DeliveryReview } from "./http-delivery.js";
import { safeHttpResourceUrl } from "./non-html-directives.js";

/** Live point-in-time HTTP diagnostic, with DNS-pinned public target validation. */
export async function probeHttpDelivery(input: string): Promise<DeliveryReview> {
  const safe = safeHttpResourceUrl(input);
  if (!safe) throw new Error("Provide a public, query-free HTTP(S) URL.");
  const initial = new URL(safe);
  const observations: DeliveryInputHop[] = [];
  try {
    const { response } = await fetchPublicHttp(safe, {
      method: "GET",
      headers: { accept: "*/*", "user-agent": "mcp-web-validator-http-diagnostics/1" },
      timeoutMs: 12_000,
      maxRedirects: 3,
      allowRedirect: (next, current) =>
        next.origin === initial.origin && Boolean(safeHttpResourceUrl(next.href)) &&
        !(current.protocol === "https:" && next.protocol === "http:"),
      onResponse: (url, response) => {
        observations.push({
          url: url.href, status_code: response.status, method: "GET",
          headers: deliveryResponseHeaders(response.headers),
        });
      },
    });
    try {
      await response.body?.cancel();
    } catch {
      // The peer may have closed the stream already.
    }
    return analyzeHttpDelivery(observations, "live_public_http_probe");
  } catch {
    if (observations.length > 0) {
      const report = analyzeHttpDelivery(observations, "live_public_http_probe");
      report.error = "The redirect chain could not be completed within safe URL, DNS and timeout limits.";
      report.redirect_chain_complete = false;
      return report;
    }
    throw new Error("The public HTTP delivery probe failed or exceeded its timeout.");
  }
}
