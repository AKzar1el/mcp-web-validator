/** V11-FIELD: bounded, evidence-only Chrome UX Report p75 field diagnostics. */
export const CRUX_METRICS = [
  "largest_contentful_paint", "interaction_to_next_paint",
  "cumulative_layout_shift", "first_contentful_paint",
  "experimental_time_to_first_byte",
] as const;
export const CRUX_FORMS = ["ALL", "PHONE", "DESKTOP", "TABLET"] as const;
export const CRUX_MODES = ["daily", "history"] as const;
export const CRUX_SOURCES = ["caller_supplied", "verified_crux_api"] as const;
export const MAX_CRUX_RESPONSE_BYTES = 300_000;
export const MAX_CRUX_HISTORY_PERIODS = 40;
export const MAX_CRUX_RETURNED_PERIODS = 8;
export const MAX_CRUX_FINDINGS = 12;
export const CRUX_FINDING_CODES = [
  "metric_missing", "core_web_vitals_good", "core_web_vitals_poor",
  "core_web_vitals_needs_improvement", "insufficient_core_web_vitals",
  "historical_gaps", "historical_change", "field_sample_only",
] as const;
export type CruxMode = typeof CRUX_MODES[number];
export type CruxForm = typeof CRUX_FORMS[number];
export type CruxSource = typeof CRUX_SOURCES[number];
export type CruxMetric = typeof CRUX_METRICS[number];
export type CruxCode = typeof CRUX_FINDING_CODES[number];
export type CruxVerdict = "good" | "needs_improvement" | "poor" | "unavailable";
type CruxMetrics = Record<CruxMetric, number | null>;
export interface CruxFinding { code: CruxCode; severity: "warning" | "info"; message: string }
export interface CruxHistoryPoint {
  period: number;
  period_end: string;
  p75: CruxMetrics;
  core_web_vitals: "good" | "needs_improvement" | "poor" | "insufficient_data";
}
export interface CruxFieldReview {
  scope: "crux_real_user_field_p75";
  mode: CruxMode;
  source: CruxSource;
  granularity: "origin" | "url";
  form_factor: CruxForm;
  status: "complete" | "partial" | "unavailable";
  period_end: string | null;
  p75: CruxMetrics;
  metric_verdicts: Record<CruxMetric, CruxVerdict>;
  core_web_vitals: "good" | "needs_improvement" | "poor" | "insufficient_data";
  periods_available: number;
  periods_returned: number;
  history_points: CruxHistoryPoint[];
  first_last_delta: CruxMetrics;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: CruxFinding[];
  findings_truncated: boolean;
  error?: string;
}
const thresholds: Record<CruxMetric, [number,number]> = {
  largest_contentful_paint: [2500, 4000],
  interaction_to_next_paint: [200,500],
  cumulative_layout_shift: [0.1,0.25],
  first_contentful_paint: [1800,3000],
  experimental_time_to_first_byte: [800,1800],
};
const limitations = [
  "CrUX percentiles represent aggregated eligible Chrome real-user experiences over rolling 28-day windows, not a current page fetch or an exhaustive sample of every visitor.",
  "URL-level and origin-level records cover different populations; returned p75 values cannot be combined across them or interpreted as a Lighthouse laboratory score.",
  "History entries are overlapping weekly 28-day windows, not independent weekly samples. Missing eligible data stays null; no causality, traffic, Google ranking or indexing conclusion.",
  "Caller-supplied JSON is not authenticated CrUX evidence; live source requires an explicit opt-in and a local CRUX_API_KEY environment variable.",
];
const emptyMetrics = (): CruxMetrics => Object.fromEntries(CRUX_METRICS.map(k=>[k,null])) as CruxMetrics;
const emptyVerdicts = (): Record<CruxMetric,CruxVerdict> =>
  Object.fromEntries(CRUX_METRICS.map(k=>[k,"unavailable"])) as Record<CruxMetric,CruxVerdict>;
export function emptyCruxFieldReview(
  mode: CruxMode="daily", source: CruxSource="caller_supplied",
  granularity:"origin"|"url"="origin", form:CruxForm="ALL",
): CruxFieldReview {
  return {
    scope:"crux_real_user_field_p75", mode, source, granularity,
    form_factor: form, status:"unavailable", period_end:null,
    p75:emptyMetrics(),metric_verdicts:emptyVerdicts(),core_web_vitals:"insufficient_data",
    periods_available:0, periods_returned:0, history_points:[],
    first_last_delta:emptyMetrics(),coverage_limited:true,limitations,
    total_findings:0,findings:[],findings_truncated:false,
  };
}
function recordObject(value:unknown):Record<string,unknown>|undefined {
  return value !== null && typeof value==="object" && !Array.isArray(value)
    ? value as Record<string,unknown> : undefined;
}
function dateValue(value:unknown):string {
  const d=recordObject(value);
  if (!d||!Number.isInteger(d.year)||!Number.isInteger(d.month)||!Number.isInteger(d.day))
    throw new Error("Invalid CrUX collection date");
  const year=d.year as number, month=d.month as number, day=d.day as number;
  if(year<2000||year>2100||month<1||month>12||day<1||day>31)
    throw new Error("Invalid CrUX collection date");
  const timestamp=Date.UTC(year,month-1,day);
  const parsed=new Date(timestamp);
  if (parsed.getUTCFullYear()!==year||parsed.getUTCMonth()!==month-1||parsed.getUTCDate()!==day)
    throw new Error("Invalid CrUX collection date");
  return parsed.toISOString().slice(0,10);
}
function periodEnd(period:unknown):string {
  const p=recordObject(period);
  if(!p) throw new Error("Missing CrUX collection period");
  const start=dateValue(p.firstDate), end=dateValue(p.lastDate);
  const days=(Date.parse(end)-Date.parse(start))/86400000;
  if(days!==27) throw new Error("Unexpected CrUX collection window");
  return end;
}
function percentile(raw:unknown,metric:CruxMetric):number|null {
  if(raw===null||raw===undefined||raw==="NaN") return null;
  const value=typeof raw==="number"?raw:
    metric==="cumulative_layout_shift"&&typeof raw==="string"&&/^\d+(?:\.\d{1,5})?$/u.test(raw)
      ?Number(raw):Number.NaN;
  if(!Number.isFinite(value)||value<0||value>(metric==="cumulative_layout_shift"?100:600000)) return null;
  return metric==="cumulative_layout_shift"?Math.round(value*1000)/1000:Math.round(value);
}
function verdict(value:number|null,metric:CruxMetric):CruxVerdict {
  if (value===null) return "unavailable";
  const [good,poor]=thresholds[metric];
  return value<=good?"good":value<=poor?"needs_improvement":"poor";
}
function coreVerdict(metrics:CruxMetrics):CruxFieldReview["core_web_vitals"] {
  const values=[
    verdict(metrics.largest_contentful_paint,"largest_contentful_paint"),
    verdict(metrics.interaction_to_next_paint,"interaction_to_next_paint"),
    verdict(metrics.cumulative_layout_shift,"cumulative_layout_shift"),
  ];
  if(values.includes("unavailable"))return "insufficient_data";
  if(values.includes("poor"))return "poor";
  if(values.includes("needs_improvement"))return "needs_improvement";
  return "good";
}
function metricsFrom(record:Record<string,unknown>,index?:number,total?:number):CruxMetrics {
  const out=emptyMetrics();
  const metrics=recordObject(record.metrics)??{};
  for(const metric of CRUX_METRICS) {
    const entry=recordObject(metrics[metric]);
    if(!entry)continue;
    if (index===undefined) {
      const fields=recordObject(entry.percentiles);
      out[metric]=percentile(fields?.p75,metric);
    } else {
      const fields=recordObject(entry.percentilesTimeseries);
      const values=fields?.p75s;
      if(!Array.isArray(values)||values.length!==total) throw new Error("Malformed CrUX historical percentile series");
      out[metric]=percentile(values[index],metric);
    }
  }
  return out;
}
function addFinding(report:CruxFieldReview,code:CruxCode,severity:CruxFinding["severity"],message:string):void{
  report.total_findings++;
  if(report.findings.length<MAX_CRUX_FINDINGS)report.findings.push({code,severity,message});
}
export interface CruxQuery {
  granularity:"origin"|"url";
  target:string;
  form_factor:CruxForm;
  mode:CruxMode;
}
export function safeCruxTarget(target:unknown,granularity:"origin"|"url"):string|undefined {
  if(typeof target!=="string"||target.length>512||/[\u0000-\u001f\u007f\u202a-\u202e\\]/u.test(target))return;
  try{
    const url=new URL(target);
    if(url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash||
      !url.hostname.includes(".")||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/iu.test(url.hostname)||
      /^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname)||url.hostname.includes(":")) return;
    if(granularity==="origin") {
      if(target!==url.origin && target!==url.origin+"/")return;
      return url.origin;
    }
    return url.href;
  }catch{return;}
}
export function validateCruxQuery(query:CruxQuery):CruxQuery{
  if(!query||!CRUX_MODES.includes(query.mode)||!CRUX_FORMS.includes(query.form_factor)||
    (query.granularity!=="origin"&&query.granularity!=="url"))throw new Error("Unsupported CrUX query");
  const target=safeCruxTarget(query.target,query.granularity);
  if(!target)throw new Error("Unsafe CrUX target identifier");
  return {...query,target};
}
export function analyzeCruxField(
  supplied:unknown, query:CruxQuery, source:CruxSource="caller_supplied",
):CruxFieldReview {
  const q=validateCruxQuery(query);
  if(!CRUX_SOURCES.includes(source))throw new Error("Invalid CrUX evidence source");
  if(typeof supplied!=="object"||supplied===null)throw new Error("CrUX response is not an object");
  const root=recordObject(supplied);
  const record=recordObject(root?.record);
  const key=recordObject(record?.key);
  if(!record||!key)throw new Error("CrUX response is missing record identity");
  const returned=key[q.granularity];
  if(typeof returned!=="string"||
    safeCruxTarget(returned,q.granularity)!==q.target||
    (q.form_factor==="ALL" ? key.formFactor!==undefined :
      key.formFactor!==q.form_factor) ||
    (q.granularity==="url"&&key.origin!==undefined) ||
    (q.granularity==="origin"&&key.url!==undefined)) {
    throw new Error("CrUX response identity or device class does not match the requested record");
  }
  const review=emptyCruxFieldReview(q.mode,source,q.granularity,q.form_factor);
  if(q.mode==="daily"){
    review.period_end=periodEnd(record.collectionPeriod);
    review.p75=metricsFrom(record);
    review.periods_available=1;
  }else{
    const periods=record.collectionPeriods;
    if(!Array.isArray(periods)||periods.length<1||periods.length>MAX_CRUX_HISTORY_PERIODS)
      throw new Error("Invalid CrUX history period count");
    let previous="";
    const all:CruxHistoryPoint[]=[];
    for(let i=0;i<periods.length;i++) {
      const end=periodEnd(periods[i]);
      if(end<=previous)throw new Error("CrUX history periods are not strictly ascending");
      previous=end;
      const p75=metricsFrom(record,i,periods.length);
      all.push({period:i+1,period_end:end,p75,core_web_vitals:coreVerdict(p75)});
    }
    review.periods_available=periods.length;
    review.history_points=all.slice(-MAX_CRUX_RETURNED_PERIODS);
    review.periods_returned=review.history_points.length;
    review.period_end=all[all.length-1].period_end;
    review.p75=all[all.length-1].p75;
    for(const metric of CRUX_METRICS){
      const first=all[0].p75[metric],last=review.p75[metric];
      review.first_last_delta[metric]=first===null||last===null?null:
        Math.round((last-first)*1000)/1000;
    }
    if (all.some(x=>x.core_web_vitals==="insufficient_data"))
      addFinding(review,"historical_gaps","info",
        "Some historical windows do not have all eligible Core Web Vitals; missing periods were not interpolated.");
    if(CRUX_METRICS.some(m=>review.first_last_delta[m]!==null&&review.first_last_delta[m]!==0))
      addFinding(review,"historical_change","info",
        "First-versus-last field percentiles differ; overlapping 28-day windows cannot identify a specific deployment cause.");
  }
  review.core_web_vitals=coreVerdict(review.p75);
  for(const metric of CRUX_METRICS) {
    review.metric_verdicts[metric]=verdict(review.p75[metric],metric);
  }
  const missing=CRUX_METRICS.filter(m=>review.p75[m]===null);
  review.status=missing.length===0?"complete":missing.length===CRUX_METRICS.length?"unavailable":"partial";
  if(missing.length>0)addFinding(review,"metric_missing","info",
    "Some requested CrUX field percentile data are unavailable for the eligible population.");
  if(review.core_web_vitals==="good")addFinding(review,"core_web_vitals_good","info",
    "All three available real-user CWV p75 values fall in good ranges for this sampled population.");
  else if(review.core_web_vitals==="poor")addFinding(review,"core_web_vitals_poor","warning",
    "At least one real-user Core Web Vitals p75 value is poor; evaluate the reported device/population.");
  else if(review.core_web_vitals==="needs_improvement")addFinding(review,"core_web_vitals_needs_improvement","warning",
    "At least one real-user Core Web Vitals p75 value needs improvement.");
  else addFinding(review,"insufficient_core_web_vitals","info",
    "One or more LCP, INP or CLS percentiles are missing; do not declare the population passed or failed.");
  addFinding(review,"field_sample_only","info",
    "Field data are aggregated Chrome experience for an origin or exact page, not all traffic or a current deployment audit.");
  review.findings_truncated=review.total_findings>review.findings.length;
  return review;
}
