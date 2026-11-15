import { handle } from '@/lib/api';
import { deliverOutbox } from '@/lib/email';
import { after } from 'next/server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=handle;
async function mutate(request:Request) {
  const response=await handle(request);
  const path=new URL(request.url).pathname;
  if(response.ok && ['/api/bookings','/api/manage','/api/admin/bookings'].includes(path)) {
    after(async()=>{try {await deliverOutbox();} catch { /* The persistent outbox remains available to the authenticated retry worker. */ }});
  }
  return response;
}
export const POST=mutate;
export const PUT=handle;
export const PATCH=mutate;
export const DELETE=handle;
