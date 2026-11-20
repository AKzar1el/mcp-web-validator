// V01 Worker-safe adapter to the shared, bounded pure response analyzer.
export {
  analyzeHttpDelivery,
  emptyDeliveryReview,
  deliveryResponseHeaders,
  MAX_DELIVERY_HOPS,
  MAX_DELIVERY_FINDINGS,
  MAX_DELIVERY_HEADER_VALUE_BYTES,
  MAX_DELIVERY_TOTAL_HEADER_BYTES,
  DELIVERY_HEADER_NAMES,
  DELIVERY_FINDING_CODES,
} from "../../../../src/modules/http-crawl/http-delivery";
export type {
  DeliveryInputHop, DeliveryHop, DeliveryFinding, DeliveryFindingCode,
  DeliveryReview, DeliveryStatus, DeliveryRedirectTarget, DeliveryCacheState,
} from "../../../../src/modules/http-crawl/http-delivery";
