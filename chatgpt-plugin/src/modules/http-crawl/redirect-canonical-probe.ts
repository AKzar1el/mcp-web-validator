import {
  fetchPublicHtml, probePublicHttp, PublicHttpProbeBudgetError,
} from "../../network";
import { safeHttpResourceUrl } from "./non-html-directives";
import {
  analyzeRedirectCanonicalChains, MAX_CHAIN_HTML_BYTES,
  type RedirectChainObservation, type RedirectCanonicalReview,
} from "./redirect-canonical-chains";

/**
 * Hosted V04 uses existing guarded HTTP probes. Its second bounded GET for
 * final HTML is sampled independently, only if the first probe saw HTTP 2xx.
 * The caller supplies the existing per-attempt rate limiter callback.
 */
export async function probeRedirectCanonicalChain(
  url: string,
  expected_destination?: string,
  beforeRequest?: () => Promise<void>,
): Promise<RedirectCanonicalReview> {
  const safe = safeHttpResourceUrl(url);
  if (!safe) throw new Error("The live chain source must be a safe query-free public URL.");
  const hops = await probePublicHttp(safe, beforeRequest);
  if (!hops.length) throw new Error("No public HTTP response was observed.");
  const observations: RedirectChainObservation[] = hops.map((hop) => ({
    url: hop.url, status_code: hop.status_code,
    ...(hop.headers?.location ? { location: hop.headers.location } : {}),
  }));

  const last = observations.at(-1)!;
  let limited = false;
  if (last.status_code >= 200 && last.status_code <= 299) {
    try {
      const html = await fetchPublicHtml(last.url, {
        allowedOrigin: new URL(safe).origin,
        allowRedirect: () => false,
        beforeRequest,
      });
      if (html.finalUrl === last.url && html.status === last.status_code) {
        if (new TextEncoder().encode(html.html).byteLength <= MAX_CHAIN_HTML_BYTES) {
          last.html = html.html;
        } else limited = true;
        last.x_robots_tag = html.xRobotsTag ? [html.xRobotsTag] : [];
      } else limited = true;
    } catch (cause) {
      if (cause instanceof PublicHttpProbeBudgetError) throw cause;
      limited = true;
    }
  }

  const report = analyzeRedirectCanonicalChains({
    source_url: safe, observations,
    ...(expected_destination ? { expected_destination } : {}),
  }, "live_public_redirect_probe");
  if (limited) {
    report.error =
      "Final HTML/header evidence was unavailable or changed between guarded GET samples.";
  }
  return report;
}
