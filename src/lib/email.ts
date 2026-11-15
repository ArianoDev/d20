import { Resend } from 'resend';
import { transaction } from './db';
import { ApiError, unseal } from './domain';
type Message={to:string;subject:string;text:string};
async function resend(message:Message,id:string) {
  if(!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new ApiError('Servizio email non configurato.',503);
  const {error}=await new Resend(process.env.RESEND_API_KEY).emails.send({from:process.env.EMAIL_FROM,...message},{idempotencyKey:id,signal:AbortSignal.timeout(10000)});
  if(error) throw new Error('Invio email non riuscito');
}
export async function deliverOutbox(send:(message:Message,id:string)=>Promise<unknown>=resend) {
  let sent=0,failed=0;
  // A locked or backed-off predecessor must still block later messages for that booking.
  // Unassociated legacy messages form global barriers until delivered, preserving their links.
  for(let i=0;i<25;i++) {
    const processed=await transaction(async client=>{
      const row=(await client.query(`SELECT current.id,current.payload,current.attempts FROM outbox current
        WHERE current.sent_at IS NULL AND current.next_attempt_at<=now()
        AND NOT EXISTS (
          SELECT 1 FROM outbox prior WHERE prior.sent_at IS NULL AND prior.sequence_no<current.sequence_no
          AND (prior.booking_id=current.booking_id OR prior.booking_id IS NULL OR current.booking_id IS NULL)
        )
        ORDER BY current.sequence_no LIMIT 1 FOR UPDATE OF current SKIP LOCKED`)).rows[0];
      if(!row) return false;
      try {
        await send(JSON.parse(unseal(row.payload)),row.id);
        await client.query('UPDATE outbox SET sent_at=now(),payload=NULL,attempts=attempts+1 WHERE id=$1',[row.id]);sent++;
      } catch {
        await client.query("UPDATE outbox SET attempts=attempts+1,next_attempt_at=now()+($2 * interval '1 second') WHERE id=$1",[row.id,Math.min(86400,60*2**Math.min(row.attempts,10))]);failed++;
      }
      return true;
    },false);
    if(!processed) break;
  }
  return {sent,failed};
}
