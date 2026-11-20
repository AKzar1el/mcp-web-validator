// V02 Worker-safe shared availability sample analyzer.
export {
  analyzeAvailabilityHistory, emptyAvailabilityReview,
  validateAvailabilityObservation, availabilityState,
  MAX_AVAILABILITY_OBSERVATIONS, MAX_AVAILABILITY_FINDINGS,
  AVAILABILITY_FAILURE_CODES, AVAILABILITY_STATES, AVAILABILITY_FINDING_CODES,
} from "../../../../src/modules/http-crawl/availability-observations";
export type {
  AvailabilityObservation, AvailabilitySample, AvailabilityReview,
  AvailabilityFinding, AvailabilityFailureCode, AvailabilityState, AvailabilityFindingCode,
} from "../../../../src/modules/http-crawl/availability-observations";
