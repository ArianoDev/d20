import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { migrate, pool } from '../src/lib/db';
import { createBooking, manageBooking, changeStatus, getAvailability, saveSettings, listBookings } from '../src/lib/service';
import { deliverOutbox } from '../src/lib/email';
import { handle } from '../src/lib/api';
import { getSettings, listGames, saveGame, archiveGame } from '../src/lib/service';
import { rateLimit } from '../src/lib/security';
import { seal, unseal } from '../src/lib/domain';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!enabled)('real PostgreSQL atomic backend', () => {
  const defaults={roomCapacity:12,tables:[{id:'table-2',name:'Tavolo 2',seats:2},{id:'table-4',name:'Tavolo 4',seats:4},{id:'table-6',name:'Tavolo 6',seats:6}],openingDays:[0,2,3,4,5,6],openTime:'18:00',closeTime:'24:00',slotMinutes:120};
  const createdRoles:string[]=[];
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.EMAIL_ENCRYPTION_KEY = Buffer.alloc(32,5).toString('base64');
    process.env.APP_URL = 'https://ludoteca.example';
    const local=['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.TEST_DATABASE_URL!).hostname);
    const superuser=(await pool().query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper;
    if(local&&superuser) {
      for(const role of ['anon','authenticated']) {
        if(!(await pool().query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount) {
          await pool().query(`CREATE ROLE ${role} NOLOGIN`);createdRoles.push(role);
        }
      }
    }
    await migrate();
  });
  beforeEach(async()=>{
    await pool().query('TRUNCATE bookings, outbox, rate_limits, games');
    await pool().query('UPDATE settings SET data=$1',[JSON.stringify(defaults)]);
  });
  afterAll(async () => {
    if(enabled) {
      await pool().query('TRUNCATE bookings,outbox,rate_limits,games');
      await pool().query('UPDATE settings SET data=$1',[JSON.stringify(defaults)]);
      for(const role of createdRoles) await pool().query(`DROP ROLE ${role}`);
      await pool().end();
    }
  });
  const input = (tableId='table-6',participants=['Ada']) => ({email:'ada@example.com',participants,tableId,start:'2027-01-05T17:00:00.000Z',end:'2027-01-05T19:00:00.000Z'});
  const update = (participants=['Ada']) => { const {email,...booking}=input('table-6',participants);void email;return booking; };
  async function bookingToken(tableId:string) {
    const row=(await pool().query(`SELECT o.payload FROM outbox o JOIN bookings b ON b.id=o.booking_id WHERE b.table_id=$1 ORDER BY o.sequence_no LIMIT 1`,[tableId])).rows[0];
    return JSON.parse(unseal(row.payload)).text.match(/\/manage#([A-Za-z0-9_-]+)/)[1] as string;
  }
  async function queuedRace(first:()=>Promise<unknown>,second:()=>Promise<unknown>) {
    const blocker=await pool().connect(),running:Promise<unknown>[]=[];
    try {
      await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(20261114)');
      for(const operation of [first,second]) {
        running.push(operation());
        const deadline=Date.now()+5000;
        for(;;) {
          const waiters=(await pool().query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=20261114 AND NOT granted")).rows[0].count;
          if(waiters>=running.length) break;
          if(Date.now()>deadline) throw new Error('Le operazioni concorrenti non hanno raggiunto il lock.');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
      }
    } finally {
      await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled(running);
    }
    return Promise.allSettled(running);
  }
  it('serializes competing bookings, preserves privacy and encrypts outbox', async () => {
    const results = await Promise.allSettled([createBooking(input()),createBooking(input())]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(results.find(r=>r.status==='fulfilled')).toMatchObject({value:{ok:true}});
    const available = await getAvailability('2027-01-05');
    expect(JSON.stringify(available)).not.toContain('ada@example.com');
    expect(available.slots[0].remainingCapacity).toBe(11);
    expect(available.slots[0].tables.find(t=>t.id==='table-6')?.available).toBe(false);
    const rows = await pool().query('SELECT token_hash FROM bookings');
    expect(rows.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('delivers encrypted links, retries safely, transitions and rejects token tampering', async () => {
    await createBooking(input());
    let text=''; let attempts=0;
    const send = async (message: {text:string}) => { attempts++; text=message.text; if(attempts===1) throw new Error('provider unavailable'); };
    expect(await deliverOutbox(send)).toMatchObject({failed:1});
    await pool().query("UPDATE outbox SET next_attempt_at=now()");
    expect(await deliverOutbox(send)).toMatchObject({sent:1});
    const token = text.match(/\/manage#([A-Za-z0-9_-]+)/)![1];
    await expect(manageBooking(token+'x','read')).rejects.toThrow();
    await expect(manageBooking((token[0]==='a'?'b':'a')+token.slice(1),'read')).rejects.toThrow();
    const initial = await manageBooking(token,'read');
    await changeStatus(initial.booking.id,'confirmed');
    await manageBooking(token,'update',update(['Ada','Lin']));
    expect((await manageBooking(token,'read')).booking.status).toBe('pending');
    await expect(manageBooking(token,'update',update(Array(7).fill('A')))).rejects.toThrow();
    expect((await manageBooking(token,'read')).booking.participants).toHaveLength(2);
    await manageBooking(token,'cancel');
    expect((await manageBooking(token,'read')).booking.status).toBe('cancelled');
    await expect(manageBooking(token,'update',input())).rejects.toThrow();
    await expect(changeStatus(initial.booking.id,'confirmed')).rejects.toThrow();
  });
  it('enforces room capacity across different tables concurrently', async () => {
    await pool().query('TRUNCATE bookings, outbox');
    const {getSettings} = await import('../src/lib/service');
    const settings = await getSettings();
    await saveSettings({...settings,roomCapacity:6});
    const result = await Promise.allSettled([createBooking(input('table-6',Array(4).fill('A'))),createBooking(input('table-4',Array(4).fill('B')))]);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    await expect(saveSettings({...settings,roomCapacity:1})).rejects.toThrow();
    await expect(saveSettings({...settings,openingDays:[1]})).rejects.toThrow();
    expect(await listBookings()).toHaveLength(1);
    await pool().query('TRUNCATE bookings, outbox');
    await saveSettings(settings);
  });
  it('validates exact slots, participants, closed days and honeypot before persistence',async()=>{
    for(const bad of [
      {...input(),email:''}, {...input(),participants:[' ']}, {...input(),participants:Array(7).fill('A')},
      {...input(),tableId:'table-2',participants:['A','B','C']}, {...input(),website:'spam'},
      {...input(),start:'2027-01-05T17:01:00Z'}, {...input(),end:'2027-01-05T20:00:00Z'},
      {...input(),start:'2027-01-04T17:00:00Z',end:'2027-01-04T19:00:00Z'},
    ]) await expect(createBooking(bad)).rejects.toThrow();
    expect(await listBookings()).toHaveLength(0);
  });
  it('preserves pending status, rolls back conflicts, permits adjacent slots and rejects terminal changes',async()=>{
    await createBooking(input());
    const encrypted=(await pool().query('SELECT payload FROM outbox ORDER BY created_at DESC LIMIT 1')).rows[0].payload;
    const token=JSON.parse(unseal(encrypted)).text.match(/\/manage#([A-Za-z0-9_-]+)/)[1];
    await createBooking(input('table-4'));
    await expect(manageBooking(token,'update',{...update(),tableId:'table-4'})).rejects.toThrow();
    expect((await manageBooking(token,'read')).booking.tableId).toBe('table-6');
    await manageBooking(token,'update',update(['A','B']));
    const current=(await manageBooking(token,'read')).booking;
    expect(current.status).toBe('pending');
    await createBooking({...input(),start:input().end,end:'2027-01-05T21:00:00Z'});
    await changeStatus(current.id,'rejected');
    expect((await manageBooking(token,'read')).booking.status).toBe('rejected');
    await expect(manageBooking(token,'cancel')).rejects.toThrow();
    await expect(changeStatus(current.id,'confirmed')).rejects.toThrow();
    await pool().query('TRUNCATE bookings,outbox');
  });
  it('archives catalog entries instead of deleting and never exposes them publicly',async()=>{
    const game=await saveGame({title:'Azul',minPlayers:2,maxPlayers:4,duration:45,complexity:2,description:'Mosaici',images:['https://example.com/a.png'],bggUrl:'https://boardgamegeek.com/boardgame/230802/azul'});
    expect((await listGames()).some(g=>g.id===game.id)).toBe(true);
    const {id,...data}=game;
    expect((await saveGame({...data,title:'Azul nuovo'},id)).title).toBe('Azul nuovo');
    await archiveGame(id);
    expect((await listGames()).some(g=>g.id===id)).toBe(false);
    expect((await listGames(true)).find(g=>g.id===id)?.archived).toBe(true);
    await pool().query('DELETE FROM games WHERE id=$1',[id]);
  });
  it('persists rate limits atomically across parallel requests',async()=>{
    const req=new Request('https://ludoteca.example');
    const scope=`test-${Date.now()}`;
    const results=await Promise.allSettled(Array.from({length:12},()=>rateLimit(req,scope,5)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(7);
    const key=(await pool().query('SELECT key FROM rate_limits LIMIT 1')).rows[0].key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
  it('grants the runtime role only data access and enables RLS on every data table',async()=>{
    const client=await pool().connect();
    try {
      await client.query('BEGIN');await client.query('SET LOCAL ROLE ludoteca_app');
      expect((await client.query('SELECT data FROM settings')).rowCount).toBe(1);
      await expect(client.query('SELECT * FROM schema_migrations')).rejects.toThrow();
      await client.query('ROLLBACK');
      const rows=await client.query("SELECT relrowsecurity FROM pg_class WHERE oid IN ('settings'::regclass,'games'::regclass,'bookings'::regclass,'outbox'::regclass,'rate_limits'::regclass)");
      expect(rows.rows.every(r=>r.relrowsecurity)).toBe(true);
      const grants=await client.query("SELECT grantee FROM information_schema.role_table_grants WHERE table_name IN ('settings','games','bookings','outbox','rate_limits') AND grantee IN ('anon','authenticated','PUBLIC')");
      expect(grants.rowCount).toBe(0);
    } finally {await client.query('ROLLBACK');client.release();}
  });
  it('handles public and authenticated admin API contracts with no public personal data',async()=>{
    const req=(path:string,method='GET',body?:unknown,auth=false)=>new Request(`https://ludoteca.example/api/${path}`,{method,headers:{origin:'https://ludoteca.example','content-type':'application/json',...(auth?{cookie:'ludoteca_admin=test-access-token'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const create=await handle(req('bookings','POST',input()));
    expect(create.status).toBe(201);expect(await create.json()).toEqual({ok:true});
    const available=await handle(req('availability?date=2027-01-05'));
    const raw=await available.text();expect(raw).not.toContain('ada@example.com');expect(raw).not.toContain('participants');
    process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='anon';process.env.ADMIN_USER_IDS='00000000-0000-4000-8000-000000000001';
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:process.env.ADMIN_USER_IDS,email:'admin@example.com'}));
    try {
      const response=await handle(req('admin/bookings','GET',undefined,true));
      expect(response.status).toBe(200);
      expect((await response.json()).bookings[0].email).toBe('ada@example.com');
      expect(response.headers.get('cache-control')).toContain('private, no-store');
      mock.mockResolvedValue(Response.json({id:'different-user'}));
      expect((await handle(req('admin/bookings','GET',undefined,true))).status).toBe(403);
    } finally {mock.mockRestore();}
    await pool().query('TRUNCATE bookings,outbox,rate_limits');
  });
  it('uses the real Resend adapter with stable idempotency and scrubs delivered secrets',async()=>{
    await createBooking(input());
    process.env.RESEND_API_KEY='re_test';process.env.EMAIL_FROM='Ludoteca <test@example.com>';
    let sentBody='';let key='';
    const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{
      sentBody=String(options?.body);key=new Headers(options?.headers).get('idempotency-key')??'';
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({id:'provider-id'});
    });
    try {
      expect(await deliverOutbox()).toEqual({sent:1,failed:0});
      expect(sentBody).toContain('/manage#');expect(sentBody).toContain('ada@example.com');expect(key).toMatch(/^[a-f0-9-]{36}$/);
      const row=(await pool().query('SELECT payload,sent_at FROM outbox')).rows[0];
      expect(row.payload).toBeNull();expect(row.sent_at).not.toBeNull();
    } finally {mock.mockRestore();}
    await pool().query('TRUNCATE bookings,outbox');
  });
  it('sets an HttpOnly session on login without returning tokens and revokes non-admin login',async()=>{
    process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='anon';
    const id='00000000-0000-4000-8000-000000000001';process.env.ADMIN_USER_IDS=id;
    const response={access_token:'secure-access-token',refresh_token:'refresh-token',expires_in:3600,token_type:'bearer',user:{id,email:'admin@example.com'}};
    const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json(response));
    const login=()=>handle(new Request('https://ludoteca.example/api/auth/login',{method:'POST',headers:{origin:'https://ludoteca.example','content-type':'application/json'},body:JSON.stringify({email:'admin@example.com',password:'private-password'})}));
    try {
      const result=await login();expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ok:true});
      expect(result.headers.get('set-cookie')).toContain('HttpOnly');expect(result.headers.get('set-cookie')).toContain('SameSite=Strict');expect(result.headers.get('set-cookie')).toContain('Secure');
      process.env.ADMIN_USER_IDS='someone-else';
      const rejected=await login();expect(rejected.status).toBe(403);expect(rejected.headers.get('set-cookie')).toBeNull();
    } finally {mock.mockRestore();process.env.ADMIN_USER_IDS=id;}
  });
  it('validates admin image uploads and stores only recognized images in Supabase Storage',async()=>{
    process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='anon';process.env.ADMIN_USER_IDS='00000000-0000-4000-8000-000000000001';
    process.env.SUPABASE_SERVICE_ROLE_KEY='service-test';
    const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async (input)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.includes('/auth/v1/user')) return Response.json({id:process.env.ADMIN_USER_IDS});
      if(url.includes('/storage/v1/object/')) return Response.json({Key:'game-images/games/test.png',Id:'object-id'});
      throw new Error('Unexpected provider URL');
    });
    const upload=async(bytes:Uint8Array,type:string)=>{
      const form=new FormData();form.append('file',new File([bytes as BlobPart],'untrusted-name.png',{type}));
      return handle(new Request('https://ludoteca.example/api/admin/uploads',{method:'POST',headers:{origin:'https://ludoteca.example',cookie:'ludoteca_admin=test-access-token'},body:form}));
    };
    try {
      expect((await upload(new TextEncoder().encode('not png'),'image/png')).status).toBe(400);
      expect((await upload(new Uint8Array(5*1024*1024+1),'image/png')).status).toBe(413);
      const result=await upload(new Uint8Array([137,80,78,71,13,10,26,10]),'image/png');
      expect(result.status).toBe(201);expect((await result.json()).url).toMatch(/^https:\/\/example.supabase.co\/storage\/v1\/object\/public\/game-images\/games\/[a-f0-9-]+\.png$/);
    } finally {mock.mockRestore();}
  });
  it('requires authenticated retries as well as trusted origin',async()=>{
    const request=(headers:Record<string,string>)=>new Request('https://ludoteca.example/api/internal/outbox',{method:'POST',headers});
    expect((await handle(request({origin:'https://ludoteca.example'}))).status).toBe(401);
    process.env.OUTBOX_SECRET='s'.repeat(40);
    expect((await handle(request({origin:'https://evil.example',authorization:`Bearer ${process.env.OUTBOX_SECRET}`}))).status).toBe(403);
    expect((await handle(request({origin:'https://ludoteca.example',authorization:`Bearer ${process.env.OUTBOX_SECRET}`}))).status).toBe(200);
  });
  it('preserves active tables, seats and exact opening slots when settings change',async()=>{
    await createBooking(input('table-6',['A','B','C','D']));
    await expect(saveSettings({...defaults,tables:defaults.tables.filter(t=>t.id!=='table-6')})).rejects.toThrow();
    await expect(saveSettings({...defaults,tables:defaults.tables.map(t=>({...t,seats:2}))})).rejects.toThrow();
    await expect(saveSettings({...defaults,openTime:'19:00'})).rejects.toThrow();
    await expect(saveSettings({...defaults,slotMinutes:60})).rejects.toThrow();
    expect(await saveSettings({...defaults,tables:defaults.tables.map(t=>({...t,name:'Nuovo nome'}))})).toMatchObject({roomCapacity:12});
  });
  it('serializes settings changes against booking creation',async()=>{
    const results=await Promise.allSettled([saveSettings({...defaults,roomCapacity:1}),createBooking(input('table-6',['A','B','C','D']))]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const bookings=await listBookings(),settings=await getSettings();
    expect(bookings.reduce((n,b)=>n+b.participants.length,0)).toBeLessThanOrEqual(settings.roomCapacity);
  });
  it('rolls back a booking when secure email persistence is not configured',async()=>{
    const key=process.env.EMAIL_ENCRYPTION_KEY;delete process.env.EMAIL_ENCRYPTION_KEY;
    try {
      await expect(createBooking(input())).rejects.toMatchObject({status:503});
      expect(await listBookings()).toHaveLength(0);
      expect((await pool().query('SELECT * FROM outbox')).rowCount).toBe(0);
    } finally {process.env.EMAIL_ENCRYPTION_KEY=key;}
  });
  it('handles idle database connection errors without crashing or logging sensitive detail',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      expect(()=>pool().emit('error',new Error('sensitive@example.com'))).not.toThrow();
      expect(log).toHaveBeenCalledWith('Connessione database interrotta.');
      expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive@example.com');
    } finally {log.mockRestore();}
  });
  it('keeps later status emails behind a backed-off initial email and preserves its management link',async()=>{
    await createBooking(input());
    const booking=(await listBookings())[0];
    const delivered:string[]=[];
    expect(await deliverOutbox(async()=>{throw new Error('Provider unavailable');})).toEqual({sent:0,failed:1});
    await changeStatus(booking.id,'confirmed');
    await changeStatus(booking.id,'cancelled');
    await pool().query("UPDATE outbox SET created_at='2000-01-01'::timestamptz-(sequence_no*interval '1 minute')");
    expect(await deliverOutbox(async message=>{delivered.push(message.text);})).toEqual({sent:0,failed:0});
    expect(delivered).toEqual([]);
    await pool().query('UPDATE outbox SET next_attempt_at=now() WHERE sent_at IS NULL');
    expect(await deliverOutbox(async message=>{delivered.push(message.text);})).toEqual({sent:3,failed:0});
    expect(delivered.map(text=>text.split('\n')[0])).toEqual(['Prenotazione: pending','Prenotazione: confirmed','Prenotazione: cancelled']);
    const token=delivered[0].match(/\/manage#([A-Za-z0-9_-]+)/)![1];
    expect((await manageBooking(token,'read')).booking.status).toBe('cancelled');
    const rows=await pool().query('SELECT booking_id,payload,sent_at FROM outbox');
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every(row=>row.booking_id===booking.id && row.payload===null && row.sent_at)).toBe(true);
  });
  it('does not let a second worker skip a locked earlier message for the same booking',async()=>{
    await createBooking(input('table-6'));
    const first=(await listBookings())[0];
    await changeStatus(first.id,'confirmed');
    await createBooking({...input('table-4'),email:'other@example.com'});
    let release!:()=>void,started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const messages:{to:string;text:string}[]=[];
    let calls=0;
    const firstWorker=deliverOutbox(async message=>{
      messages.push(message);
      if(calls++===0) {started();await gate;}
    });
    try {
      await entered;
      const secondMessages:{to:string;text:string}[]=[];
      expect(await deliverOutbox(async message=>{secondMessages.push(message);})).toEqual({sent:1,failed:0});
      expect(secondMessages.map(message=>message.to)).toEqual(['other@example.com']);
      expect(messages.map(message=>message.text.split('\n')[0])).toEqual(['Prenotazione: pending']);
    } finally {release();await firstWorker;}
    expect(messages.map(message=>message.text.split('\n')[0])).toEqual(['Prenotazione: pending','Prenotazione: confirmed']);
  });
  it('lists pending bookings even when more than 1000 newer historical bookings exist',async()=>{
    await createBooking(input());
    const pending=(await listBookings())[0];
    await pool().query(`INSERT INTO bookings(email,participants,table_id,start_at,end_at,status,token_hash)
      SELECT 'history@example.com','["Archived"]','table-6',$1::timestamptz+(n*interval '1 day'),$2::timestamptz+(n*interval '1 day'),'rejected',md5(n::text)||md5(n::text) FROM generate_series(1,1001) n`,[input().start,input().end]);
    const bookings=await listBookings();
    expect(bookings).toHaveLength(1002);
    expect(bookings.find(booking=>booking.id===pending.id)?.status).toBe('pending');
  });
  it('exposes table occupancy independently of a full room without exposing booking data',async()=>{
    await saveSettings({...defaults,roomCapacity:2});
    await createBooking(input('table-2',['Ada','Lin']));
    const response=await handle(new Request('https://ludoteca.example/api/availability?date=2027-01-05'));
    expect(response.status).toBe(200);
    const availability=await response.json(),slot=availability.slots[0];
    expect(slot.remainingCapacity).toBe(0);
    expect(slot.tables.find((t:{id:string})=>t.id==='table-2')).toMatchObject({available:false,occupied:true});
    expect(slot.tables.find((t:{id:string})=>t.id==='table-6')).toMatchObject({available:false,occupied:false});
    expect(availability.slots[1].tables.every((t:{occupied:boolean;available:boolean})=>!t.occupied&&t.available)).toBe(true);
    const text=JSON.stringify(availability);
    for(const forbidden of ['email','participants','token','bookingId','Ada','Lin']) expect(text).not.toContain(forbidden);
  });
  it('serializes two updates competing for the same table while preserving the losing booking',async()=>{
    await createBooking(input('table-2'));
    await createBooking(input('table-4'));
    const a=await bookingToken('table-2'),b=await bookingToken('table-4');
    const results=await queuedRace(()=>manageBooking(a,'update',update(['First'])),()=>manageBooking(b,'update',update(['Second'])));
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    const bookings=await listBookings();
    expect(bookings.filter(booking=>booking.tableId==='table-6')).toHaveLength(1);
    const loser=bookings.find(booking=>booking.tableId!=='table-6')!;
    expect(loser.participants).toEqual(['Ada']);expect(loser.status).toBe('pending');
    expect((await pool().query('SELECT count(*)::int AS count FROM outbox')).rows[0].count).toBe(3);
  });
  it('serializes updates to different tables when both participant increases would exceed room capacity',async()=>{
    await saveSettings({...defaults,roomCapacity:6});
    await createBooking(input('table-6'));await createBooking(input('table-4'));
    const a=await bookingToken('table-6'),b=await bookingToken('table-4');
    const results=await queuedRace(()=>manageBooking(a,'update',update(['A','B','C','D'])),()=>manageBooking(b,'update',{...update(['E','F','G','H']),tableId:'table-4'}));
    expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
    const bookings=await listBookings();
    expect(bookings.reduce((sum,booking)=>sum+booking.participants.length,0)).toBe(5);
    expect((await manageBooking(b,'read')).booking.participants).toEqual(['Ada']);
  });
  it.each([false,true])('serializes update against create on the same table (create first: %s)',async createFirst=>{
    await createBooking(input('table-2'));
    const token=await bookingToken('table-2');
    const edit=()=>manageBooking(token,'update',update(['Changed'])),create=()=>createBooking(input('table-6'));
    const results=await queuedRace(createFirst?create:edit,createFirst?edit:create);
    expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
    const bookings=await listBookings();
    expect(bookings.filter(booking=>booking.tableId==='table-6')).toHaveLength(1);
    const original=(await manageBooking(token,'read')).booking;
    expect(original.tableId).toBe(createFirst?'table-2':'table-6');
    expect(original.participants).toEqual(createFirst?['Ada']:['Changed']);
  });
  it.each([false,true])('serializes update against create when different tables would exceed room capacity (create first: %s)',async createFirst=>{
    await saveSettings({...defaults,roomCapacity:6});
    await createBooking(input('table-6'));
    const token=await bookingToken('table-6');
    const edit=()=>manageBooking(token,'update',update(['A','B','C','D'])),create=()=>createBooking(input('table-4',['E','F','G','H']));
    const results=await queuedRace(createFirst?create:edit,createFirst?edit:create);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    const bookings=await listBookings();
    expect(bookings.reduce((sum,booking)=>sum+booking.participants.length,0)).toBeLessThanOrEqual(6);
    expect((await manageBooking(token,'read')).booking.participants.length).toBe(createFirst?1:4);
  });
  it.each([
    {status:'rejected',adminFirst:false},{status:'rejected',adminFirst:true},
    {status:'cancelled',adminFirst:false},{status:'cancelled',adminFirst:true},
  ])('does not resurrect a booking when update races admin $status (admin first: $adminFirst)',async({status,adminFirst})=>{
    await createBooking(input());
    const token=await bookingToken('table-6'),booking=(await manageBooking(token,'read')).booking;
    const edit=()=>manageBooking(token,'update',update(['Changed'])),terminal=()=>changeStatus(booking.id,status);
    const results=await queuedRace(adminFirst?terminal:edit,adminFirst?edit:terminal);
    expect(results[adminFirst?0:1].status).toBe('fulfilled');
    expect(results[adminFirst?1:0].status).toBe(adminFirst?'rejected':'fulfilled');
    const current=(await manageBooking(token,'read')).booking;
    expect(current.status).toBe(status);
    expect(current.participants).toEqual(adminFirst?['Ada']:['Changed']);
    await expect(manageBooking(token,'update',update())).rejects.toMatchObject({status:409});
  });
  it('upgrades existing encrypted outbox rows without losing payloads and grants runtime sequence access',async()=>{
    const client=await pool().connect();
    const legacyPayload=seal(JSON.stringify({to:'legacy@example.com',text:'Gestisci: https://ludoteca.example/manage#legacy-link'}));
    try {
      await client.query('BEGIN');
      await client.query('CREATE SCHEMA backend_upgrade_fixture');
      await client.query('SET LOCAL search_path TO backend_upgrade_fixture');
      await client.query(await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8'));
      const booking=(await client.query(`INSERT INTO bookings(email,participants,table_id,start_at,end_at,token_hash) VALUES('legacy@example.com','["Legacy"]','table-2',$1,$2,repeat('a',64)) RETURNING id`,[input().start,input().end])).rows[0];
      await client.query("INSERT INTO outbox(payload,created_at) VALUES($1,now()),($1,now()-interval '1 minute')",[legacyPayload]);
      await client.query(await readFile(new URL('../migrations/002_outbox_ordering.sql',import.meta.url),'utf8'));
      const legacy=await client.query('SELECT booking_id,sequence_no,payload FROM outbox ORDER BY sequence_no');
      expect(legacy.rows.map(row=>row.sequence_no)).toEqual(['1','2']);
      expect(legacy.rows.every(row=>row.booking_id===null&&row.payload===legacyPayload)).toBe(true);
      await client.query('GRANT USAGE ON SCHEMA backend_upgrade_fixture TO ludoteca_app');
      await client.query('SET LOCAL ROLE ludoteca_app');
      const next=(await client.query('INSERT INTO outbox(booking_id,payload) VALUES($1,$2) RETURNING sequence_no',[booking.id,legacyPayload])).rows[0];
      expect(next.sequence_no).toBe('3');
      await expect(client.query('INSERT INTO outbox(booking_id,payload) VALUES(gen_random_uuid(),$1)',[legacyPayload])).rejects.toMatchObject({code:'23503'});
    } finally {await client.query('ROLLBACK');client.release();}
  });
  it('keeps unassociated legacy messages as barriers across retries and concurrent workers',async()=>{
    const legacyPayload=seal(JSON.stringify({to:'legacy@example.com',subject:'Legacy',text:'Original /manage#preserved'}));
    await pool().query("INSERT INTO outbox(payload,next_attempt_at) VALUES($1,now()+interval '1 hour')",[legacyPayload]);
    await createBooking(input());
    const delivered:string[]=[];
    const send=async(message:{text:string})=>{delivered.push(message.text);};
    expect(await Promise.all([deliverOutbox(send),deliverOutbox(send)])).toEqual([{sent:0,failed:0},{sent:0,failed:0}]);
    expect(delivered).toEqual([]);
    await pool().query('UPDATE outbox SET next_attempt_at=now() WHERE booking_id IS NULL');
    await Promise.all([deliverOutbox(send),deliverOutbox(send)]);
    expect(delivered).toHaveLength(2);expect(delivered[0]).toBe('Original /manage#preserved');
    expect(delivered[1]).toContain('Prenotazione: pending');
  });
  it('denies anon and authenticated SELECT, INSERT, UPDATE, DELETE and outbox sequence access',async({skip})=>{
    const roles=(await pool().query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows;
    if(roles.length!==2) {skip();return;}
    const client=await pool().connect();
    try {
      for(const role of ['anon','authenticated']) {
        for(const table of ['settings','games','bookings','outbox','rate_limits']) {
          const column=table==='rate_limits'?'key':'id';
          for(const sql of [`SELECT * FROM ${table}`,`INSERT INTO ${table} DEFAULT VALUES`,`UPDATE ${table} SET ${column}=${column}`,`DELETE FROM ${table}`]) {
            await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
            await expect(client.query(sql)).rejects.toMatchObject({code:'42501'});
            await client.query('ROLLBACK');
          }
        }
        await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
        await expect(client.query("SELECT nextval('outbox_sequence_no_seq')")).rejects.toMatchObject({code:'42501'});
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON settings TO ${role}`);
        await client.query(`SET LOCAL ROLE ${role}`);
        expect((await client.query('SELECT * FROM settings')).rowCount).toBe(0);
        expect((await client.query('UPDATE settings SET data=data')).rowCount).toBe(0);
        expect((await client.query('DELETE FROM settings')).rowCount).toBe(0);
        await expect(client.query("INSERT INTO settings(id,data) VALUES(false,'{}')")).rejects.toMatchObject({code:'42501'});
        await client.query('ROLLBACK');
      }
    } finally {await client.query('ROLLBACK');client.release();}
  });
  it('ignores spoofed forwarded IPs without trusted proxy configuration and isolates trusted client buckets',async()=>{
    const previous=process.env.TRUST_PROXY;
    const a=new Request('https://ludoteca.example',{headers:{'x-forwarded-for':'192.0.2.1'}});
    const b=new Request('https://ludoteca.example',{headers:{'x-forwarded-for':'192.0.2.2'}});
    try {
      delete process.env.TRUST_PROXY;
      await rateLimit(a,'untrusted-test',1);
      await expect(rateLimit(b,'untrusted-test',1)).rejects.toMatchObject({status:429});
      process.env.TRUST_PROXY='true';
      await rateLimit(a,'trusted-test',1);await rateLimit(b,'trusted-test',1);
      await expect(rateLimit(a,'trusted-test',1)).rejects.toMatchObject({status:429});
    } finally {if(previous===undefined) delete process.env.TRUST_PROXY;else process.env.TRUST_PROXY=previous;}
  });
});
