import type { PoolClient } from 'pg';
import { pool, transaction } from './db';
import { ApiError, bookingSchema, gameSchema, newToken, parse, romeDate, seal, settingsSchema, slotsForDate, tokenHash, updateBookingSchema, type Availability, type BookingInput, type BookingUpdate, type Settings } from './domain';

export type Booking={id:string;email:string;participants:string[];tableId:string;start:string;end:string;status:'pending'|'confirmed'|'rejected'|'cancelled';createdAt:string};
const fields=`id,email,participants,table_id AS "tableId",start_at AS start,end_at AS "end",status,created_at AS "createdAt"`;
function normalize(row:Record<string,unknown>):Booking {
  return {...row,start:new Date(row.start as string).toISOString(),end:new Date(row.end as string).toISOString(),createdAt:new Date(row.createdAt as string).toISOString()} as Booking;
}
export async function getSettings(client:Pick<PoolClient,'query'>=pool()):Promise<Settings> { return (await client.query('SELECT data FROM settings WHERE id=true')).rows[0].data; }
async function active(client:Pick<PoolClient,'query'>,start:string,end:string,exclude=''):Promise<Booking[]> {
  return (await client.query(`SELECT ${fields} FROM bookings WHERE status IN ('pending','confirmed') AND start_at<$2 AND end_at>$1 AND id::text<>$3`,[start,end,exclude])).rows.map(normalize);
}
function occupiedAtPeak(bookings:Booking[],start:string,end:string) {
  const points=[Date.parse(start),...bookings.map(b=>Date.parse(b.start)).filter(t=>t>Date.parse(start)&&t<Date.parse(end))];
  return Math.max(0,...points.map(t=>bookings.filter(b=>Date.parse(b.start)<=t&&Date.parse(b.end)>t).reduce((n,b)=>n+b.participants.length,0)));
}
function validateSlot(input:BookingUpdate,settings:Settings, allowPast=false) {
  const table=settings.tables.find(t=>t.id===input.tableId);
  if(!table || input.participants.length>table.seats) throw new ApiError('Il tavolo non dispone dei posti richiesti.');
  const start=new Date(input.start).toISOString(),end=new Date(input.end).toISOString();
  if((!allowPast && Date.parse(start)<=Date.now()) || !slotsForDate(romeDate(start),settings).some(s=>s.start===start&&s.end===end)) throw new ApiError('La fascia oraria non e disponibile.');
}
async function validateAvailability(client:PoolClient,input:BookingUpdate,settings:Settings,exclude='') {
  validateSlot(input,settings);
  const overlapping=await active(client,input.start,input.end,exclude);
  if(overlapping.some(b=>b.tableId===input.tableId)) throw new ApiError('Il tavolo e gia occupato in questa fascia.',409);
  if(occupiedAtPeak(overlapping,input.start,input.end)+input.participants.length>settings.roomCapacity) throw new ApiError('La capienza della sala e esaurita.',409);
}
async function notify(client:PoolClient,booking:Booking,token?:string) {
  const base=process.env.APP_URL;
  if(!base || !/^https?:\/\//.test(base)) throw new ApiError('Servizio email non configurato.',503);
  const u=new URL(base); if(u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw new ApiError('Servizio email non configurato.',503);
  if(process.env.NODE_ENV==='production' && u.protocol!=='https:') throw new ApiError('Servizio email non configurato.',503);
  const local=(s:string)=>new Date(s).toLocaleString('it-IT',{timeZone:'Europe/Rome',dateStyle:'full',timeStyle:'short'});
  const text=`Prenotazione: ${booking.status}\n${local(booking.start)} - ${local(booking.end)}\nTavolo: ${booking.tableId}\nPartecipanti: ${booking.participants.join(', ')}${token?`\nGestisci la prenotazione: ${u.origin}/manage#${token}`:''}`;
  await client.query('INSERT INTO outbox(booking_id,payload) VALUES($1,$2)',[booking.id,seal(JSON.stringify({to:booking.email,subject:'Aggiornamento prenotazione ludoteca',text}))]);
}
export async function createBooking(value:unknown):Promise<{ok:true}> {
  const input:BookingInput=parse(bookingSchema,value);
  if(input.website) throw new ApiError('Richiesta non valida.');
  return transaction(async client=>{
    const settings=await getSettings(client); await validateAvailability(client,input,settings);
    const token=newToken();
    const result=await client.query(`INSERT INTO bookings(email,participants,table_id,start_at,end_at,token_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${fields}`,[input.email,JSON.stringify(input.participants),input.tableId,input.start,input.end,tokenHash(token)]);
    await notify(client,normalize(result.rows[0]),token); return {ok:true};
  });
}
export async function manageBooking(token:string,action:'read'|'update'|'cancel',value?:unknown):Promise<{booking:Booking}> {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError('Link non valido.',404);
  return transaction(async client=>{
    const result=await client.query(`SELECT ${fields} FROM bookings WHERE token_hash=$1 FOR UPDATE`,[tokenHash(token)]);
    if(!result.rowCount) throw new ApiError('Link non valido.',404);
    const current=normalize(result.rows[0]);
    if(action==='read') return {booking:current};
    if(!['pending','confirmed'].includes(current.status)) throw new ApiError('Questa prenotazione non e piu modificabile.',409);
    let booking:Booking;
    if(action==='cancel') booking=normalize((await client.query(`UPDATE bookings SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING ${fields}`,[current.id])).rows[0]);
    else {
      const input=parse(updateBookingSchema,value);
      await validateAvailability(client,input,await getSettings(client),current.id);
      booking=normalize((await client.query(`UPDATE bookings SET participants=$2,table_id=$3,start_at=$4,end_at=$5,status='pending',updated_at=now() WHERE id=$1 RETURNING ${fields}`,[current.id,JSON.stringify(input.participants),input.tableId,input.start,input.end])).rows[0]);
    }
    await notify(client,booking,token);return {booking};
  });
}
export async function changeStatus(id:string,status:string) {
  return transaction(async client=>{
    const row=(await client.query(`SELECT ${fields} FROM bookings WHERE id::text=$1 FOR UPDATE`,[id])).rows[0];
    if(!row) throw new ApiError('Prenotazione non trovata.',404);
    const current=normalize(row);
    const allowed:Record<string,string[]>={pending:['confirmed','rejected','cancelled'],confirmed:['rejected','cancelled'],rejected:[],cancelled:[]};
    if(!allowed[current.status].includes(status)) throw new ApiError('Transizione di stato non consentita.',409);
    const booking=normalize((await client.query(`UPDATE bookings SET status=$2,updated_at=now() WHERE id=$1 RETURNING ${fields}`,[id,status])).rows[0]);
    await notify(client,booking); return {booking};
  });
}
export async function listBookings() { return (await pool().query(`SELECT ${fields} FROM bookings ORDER BY start_at DESC`)).rows.map(normalize); }
export async function saveSettings(value:unknown) {
  const settings=parse(settingsSchema,value);
  return transaction(async client=>{
    const rows:Booking[]=(await client.query(`SELECT ${fields} FROM bookings WHERE status IN ('pending','confirmed') AND end_at>now()`)).rows.map(normalize);
    for(const b of rows) {
      validateSlot(b,settings,true);
      if(occupiedAtPeak(rows,b.start,b.end)>settings.roomCapacity) throw new ApiError('La configurazione non preserva le prenotazioni attive.',409);
    }
    await client.query('UPDATE settings SET data=$1 WHERE id=true',[JSON.stringify(settings)]);return settings;
  });
}
export async function getAvailability(date:string):Promise<Availability> {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) throw new ApiError('Data non valida.');
  return transaction(async client=>{
    const settings=await getSettings(client), slots=slotsForDate(date,settings);
    const bookings=slots.length?await active(client,slots[0].start,slots.at(-1)!.end):[];
    return {slots:slots.map(slot=>{
      const overlapping=bookings.filter(b=>b.start<slot.end&&b.end>slot.start);
      const remainingCapacity=Math.max(0,settings.roomCapacity-occupiedAtPeak(overlapping,slot.start,slot.end));
      return {...slot,tables:settings.tables.map(t=>{
        const occupied=overlapping.some(b=>b.tableId===t.id);
        return {...t,occupied,available:Date.parse(slot.start)>Date.now() && remainingCapacity>0 && !occupied};
      }),remainingCapacity};
    })};
  });
}
export async function listGames(admin=false) { return (await pool().query(`SELECT id,data FROM games ${admin?'':"WHERE COALESCE((data->>'archived')::boolean,false)=false"} ORDER BY data->>'title'`)).rows.map(r=>({id:r.id,...r.data})); }
export async function saveGame(value:unknown,id?:string) {
  const game=parse(gameSchema,value);
  const row=id?(await pool().query('UPDATE games SET data=$2 WHERE id::text=$1 RETURNING id,data',[id,JSON.stringify(game)])).rows[0]:(await pool().query('INSERT INTO games(data) VALUES($1) RETURNING id,data',[JSON.stringify(game)])).rows[0];
  if(!row) throw new ApiError('Gioco non trovato.',404);return {id:row.id,...row.data};
}
export async function archiveGame(id:string) {
  const result=await pool().query("UPDATE games SET data=jsonb_set(data,'{archived}','true') WHERE id::text=$1",[id]);
  if(!result.rowCount) throw new ApiError('Gioco non trovato.',404);return {ok:true};
}
