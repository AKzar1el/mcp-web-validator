import assert from "node:assert/strict";
import test from "node:test";
import { observeInternalLinks } from "../dist/modules/site-architecture/extract-internal-links.js";
import { reviewInternalLinks, safeLinkPageUrl, MAX_LINK_FINDINGS } from "../dist/modules/site-architecture/internal-link-quality.js";

const origin = "https://example.test";
const source = origin + "/guides/ergonomics";
const chairs = origin + "/products/chairs";
const pricing = origin + "/pricing";
const html = (title, h1, links, nav = "") => '<!doctype html><html><head><title>'+title+'</title></head>'
  +'<body><header><a href="/hidden">Old header</a></header><nav>'+nav+'</nav>'
  +'<main><h1>'+h1+'</h1>'+links+'</main>'
  +'<footer><a href="/footer">Old footer</a></footer></body></html>';
const page = (url, markup) => observeInternalLinks(markup,url);
const target = page(chairs,html("Ergonomic office chairs","Ergonomic seating chairs", "<p>Browse chairs.</p>"));
const terms = (r) => r.findings.map((f) => f.code);

test("P1-08 labels real main links and resolves sampled same-origin destinations without crawling", () => {
 const main = page(source,html("Ergonomics guide","Workplace ergonomics",
  '<a href="../products/chairs">Ergonomic office chairs</a>'
 +'<a href="https://outside.example/product">Research source</a>'
 +'<a href="#footnotes">Read notes</a>'
 +'<a href="mailto:person@example.test">Mail</a>',
 '<a href="/products/chairs">In main navigation</a>'));
 const report = reviewInternalLinks([main,target]);
 assert.equal(report.pages_sampled,2);
 assert.equal(report.pages_eligible,2);
 assert.equal(report.internal_links_observed,1);
 assert.equal(report.external_links_observed,1);
 assert.equal(report.linked_sample_targets,1);
 assert.equal(report.fragment_only_links,1);
 assert.equal(report.skipped_non_http_links,1);
 assert(report.excluded_navigation_links>=1);
 assert.equal(report.low_heading_overlap_links,0);
 assert.equal(report.unmatched_internal_links,0);
 assert.equal(report.missing_anchor_labels,0);
 assert(report.coverage_limited);
 assert(!JSON.stringify(report).includes("Workplace ergonomics"));
 assert(!JSON.stringify(report).includes("/products/chairs"));
});
test("P1-08 distinguishes missing accessible names from generic English labels", () => {
 const main = page(source,html("Guide","Guide",
  '<a href="/products/chairs"><img src="a.png" alt=""></a>'
 +'<a href="/pricing">read more</a>'
 +'<a href="/products/chairs"><img alt="Ergonomic chairs" src="chair.png"></a>'
 +'<a href="/pricing" aria-label="Pricing options">click here</a>'
 +'<a href="/pricing" title="Pricing plans"><svg></svg></a>'));
 const r=reviewInternalLinks([main,target,page(pricing,html("Pricing options","Pricing plans",""))]);
 assert.equal(r.internal_links_observed,5);
 assert.equal(r.missing_anchor_labels,1);
 assert.equal(r.generic_anchor_links,1);
 assert(terms(r).includes("accessible_anchor_missing"));
 assert(terms(r).includes("generic_anchor_text"));
});
test("P1-08 uses aria-labelledby and image alt but never script or hidden text as an anchor", () => {
 const main=page(source,html("Guide","Guide",
 '<span id="meaning">Specific product details</span>'
 +'<a aria-labelledby="meaning" href="/products/chairs"></a>'
 +'<div hidden><a href="/products/chairs">click here</a></div>'
 +'<div aria-hidden="true"><a href="/products/chairs">read more</a></div>'
 +'<script><a href="/products/chairs">hidden</a></script>'
 +'<a href="/products/chairs"><img alt="Office chairs" src="x"></a>'));
 const r=reviewInternalLinks([main,target]);
 assert.equal(r.internal_links_observed,2);
 assert.equal(r.generic_anchor_links,0);
 assert.equal(r.missing_anchor_labels,0);
});
test("P1-08 directly referenced hidden label text names an otherwise empty anchor", () => {
 const markup=html("Guide","Guide",
  '<a href="/products/chairs" aria-labelledby="hidden-name"></a>'
  +'<span id="hidden-name" hidden>Ergonomic chairs</span>'
  +'<a href="/pricing" aria-labelledby="aria-hidden-name"></a>'
  +'<span id="aria-hidden-name" aria-hidden="true">Pricing options</span>'
  +'<div hidden><a href="/pricing">Invisible link</a></div>');
 const main=page(source,markup);
 assert.deepEqual(main.links.map((link)=>[link.label,link.accessible]),[
  ["Ergonomic chairs",true],["Pricing options",true],
 ]);
 const r=reviewInternalLinks([main,target,page(pricing,html("Pricing options","Plans",""))]);
 assert.equal(r.internal_links_observed,2);
 assert.equal(r.missing_anchor_labels,0);
});
test("P1-08 repeated descriptive anchor to distinct targets is only a review signal", () => {
 const main=page(source,html("Guide","Guide",
  '<a href="/products/chairs">Product features</a><a href="/pricing">Product features</a>'
 +'<a href="/pricing">Product features</a>'));
 const r=reviewInternalLinks([main,target,page(pricing,html("Pricing options","Plans",""))]);
 assert.equal(r.ambiguous_anchor_target_groups,1);
 assert(terms(r).includes("repeated_anchor_multiple_targets"));
 assert(r.findings.some(f=>f.code==="repeated_anchor_multiple_targets" && f.severity==="info"));
});
test("P1-08 lexical anchor mismatch is not claimed as semantic relevance or a ranking issue", () => {
 const main=page(source,html("Guide","Guide",
  '<a href="/products/chairs">Animal care handbook</a>'
 +'<a href="/pricing">Pricing plans and cost breakdown</a>'));
 const r=reviewInternalLinks([main,target,page(pricing,html("Pricing options","Pricing plans",""))]);
 assert.equal(r.low_heading_overlap_links,1);
 assert(terms(r).includes("anchor_target_heading_low_overlap"));
 assert.match(r.limitations.join(" "),/not semantic relevance/);
});
test("P1-08 unknown links and query variants remain unverified rather than broken", () => {
 const main=page(source,html("Guide","Guide",
  '<a href="/not-supplied">Descriptive resource</a>'
 +'<a href="/products/chairs?variant=FAKE_SECRET">Chairs</a>'
 +'<a href="?page=2">Same path query</a>'));
 const r=reviewInternalLinks([main,target]);
 assert.equal(r.unmatched_internal_links,3);
 assert.equal(r.skipped_non_http_links,0);
 assert.equal(r.internal_links_observed,3);
 assert.equal(r.linked_sample_targets,0);
 assert(terms(r).includes("sampled_target_unobserved"));
 assert(!JSON.stringify(r).includes("FAKE_SECRET"));
 assert(!JSON.stringify(r).includes("/not-supplied"));
});
test("P1-08 counts internal nofollow, distinct non-fragment self-link and fragment-only separately", () => {
 const main=page(source,html("Guide","Guide",
  '<a rel="nofollow" href="/products/chairs">Ergonomic chairs</a>'
 +'<a href="/guides/ergonomics">Home guide</a>'
 +'<a href="#part-two">Jump to part two</a>'));
 const r=reviewInternalLinks([main,target]);
 assert.equal(r.nofollow_internal_links,1);
 assert.equal(r.self_links,1);
 assert.equal(r.fragment_only_links,1);
 assert.equal(r.linked_sample_targets,1);
 assert(terms(r).includes("nofollow_contextual_internal"));
});
test("P1-08 an empty main page reports no contextual links, not fake site-wide orphan pages", () => {
 const r=reviewInternalLinks([page(source,html("Guide","Guide",""))]);
 assert.equal(r.internal_links_observed,0);
 assert(terms(r).includes("no_contextual_internal_links"));
 assert.equal(r.pages_sampled,1);
 assert(!terms(r).includes("no_sampled_contextual_internal_links"));
 assert(r.coverage_limited);
});
test("P1-08 rejects mixed-origin, duplicated, unsafe, private-token URL labels", () => {
 const p=page(source,html("Guide","Guide",""));
 assert.throws(()=>reviewInternalLinks([]),/one to eight/);
 assert.throws(()=>reviewInternalLinks([p,p]),/unique/);
 assert.throws(()=>reviewInternalLinks([p,page("https://different.test/x",html("Other","Other",""))]),/same exact origin/);
 assert.equal(safeLinkPageUrl("https://user:FAKE_SECRET@example.test/path"),undefined);
 assert.equal(safeLinkPageUrl("https://example.test/path?token=FAKE_SECRET"),undefined);
 assert.equal(safeLinkPageUrl("file:///etc/password"),undefined);
});
test("P1-08 relative protocol-less external URLs are not counted as same-origin", () => {
 const p=page(source,html("Guide","Guide",
  '<a href="//external.test/scheme-relative">Reference</a>'
 +'<a href="tel:123">Call</a>'
 +'<a href="javascript:alert(1)">Click</a>'));
 const r=reviewInternalLinks([p]);
 assert.equal(r.internal_links_observed,0);
 assert.equal(r.external_links_observed,1);
 assert.equal(r.skipped_non_http_links,2);
});
test("P1-08 main fallback when there is no main is partial, not deemed broken", () => {
 const p=page(source,'<html><head><title>Guide</title></head><body>'
 +'<p><a href="/pricing">Plans and pricing</a></p></body></html>');
 const r=reviewInternalLinks([p]);
 assert.equal(r.pages[0].main_present,false);
 assert(terms(r).includes("page_main_missing"));
 assert(r.coverage_limited);
});
test("P1-08 bounded 8 pages, 160 links per page, capped findings, deterministic and nonleaking", () => {
 const link=Array.from({length:190},(_,i)=>'<a href="/outside-'+i+'">read more</a>').join("");
 const pages=Array.from({length:8},(_,i)=>page(origin+"/page-"+i,
   html("Page "+i,"Page "+i,link)));
 const r=reviewInternalLinks(pages);
 assert.equal(r.pages_sampled,8);
 assert.equal(r.internal_links_observed,8*160);
 assert(r.pages.every(p=>p.extraction_limited));
 assert(r.total_findings>MAX_LINK_FINDINGS);
 assert.equal(r.findings.length,MAX_LINK_FINDINGS);
 assert(r.findings_truncated);
 assert(Buffer.byteLength(JSON.stringify(r),"utf8")<10000);
 assert.deepEqual(r,reviewInternalLinks(pages));
});
test("P1-08 exactly same sampled pathname must be linked; trailing slash is not assumed canonical",()=>{
 const one=page(source,html("Guide","Guide",
   '<a href="/products/chairs/">Office chairs</a>'
  +'<a href="/products/chairs">Ergonomic chairs</a>'));
 const r=reviewInternalLinks([one,target]);
 assert.equal(r.linked_sample_targets,1);
 assert.equal(r.unmatched_internal_links,1);
});
test("P1-08 relative main links honor a valid HTML document base", () => {
 const main = page(source, '<html><head><title>Guide</title>'
  +'<base href="/products/"></head><body><main><h1>Guide</h1>'
  +'<a href="chairs">Office chairs</a></main></body></html>');
 const report = reviewInternalLinks([main,target]);
 assert.equal(report.linked_sample_targets,1);
 assert.equal(report.unmatched_internal_links,0);
 assert.equal(report.external_links_observed,0);

 const external = page(source, '<html><head><title>Guide</title>'
  +'<base href="https://elsewhere.test/guides/"></head><body><main>'
  +'<a href="resource">External resource</a></main></body></html>');
 const differentOrigin = reviewInternalLinks([external,target]);
 assert.equal(differentOrigin.external_links_observed,1);
 assert.equal(differentOrigin.internal_links_observed,0);
 assert.equal(differentOrigin.unmatched_internal_links,0);

 const fragment = page(source, '<html><head><title>Guide</title>'
  +'<base href="/products/chairs"></head><body><main>'
  +'<a href="#details">Chair details</a></main></body></html>');
 const fragmentReport = reviewInternalLinks([fragment,target]);
 assert.equal(fragmentReport.fragment_only_links,0);
 assert.equal(fragmentReport.linked_sample_targets,1);

 const samePageBase = page(source, '<html><head><base href="/guides/ergonomics"></head>'
  +'<body><main><a href="#section">On-page section</a></main></body></html>');
 assert.equal(reviewInternalLinks([samePageBase]).fragment_only_links,1);

 const unsafeBase = page(source, '<html><head><base href="javascript:bad()"></head>'
  +'<body><main><a href="/products/chairs">Office chairs</a></main></body></html>');
 assert.equal(reviewInternalLinks([unsafeBase,target]).linked_sample_targets,1);
});
test("P1-08 many aria-labelledby anchors use referenced visible names without excessive DOM rescans",()=>{
 const decoys=Array.from({length:1000},(_,i)=>'<span id="unrelated-'+i+'">Noise</span>').join("");
 const labelled=Array.from({length:160},(_,i)=>
   '<span id="anchor-label-'+i+'">Office chairs</span>'
   +'<a href="/products/chairs" aria-labelledby="anchor-label-'+i+'"></a>').join("");
 const observed=page(source,html("Guide","Guide",decoys+labelled));
 const report=reviewInternalLinks([observed,target]);
 assert.equal(report.internal_links_observed,160);
 assert.equal(report.missing_anchor_labels,0);
 assert.equal(report.generic_anchor_links,0);
 assert.equal(report.linked_sample_targets,1);
});
