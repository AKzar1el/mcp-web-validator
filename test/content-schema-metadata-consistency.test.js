import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeMetadataConsistency, safeMetadataLabel, MAX_METADATA_FINDINGS, MAX_METADATA_VALUES,
} from "../dist/modules/content-schema/metadata-consistency.js";
import { observeMetadata } from "../dist/modules/content-schema/extract-metadata-consistency.js";

const base = "https://example.test";
const a = base + "/article", b = base + "/product", c = base + "/third";
const meta = (name, content) => '<meta name="' + name + '" content="' + content + '">';
const og = (name, content) => '<meta property="' + name + '" content="' + content + '">';
const canonical = (href, extra = "") => '<link rel="canonical" href="' + href + '" ' + extra + '>';
const html = (head, body = "") => '<!doctype html><html lang=en><head>'
  + head + '</head><body><main>' + body + '</main></body></html>';
const page = (url, markup) => observeMetadata(markup, url);
const find = (r, code) => r.findings.filter((f) => f.code === code);
const healthy = (url = a, title = "A Unique Article", description = "A purpose-specific page summary") =>
  page(url, html('<title>' + title + '</title>'
    + meta("description", description) + canonical(url) + og("og:title", title)
    + og("og:description", description) + og("og:url", url)));

test("P1-09 agreed metadata is observed without invented warnings", () => {
  const r=analyzeMetadataConsistency([healthy()]);
  assert.equal(r.pages_sampled,1);
  assert.equal(r.conflicting_declaration_fields,0);
  assert.equal(r.duplicate_declaration_fields,0);
  assert.equal(r.cross_field_review_leads,0);
  assert.equal(r.duplicate_title_groups,0);
  assert.equal(r.total_findings,0);
  assert.equal(r.coverage_limited,true);
});
test("P1-09 repeated identical declarations are not automatically contradictions", () => {
  const r=analyzeMetadataConsistency([page(a,html('<title>Same</title><title> same </title>'
    +meta("description","Good")+meta("description","GOOD")
    + canonical(a)+canonical(a)))]);
  assert.equal(r.duplicate_declaration_fields,3);
  assert.equal(r.conflicting_declaration_fields,0);
  assert(find(r,"duplicate_declaration").every((f)=>f.severity==="info"));
});
test("P1-09 incompatible title, description and canonical declarations are prioritized", () => {
  const r=analyzeMetadataConsistency([page(a,html('<title>Alpha</title><title>Beta</title>'
    +meta("description","One")+meta("description","Two")
    +canonical(a)+canonical(b)))]);
  assert.equal(r.conflicting_declaration_fields,3);
  assert.equal(find(r,"conflicting_declaration").length,3);
  assert(find(r,"conflicting_declaration").every((f)=>f.severity==="warning"));
  assert.equal(r.pages[0].conflicting_fields,3);
});
test("P1-09 social title and description differences are review-only, not hard SEO errors", () => {
  const r=analyzeMetadataConsistency([page(a,html('<title>Site title</title>'
    +meta("description","A unique site description")
    +og("og:title","Social title")+og("og:description","Social description")
    +meta("twitter:title","Twitter title")
    +meta("twitter:description","Twitter description")))]);
  assert.equal(r.cross_field_review_leads,4);
  assert.equal(find(r,"title_social_difference").length,2);
  assert.equal(find(r,"description_social_difference").length,2);
  assert(find(r,"title_social_difference").every((f)=>f.severity==="info"));
});
test("P1-09 relative canonical uses URL resolution without HTTP requests; absolute og:url may differ", () => {
  const matching=analyzeMetadataConsistency([page(a,html('<title>Example</title>'
    +canonical("/article")+og("og:url",a)))]);
  assert.equal(matching.cross_field_review_leads,0);
  const mismatched=analyzeMetadataConsistency([page(a,html('<title>Example</title>'
    +canonical("/article")+og("og:url",b)))]);
  assert.equal(mismatched.cross_field_review_leads,1);
  assert.equal(find(mismatched,"canonical_social_url_difference").length,1);
});
test("P1-09 canonical fragment, bad protocol and embedded credential never leak", () => {
  const r=analyzeMetadataConsistency([page(a,html(
    canonical("https://user:FAKE_SECRET@example.test/") +
    canonical("https://example.test/article#bad") +
    canonical("javascript:FAKE_PRIVATE")
    + og("og:url","https://example.test/article?token=FAKE_TOKEN")))]);
  assert.equal(r.unresolved_canonical_references,3);
  assert.equal(find(r,"unresolved_canonical").length,1);
  assert(!JSON.stringify(r).includes("FAKE_"));
  assert(!JSON.stringify(r).includes("/article"));
});
test("P1-09 base href is respected for relative canonical, invalid base fails closed", () => {
  const override=analyzeMetadataConsistency([page(a,html(
    '<base href="https://example.test/sub/">'+canonical("article")
    +og("og:url","https://example.test/sub/article")) )]);
  assert.equal(override.cross_field_review_leads,0);
  const invalid=analyzeMetadataConsistency([page(a,html(
    '<base href="javascript:FAKE_SECRET">'+canonical("article")))]);
  assert.equal(invalid.unresolved_canonical_references,1);
  assert(!JSON.stringify(invalid).includes("FAKE_SECRET"));
});
test("P1-09 annotated canonical is excluded, never assumed usable", () => {
  const r=analyzeMetadataConsistency([page(a,html(
    canonical(b,'hreflang="en"')+canonical(a)))]);
  assert.equal(r.excluded_annotated_canonicals,1);
  assert.equal(r.pages[0].canonical_declarations,1);
  assert.equal(r.conflicting_declaration_fields,0);
});
test("P1-09 normalizes robots case, detects explicit mixed noindex/index directives", () => {
  const r=analyzeMetadataConsistency([page(a,html(
    meta("robots","NOINDEX, index")+meta("googlebot","INDEX, FOLLOW")))]);
  assert.equal(r.explicit_robots_conflicts,1);
  assert.equal(find(r,"conflicting_robots_directives").length,1);
  assert.equal(r.pages[0].robots_declarations,2);
});
test("P1-09 body robots metadata is inspected but headers/search crawler state are not invented", () => {
  const r=analyzeMetadataConsistency([page(a,html('<title>A</title>',
    meta("robots","noindex") + meta("googlebot","index")) )]);
  assert.equal(r.explicit_robots_conflicts,1);
  assert(r.limitations.join(" ").includes("HTTP headers"));
});
test("P1-09 catches index/noindex split across distinct same-agent meta declarations", () => {
  const r=analyzeMetadataConsistency([page(a,html(
    meta("robots","index, follow") + meta("robots","noindex") ))]);
  assert.equal(r.explicit_robots_conflicts,1);
  assert.equal(r.conflicting_declaration_fields,1);
  assert.equal(find(r,"conflicting_robots_directives").length,1);
});
test("P1-09 expands explicit robots 'none' and 'all' directives before conflict checks", () => {
  const r=analyzeMetadataConsistency([page(a,html(
    meta("robots","none") + meta("robots","index, follow") ))]);
  assert.equal(r.explicit_robots_conflicts,1);
  assert.equal(find(r,"conflicting_robots_directives").length,1);
});
test("P1-09 treats equivalent robots aliases as duplicates and complementary directives as compatible", () => {
  const same=analyzeMetadataConsistency([page(a,html(
    meta("robots","all") + meta("robots","FOLLOW, INDEX")))]);
  assert.equal(same.duplicate_declaration_fields,1);
  assert.equal(same.conflicting_declaration_fields,0);
  const complementary=analyzeMetadataConsistency([page(a,html(
    meta("robots","noindex") + meta("robots","nofollow")))]);
  assert.equal(complementary.conflicting_declaration_fields,0);
  assert.equal(complementary.explicit_robots_conflicts,0);
  const conflictingValue=analyzeMetadataConsistency([page(a,html(
    meta("robots","max-snippet:1") + meta("robots","max-snippet:2")))]);
  assert.equal(conflictingValue.conflicting_declaration_fields,1);
});
test("P1-09 same title and descriptions on distinct sampled canonicals are contextual review leads", () => {
  const r=analyzeMetadataConsistency([healthy(a,"Same title","Same description"),
    healthy(b," same TITLE ","same   description")]);
  assert.equal(r.duplicate_title_groups,1);
  assert.equal(r.duplicate_description_groups,1);
  assert.equal(find(r,"duplicate_title_across_pages").length,1);
  assert.deepEqual(find(r,"duplicate_title_across_pages")[0].related_pages,[2]);
  assert.equal(r.conflicting_declaration_fields,0);
  assert(find(r,"duplicate_title_across_pages").every((f)=>f.severity==="info"));
});
test("P1-09 shared canonical preference does not pretend pages are distinct canonical pages", () => {
  const shared=page(b,html('<title>Same title</title>'+meta("description","Repeated description")
    +canonical(a)));
  const r=analyzeMetadataConsistency([healthy(a,"Same title","Repeated description"),shared]);
  assert.equal(r.duplicate_title_groups,0);
  assert.equal(r.duplicate_description_groups,0);
});
test("P1-09 never promotes one valid canonical amid other unresolved declarations into an unambiguous preference", () => {
  const ambiguous = page(b, html('<title>Same title</title>'
    + canonical(a) + canonical("javascript:FAKE_SECRET")
    + og("og:url", b)));
  const r = analyzeMetadataConsistency([healthy(a, "Same title"), ambiguous]);
  assert.equal(r.unresolved_canonical_references, 1);
  assert.equal(r.cross_field_review_leads, 0);
  assert.equal(r.duplicate_title_groups, 1);
  assert(!JSON.stringify(r).includes("FAKE_SECRET"));
});
test("P1-09 distinct input labels on different origins or with credentials/query are rejected", () => {
  assert.equal(safeMetadataLabel(a+"?private=FAKE_SECRET"),undefined);
  assert.equal(safeMetadataLabel("https://user:pass@example.test/page"),undefined);
  assert.equal(safeMetadataLabel("file:///etc/passwd"),undefined);
  assert.throws(()=>analyzeMetadataConsistency([]),/one to eight/);
  assert.throws(()=>analyzeMetadataConsistency([healthy(a),healthy(a)]),/distinct/);
  assert.throws(()=>analyzeMetadataConsistency([healthy(a),
    healthy("https://other.test/page")]),/one exact origin/);
});
test("P1-09 bounds per-field declarations, eight pages, number of findings and output bytes", () => {
  const repetitive='<title>one</title><title>two</title>'
    + Array.from({length:MAX_METADATA_VALUES+80},(_,i)=>meta("description","different-"+i)).join("");
  const pages=Array.from({length:8},(_,i)=>page(base+"/case-"+i,html(
    repetitive+og("og:title","Social")+canonical("/a")+canonical("/b")
    + meta("robots","noindex, index"))));
  const r=analyzeMetadataConsistency(pages);
  assert.equal(r.pages_sampled,8);
  assert.equal(r.findings.length,MAX_METADATA_FINDINGS);
  assert(r.findings_truncated);
  assert(r.total_findings>MAX_METADATA_FINDINGS);
  assert(r.pages.every((p)=>p.extraction_limited));
  assert(Buffer.byteLength(JSON.stringify(r),"utf8")<11000);
  assert.deepEqual(r,analyzeMetadataConsistency(pages));
});
test("P1-09 HTML with no explicit metadata is unknown rather than clean site-wide proof", () => {
  const r=analyzeMetadataConsistency([page(a,"<html><head></head><body>Empty</body></html>")]);
  assert.equal(r.total_findings,0);
  assert.equal(r.pages[0].fields_present,0);
  assert(r.coverage_limited);
});
