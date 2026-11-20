import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProvenance, normalizedEvidenceDate, MAX_PROVENANCE_FINDINGS } from "../dist/modules/content-schema/citation-methodology-consistency.js";
import { observeProvenancePage } from "../dist/modules/content-schema/extract-citation-methodology.js";
const url="https://example.test/article", src="https://doi.org/10.1234/study", meth="https://example.test/methods";
const evidence={as_of:"2026-11-19",sources:[{id:"study_2026",url:src}],datasets:[{id:"search_weekly",version:"v2.1",as_of:"2026-11-12",max_age_days:14,methodology_id:"weighted"}],methodologies:[{id:"weighted",url:meth}]};
const html=(body,head="")=>'<html><head>'+head+'</head><body><nav><a rel=cite href="https://example.test/menu">Menu</a></nav><main>'+body+'</main><footer><a rel=cite href="https://example.test/footer">Footer</a></footer></body></html>';
const parse=(body,head="",page=url)=>observeProvenancePage(html(body,head),page);
const main='<a rel=cite data-citation-id=study_2026 href="'+src+'">Study</a><div data-dataset-id=search_weekly data-dataset-version=v2.1 data-dataset-as-of=2026-11-12 data-methodology-id=weighted></div><a data-methodology-id=weighted href="'+meth+'">Method</a>';
const codes=(r)=>r.findings.map(f=>f.code);

test("P1-05 consistent citation/dataset/method and published-modified chronology",()=>{
 const r=analyzeProvenance([parse(main,'<meta property=article:published_time content=2026-11-08><meta property=article:modified_time content=2026-11-12>')],evidence);
 assert.equal(r.citations_observed,1);assert.equal(r.datasets_observed,1);assert.equal(r.methodologies_observed,1);
 assert.equal(r.conflicting_declarations,0);assert.equal(r.unverified_declarations,0);assert.equal(r.coverage_limited,false);
 assert(r.consistent_declarations>=6);
});
test("P1-05 conflicting target/version/snapshot/method and impossible chronology",()=>{
 const broken=main.replace(src,"https://example.test/alternate").replace("v2.1","v9").replace("2026-11-12","2026-11-11").replace(meth,"https://example.test/other");
 const r=analyzeProvenance([parse(broken,'<meta property=article:published_time content=2026-11-13><meta property=article:modified_time content=2026-11-10>')],evidence);
 for(const code of ["citation_target_differs_from_supplied_evidence","dataset_version_conflict","dataset_as_of_conflict","methodology_link_conflict","modified_before_published"])assert(codes(r).includes(code),code);
 assert(r.conflicting_declarations>=5);
});
test("P1-05 missing evidence remains unverified; duplicate source ID target conflict is observed",()=>{
 const one=parse('<a data-citation-id=study_2026 href="https://example.test/a">A</a>');
 const two=parse('<a data-citation-id=study_2026 href="https://example.test/b">B</a>',"","https://example.test/b");
 const r=analyzeProvenance([one,two]);assert(r.unverified_declarations>=2);assert(r.coverage_limited);assert(codes(r).includes("citation_id_target_conflict"));
});
test("P1-05 calendar/leap/timezone and malformed date declarations",()=>{
 for(const bad of ["2026-02-29","2026-13-01","2026-11-31","2026-11-01T99:00:00Z"])assert.equal(normalizedEvidenceDate(bad),undefined);
 assert.equal(normalizedEvidenceDate("2024-02-29"),"2024-02-29");
 assert.equal(normalizedEvidenceDate("2026-11-19T01:20:00+02:00"),"2026-11-18");
 const r=analyzeProvenance([parse('<time itemprop=datePublished datetime=2026-02-30></time><div data-dataset-id=search_weekly data-dataset-as-of=2030-99-99></div>','<meta property=article:modified_time content=2026-13-99>')]);
 assert.equal(r.invalid_date_declarations,3);assert(codes(r).includes("invalid_date_declarations"));
});
test("P1-05 only uses explicit freshness policy and reference date",()=>{
 const stale=analyzeProvenance([parse(main)],{...evidence,datasets:[{...evidence.datasets[0],max_age_days:2}]});
 assert(codes(stale).includes("dataset_freshness_window_exceeded"));
 const noDate=analyzeProvenance([parse(main)],{datasets:[{...evidence.datasets[0],max_age_days:2}]});
 assert(!codes(noDate).includes("dataset_freshness_window_exceeded"));
 const future=analyzeProvenance([parse(main.replace("2026-11-12","2027-01-01"),'<meta property=article:published_time content=2027-01-01>')],evidence);
 assert(codes(future).includes("publication_after_reference_date"));assert(codes(future).includes("dataset_snapshot_in_future"));
});
test("P1-05 bounded structured Dataset and Article JSON-LD",()=>{
 const data=JSON.stringify({"@graph":[{"@type":"Article",datePublished:"2026-11-08",citation:src},{"@type":"Dataset",identifier:"search_weekly",version:"v2.1",dateModified:"2026-11-12"}]});
 const p=parse("",'<script type="application/ld+json">'+data+'</script>');
 assert.equal(p.citations.length,1);assert.equal(p.datasets.length,1);
 assert.equal(analyzeProvenance([p],evidence).conflicting_declarations,0);
});
test("P1-05 no query/credential/hidden/nav/footer leakage",()=>{
 const p=parse('<a rel=cite data-citation-id=source href="https://user:FAKE_SECRET@example.test/a">Cite</a><div hidden><a rel=cite href="https://example.test/hidden"></a></div><template><a rel=cite href="https://example.test/inert"></a></template>');
 const r=analyzeProvenance([p]);assert.equal(r.citations_observed,1);assert(!JSON.stringify(r).includes("FAKE_SECRET"));
});
test("P1-05 bounded 8 pages, 48 declarations and 12 returned findings",()=>{
 const refs=Array.from({length:80},(_,i)=>'<a rel=cite href="https://example.test/source/'+i+'">Cite</a>').join("");
 const pages=Array.from({length:8},(_,i)=>parse(refs,"","https://example.test/p/"+i));
 const r=analyzeProvenance(pages);
 assert(r.total_findings>MAX_PROVENANCE_FINDINGS);assert.equal(r.findings.length,MAX_PROVENANCE_FINDINGS);
 assert(r.coverage_limited);assert(r.findings_truncated);assert(Buffer.byteLength(JSON.stringify(r),"utf8")<14000);
 assert.deepEqual(r,analyzeProvenance(pages));assert.throws(()=>analyzeProvenance([...pages,pages[0]]),/at most eight/);
});
test("P1-05 no structured citations means no invented contradictions",()=>{
 const r=analyzeProvenance([parse("<p>Ordinary prose with no explicit sources.</p>")]);
 assert.equal(r.citations_observed,0);assert.equal(r.conflicting_declarations,0);assert(r.coverage_limited);
});
test("P1-05 refuses duplicate source IDs instead of silently trusting the last manifest entry",()=>{
 const page=parse('<a rel=cite data-citation-id=study_2026 href="'+evidence.sources[0].url+'">Cite</a>');
 assert.throws(()=>analyzeProvenance([page],{sources:[
   {id:"study_2026",url:"https://example.test/first"},
   {id:"study_2026",url:"https://example.test/second"},
 ]}),/Duplicate sources IDs/);
});
