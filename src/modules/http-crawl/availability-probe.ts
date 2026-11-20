import {
  type AvailabilityObservation,
} from "./availability-observations.js";
import { probeHttpDelivery } from "./http-delivery-probe.js";
import { safeHttpResourceUrl } from "./non-html-directives.js";
import { resolvePublicHttpUrl } from "../../network.js";

/**
 * V02: a tiny sequential, read-only GET burst. It deliberately does not store
 * observations or sleep in the background. Callers may separately save
 * individual results using the local availability history MCP. That tool
 * requests a single probe per opt-in capture.
 */
export async function collectPublicAvailability(
  url: string, checks = 3,
): Promise<AvailabilityObservation[]> {
  if (!safeHttpResourceUrl(url)) throw new Error("A safe query-free public URL is required.");
  // Do not silently record three synthetic failures for a private/reserved URL.
  await resolvePublicHttpUrl(url);
  if (!Number.isInteger(checks) || checks < 1 || checks > 3) {
    throw new Error("A live availability capture permits one to three checks.");
  }
  const items: AvailabilityObservation[] = [];
  let previousTimestamp = -1;
  for (let index = 0; index < checks; index++) {
    const started = Date.now();
    let outcome: Pick<AvailabilityObservation, "status_code" | "failure" | "cf_challenge">;
    try {
      const result = await probeHttpDelivery(url);
      outcome = result.final_http_status === undefined
        ? { failure: "fetch_error" }
        : { status_code: result.final_http_status,
          cf_challenge: result.challenges_observed > 0 };
    } catch {
      outcome = { failure: "fetch_error" };
    }
    const ended = Date.now();
    // Millisecond timestamps are rounded; monotonic tie-breaks preserve sample
    // ordering when two fast responses complete within the same clock tick.
    const stamp = Math.max(ended, previousTimestamp + 1);
    previousTimestamp = stamp;
    items.push({
      observed_at: new Date(stamp).toISOString(),
      ...outcome,
      elapsed_ms: Math.min(120_000, Math.max(0, ended - started)),
    });
  }
  return items;
}
