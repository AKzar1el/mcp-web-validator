/**
 * V12: bounded, offline correlation of caller-supplied HTTP access records.
 * No IP, URL, user agent, token, log line or timestamp is returned. A bot
 * user-agent is only a self-declared string, not verified crawler identity.
 */
export const MAX_CRAWL_LOG_RECORDS=500;
export const MAX_CRAWL_LOG_TOTAL_BYTES=256_000;
export const MAX_CRAWL_IMPORTANT_URLS=16;
export const MAX_CRAWL_FINDINGS=16;
export const CRAWL_LOG_FORMATS=["structured","combined_access"] as const;
export const CRAWL_PROFILES=["claimed_googlebot","claimed_bingbot","claimed_gptbot","claimed_other_bot","other"] as const;
export const CRAWL_FINDING_CODES=[
  "no_important_url_matches","incomplete_before_after_sample","failed_requests_increased",
  "post_block_challenge","post_rate_limiting","post_server_errors",
  "post_missing_pages","important_url_post_failures","unparsed_log_entries",
  "query_variants_observed","user_agents_unverified","sample_only",
] as const;
type LogFormat=typeof CRAWL_LOG_FORMATS[number];
type LogProfile=typeof CRAWL_PROFILES[number];
type LogCode=typeof CRAWL_FINDING_CODES[number];
export interface LogObservation {
  timestamp:string;
  method:string;
  path:string;
  status:number;
  user_agent?:string;
}
export interface CrawlerLogInput {
  site_origin:string;
  important_urls:string[];
  cutover_at:string;
  format:LogFormat;
  observations?:LogObservation[];
  access_log?:string;
}
export interface LogPeriodStats {
  requests:number;
  http_2xx:number;
  redirects_3xx:number;
  block_401_403:number;
  rate_limited_429:number;
  missing_404_410:number;
  server_5xx:number;
  other_4xx:number;
  problem_responses:number;
  failure_rate_percent:number|null;
}
export interface LogUrlStats {
  url_index:number;
  before_requests:number;
  after_requests:number;
  after_problem_responses:number;
  after_block_401_403:number;
  after_rate_limited_429:number;
  after_server_5xx:number;
}
export interface LogProfileStats {
  profile:LogProfile;
  before_requests:number;
  after_requests:number;
  after_problem_responses:number;
}
export interface CrawlerLogFinding{
  code:LogCode;
  severity:"warning"|"info";
  url_index?:number;
  message:string;
}
export interface CrawlerLogReview{
  scope:"caller_supplied_access_log_sample";
  format:LogFormat;
  status:"comparable_sample"|"partial"|"not_comparable";
  important_urls_supplied:number;
  source_records:number;
  parsed_records:number;
  invalid_records:number;
  ignored_methods:number;
  unmatched_requests:number;
  query_variants_observed:number;
  matched_requests:number;
  before:LogPeriodStats;
  after:LogPeriodStats;
  failure_rate_delta_percentage_points:number|null;
  per_url:LogUrlStats[];
  claimed_crawler_profiles:LogProfileStats[];
  crawler_identities_verified:false;
  coverage_limited:true;
  limitations:string[];
  total_findings:number;
  findings:CrawlerLogFinding[];
  findings_truncated:boolean;
  error?:string;
}
const limitations=[
  "Only caller-supplied bounded log observations are analyzed; missing log periods or unmatched URLs cannot prove real availability, crawling frequency or absence of defects.",
  "Googlebot, Bingbot and other bot groups are unverified user-agent claims, not verified source IPs or confirmed crawler identity.",
  "The before/after cutover is a sample comparison of request counts and HTTP statuses, not a causal test of deployment changes, Google indexing, rankings or traffic loss.",
  "IP addresses, raw paths, query strings, user agents, timestamps and source log text are never returned or stored; redirects, robots policy and Google-selected canonicals are not followed.",
];
const encoder=new TextEncoder();
const byteLength=(s:string)=>encoder.encode(s).byteLength;
function emptyPeriod():LogPeriodStats{
  return {
    requests:0,http_2xx:0,redirects_3xx:0,block_401_403:0,
    rate_limited_429:0,missing_404_410:0,server_5xx:0,
    other_4xx:0,problem_responses:0,failure_rate_percent:null,
  };
}
export function emptyCrawlerLogReview(format:LogFormat="structured"):CrawlerLogReview{
  return {
    scope:"caller_supplied_access_log_sample",format,status:"not_comparable",
    important_urls_supplied:0,source_records:0,parsed_records:0,invalid_records:0,
    ignored_methods:0,unmatched_requests:0,query_variants_observed:0,
    matched_requests:0,before:emptyPeriod(),after:emptyPeriod(),
    failure_rate_delta_percentage_points:null,per_url:[],
    claimed_crawler_profiles:[],crawler_identities_verified:false,
    coverage_limited:true,limitations,total_findings:0,findings:[],findings_truncated:false,
  };
}
const offsetIso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
export function isoTimestamp(raw:unknown):number|undefined {
  if(typeof raw!=="string"||raw.length>40||!offsetIso.test(raw))return;
  const calendar=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(raw);
  if(!calendar)return;
  const [year,month,day,hour,minute,second]=calendar.slice(1).map(Number);
  if(year<2000||year>2100||month<1||month>12||hour>23||minute>59||second>59)return;
  const checked=new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if(checked.getUTCFullYear()!==year||checked.getUTCMonth()!==month-1||
    checked.getUTCDate()!==day)return;
  const zone=/([+-])(\d{2}):(\d{2})$/u.exec(raw);
  if(zone&&(Number(zone[2])>14||Number(zone[3])>59))return;
  const v=Date.parse(raw);
  return Number.isFinite(v)?v:undefined;
}
export function safeLogOrigin(raw:unknown):string|undefined {
  if(typeof raw!=="string"||byteLength(raw)>300) return;
  try{
    const url=new URL(raw);
    if(url.protocol!=="https:"||url.username||url.password||url.port||
      url.search||url.hash||!url.hostname.includes(".")||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/iu.test(url.hostname)||
      /^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname)||url.hostname.includes(":")||
      (raw!==url.origin&&raw!==url.origin+"/"))return;
    return url.origin;
  }catch{return;}
}
function safeRequestPath(raw:unknown,origin:string):{path:string;query:boolean}|undefined {
  if(typeof raw!=="string"||byteLength(raw)>1024||!raw.startsWith("/")||
    raw.startsWith("//")||raw.includes("\\")||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(raw)||
    /%(?:2e|2f|5c|00|0a|0d)/iu.test(raw)||raw.includes("#")||
    // URL() normalizes plain dot segments; reject them before path matching.
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(raw.split("?",1)[0])) return;
  try{
    const url=new URL(raw,origin);
    if(url.origin!==origin||url.username||url.password||url.hash)return;
    return {path:url.pathname,query:Boolean(url.search)};
  }catch{return;}
}
function validateImportant(input:unknown,origin:string):string[] {
  if(!Array.isArray(input)||input.length<1||input.length>MAX_CRAWL_IMPORTANT_URLS)
    throw new Error("Require 1–16 explicit same-origin important URLs");
  const out:string[]=[];
  for(const raw of input){
    if(typeof raw!=="string"||raw.length>512)throw new Error("Invalid important URL");
    let u:URL;
    try{u=new URL(raw);}catch{throw new Error("Invalid important URL");}
    if(u.origin!==origin||u.search||u.hash||u.username||u.password||u.port||
      !raw.startsWith(origin)||raw.includes("\\"))throw new Error("Unsafe important URL");
    // Validate the original path before URL.pathname can normalize ../.
    const path=safeRequestPath(raw.slice(origin.length)||"/",origin)?.path;
    if(!path||out.includes(path))throw new Error("Duplicate or unsafe important URL");
    out.push(path);
  }
  return out;
}
const months:Record<string,number>={
  Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,
  Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,
};
function apacheTime(raw:string):string|undefined {
  const m=/^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/u.exec(raw);
  if(!m||!months[m[2]])return;
  const [day,year,hour,minute,second,offsetHour,offsetMinute]=[
    Number(m[1]),Number(m[3]),Number(m[4]),Number(m[5]),
    Number(m[6]),Number(m[8]),Number(m[9])];
  if(year<2000||year>2100||hour>23||minute>59||second>59||offsetHour>14||offsetMinute>59)
    return;
  const month=months[m[2]];
  const checked=new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if(checked.getUTCDate()!==day||checked.getUTCMonth()!==month-1||checked.getUTCFullYear()!==year)
    return;
  const offset=(offsetHour*60+offsetMinute)*(m[7]==="+"?1:-1);
  return new Date(Date.UTC(year,month-1,day,hour,minute,second)-offset*60_000).toISOString();
}
/** A deliberately narrow Apache combined log parser; malformed lines become unknown evidence. */
export function parseCombinedAccessLine(line:string):LogObservation|undefined {
  if(typeof line!=="string"||byteLength(line)>2048)return;
  const m=/^\S+ \S+ \S+ \[([^\]]{15,45})\] "([A-Z]+) ([^"\s]{1,1024}) HTTP\/\d(?:\.\d)?" ([2-5]\d{2}) (?:\d+|-) "[^"]{0,1024}" "([^"]{0,300})"$/u.exec(line);
  if(!m)return;
  const timestamp=apacheTime(m[1]);
  if(!timestamp)return;
  return {timestamp,method:m[2],path:m[3],status:Number(m[4]),user_agent:m[5]};
}
function claimedAgent(raw:unknown):LogProfile {
  if(typeof raw!=="string"||raw.length>300)return "other";
  if(/googlebot/iu.test(raw))return "claimed_googlebot";
  if(/bingbot/iu.test(raw))return "claimed_bingbot";
  if(/gptbot/iu.test(raw))return "claimed_gptbot";
  return /bot|crawler|spider/iu.test(raw)?"claimed_other_bot":"other";
}
function accumulate(period:LogPeriodStats,status:number):void {
  period.requests++;
  if(status>=200&&status<300)period.http_2xx++;
  else if(status>=300&&status<400)period.redirects_3xx++;
  else if(status===401||status===403)period.block_401_403++;
  else if(status===429)period.rate_limited_429++;
  else if(status===404||status===410)period.missing_404_410++;
  else if(status>=500&&status<600)period.server_5xx++;
  else if(status>=400&&status<500)period.other_4xx++;
  if(status>=400)period.problem_responses++;
}
function finalize(period:LogPeriodStats):void{
  period.failure_rate_percent=period.requests?Math.round(period.problem_responses/period.requests*10_000)/100:null;
}
function addFinding(
  report:CrawlerLogReview,code:LogCode,severity:CrawlerLogFinding["severity"],
  message:string,urlIndex?:number,
):void{
  report.total_findings++;
  if(report.findings.length<MAX_CRAWL_FINDINGS)
    report.findings.push({code,severity,message,...(urlIndex===undefined?{}:{url_index:urlIndex})});
}
export function analyzeCrawlerLogs(input:CrawlerLogInput):CrawlerLogReview {
  if(!input||!CRAWL_LOG_FORMATS.includes(input.format))throw new Error("Invalid log format");
  const origin=safeLogOrigin(input.site_origin);
  if(!origin)throw new Error("Unsafe log site origin");
  const important=validateImportant(input.important_urls,origin);
  const cutoff=isoTimestamp(input.cutover_at);
  if(cutoff===undefined)throw new Error("Invalid offset-aware cutover timestamp");
  const report=emptyCrawlerLogReview(input.format);
  report.important_urls_supplied=important.length;
  const all:LogObservation[]=[];
  if(input.format==="structured"){
    if(input.access_log!==undefined||!Array.isArray(input.observations)||
      input.observations.length<1||input.observations.length>MAX_CRAWL_LOG_RECORDS)
      throw new Error("Invalid structured log evidence");
    if(byteLength(JSON.stringify(input.observations))>MAX_CRAWL_LOG_TOTAL_BYTES)
      throw new Error("Oversized structured log evidence");
    all.push(...input.observations);
  }else{
    if(input.observations!==undefined||typeof input.access_log!=="string"||
      byteLength(input.access_log)>MAX_CRAWL_LOG_TOTAL_BYTES)
      throw new Error("Invalid combined access log evidence");
    const lines=input.access_log.split(/\r?\n/u).filter(Boolean);
    if(lines.length<1||lines.length>MAX_CRAWL_LOG_RECORDS)
      throw new Error("Too many access log lines");
    for(const line of lines){
      const parsed=parseCombinedAccessLine(line);
      if(parsed)all.push(parsed);
      else report.invalid_records++;
    }
    report.source_records=lines.length;
  }
  if(input.format==="structured") report.source_records=all.length;
  const pathIndex=new Map(important.map((path,i)=>[path,i]));
  const urlStats:LogUrlStats[]=important.map((_,i)=>({
    url_index:i+1,before_requests:0,after_requests:0,
    after_problem_responses:0,after_block_401_403:0,
    after_rate_limited_429:0,after_server_5xx:0,
  }));
  const profiles:LogProfileStats[]=CRAWL_PROFILES.map(profile=>({
    profile,before_requests:0,after_requests:0,after_problem_responses:0,
  }));
  for(const item of all){
    const timestamp=isoTimestamp(item?.timestamp);
    const status=item?.status;
    const path=safeRequestPath(item?.path,origin);
    if(timestamp===undefined||!Number.isInteger(status)||status<200||status>599||
      typeof item?.method!=="string"||item.method.length>12||
      (item.user_agent!==undefined&&(typeof item.user_agent!=="string"||item.user_agent.length>300))||
      !path){
      report.invalid_records++;
      continue;
    }
    report.parsed_records++;
    if(path.query)report.query_variants_observed++;
    if(!["GET","HEAD"].includes(item.method)){
      report.ignored_methods++;
      continue;
    }
    const index=pathIndex.get(path.path);
    if(index===undefined){report.unmatched_requests++;continue;}
    report.matched_requests++;
    const after=timestamp>=cutoff;
    const period=after?report.after:report.before;
    accumulate(period,status);
    const u=urlStats[index];
    if(after){
      u.after_requests++;
      if(status>=400)u.after_problem_responses++;
      if(status===401||status===403)u.after_block_401_403++;
      if(status===429)u.after_rate_limited_429++;
      if(status>=500)u.after_server_5xx++;
    }else{u.before_requests++;}
    const profile=profiles.find(p=>p.profile===claimedAgent(item.user_agent))!;
    if(after){
      profile.after_requests++;
      if(status>=400)profile.after_problem_responses++;
    }else profile.before_requests++;
  }
  finalize(report.before);
  finalize(report.after);
  report.per_url=urlStats;
  report.claimed_crawler_profiles=profiles;
  if(report.before.failure_rate_percent!==null&&report.after.failure_rate_percent!==null)
    report.failure_rate_delta_percentage_points=
      Math.round((report.after.failure_rate_percent-report.before.failure_rate_percent)*100)/100;
  report.status=report.matched_requests===0?"not_comparable":
    report.before.requests===0||report.after.requests===0||report.invalid_records>0
      ?"partial":"comparable_sample";
  if(report.matched_requests===0)
    addFinding(report,"no_important_url_matches","warning",
      "No valid GET/HEAD requests match the bounded important-URL sample; do not infer pages were not crawled.");
  if(report.before.requests===0||report.after.requests===0)
    addFinding(report,"incomplete_before_after_sample","info",
      "At least one cutover period has no matched observations; a before/after failure-rate comparison is unavailable.");
  if(report.failure_rate_delta_percentage_points!==null&&
    report.failure_rate_delta_percentage_points>0)
    addFinding(report,"failed_requests_increased","warning",
      "The observed HTTP 4xx/5xx fraction increased after the supplied cutover; this does not prove a deployment or search-visibility cause.");
  if(report.after.block_401_403>0)
    addFinding(report,"post_block_challenge","warning",
      "HTTP 401/403 responses were observed on sampled important routes after the cutover.");
  if(report.after.rate_limited_429>0)
    addFinding(report,"post_rate_limiting","warning",
      "HTTP 429 rate limiting was observed on sampled important routes after the cutover.");
  if(report.after.server_5xx>0)
    addFinding(report,"post_server_errors","warning",
      "HTTP 5xx responses were observed on sampled important routes after the cutover.");
  if(report.after.missing_404_410>0)
    addFinding(report,"post_missing_pages","warning",
      "HTTP 404/410 responses were observed on sampled important routes after the cutover.");
  for(const u of urlStats){
    if(u.after_problem_responses>0)
      addFinding(report,"important_url_post_failures","warning",
        "This numbered important URL had one or more observed HTTP 4xx/5xx responses after the cutover.",u.url_index);
  }
  if(report.invalid_records>0)addFinding(report,"unparsed_log_entries","info",
    "Some input entries could not be parsed or safely matched; review coverage before interpreting apparent changes.");
  if(report.query_variants_observed>0)addFinding(report,"query_variants_observed","info",
    "Query-bearing log requests were counted by safe path only; raw query values were dropped.");
  if(profiles.some(p=>p.profile!=="other"&&(p.before_requests+p.after_requests)>0))
    addFinding(report,"user_agents_unverified","info",
      "Crawler groupings reflect claimed user-agent text; reverse-DNS or published-IP verification was not performed.");
  addFinding(report,"sample_only","info",
    "The supplied log sample and cutoff cannot establish complete server traffic, Google indexing or ranking causation.");
  report.findings_truncated=report.total_findings>report.findings.length;
  return report;
}
