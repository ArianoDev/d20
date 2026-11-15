import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, parse, validImage } from './domain';
import { pool } from './db';
import { archiveGame, changeStatus, createBooking, getAvailability, getSettings, listBookings, listGames, manageBooking, saveGame, saveSettings } from './service';
import { authenticatedWorker, checkOrigin, cookie, cookieToken, isAdmin, jsonBody, rateLimit, readBody, requireAdmin, supabase } from './security';
import { deliverOutbox } from './email';

const headers={'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Cookie'};
function json(value:unknown,status=200,extra:Record<string,string>={}) {return Response.json(value,{status,headers:{...headers,...extra}});}
async function upload(request:Request) {
  const bytes=await readBody(request,5*1024*1024+65536);
  let form:FormData;
  try {form=await new Response(bytes,{headers:{'content-type':request.headers.get('content-type')??''}}).formData();} catch {throw new ApiError('Caricamento non valido.');}
  const file=form.get('file');
  if(!(file instanceof File)) throw new ApiError('Seleziona un file immagine.');
  if(file.size>5*1024*1024) throw new ApiError("L'immagine supera il limite di 5 MB.",413);
  const buffer=Buffer.from(await file.arrayBuffer());
  if(!validImage(buffer,file.type)) throw new ApiError('Formato immagine non valido. Usa PNG, JPEG o WebP.');
  const ext:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
  const storage=supabase(true).storage.from(process.env.SUPABASE_STORAGE_BUCKET??'game-images');
  const filename=`games/${randomUUID()}.${ext[file.type]}`;
  const {error}=await storage.upload(filename,buffer,{contentType:file.type,upsert:false,cacheControl:'31536000'});
  if(error) throw new ApiError('Caricamento immagine non riuscito.',502);
  const url=storage.getPublicUrl(filename).data.publicUrl;
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password) throw new ApiError('Archivio immagini non configurato.',503);
  return {url};
}
export async function handle(request:Request):Promise<Response> {
  try {
    const url=new URL(request.url),path=url.pathname.replace(/^\/api\/?/,'').replace(/\/$/,''),method=request.method;
    if(!['GET','HEAD','OPTIONS'].includes(method)) checkOrigin(request);
    if(path.startsWith('admin/')) await requireAdmin(request);
    if(path==='health'&&method==='GET') {
      await pool().query('SELECT 1');return json({ok:true});
    }
    if(path==='games'&&method==='GET') return json({games:await listGames()});
    if(path==='settings'&&method==='GET') return json(await getSettings());
    if(path==='availability'&&method==='GET') return json(await getAvailability(url.searchParams.get('date')??''));
    if(path==='bookings'&&method==='POST') {
      await rateLimit(request,'bookings',10);
      const result=await createBooking(await jsonBody(request));
      return json(result,201);
    }
    if(path==='manage'&&method==='POST') {
      await rateLimit(request,'manage',60);
      const input=parse(z.object({token:z.string().min(1).max(256),action:z.enum(['read','update','cancel']),booking:z.unknown().optional()}).strict(),await jsonBody(request));
      return json(await manageBooking(input.token,input.action,input.booking));
    }
    if(path==='auth/login'&&method==='POST') {
      await rateLimit(request,'login',10);
      const {email,password}=parse(z.object({email:z.email().max(254),password:z.string().min(1).max(1024)}).strict(),await jsonBody(request));
      const auth=supabase();
      const {data,error}=await auth.auth.signInWithPassword({email,password});
      if(error||!data.session||!data.user) throw new ApiError('Credenziali non valide.',401);
      if(!isAdmin(data.user.id)) {await auth.auth.signOut();throw new ApiError('Accesso non autorizzato.',403);}
      return json({ok:true},200,{'Set-Cookie':cookie(data.session.access_token,data.session.expires_in)});
    }
    if(path==='auth/logout'&&method==='POST') {
      await rateLimit(request,'logout',60);
      const token=cookieToken(request);
      if(token) {try {await supabase().auth.admin.signOut(token,'local');} catch { /* Cookie is cleared even if the auth provider is unavailable. */ }}
      return json({ok:true},200,{'Set-Cookie':cookie('',0)});
    }
    if(path==='admin/session'&&method==='GET') return json({ok:true});
    if(path==='admin/settings') {
      if(method==='GET') return json(await getSettings());
      if(method==='PUT') {await rateLimit(request,'admin',120);return json(await saveSettings(await jsonBody(request)));}
    }
    if(path==='admin/bookings') {
      if(method==='GET') return json({bookings:await listBookings()});
      if(method==='PATCH') {
        await rateLimit(request,'admin',120);
        const input=parse(z.object({id:z.uuid(),status:z.enum(['confirmed','rejected','cancelled'])}).strict(),await jsonBody(request));
        return json(await changeStatus(input.id,input.status));
      }
    }
    if(path==='admin/games'||path.startsWith('admin/games/')) {
      if(method==='GET'&&path==='admin/games') return json({games:await listGames(true)});
      await rateLimit(request,'admin',120);
      const pathId=path.split('/')[2];
      if(method==='POST'&&!pathId) return json({game:await saveGame(await jsonBody(request))},201);
      if(['PUT','PATCH','DELETE'].includes(method)) {
        const body=pathId && method==='DELETE'?{}:await jsonBody(request);
        const id=parse(z.uuid(),pathId??body.id);
        if(method==='DELETE') return json(await archiveGame(id));
        const {id:ignored,...game}=body;void ignored;
        return json({game:await saveGame(game,id)});
      }
    }
    if(path==='admin/uploads'&&method==='POST') {await rateLimit(request,'uploads',20);return json(await upload(request),201);}
    if((path==='admin/outbox'||path==='internal/outbox')&&method==='POST') {
      if(path==='internal/outbox'&&!authenticatedWorker(request)) throw new ApiError('Accesso non autorizzato.',401);
      await rateLimit(request,'outbox',60,60);return json(await deliverOutbox());
    }
    throw new ApiError('Risorsa non trovata.',404);
  } catch(error) {
    if(error instanceof ApiError) return json({error:error.message},error.status,error.status===429?{'Retry-After':'900'}:{});
    // Deliberately do not log provider responses, request bodies, tokens or PostgreSQL error detail.
    return json({error:'Servizio temporaneamente non disponibile. Riprova piu tardi.'},503);
  }
}
