import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../src/lib/api';

describe('HTTP security boundaries',()=>{
  beforeEach(()=>{ process.env.APP_URL='https://ludoteca.example'; });
  const request=(path:string,method='GET',body?:unknown,origin?:string)=>new Request(`https://ludoteca.example/api/${path}`,{method,headers:{...(origin?{origin}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  it('requires trusted Origin on every write, including login',async()=>{
    for(const path of ['bookings','auth/login','auth/logout','manage','admin/settings']) {
      const response=await handle(request(path,'POST',{},'https://evil.example'));
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toHaveProperty('error');
    }
  });
  it('rejects unauthenticated admin calls before reading database',async()=>{
    for(const path of ['admin/games','admin/settings','admin/bookings','admin/uploads','admin/outbox']) {
      for(const method of ['GET','POST','PUT','PATCH','DELETE']) {
        const response=await handle(request(path,method,undefined,'https://ludoteca.example'));
        expect(response.status).toBe(401);
      }
    }
  });
  it('does not trust a cookie without Supabase getUser verification',async()=>{
    process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='test';process.env.ADMIN_USER_IDS='admin';
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({message:'bad token'}),{status:401}));
    const req=new Request('https://ludoteca.example/api/admin/games',{headers:{cookie:'ludoteca_admin=forged'}});
    expect((await handle(req)).status).toBe(401);
    expect(fetcher).toHaveBeenCalled();fetcher.mockRestore();
  });
  it('does not disclose internals for unknown routes',async()=>{
    const response=await handle(request('nonexistent'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({error:'Risorsa non trovata.'});
  });
});
