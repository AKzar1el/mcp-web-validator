/**
 * Optional V13 Google common-crawler source-IP evidence.
 * One opt-in GET to a fixed, official Google JSON endpoint; never send site,
 * log records or client IPs to Google. Caller data never influences the URL.
 */
import { isIP } from "node:net";

export const GOOGLE_COMMON_CRAWLERS_URL =
  "https://developers.google.com/static/crawling/ipranges/common-crawlers.json";
export const MAX_GOOGLE_RANGES_BYTES=512_000;
export const MAX_GOOGLE_CIDR_PREFIXES=1_000;

interface NumericAddress { family:4|6; bits:32|128; value:bigint }
export interface NumericCidr extends NumericAddress { length:number }

function parseV4(value:string):NumericAddress|undefined {
  if(isIP(value)!==4)return;
  const octets=value.split(".").map(Number);
  if(octets.length!==4||octets.some(n=>!Number.isInteger(n)||n<0||n>255))return;
  return {family:4,bits:32,value:octets.reduce((n,octet)=>(n<<8n)|BigInt(octet),0n)};
}
function parseV6(value:string):NumericAddress|undefined {
  if(isIP(value)!==6||value.includes("%"))return;
  let expanded=value.toLowerCase();
  // Node's isIP permits IPv4-mapped IPv6; normalize the dotted tail.
  if(expanded.includes(".")){
    const tail=expanded.slice(expanded.lastIndexOf(":")+1);
    const v4=parseV4(tail);
    if(!v4)return;
    const hi=Number(v4.value>>16n).toString(16);
    const lo=Number(v4.value&0xffffn).toString(16);
    expanded=expanded.slice(0,expanded.lastIndexOf(":")+1)+hi+":"+lo;
  }
  const parts=expanded.split("::");
  if(parts.length>2)return;
  const left=parts[0]?parts[0].split(":"):[];
  const right=parts.length===2&&parts[1]?parts[1].split(":"):[];
  const missing=8-left.length-right.length;
  if(parts.length===1?missing!==0:missing<1)return;
  const words=[...left,...Array(missing).fill("0"),...right];
  if(words.length!==8||words.some(w=>!/^[0-9a-f]{1,4}$/u.test(w)))return;
  return {family:6,bits:128,value:words.reduce((n,w)=>(n<<16n)|BigInt(parseInt(w,16)),0n)};
}
function parseAddress(value:string):NumericAddress|undefined {
  const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(value);
  if(mapped&&isIP(value)===6)return parseV4(mapped[1]);
  return isIP(value)===4?parseV4(value):parseV6(value);
}
function parseCidr(value:string):NumericCidr|undefined {
  if(typeof value!=="string"||value.length>65)return;
  const parts=value.split("/");
  if(parts.length!==2||!/^(?:0|[1-9]\d{0,2})$/u.test(parts[1]))return;
  const address=parseAddress(parts[0]);
  if(!address)return;
  const length=Number(parts[1]);
  if(length<0||length>address.bits)return;
  return {...address,length};
}

export function parseOfficialGoogleCommonRanges(raw:string):NumericCidr[]{
  if(typeof raw!=="string"||Buffer.byteLength(raw,"utf8")>MAX_GOOGLE_RANGES_BYTES)
    throw new Error("Invalid official crawler IP range response");
  const payload:unknown=JSON.parse(raw);
  if(!payload||typeof payload!=="object"||!Array.isArray((payload as {prefixes?:unknown}).prefixes))
    throw new Error("Invalid official crawler IP range response");
  const prefixes=(payload as {prefixes:unknown[]}).prefixes;
  if(prefixes.length<1||prefixes.length>MAX_GOOGLE_CIDR_PREFIXES)
    throw new Error("Invalid official crawler IP range count");
  return prefixes.map((entry)=>{
    if(!entry||typeof entry!=="object")throw new Error("Invalid crawler IP range");
    const p=entry as {ipv4Prefix?:unknown;ipv6Prefix?:unknown};
    const v=typeof p.ipv4Prefix==="string"&&p.ipv6Prefix===undefined?p.ipv4Prefix:
      typeof p.ipv6Prefix==="string"&&p.ipv4Prefix===undefined?p.ipv6Prefix:undefined;
    const cidr=v&&parseCidr(v);
    if(!cidr||(p.ipv4Prefix!==undefined&&cidr.family!==4)||
      (p.ipv6Prefix!==undefined&&cidr.family!==6))
      throw new Error("Invalid crawler IP range");
    return cidr;
  });
}

export function matchesOfficialGoogleRange(raw:unknown,ranges:readonly NumericCidr[]):boolean|null {
  if(typeof raw!=="string"||raw.length>64)return null;
  const ip=parseAddress(raw);
  if(!ip)return null;
  return ranges.some(cidr=>cidr.family===ip.family&&
    (ip.value>>BigInt(ip.bits-cidr.length))===(cidr.value>>BigInt(cidr.bits-cidr.length)));
}

export async function fetchOfficialGoogleCommonRanges(
  fetcher:typeof fetch=fetch,
):Promise<NumericCidr[]> {
  const response=await fetcher(GOOGLE_COMMON_CRAWLERS_URL,{
    method:"GET",redirect:"manual",cache:"no-store",
    headers:{accept:"application/json"},signal:AbortSignal.timeout(8_000),
  });
  if(response.status!==200||!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
    throw new Error("Official crawler IP range response unavailable");
  const length=Number(response.headers.get("content-length"));
  if(response.headers.has("content-length")&&(!Number.isFinite(length)||length>MAX_GOOGLE_RANGES_BYTES||length<0))
    throw new Error("Oversized official crawler IP range response");
  if(!response.body)throw new Error("Empty official crawler IP range response");
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let bytes=0;
  let text="";
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_GOOGLE_RANGES_BYTES)throw new Error("Oversized official crawler IP range response");
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
  }finally{await reader.cancel().catch(()=>{});}
  return parseOfficialGoogleCommonRanges(text);
}
