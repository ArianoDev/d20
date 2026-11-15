import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const text = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z.string().max(2048).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}, 'URL HTTPS non valido');
export const gameSchema = z.object({
  title:text(200), minPlayers:z.number().int().min(1).max(100), maxPlayers:z.number().int().min(1).max(100),
  duration:z.number().int().min(1).max(10080), complexity:z.number().min(1).max(5), description:text(20000),
  images:z.array(httpsUrl).min(1).max(12), bggUrl:httpsUrl.pipe(z.string().refine(v=>{
    const url=new URL(v);
    return url.hostname==='boardgamegeek.com' && url.port==='' && /^\/boardgame\/[1-9]\d*(?:\/|$)/.test(url.pathname);
  }, 'URL BoardGameGeek non valido')),
  archived:z.boolean().default(false),
}).strict().refine(g=>g.minPlayers<=g.maxPlayers,'Numero di giocatori non valido');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const settingsSchema = z.object({
  roomCapacity:z.number().int().min(1).max(1000),
  tables:z.array(z.object({id:text(80).regex(/^[a-zA-Z0-9_-]+$/),name:text(100),seats:z.union([z.literal(2),z.literal(4),z.literal(6)])}).strict()).min(1).max(100),
  openingDays:z.array(z.number().int().min(0).max(6)).min(1).max(7), openTime:time,
  closeTime:z.union([time,z.literal('24:00')]),slotMinutes:z.number().int().min(15).max(720),
}).strict().refine(s=>new Set(s.tables.map(t=>t.id)).size===s.tables.length && new Set(s.openingDays).size===s.openingDays.length && s.openTime<s.closeTime,'Configurazione orari o tavoli non valida');
export type Settings = z.infer<typeof settingsSchema>;
export type Availability = {slots:{start:string;end:string;tables:(Settings['tables'][number]&{occupied:boolean;available:boolean})[];remainingCapacity:number}[]};
export const updateBookingSchema = z.object({
  participants:z.array(text(100)).min(1).max(6),tableId:text(80),
  start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}),
}).strict();
export const bookingSchema = updateBookingSchema.extend({email:z.email().max(254),website:z.string().max(200).optional()}).strict();
export type BookingInput = z.infer<typeof bookingSchema>;
export type BookingUpdate = z.infer<typeof updateBookingSchema>;
export function parse<T>(schema:z.ZodType<T>, value:unknown):T {
  const parsed=schema.safeParse(value);
  if(!parsed.success) throw new ApiError('Dati non validi. Controlla i campi inseriti.');
  return parsed.data;
}
export const newToken=()=>randomBytes(32).toString('base64url');
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
function encryptionKey() {
  const key=Buffer.from(process.env.EMAIL_ENCRYPTION_KEY ?? '', 'base64');
  if(key.length!==32) throw new ApiError('Servizio email non configurato.',503);
  return key;
}
export function seal(value:string) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
}
export function unseal(value:string) {
  const bytes=Buffer.from(value,'base64');
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
}
const rome = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function romeDate(iso:string) {
  const p=Object.fromEntries(rome.formatToParts(new Date(iso)).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function slotsForDate(date:string,settings:Pick<Settings,'openingDays'|'openTime'|'closeTime'|'slotMinutes'>):{start:string;end:string}[] {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const midnight=Date.parse(`${date}T00:00:00Z`);
  if(!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0,10)!==date || !settings.openingDays.includes(new Date(midnight).getUTCDay())) return [];
  const minutes=(v:string)=>Number(v.slice(0,2))*60+Number(v.slice(3));
  // Map civil minutes to UTC candidates. Nonexistent and ambiguous DST times are not bookable.
  const candidates=new Map<number,number[]>();
  const nextDate=new Date(midnight+86400000).toISOString().slice(0,10);
  for(let instant=midnight-3*3600000;instant<=midnight+26*3600000;instant+=60000) {
    const p=Object.fromEntries(rome.formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
    const day=`${p.year}-${p.month}-${p.day}`,m=Number(p.hour)*60+Number(p.minute);
    const key=day===date?m:day===nextDate && m===0?1440:-1;
    if(key>=0) candidates.set(key,[...(candidates.get(key)??[]),instant]);
  }
  const slots=[];
  for(let m=minutes(settings.openTime);m+settings.slotMinutes<=minutes(settings.closeTime);m+=settings.slotMinutes) {
    const a=candidates.get(m),b=candidates.get(m+settings.slotMinutes);
    if(a?.length===1 && b?.length===1 && b[0]-a[0]===settings.slotMinutes*60000) slots.push({start:new Date(a[0]).toISOString(),end:new Date(b[0]).toISOString()});
  }
  return slots;
}
export function validImage(bytes:Buffer,mime:string) {
  if(bytes.length>5*1024*1024) return false;
  if(mime==='image/png') return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg') return bytes.length>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  if(mime==='image/webp') return bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP';
  return false;
}
