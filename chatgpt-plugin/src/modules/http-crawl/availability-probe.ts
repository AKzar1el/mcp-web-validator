import {
  probePublicHttp, PublicHtmlFetchError, PublicHttpProbeBudgetError,
} from "../../network";
import { toPublicHttpUrl } from "../../audits";
import type { AvailabilityObservation } from "./availability-observations";

/**
 * V02: bounded sequential GET observations, no timer-driven monitoring,
 * browser automation, persistence, or request-body acquisition.
 */
export async function collectPublicAvailability(
  url: string, checks = 3,
  requestAllowed?: () => Promise<boolean>,
): Promise<AvailabilityObservation[]> {
  if (!toPublicHttpUrl(url) || url.includes("?") || url.includes("#")) {
    throw new Error("A query-free public HTTP(S) URL is required.");
  }
  if (!Number.isInteger(checks) || checks < 2 || checks > 3) {
    throw new Error("A live availability burst must contain two or three checks.");
  }
  const observations: AvailabilityObservation[] = [];
  let previousTimestamp = -1;
  for (let index = 0; index < checks; index++) {
    const started = Date.now();
    let outcome: Pick<AvailabilityObservation, "status_code" | "failure" | "cf_challenge">;
    try {
      const hops = await probePublicHttp(url, async () => {
        if (requestAllowed && !(await requestAllowed())) {
          throw new PublicHttpProbeBudgetError("Public request budget exceeded");
        }
      });
      const final = hops.at(-1);
      outcome = final
        ? {
            status_code: final.status_code,
            cf_challenge: hops.some((hop) =>
              hop.headers?.["cf-mitigated"]?.trim().toLowerCase() === "challenge"),
          }
        : { failure: "fetch_error" };
    } catch (cause) {
      if (cause instanceof PublicHttpProbeBudgetError) throw cause;
      outcome = {
        failure: cause instanceof PublicHtmlFetchError && cause.code === "timeout"
          ? "timeout" : "fetch_error",
      };
    }
    const ended = Date.now();
    const stamp = Math.max(ended, previousTimestamp + 1);
    previousTimestamp = stamp;
    observations.push({
      observed_at: new Date(stamp).toISOString(),
      ...outcome,
      elapsed_ms: Math.min(120_000, Math.max(0, ended - started)),
    });
  }
  return observations;
}
