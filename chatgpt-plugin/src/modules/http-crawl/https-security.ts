// P1-13: Worker-safe adapter to the exact same bounded pure analyzer.
export {
  analyzeHttpsSecurity,
  emptyHttpsSecurityReview,
  MAX_SECURITY_PAGES,
  MAX_SECURITY_FINDINGS,
  MAX_SECURITY_HEADER_BYTES,
  MAX_SECURITY_HEADER_VALUES,
  MAX_SECURITY_HEADER_TOTAL_BYTES,
  MAX_SECURITY_HTML_BYTES,
  MAX_SECURITY_TOTAL_HTML_BYTES,
  MAX_SECURITY_DOM_ELEMENTS,
  MAX_SECURITY_RESOURCE_DECLARATIONS,
  SECURITY_HSTS_STATES,
  SECURITY_CSP_STATES,
  SECURITY_FINDING_CODES,
} from "../../../../src/modules/http-crawl/https-security";
export type {
  HstsState, CspState, SecurityFindingCode,
  SecurityPageObservation, SecurityPageEvidence,
  SecurityFinding, HttpsSecurityReview,
} from "../../../../src/modules/http-crawl/https-security";
