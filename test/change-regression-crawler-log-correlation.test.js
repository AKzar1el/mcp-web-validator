import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCrawlerLogs, emptyCrawlerLogReview,
  parseCombinedAccessLine, safeLogOrigin, isoTimestamp,
  MAX_CRAWL_LOG_RECORDS, MAX_CRAWL_FINDINGS,
} from "../dist/modules/change-regression/crawler-log-correlation.js";

const origin="https://example.com";
const cutover="2026-11-12T00:00:00Z";
const monitored=[origin+"/",origin+"/important"];
const observation=(ts,status,path="/",agent="Googlebot/2.1",extra={})=>({
  timestamp:ts,method:"GET",path,status,user_agent:agent,...extra,
});
const before="2026-11-11T23:00:00Z",after="2026-11-12T06:00:00Z";
const input=(items=[],props={})=>({
  site_origin:origin,important_urls:monitored,cutover_at:cutover,
  format:"structured",observations:items,...props,
});
const codes=r=>r.findings.map(f=>f.code);
const apache=(date,path,status,agent="Googlebot/2.1")=>
  `192.0.2.5 - - [${date}] "GET ${path} HTTP/1.1" ${status} 123 "-" "${agent}"`;
const leaked=(r)=>{
  const s=JSON.stringify(r);
  for(const value of ["https://example.com","192.0.2.5","Googlebot/2.1","secret-query"]){
    assert(!s.includes(value),value+" leaked");
  }
};

test("V12: before/after 200 vs 403/429/5xx matches important URLs without revealing identifiers",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,200), observation(before,200,"/important"),
    observation(after,403), observation(after,429,"/important"),
    observation(after,503,"/important"),
  ]));
  assert.equal(r.scope,"caller_supplied_access_log_sample");
  assert.equal(r.status,"comparable_sample");
  assert.equal(r.source_records,5);
  assert.equal(r.matched_requests,5);
  assert.equal(r.before.http_2xx,2);
  assert.equal(r.before.problem_responses,0);
  assert.equal(r.after.block_401_403,1);
  assert.equal(r.after.rate_limited_429,1);
  assert.equal(r.after.server_5xx,1);
  assert.equal(r.after.problem_responses,3);
  assert.equal(r.failure_rate_delta_percentage_points,100);
  assert.equal(r.per_url[0].after_problem_responses,1);
  assert.equal(r.per_url[1].after_problem_responses,2);
  assert.equal(r.crawler_identities_verified,false);
  assert(codes(r).includes("failed_requests_increased"));
  assert(codes(r).includes("post_block_challenge"));
  assert(codes(r).includes("post_rate_limiting"));
  assert(codes(r).includes("post_server_errors"));
  leaked(r);
});

test("V12: a Googlebot user-agent is explicitly only a claimed, not a verified crawler",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,200,"/","Googlebot/2.1"),
    observation(after,403,"/","Googlebot/2.1"),
  ]));
  const g=r.claimed_crawler_profiles.find(x=>x.profile==="claimed_googlebot");
  assert.equal(g.before_requests,1);
  assert.equal(g.after_requests,1);
  assert.equal(g.after_problem_responses,1);
  assert.equal(r.crawler_identities_verified,false);
  assert(codes(r).includes("user_agents_unverified"));
  assert(r.limitations.join(" ").includes("not verified")||r.limitations.join(" ").includes("unverified"));
  leaked(r);
});

test("V12: normal redirects are not HTTP failure responses",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,301), observation(after,302),observation(after,304),
  ]));
  assert.equal(r.before.redirects_3xx,1);
  assert.equal(r.after.redirects_3xx,2);
  assert.equal(r.after.problem_responses,0);
  assert.equal(r.failure_rate_delta_percentage_points,0);
  assert(!codes(r).includes("failed_requests_increased"));
});

test("V12: 404 and 410 are distinguishable from challenges and server errors",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,200), observation(after,404),observation(after,410),
  ]));
  assert.equal(r.after.missing_404_410,2);
  assert.equal(r.after.block_401_403,0);
  assert.equal(r.after.server_5xx,0);
  assert(codes(r).includes("post_missing_pages"));
});

test("V12: one-sided evidence is partial, not a false zero failure-rate delta",()=>{
  const r=analyzeCrawlerLogs(input([observation(after,200)]));
  assert.equal(r.status,"partial");
  assert.equal(r.before.failure_rate_percent,null);
  assert.equal(r.after.failure_rate_percent,0);
  assert.equal(r.failure_rate_delta_percentage_points,null);
  assert(codes(r).includes("incomplete_before_after_sample"));
});

test("V12: no matching important URLs is not-comparable and never proof a bot did not crawl",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,200,"/unlisted"),observation(after,403,"/unlisted"),
  ]));
  assert.equal(r.status,"not_comparable");
  assert.equal(r.matched_requests,0);
  assert.equal(r.unmatched_requests,2);
  assert.equal(r.failure_rate_delta_percentage_points,null);
  assert(codes(r).includes("no_important_url_matches"));
});

test("V12: query variants match only the public path and never echo query secrets",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,200,"/?secret-query=HIDDEN"),
    observation(after,403,"/important?secret-query=OTHER"),
  ]));
  assert.equal(r.query_variants_observed,2);
  assert.equal(r.matched_requests,2);
  assert.equal(r.per_url[1].after_problem_responses,1);
  assert(codes(r).includes("query_variants_observed"));
  leaked(r);
});

test("V12: encoded separators, path traversal, backslashes and cross-origin paths are excluded",()=>{
  const badPaths=[
    "/important%2fsecret","/%2e%2e/admin","/important%5cadmin",
    "//other.example/private","/x\\secret","https://other.example/",
    "/important#fragment","/foo/../important","/./important",
  ];
  const records=[observation(before,200),...badPaths.map(p=>observation(after,403,p))];
  const r=analyzeCrawlerLogs(input(records));
  assert.equal(r.invalid_records,badPaths.length);
  assert.equal(r.matched_requests,1);
  assert.equal(r.status,"partial");
  assert.equal(r.after.failure_rate_percent,null);
});

test("V12: POST/DELETE methods are explicitly ignored, not treated as crawler fetches",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,200), observation(after,200),
    observation(after,403,"/","Googlebot",{method:"POST"}),
    observation(after,403,"/","Googlebot",{method:"DELETE"}),
  ]));
  assert.equal(r.ignored_methods,2);
  assert.equal(r.matched_requests,2);
  assert.equal(r.after.problem_responses,0);
});

test("V12: HTTP time-zone offsets correctly place access log entries on either side of cutover",()=>{
  const raw=[
    apache("12/Nov/2026:01:00:00 +0200","/important",200),
    apache("12/Nov/2026:04:00:00 +0200","/important",403),
  ].join("\n");
  const r=analyzeCrawlerLogs(input([],{format:"combined_access",observations:undefined,access_log:raw}));
  assert.equal(r.status,"comparable_sample");
  assert.equal(r.before.requests,1);
  assert.equal(r.after.requests,1);
  assert.equal(r.after.block_401_403,1);
  leaked(r);
});

test("V12: Apache combined parser reads fields but never forwards raw IP/referer/UA to report",()=>{
  const line=apache("11/Nov/2026:13:55:36 +0000","/important",403,"Googlebot/2.1");
  const parsed=parseCombinedAccessLine(line);
  assert.equal(parsed.status,403);
  assert.equal(parsed.path,"/important");
  assert.equal(parsed.timestamp,"2026-11-11T13:55:36.000Z");
  const r=analyzeCrawlerLogs(input([],{format:"combined_access",observations:undefined,
    access_log:line+"\n"+apache("12/Nov/2026:12:00:00 +0000","/important",403)}));
  assert.equal(r.source_records,2);
  leaked(r);
});

test("V12: malformed raw lines are counted as coverage gaps, not silently clean",()=>{
  const raw=[
    apache("11/Nov/2026:12:00:00 +0000","/",200),
    "broken secret IP-token log data",
    apache("12/Nov/2026:12:00:00 +0000","/",403),
  ].join("\n");
  const r=analyzeCrawlerLogs(input([],{format:"combined_access",observations:undefined,access_log:raw}));
  assert.equal(r.source_records,3);
  assert.equal(r.parsed_records,2);
  assert.equal(r.invalid_records,1);
  assert.equal(r.status,"partial");
  assert(codes(r).includes("unparsed_log_entries"));
  assert(!JSON.stringify(r).includes("IP-token"));
});

test("V12: rejects non-existing Apache calendar dates and invalid UTC offsets",()=>{
  for(const date of ["30/Feb/2026:12:00:00 +0000","12/Nov/2026:25:00:00 +0000",
    "12/Nov/2026:12:00:00 +9900"]){
    assert.equal(parseCombinedAccessLine(apache(date,"/",200)),undefined);
  }
  assert.equal(parseCombinedAccessLine("192.0.2.3 - - invalid"),undefined);
});

test("V12: structural input contracts reject missing, reversed/duplicate important URLs, mismatched modes",()=>{
  const valid=[observation(before,200)];
  for(const props of [
    {important_urls:[]},
    {important_urls:[origin,origin+"/"]},
    {important_urls:["https://other.example/"]},
    {important_urls:[origin+"/p?secret=YES"]},
    {important_urls:[origin+"/foo/../important"]},
    {important_urls:[origin+"/%2e%2e/important"]},
    {site_origin:"http://example.com"},
    {site_origin:"https://localhost"},
    {cutover_at:"2026-11-12T00:00:00"},
    {format:"combined_access",access_log:"",observations:valid},
  ]){
    assert.throws(()=>analyzeCrawlerLogs(input(valid,props)));
  }
});

test("V12: exactly 500 observations allowed; 501 or oversized source fails closed",()=>{
  const entries=Array.from({length:MAX_CRAWL_LOG_RECORDS},(_,i)=>
    observation(i%2?after:before,200));
  assert.equal(analyzeCrawlerLogs(input(entries)).source_records,500);
  assert.throws(()=>analyzeCrawlerLogs(input([...entries,observation(before,200)])));
  assert.throws(()=>analyzeCrawlerLogs(input([],{format:"combined_access",
    observations:undefined,access_log:"x".repeat(260000)})));
});

test("V12: max 16 important URLs and bounded redacted findings",()=>{
  const urls=Array.from({length:16},(_,i)=>origin+"/p"+i);
  const entries=[
    observation(before,200,"/p0"),
    ...urls.map((_,i)=>observation(after,503,"/p"+i)),
  ];
  const r=analyzeCrawlerLogs(input(entries,{important_urls:urls}));
  assert.equal(r.important_urls_supplied,16);
  assert.equal(r.per_url.length,16);
  assert(r.findings.length<=MAX_CRAWL_FINDINGS);
  assert.equal(r.findings_truncated,true);
  assert(r.total_findings>r.findings.length);
  assert(!JSON.stringify(r).includes("/p15"));
});

test("V12: bin grouping for claimed Bingbot, GPTBot, generic bot and browser is fixed",()=>{
  const agents=["bingbot/2.0","GPTBot/1.0","SomeSpider/1","Mozilla/5.0"];
  const r=analyzeCrawlerLogs(input([
    observation(before,200),
    ...agents.map(agent=>observation(after,200,"/",agent)),
  ]));
  for(const profile of ["claimed_bingbot","claimed_gptbot","claimed_other_bot","other"])
    assert.equal(r.claimed_crawler_profiles.find(x=>x.profile===profile).after_requests,1);
});

test("V12: structured invalid rows, bad statuses and malformed offsets do not fake pass",()=>{
  const r=analyzeCrawlerLogs(input([
    observation(before,200),
    observation(after,200),
    observation(after,100),
    observation(after,99),
    observation(after,700),
    observation("bad timestamp",403),
    observation(after,403,"/","Googlebot",{user_agent:123}),
  ]));
  assert.equal(r.status,"partial");
  assert.equal(r.invalid_records,5);
  assert.equal(r.matched_requests,2);
});

test("V12: query-free important URLs and origin validators reject private or suspicious labels",()=>{
  for(const host of ["http://example.com","https://127.0.0.1","https://localhost",
    "https://example.com:8443","https://example.test","https://example.com/?token=x"]){
    assert.equal(safeLogOrigin(host),undefined);
  }
  assert.equal(safeLogOrigin(origin+"/"),origin);
  assert.equal(isoTimestamp(before),Date.parse(before));
  assert.equal(isoTimestamp("not-a-timestamp"),undefined);
  assert.equal(isoTimestamp("2026-02-30T12:00:00Z"),undefined);
  assert.equal(isoTimestamp("2026-11-12T12:00:00+99:00"),undefined);
  assert.equal(emptyCrawlerLogReview().crawler_identities_verified,false);
});
