import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCruxField, emptyCruxFieldReview, validateCruxQuery, safeCruxTarget,
  MAX_CRUX_HISTORY_PERIODS, MAX_CRUX_RETURNED_PERIODS,
} from "../dist/modules/external-metrics/crux-field.js";
import {
  queryCruxField, CruxRequestError,
} from "../dist/modules/external-metrics/crux-field-probe.js";

const origin="https://example.com";
const page="https://example.com/products/item";
const query=(x={})=>({ mode:"daily",granularity:"origin",target:origin,form_factor:"PHONE",...x });
const asDate=d=>({year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()});
const period=i=>{
  const first=new Date(Date.UTC(2026,8,1+i*7));
  const last=new Date(first.getTime()+27*86400000);
  return {firstDate:asDate(first),lastDate:asDate(last)};
};
const data=(metrics={})=>({
  record:{key:{origin,formFactor:"PHONE"},
    metrics:{
      largest_contentful_paint:{percentiles:{p75:2200}},
      interaction_to_next_paint:{percentiles:{p75:175}},
      cumulative_layout_shift:{percentiles:{p75:"0.08"}},
      first_contentful_paint:{percentiles:{p75:1100}},
      experimental_time_to_first_byte:{percentiles:{p75:510}},
      ...metrics,
    },
    collectionPeriod:period(0),
  },
  urlNormalizationDetails:{originalUrl:"https://example.com/?secret=DO_NOT_ECHO"},
});
const hist=(n=6)=>{
  const record=structuredClone(data().record);
  const source=record.metrics;
  const metrics=Object.fromEntries(Object.entries(source).map(([id,v])=>
    [id,{percentilesTimeseries:{p75s:Array.from({length:n},(_,i)=>
      id==="cumulative_layout_shift"?(0.04+i/100).toFixed(2):
        v.percentiles.p75+i*10)}}]));
  return {record:{key:record.key,metrics,collectionPeriods:Array.from({length:n},(_,i)=>period(i))}};
};
const codes=r=>r.findings.map(f=>f.code);
const noSecrets=r=>{
  const s=JSON.stringify(r);
  assert(!s.includes("DO_NOT_ECHO"));
  assert(!s.includes("https://example.com"));
};
const apiKey="FAKEGOOGLECRUXKEY_12345678";
const response=(input,status=200)=>new Response(JSON.stringify(input),{
  status,headers:{"content-type":"application/json"},
});

test("V11-FIELD: valid daily field record computes real-user good CWV p75 with no raw URLs",()=>{
  const r=analyzeCruxField(data(),query());
  assert.equal(r.status,"complete");
  assert.equal(r.source,"caller_supplied");
  assert.equal(r.core_web_vitals,"good");
  assert.equal(r.p75.largest_contentful_paint,2200);
  assert.equal(r.p75.interaction_to_next_paint,175);
  assert.equal(r.p75.cumulative_layout_shift,0.08);
  assert.equal(r.period_end,"2026-09-28");
  assert.equal(r.metric_verdicts.first_contentful_paint,"good");
  assert.equal(r.total_findings,2);
  assert(codes(r).includes("core_web_vitals_good"));
  noSecrets(r);
});

test("V11-FIELD: CWV severe/needs-improvement threshold classification is correctly gated",()=>{
  const poor=data({largest_contentful_paint:{percentiles:{p75:4200}}});
  const a=analyzeCruxField(poor,query());
  assert.equal(a.core_web_vitals,"poor");
  assert.equal(a.metric_verdicts.largest_contentful_paint,"poor");
  const needs=data({interaction_to_next_paint:{percentiles:{p75:250}}});
  const b=analyzeCruxField(needs,query());
  assert.equal(b.core_web_vitals,"needs_improvement");
});

test("V11-FIELD: missing eligible metric never becomes 0 or false pass/fail",()=>{
  const raw=data();
  delete raw.record.metrics.interaction_to_next_paint;
  const r=analyzeCruxField(raw,query());
  assert.equal(r.status,"partial");
  assert.equal(r.p75.interaction_to_next_paint,null);
  assert.equal(r.core_web_vitals,"insufficient_data");
  assert(codes(r).includes("insufficient_core_web_vitals"));
});

test("V11-FIELD: zero p75 is valid and blank/NAN is unavailable",()=>{
  const raw=data({
    cumulative_layout_shift:{percentiles:{p75:"0.00"}},
    interaction_to_next_paint:{percentiles:{p75:null}},
  });
  const r=analyzeCruxField(raw,query());
  assert.equal(r.p75.cumulative_layout_shift,0);
  assert.equal(r.p75.interaction_to_next_paint,null);
  const raw2=data({interaction_to_next_paint:{percentiles:{p75:"NaN"}}});
  assert.equal(analyzeCruxField(raw2,query()).p75.interaction_to_next_paint,null);
});

test("V11-FIELD: invalid numeric, negative, infinity and non-CLS strings are excluded",()=>{
  const raw=data({
    largest_contentful_paint:{percentiles:{p75:-5}},
    cumulative_layout_shift:{percentiles:{p75:"Infinity"}},
    interaction_to_next_paint:{percentiles:{p75:"999"}},
    first_contentful_paint:{percentiles:{p75:9000000}},
  });
  const r=analyzeCruxField(raw,query());
  for(const key of ["largest_contentful_paint","cumulative_layout_shift","interaction_to_next_paint","first_contentful_paint"]){
    assert.equal(r.p75[key],null);
  }
});

test("V11-FIELD: strict exact-page vs origin identity and device matching",()=>{
  const raw=data();
  for(const q of [
    query({target:"https://elsewhere.com"}),
    query({granularity:"url",target:page}),
    query({form_factor:"DESKTOP"}),
  ]) assert.throws(()=>analyzeCruxField(raw,q));
  const p=structuredClone(raw);
  p.record.key={url:page,formFactor:"PHONE"};
  const r=analyzeCruxField(p,query({granularity:"url",target:page}));
  assert.equal(r.granularity,"url");
  assert.equal(r.p75.largest_contentful_paint,2200);
});

test("V11-FIELD: aggregated ALL form factor requires matching absence of formFactor",()=>{
  const raw=data();
  const q=query({form_factor:"ALL"});
  assert.throws(()=>analyzeCruxField(raw,q));
  delete raw.record.key.formFactor;
  assert.equal(analyzeCruxField(raw,q).form_factor,"ALL");
});

test("V11-FIELD: rejects private, query, fragment, http, IDN-internal and credentialed targets",()=>{
  for(const target of [
    "http://example.com", "https://example.com?token=abc","https://example.com/a#p",
    "https://user:pass@example.com/a","https://127.0.0.1", "https://localhost",
    "https://foo.internal/","https://example.invalid", "file:///etc/passwd",
    "https://example.com:8443/path",
  ]){
    assert.equal(safeCruxTarget(target,"url"),undefined,target);
  }
  assert.equal(safeCruxTarget(origin+"/","origin"),origin);
  assert.equal(safeCruxTarget(page,"url"),page);
});

test("V11-FIELD: rejects invalid date, non-28-day periods, and mismatched record structure",()=>{
  for(const fields of [
    {firstDate:{year:2026,month:2,day:30},lastDate:{year:2026,month:3,day:29}},
    {firstDate:{year:2026,month:10,day:1},lastDate:{year:2026,month:11,day:1}},
    {},
  ]){
    const raw=data();raw.record.collectionPeriod=fields;
    assert.throws(()=>analyzeCruxField(raw,query()));
  }
  const noRecord={error:{message:"FAKE KEY SECRET"}};
  assert.throws(()=>analyzeCruxField(noRecord,query()));
});

test("V11-FIELD: history is ascending, bounded to latest eight, with valid first-last deltas",()=>{
  const r=analyzeCruxField(hist(12),query({mode:"history"}));
  assert.equal(r.status,"complete");
  assert.equal(r.periods_available,12);
  assert.equal(r.periods_returned,MAX_CRUX_RETURNED_PERIODS);
  assert.equal(r.history_points[0].period,5);
  assert.equal(r.history_points.at(-1).period,12);
  assert.equal(r.first_last_delta.largest_contentful_paint,110);
  assert(codes(r).includes("historical_change"));
  noSecrets(r);
});

test("V11-FIELD: history missing eligible periods remain null and do not infer recovery",()=>{
  const raw=hist(4);
  raw.record.metrics.interaction_to_next_paint.percentilesTimeseries.p75s[1]=null;
  raw.record.metrics.cumulative_layout_shift.percentilesTimeseries.p75s[3]=null;
  const r=analyzeCruxField(raw,query({mode:"history"}));
  assert.equal(r.history_points[1].p75.interaction_to_next_paint,null);
  assert.equal(r.p75.cumulative_layout_shift,null);
  assert.equal(r.core_web_vitals,"insufficient_data");
  assert.equal(r.first_last_delta.cumulative_layout_shift,null);
  assert(codes(r).includes("historical_gaps"));
});

test("V11-FIELD: history rejects reversed/double dates, wrong array lengths and 41 periods",()=>{
  const bad=hist(2);
  bad.record.collectionPeriods.reverse();
  assert.throws(()=>analyzeCruxField(bad,query({mode:"history"})));
  const mismatched=hist(3);
  mismatched.record.metrics.largest_contentful_paint.percentilesTimeseries.p75s.pop();
  assert.throws(()=>analyzeCruxField(mismatched,query({mode:"history"})));
  assert.throws(()=>analyzeCruxField(hist(MAX_CRUX_HISTORY_PERIODS+1),query({mode:"history"})));
});

test("V11-FIELD: source attribution is not forged for caller-supplied JSON",()=>{
  const r=analyzeCruxField(data(),query());
  assert.equal(r.source,"caller_supplied");
  assert.equal(emptyCruxFieldReview().source,"caller_supplied");
});

test("V11-FIELD: live CrUX only reaches fixed Google API, with no credential in results",async()=>{
  let requested=0;
  const fetchFn=async(url,opts)=>{
    requested++;
    const u=new URL(url);
    assert.equal(u.origin,"https://chromeuxreport.googleapis.com");
    assert.equal(u.pathname,"/v1/records:queryRecord");
    assert.equal(u.searchParams.get("key"),apiKey);
    assert.equal(opts.method,"POST");
    assert.equal(opts.redirect,"error");
    assert.equal(opts.credentials,"omit");
    assert.equal(opts.cache,"no-store");
    const payload=JSON.parse(opts.body);
    assert.equal(payload.origin,origin);
    assert.deepEqual(payload.metrics.length,5);
    return response(data());
  };
  const r=await queryCruxField(query(),fetchFn,apiKey);
  assert.equal(requested,1);
  assert.equal(r.source,"verified_crux_api");
  assert.equal(r.status,"complete");
  assert(!JSON.stringify(r).includes(apiKey));
});

test("V11-FIELD: history client requests at most 40 and sends no traffic to target site",async()=>{
  const r=await queryCruxField(query({mode:"history"}),async(url,options)=>{
    assert(new URL(url).pathname.endsWith("queryHistoryRecord"));
    const payload=JSON.parse(options.body);
    assert.equal(payload.collectionPeriodCount,40);
    assert.equal(payload.origin,origin);
    return response(hist(3));
  },apiKey);
  assert.equal(r.periods_available,3);
});

test("V11-FIELD: no API key fails before any outbound fetch",async()=>{
  let calls=0;
  await assert.rejects(queryCruxField(query(),async()=>{
    calls++;return response(data());
  },undefined),e=>e instanceof CruxRequestError && e.code==="missing_key");
  assert.equal(calls,0);
});

test("V11-FIELD: 404 eligibility is unavailable not a manufactured zero",async()=>{
  const r=await queryCruxField(query(),async()=>response({error:{message:"private"}},404),apiKey);
  assert.equal(r.source,"verified_crux_api");
  assert.equal(r.status,"unavailable");
  assert.equal(r.p75.largest_contentful_paint,null);
  assert(!JSON.stringify(r).includes("private"));
});

test("V11-FIELD: 403,429,500,redirect,network failures map to fixed codes without body leaks",async()=>{
  for(const [status,code] of [[403,"access_denied"],[429,"rate_limited"],[500,"api_unavailable"]]){
    await assert.rejects(queryCruxField(query(),async()=>response({message:"secret-token"},status),apiKey),
      e=>e instanceof CruxRequestError&&e.code===code&&!String(e).includes("secret"));
  }
  await assert.rejects(queryCruxField(query(),async()=>{throw Error("internal secret")},apiKey),
    e=>e instanceof CruxRequestError&&e.code==="api_unavailable");
});

test("V11-FIELD: rejects invalid response JSON, wrong MIME, oversized stream and identity drift",async()=>{
  await assert.rejects(queryCruxField(query(),async()=>new Response("bad",{
    status:200,headers:{"content-type":"application/json"},
  }),apiKey),e=>e.code==="invalid_response");
  await assert.rejects(queryCruxField(query(),async()=>new Response("ok",{
    status:200,headers:{"content-type":"text/plain"},
  }),apiKey),e=>e.code==="invalid_response");
  await assert.rejects(queryCruxField(query(),async()=>new Response("x".repeat(300001),{
    status:200,headers:{"content-type":"application/json"},
  }),apiKey),e=>e.code==="invalid_response");
  await assert.rejects(queryCruxField(query(),async()=>{
    const raw=data();raw.record.key.origin="https://another.example";
    return response(raw);
  },apiKey),e=>e.code==="invalid_response");
});
