/** V11-FIELD: opt-in fixed Google CrUX API client; no target-URL fetch. */
import {
  analyzeCruxField, emptyCruxFieldReview, validateCruxQuery,
  MAX_CRUX_RESPONSE_BYTES, CRUX_METRICS, type CruxFieldReview, type CruxQuery,
} from "./crux-field.js";
const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:";
export const CRUX_TIMEOUT_MS = 12_000;
export class CruxRequestError extends Error {
  constructor(readonly code:"missing_key"|"rate_limited"|"access_denied"|"api_unavailable"|"invalid_response") {
    super("CrUX request unavailable: "+code);
    this.name="CruxRequestError";
  }
}
async function jsonBounded(response:Response):Promise<unknown> {
  const type=response.headers.get("content-type")?.split(";",1)[0].trim().toLowerCase();
  if(type!=="application/json")throw new CruxRequestError("invalid_response");
  const declared=Number(response.headers.get("content-length"));
  if(Number.isFinite(declared)&&declared>MAX_CRUX_RESPONSE_BYTES)
    throw new CruxRequestError("invalid_response");
  if(!response.body)throw new CruxRequestError("invalid_response");
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>MAX_CRUX_RESPONSE_BYTES)throw new CruxRequestError("invalid_response");
      chunks.push(value);
    }
  }finally{try{await reader.cancel();}catch{/* Reader already closed. */}reader.releaseLock();}
  const merged=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(merged));}
  catch{throw new CruxRequestError("invalid_response");}
}
type FetchFunction=(url:string,options:RequestInit)=>Promise<Response>;
export async function queryCruxField(
  query:CruxQuery,
  fetchFn:FetchFunction=(url,opts)=>fetch(url,opts),
  apiKey:string|undefined=process.env.CRUX_API_KEY,
):Promise<CruxFieldReview>{
  const q=validateCruxQuery(query);
  if(!apiKey||!/^[-_A-Za-z0-9]{15,150}$/u.test(apiKey))
    throw new CruxRequestError("missing_key");
  const endpoint=ENDPOINT+(q.mode==="daily"?"queryRecord":"queryHistoryRecord");
  const url=endpoint+"?"+new URLSearchParams({key:apiKey}).toString();
  const body:Record<string,unknown>={
    [q.granularity]:q.target,
    metrics:[...CRUX_METRICS],
  };
  if(q.form_factor!=="ALL")body.formFactor=q.form_factor;
  if(q.mode==="history")body.collectionPeriodCount=40;
  let response:Response;
  try{
    response=await fetchFn(url,{
      method:"POST",
      headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(CRUX_TIMEOUT_MS),
      redirect:"error",credentials:"omit",cache:"no-store",
    });
  }catch{throw new CruxRequestError("api_unavailable");}
  if(response.redirected)throw new CruxRequestError("api_unavailable");
  if(response.status===404) {
    try{await response.body?.cancel();}catch{/* no body */ }
    const empty=emptyCruxFieldReview(q.mode,"verified_crux_api",q.granularity,q.form_factor);
    empty.error="No eligible CrUX field data is available for this requested population.";
    return empty;
  }
  if(response.status!==200||!response.ok){
    try{await response.body?.cancel();}catch{/* Remote body not needed. */}
    if(response.status===429)throw new CruxRequestError("rate_limited");
    if(response.status===401||response.status===403)throw new CruxRequestError("access_denied");
    throw new CruxRequestError("api_unavailable");
  }
  const parsed=await jsonBounded(response);
  try{return analyzeCruxField(parsed,q,"verified_crux_api");}
  catch{throw new CruxRequestError("invalid_response");}
}
