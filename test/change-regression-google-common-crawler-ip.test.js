import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_COMMON_CRAWLERS_URL,MAX_GOOGLE_RANGES_BYTES,
  parseOfficialGoogleCommonRanges,matchesOfficialGoogleRange,fetchOfficialGoogleCommonRanges,
} from "../dist/modules/change-regression/google-common-crawler-ip.js";
import { analyzeCrawlerLogs,parseCombinedAccessLine } from
  "../dist/modules/change-regression/crawler-log-correlation.js";

const rangesJson=JSON.stringify({
  creationTime:"2026-11-20T15:45:50.000000",
  prefixes:[
    {ipv4Prefix:"66.249.64.0/19"},
    {ipv6Prefix:"2001:4860:4801:10::/64"},
  ],
});
const ranges=parseOfficialGoogleCommonRanges(rangesJson);
const origin="https://example.com";
const before="2026-11-11T13:00:00Z";
const after="2026-11-12T13:00:00Z";
const sample=(records)=>({
  site_origin:origin,important_urls:[origin+"/"],
  cutover_at:"2026-11-12T00:00:00Z",format:"structured",observations:records,
});
const record=(timestamp,status,client_ip,agent="Googlebot/2.1")=>({
  timestamp,method:"GET",path:"/?private=do-not-leak",status,user_agent:agent,client_ip,
});
const noLeaks=(value)=>{
  const s=JSON.stringify(value);
  for(const secret of ["66.249.66.1","203.0.113.9","2001:4860:4801:10::9",
    "example.com","do-not-leak","Googlebot/2.1"])
    assert(!s.includes(secret),`unexpected leaked token ${secret}`);
};

test("V13: Google official JSON CIDRs match IPv4/IPv6 and reject spoofed source IPs",()=>{
  assert.equal(ranges.length,2);
  assert.equal(matchesOfficialGoogleRange("66.249.66.1",ranges),true);
  assert.equal(matchesOfficialGoogleRange("66.249.95.255",ranges),true);
  assert.equal(matchesOfficialGoogleRange("66.249.96.0",ranges),false);
  assert.equal(matchesOfficialGoogleRange("203.0.113.9",ranges),false);
  assert.equal(matchesOfficialGoogleRange("2001:4860:4801:10::9",ranges),true);
  assert.equal(matchesOfficialGoogleRange("2001:4860:4801:11::9",ranges),false);
  assert.equal(matchesOfficialGoogleRange("::ffff:66.249.66.1",ranges),true);
  assert.equal(matchesOfficialGoogleRange(undefined,ranges),null);
  assert.equal(matchesOfficialGoogleRange("not-an-ip",ranges),null);
  assert.equal(matchesOfficialGoogleRange("fe80::1%eth0",ranges),null);
});

test("V13: official source-range JSON is shape/size/CIDR/family bounded",()=>{
  for(const payload of [
    "[]","null","{}","{\"prefixes\":[]}",
    JSON.stringify({prefixes:[{ipv4Prefix:"66.249.64.0/33"}]}),
    JSON.stringify({prefixes:[{ipv6Prefix:"66.249.64.0/19"}]}),
    JSON.stringify({prefixes:[{ipv4Prefix:"0.0.0.0/-1"}]}),
    JSON.stringify({prefixes:[{ipv4Prefix:"not-an-ip"}]}),
    JSON.stringify({prefixes:[{ipv4Prefix:"66.249.64.0/19",ipv6Prefix:"::/0"}]}),
    JSON.stringify({prefixes:Array.from({length:1001},()=>({ipv4Prefix:"66.249.64.0/19"}))}),
    "x".repeat(MAX_GOOGLE_RANGES_BYTES+1),
  ]) assert.throws(()=>parseOfficialGoogleCommonRanges(payload));
});

test("V13: supplied log UA and source IP are correlated locally with no identifiers in output",()=>{
  const r=analyzeCrawlerLogs(sample([
    record(before,200,"66.249.66.1"),
    record(after,403,"66.249.66.1"),
    record(after,429,"2001:4860:4801:10::9"),
    record(after,200,"203.0.113.9"),
    record(after,200,undefined),
    record(after,200,"66.249.66.1","Mozilla/5.0"),
  ]),{requested:true,ranges});
  const e=r.googlebot_ip_evidence;
  assert.equal(e.status,"checked_current_official_ranges");
  assert.equal(e.claimed_requests,5);
  assert.equal(e.matched_current_ranges,3);
  assert.equal(e.outside_current_ranges,1);
  assert.equal(e.missing_or_invalid_ip,1);
  assert.equal(e.matched_before,1);
  assert.equal(e.matched_after,2);
  assert.equal(e.matched_after_problem_responses,2);
  assert.equal(r.before.http_2xx,1);
  assert.equal(r.after.block_401_403,1);
  assert.equal(r.after.rate_limited_429,1);
  assert.equal(r.crawler_identities_verified,false);
  assert(r.findings.some(f=>f.code==="googlebot_range_mismatch"));
  assert(r.findings.some(f=>f.code==="googlebot_range_match"));
  noLeaks(r);
});

test("V13: offline default and unavailable official range list fail closed",()=>{
  const records=[record(before,200,"66.249.66.1"),record(after,403,"203.0.113.9")];
  const offline=analyzeCrawlerLogs(sample(records));
  const unavailable=analyzeCrawlerLogs(sample(records),{requested:true});
  assert.equal(offline.googlebot_ip_evidence.status,"not_requested");
  assert.equal(offline.googlebot_ip_evidence.matched_current_ranges,0);
  assert.equal(unavailable.googlebot_ip_evidence.status,"unavailable");
  assert.equal(unavailable.googlebot_ip_evidence.claimed_requests,2);
  assert.equal(unavailable.googlebot_ip_evidence.matched_current_ranges,0);
  assert(unavailable.findings.some(f=>f.code==="googlebot_ranges_unavailable"));
  assert.equal(unavailable.after.block_401_403,1);
  noLeaks(unavailable);
});

test("V13: combined Apache access logs preserve IP ephemerally, but not in report",()=>{
  const line=(date,status,ip)=>
    `${ip} - - [${date}] "GET / HTTP/1.1" ${status} 0 "-" "Googlebot/2.1"`;
  const raw=[
    line("11/Nov/2026:13:00:00 +0000",200,"66.249.66.1"),
    line("12/Nov/2026:13:00:00 +0000",403,"203.0.113.9"),
  ].join("\n");
  assert.equal(parseCombinedAccessLine(raw.split("\n")[0]).client_ip,"66.249.66.1");
  const r=analyzeCrawlerLogs({...sample([]),format:"combined_access",observations:undefined,access_log:raw},
    {requested:true,ranges});
  assert.equal(r.googlebot_ip_evidence.matched_current_ranges,1);
  assert.equal(r.googlebot_ip_evidence.outside_current_ranges,1);
  assert.equal(r.after.block_401_403,1);
  noLeaks(r);
});

test("V13: official network fetch uses one pinned URL, bounded JSON, no logs or IPs",async()=>{
  const requests=[];
  const fetcher=async(url,options)=>{
    requests.push([url,options]);
    return new Response(rangesJson,{status:200,headers:{"content-type":"application/json"}});
  };
  const actual=await fetchOfficialGoogleCommonRanges(fetcher);
  assert.equal(actual.length,2);
  assert.equal(requests.length,1);
  assert.equal(requests[0][0],GOOGLE_COMMON_CRAWLERS_URL);
  assert.equal(requests[0][1].redirect,"manual");
  assert.equal(requests[0][1].method,"GET");
  assert(!JSON.stringify(requests).includes("66.249.66.1"));
});

test("V13: official fetch rejects redirect, errors, non-JSON and oversized streams",async()=>{
  for(const response of [
    new Response(null,{status:302,headers:{location:"https://evil.example/"}}),
    new Response("no",{status:500,headers:{"content-type":"application/json"}}),
    new Response(rangesJson,{status:200,headers:{"content-type":"text/html"}}),
    new Response("x".repeat(MAX_GOOGLE_RANGES_BYTES+1),{status:200,headers:{"content-type":"application/json"}}),
  ]) await assert.rejects(fetchOfficialGoogleCommonRanges(async()=>response));
  await assert.rejects(fetchOfficialGoogleCommonRanges(async()=>{throw Error("network down");}));
});
