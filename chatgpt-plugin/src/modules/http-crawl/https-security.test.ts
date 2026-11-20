import { describe, expect, it } from "vitest";
import { load as loadCheerio } from "cheerio";
import {
  analyzeHttpsSecurity as analyzeHttpsSecurityCore, emptyHttpsSecurityReview,
  MAX_SECURITY_FINDINGS, MAX_SECURITY_HTML_BYTES, MAX_SECURITY_PAGES,
} from "./https-security";

const analyzeHttpsSecurity = (pages: Parameters<typeof analyzeHttpsSecurityCore>[0]) =>
  analyzeHttpsSecurityCore(pages, loadCheerio);

const base = "https://sample.example/";
const observed = (extra: Record<string, unknown> = {}) => ({
  url: base, status_code: 200, ...extra,
});
const codes = (data: ReturnType<typeof analyzeHttpsSecurity>) =>
  data.findings.map((finding) => finding.code);

describe("P1-13 pure security evidence under hosted Worker bundler", () => {
  it("shares the exact no-fetch HTTPS/HSTS/enforced CSP and frame policies", () => {
    const data = analyzeHttpsSecurity([observed({
      strict_transport_security: ["max-age=31536000; includeSubDomains"],
      content_security_policy: ["default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests"],
      referrer_policy: "no-referrer", x_content_type_options: "nosniff",
      htmlContent: "<html><body><script src='/assets/app.js'></script></body></html>",
    })]);
    expect(data.scope).toBe("caller_supplied_https_security_evidence_only");
    expect(data.https_observations).toBe(1);
    expect(data.pages[0].hsts_state).toBe("enabled");
    expect(data.pages[0].hsts_include_subdomains).toBe(true);
    expect(data.pages[0].csp_upgrade_insecure_requests).toBe(true);
    expect(data.pages[0].frame_protection_observed).toBe(true);
    expect(data.pages[0].nosniff_observed).toBe(true);
    expect(data.mixed_blockable_declarations).toBe(0);
    expect(data.total_findings).toBe(0);
    expect(data.coverage_limited).toBe(true);
  });

  it("distinguishes declared HTTP-to-HTTPS redirect and plain HTTP success", () => {
    const data = analyzeHttpsSecurity([
      observed({ url: "http://sample.example/", status_code: 301,
        location: "https://sample.example/" }),
      observed({ url: "http://sample.example/plain", status_code: 200 }),
    ]);
    expect(data.http_observations).toBe(2);
    expect(data.https_redirect_declarations).toBe(1);
    expect(data.http_without_secure_redirect).toBe(1);
    expect(codes(data)).toContain("http_success_without_redirect");
  });

  it("ignores HSTS over HTTP and distinguishes an explicit HTTPS disable", () => {
    const ignored = analyzeHttpsSecurity([observed({
      url: "http://sample.example/", strict_transport_security: ["max-age=3000"],
    })]);
    expect(ignored.pages[0].hsts_state).toBe("http_ignored");
    const disabled = analyzeHttpsSecurity([observed({
      strict_transport_security: ["max-age=0"],
    })]);
    expect(disabled.pages[0].hsts_state).toBe("disabled");
    expect(disabled.hsts_disabled_or_invalid).toBe(1);
  });

  it("report-only CSP does not claim enforcement and cannot upgrade HTTP subresources", () => {
    const data = analyzeHttpsSecurity([observed({
      content_security_policy_report_only: ["upgrade-insecure-requests; default-src https:"],
    })]);
    expect(data.pages[0].csp_state).toBe("report_only");
    expect(data.pages[0].csp_upgrade_insecure_requests).toBe(false);
    expect(data.report_only_csp_observations).toBe(1);
  });

  it("correctly combines HTML meta enforcement with a separate report-only header", () => {
    const data = analyzeHttpsSecurity([observed({
      content_security_policy_report_only: ["default-src 'none'"],
      htmlContent: '<head><meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"></head>',
    })]);
    expect(data.pages[0].csp_state).toBe("both");
    expect(data.pages[0].csp_upgrade_insecure_requests).toBe(true);
    expect(data.enforced_csp_observations).toBe(1);
    expect(data.report_only_csp_observations).toBe(0);
  });

  it("separates potentially blocked scripts and forms from upgradable media", () => {
    const data = analyzeHttpsSecurity([observed({
      htmlContent: '<html><head><link rel="stylesheet" href="http://cdn.example/app.css"></head>' +
        '<body><script src="http://cdn.example/app.js"></script>' +
        '<img src="http://cdn.example/photo.jpg">' +
        '<form action="http://sample.example/submit"></form></body></html>',
    })]);
    expect(data.mixed_blockable_declarations).toBe(2);
    expect(data.mixed_upgradable_declarations).toBe(1);
    expect(data.insecure_form_actions).toBe(1);
    expect(codes(data)).toContain("mixed_blockable");
    expect(codes(data)).toContain("insecure_form_action");
  });

  it("recognizes img srcset and IP-host mixed media as blockable candidates", () => {
    const data = analyzeHttpsSecurity([observed({
      htmlContent: '<img srcset="http://cdn.example/one.jpg 1x" src="http://192.0.2.1/a.jpg">',
    })]);
    expect(data.mixed_blockable_declarations).toBe(2);
    expect(data.pages[0].mixed_ip_host_declarations).toBe(1);
    expect(data.mixed_upgradable_declarations).toBe(0);
  });

  it("supports HTTPS head meta CSP upgrade without asserting frame-ancestors meta enforcement", () => {
    const data = analyzeHttpsSecurity([observed({
      htmlContent: '<head><meta http-equiv="Content-Security-Policy"' +
        ' content="upgrade-insecure-requests; frame-ancestors none"></head>',
    })]);
    expect(data.pages[0].csp_state).toBe("meta_only");
    expect(data.pages[0].csp_upgrade_insecure_requests).toBe(true);
    expect(data.pages[0].frame_protection_observed).toBe(false);
  });

  it("does not treat HTTPS content as mixed, protocol-relative URLs as HTTP or links as subresource fetches", () => {
    const data = analyzeHttpsSecurity([observed({
      htmlContent: '<img src="//cdn.example/image.jpg"><script src="https://cdn.example/app.js"></script>' +
        '<a href="http://elsewhere.example/">Link</a><form action="/submit"></form>',
    })]);
    expect(data.mixed_blockable_declarations).toBe(0);
    expect(data.mixed_upgradable_declarations).toBe(0);
    expect(data.insecure_form_actions).toBe(0);
  });

  it("recognizes conflicting HSTS and weak Referrer-Policy without echoing user headers", () => {
    const marker = "SECRET_IN_HEADER_P113";
    const data = analyzeHttpsSecurity([observed({
      strict_transport_security: ["max-age=1000", "max-age=0"],
      referrer_policy: "unsafe-url",
      location: "https://sample.example/" + marker,
    })]);
    expect(data.pages[0].hsts_state).toBe("conflicting");
    expect(data.pages[0].weak_referrer_policy).toBe(true);
    expect(codes(data)).toContain("hsts_conflicting");
    expect(codes(data)).toContain("weak_referrer_policy");
    expect(JSON.stringify(data)).not.toContain(marker);
  });

  it("does not treat 304 as an HTTP redirect, and uses last recognized Referrer-Policy fallback", () => {
    const r = analyzeHttpsSecurity([observed({
      url: "http://sample.example/", status_code: 304,
      referrer_policy: "unsafe-url, strict-origin-when-cross-origin",
    })]);
    expect(r.pages[0].unresolved_redirect).toBe(false);
    expect(r.pages[0].weak_referrer_policy).toBe(false);
    expect(codes(r)).not.toContain("http_redirect_unresolved");
  });

  it("rejects mixed hosts, duplicate URL labels and credential/query fragments", () => {
    for (const pages of [
      [observed(), observed()],
      [observed(), observed({ url: "https://other.example/" })],
      [observed({ url: "https://sample.example/?token=SECRET" })],
      [observed({ url: "https://me:pass@sample.example/" })],
      [observed({ url: "https://sample.example/path#secret" })],
    ]) {
      expect(() => analyzeHttpsSecurity(pages)).toThrow();
    }
  });

  it("fails closed on UTF-8 byte and CRLF limits without leaking header data", () => {
    expect(() => analyzeHttpsSecurity([
      observed({ htmlContent: "é".repeat(MAX_SECURITY_HTML_BYTES / 2 + 1) }),
    ])).toThrow();
    expect(() => analyzeHttpsSecurity([
      observed({ content_security_policy: ["default-src 'self'\r\nX-Injected: SECRET"] }),
    ])).toThrow();
    expect(() => analyzeHttpsSecurity([
      observed({ strict_transport_security: ["x".repeat(2100)] }),
    ])).toThrow();
  });

  it("bounds 8 supplied pages, 12 returned findings and reports honest truncation", () => {
    const pages = Array.from({ length: MAX_SECURITY_PAGES }, (_, i) => observed({
      url: base + "page" + i, htmlContent: '<script src="http://cdn.example/foo.js"></script>',
    }));
    const data = analyzeHttpsSecurity(pages);
    expect(data.pages_sampled).toBe(MAX_SECURITY_PAGES);
    expect(data.total_findings).toBeGreaterThan(MAX_SECURITY_FINDINGS);
    expect(data.findings).toHaveLength(MAX_SECURITY_FINDINGS);
    expect(data.findings_truncated).toBe(true);
    expect(JSON.stringify(data)).not.toContain("/page1");
    expect(JSON.stringify(data)).not.toContain("/foo.js");
    expect(emptyHttpsSecurityReview().pages_sampled).toBe(0);
  });
});
