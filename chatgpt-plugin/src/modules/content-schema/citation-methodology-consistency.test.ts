import { describe, expect, it } from "vitest";
import { analyzeProvenance, observeProvenancePage } from "./citation-methodology-consistency";

const page = "https://example.com/report";
const source = "https://doi.org/10.1000/sample";
const method = "https://example.com/methodology";
const evidence = {
  as_of: "2026-11-19",
  sources: [{ id: "study_26", url: source }],
  datasets: [{ id: "query_sample", version: "v2", as_of: "2026-11-10",
    methodology_id: "method_one", max_age_days: 20 }],
  methodologies: [{ id: "method_one", url: method }],
};
const html = (body: string, head = "") =>
  '<html lang=en><head>' + head + '</head><body><nav><a rel=cite href="https://example.com/nav">Nav</a></nav>'
  + '<main>' + body + '</main><footer><a rel=cite href="https://example.com/footer">Footer</a></footer></body></html>';
const body = '<a rel=cite data-citation-id=study_26 href="' + source + '">Reference</a>'
  + '<div data-dataset-id=query_sample data-dataset-version=v2 data-dataset-as-of=2026-11-10 data-methodology-id=method_one></div>'
  + '<a data-methodology-id=method_one href="' + method + '">Methods</a>';

describe("P1-05 hosted citation/dataset/method provenance analysis", () => {
  it("agrees only with explicit caller supplied metadata", () => {
    const obs = observeProvenancePage(html(body,
      '<meta property=article:published_time content=2026-11-01>'
      + '<meta property=article:modified_time content=2026-11-10>'), page);
    const r = analyzeProvenance([obs], evidence);
    expect(r).toMatchObject({
      scope: "supplied_static_html_and_evidence", pages_sampled: 1,
      pages_eligible: 1, citations_observed: 1, datasets_observed: 1,
      methodologies_observed: 1, conflicting_declarations: 0,
      unverified_declarations: 0, coverage_limited: false, total_findings: 0,
    });
    expect(r.consistent_declarations).toBeGreaterThanOrEqual(6);
  });
  it("flags version, reference, methodology and snapshot-date mismatches", () => {
    const altered = body.replace(source, "https://example.com/other")
      .replace("data-dataset-version=v2", "data-dataset-version=v8")
      .replace("2026-11-10", "2026-11-08").replace(method, "https://example.com/other-method");
    const r = analyzeProvenance([observeProvenancePage(html(altered), page)], evidence);
    expect(r.conflicting_declarations).toBeGreaterThanOrEqual(4);
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining([
      "citation_target_differs_from_supplied_evidence", "dataset_version_conflict",
      "dataset_as_of_conflict", "methodology_link_conflict",
    ]));
  });
  it("does not fetch missing evidence, create bad claims or expose private reference URLs", () => {
    const observed = observeProvenancePage(html(
      '<a rel=cite data-citation-id=private_ref href="https://user:FAKE_TOKEN@example.com/a">A</a>'
      + '<a rel=cite href="https://example.com/unknown">B</a>'
      + '<div hidden><a rel=cite href="https://example.com/hidden">Hidden</a></div>'), page);
    const r = analyzeProvenance([observed]);
    expect(r.evidence_supplied).toBe(false);
    expect(r.conflicting_declarations).toBe(0);
    expect(r.citations_observed).toBe(2);
    expect(r.coverage_limited).toBe(true);
    expect(JSON.stringify(r)).not.toContain("FAKE_TOKEN");
  });
  it("only reports stale snapshots when a maximum age and reference date were supplied", () => {
    const stale = analyzeProvenance([observeProvenancePage(html(body), page)], {
      ...evidence, datasets: [{ ...evidence.datasets[0], max_age_days: 3 }],
    });
    expect(stale.findings.map((f) => f.code)).toContain("dataset_freshness_window_exceeded");
    const noAsOf = analyzeProvenance([observeProvenancePage(html(body), page)], {
      datasets: [{ ...evidence.datasets[0], max_age_days: 3 }],
    });
    expect(noAsOf.findings.map((f) => f.code)).not.toContain("dataset_freshness_window_exceeded");
  });
  it("honors page limits and truncated, deterministic findings", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      '<a rel=cite href="https://example.com/ref/' + i + '">Reference</a>').join("");
    const pages = Array.from({ length: 8 }, (_, i) =>
      observeProvenancePage(html(many), "https://example.com/report/" + i));
    const r = analyzeProvenance(pages);
    expect(r.coverage_limited).toBe(true);
    expect(r.findings.length).toBe(12);
    expect(r.findings_truncated).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThan(14_000);
    expect(r).toEqual(analyzeProvenance(pages));
  });
});
