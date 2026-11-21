import { describe, expect, it } from "vitest";
import {
  analyzeProductionChange, MAX_CHANGE_HTML_BYTES,
} from "./production-change-comparison";

const url = "https://sample.example/page";
const html = (text = "early sample content") =>
  `<html><head><title>Original</title><meta name="description" content="first"><link rel="canonical" href="${url}"></head><body><main><h1>Heading</h1><p>${text}</p><a href="/other">Other</a></main></body></html>`;
const pair = (before = html(), after = before) => ({
  page_url: url,
  baseline: { observed_at: "2026-11-20T09:00:00Z", http_status: 200, html: before },
  current: { observed_at: "2026-11-21T09:00:00Z", http_status: 200, html: after },
});
const codes = (r: Awaited<ReturnType<typeof analyzeProductionChange>>) =>
  r.findings.map((f) => f.code);

describe("V10 shared production baseline analyzer in hosted Worker", () => {
  it("compares identical same-page HTML without network or server state", async () => {
    const r = await analyzeProductionChange(pair());
    expect(r.scope).toBe("two_caller_supplied_html_observations");
    expect(r.status).toBe("comparable_snapshot");
    expect(r.baseline.html_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.html_fingerprint_changed).toBe(false);
    expect(r.main_text_fingerprint_changed).toBe(false);
    expect(r.title_changed).toBe(false);
    expect(r.total_findings).toBe(0);
  });
  it("finds canonical, noindex and main-content changes without revealing values", async () => {
    const secret = "HIDDEN-HOSTED-META-VALUE";
    const changed = `<html><head><title>${secret}</title><meta name="robots" content="noindex"><link rel="canonical" href="/private-target"></head><body><main><h1>New</h1><p>${secret} update</p><a href="/second">Other</a></main></body></html>`;
    const r = await analyzeProductionChange(pair(html(),changed));
    expect(r.title_changed).toBe(true);
    expect(r.canonical_changed).toBe(true);
    expect(r.noindex_added).toBe(true);
    expect(r.main_text_fingerprint_changed).toBe(true);
    expect(codes(r)).toContain("noindex_added");
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain("private-target");
    expect(JSON.stringify(r)).not.toContain(url);
  });
  it("reports HTTP failure as non-comparable rather than a content improvement", async () => {
    const p = pair();
    p.current.http_status = 503;
    p.current.html = "<html>bad gateway</html>";
    const r = await analyzeProductionChange(p);
    expect(r.status).toBe("not_comparable");
    expect(r.title_changed).toBeNull();
    expect(r.main_text_fingerprint_changed).toBeNull();
    expect(codes(r)).toContain("delivery_not_comparable");
  });
  it("distinguishes static-snapshot drift from changed main text", async () => {
    const r = await analyzeProductionChange(pair(html(),html().replace("<head>", "<head>\n")));
    expect(r.html_fingerprint_changed).toBe(true);
    expect(r.main_text_fingerprint_changed).toBe(false);
    expect(codes(r)).toContain("html_only_changed");
  });
  it("fails on reversed timestamps and unsafe URLs", async () => {
    const p = pair();
    p.current.observed_at = "2026-11-18T09:00:00Z";
    await expect(analyzeProductionChange(p)).rejects.toThrow();
    p.current.observed_at = "2026-11-21T09:00:00Z";
    p.page_url = "https://sample.example/page?auth=secret";
    await expect(analyzeProductionChange(p)).rejects.toThrow();
  });
  it("enforces UTF-8 byte limits", async () => {
    const p = pair();
    p.current.html = "é".repeat(Math.ceil(MAX_CHANGE_HTML_BYTES/2) + 1);
    await expect(analyzeProductionChange(p)).rejects.toThrow();
  });
});
