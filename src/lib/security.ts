import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { pool } from './db';
import { ApiError, tokenHash } from './domain';

export const COOKIE='ludoteca_admin';
export function supabase(service=false) {
  const url=process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key=service?process.env.SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url||!key) throw new ApiError('Autenticazione non configurata.',503);
  return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}
export function isAdmin(id:string) { return (process.env.ADMIN_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean).includes(id); }
export function cookieToken(request:Request) {
  return request.headers.get('cookie')?.split(';').map(p=>p.trim()).find(p=>p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
}
export async function requireAdmin(request:Request) {
  const token=cookieToken(request);
  if(!token||token.length>8192) throw new ApiError('Accesso richiesto.',401);
  const {data,error}=await supabase().auth.getUser(token);
  if(error||!data.user) throw new ApiError('Sessione non valida. Accedi nuovamente.',401);
  if(!isAdmin(data.user.id)) throw new ApiError('Accesso non autorizzato.',403);
  return data.user;
}
export function checkOrigin(request:Request) {
  const expected=process.env.APP_URL;
  if(!expected) throw new ApiError('Applicazione non configurata.',503);
  let origin:string;
  try {origin=new URL(expected).origin;} catch {throw new ApiError('Applicazione non configurata.',503);}
  if(request.headers.get('origin')!==origin) throw new ApiError('Origine della richiesta non consentita.',403);
  if(request.headers.get('sec-fetch-site')==='cross-site') throw new ApiError('Origine della richiesta non consentita.',403);
}
export function cookie(value:string,maxAge:number) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0,Math.floor(maxAge))}${process.env.NODE_ENV==='production'||process.env.APP_URL?.startsWith('https:')?'; Secure':''}`;
}
export function authenticatedWorker(request:Request) {
  const expected=process.env.OUTBOX_SECRET,actual=request.headers.get('authorization')?.replace(/^Bearer /,'');
  return Boolean(expected && expected.length>=32 && actual && timingSafeEqual(Buffer.from(tokenHash(actual)),Buffer.from(tokenHash(expected))));
}
export async function rateLimit(request:Request,scope:string,limit=20,windowSeconds=900,subject='') {
  // Production per-client limits require TRUST_PROXY=true behind a proxy that strips client values.
  // Without that trusted deployment, deliberately share the bucket; never trust arbitrary IP headers.
  const ip=process.env.TRUST_PROXY==='true'?(request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'):'shared';
  const key=tokenHash(`${scope}:${ip}:${subject}`);
  const row=(await pool().query(`INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+($2*interval '1 second')) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<=now() THEN now()+($2*interval '1 second') ELSE rate_limits.expires_at END RETURNING count`,[key,windowSeconds])).rows[0];
  if(row.count>limit) throw new ApiError('Troppe richieste. Riprova piu tardi.',429);
}
export async function readBody(request:Request,maxBytes=32768) {
  if(Number(request.headers.get('content-length'))>maxBytes) throw new ApiError('Richiesta troppo grande.',413);
  const reader=request.body?.getReader();
  if(!reader) return new Uint8Array();
  const chunks:Uint8Array[]=[];let length=0;
  for(;;) {
    const {done,value}=await reader.read();if(done) break;
    length+=value.length;
    if(length>maxBytes) {await reader.cancel();throw new ApiError('Richiesta troppo grande.',413);}
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(request:Request):Promise<Record<string,unknown>> {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError('Formato richiesta non valido.',415);
  try {
    const value=JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error();return value;
  } catch(error) {if(error instanceof ApiError) throw error;throw new ApiError('JSON non valido.');}
}
