import { describe, expect, it } from 'vitest';
import { bookingSchema, gameSchema, settingsSchema, slotsForDate, tokenHash, newToken, seal, unseal, validImage } from '../src/lib/domain';
import { jsonBody } from '../src/lib/security';

describe('backend contracts', () => {
  it('requires real participants and email', () => {
    expect(bookingSchema.safeParse({ email: 'bad', participants: [' '], tableId: 'x', start: 'x', end: 'x' }).success).toBe(false);
  });
  it('accepts only HTTPS credential-free images and exact BGG host', () => {
    const game = { title:'Azul', minPlayers:2, maxPlayers:4, duration:45, complexity:2, description:'Mosaici', images:['https://example.com/a.png'], bggUrl:'https://boardgamegeek.com/boardgame/230802/azul' };
    expect(gameSchema.safeParse(game).success).toBe(true);
    for (const bggUrl of ['not-url','https://boardgamegeek.com.evil.com/a','http://boardgamegeek.com/a','https://u:p@boardgamegeek.com/a','https://boardgamegeek.com/']) expect(gameSchema.safeParse({...game,bggUrl}).success).toBe(false);
    expect(gameSchema.safeParse({...game,images:['javascript:alert(1)']}).success).toBe(false);
  });
  it('allows only 2/4/6 seats and unique opening days', () => {
    expect(settingsSchema.safeParse({roomCapacity:12,tables:[{id:'a',name:'A',seats:3}],openingDays:[2],openTime:'18:00',closeTime:'24:00',slotMinutes:120}).success).toBe(false);
  });
  it('generates exact Rome slots across winter and summer', () => {
    const settings = {openingDays:[0,1,2,3,4,5,6],openTime:'18:00',closeTime:'24:00',slotMinutes:120};
    expect(slotsForDate('2027-01-05',settings)[0]).toEqual({start:'2027-01-05T17:00:00.000Z',end:'2027-01-05T19:00:00.000Z'});
    expect(slotsForDate('2027-07-06',settings)[0].start).toBe('2027-07-06T16:00:00.000Z');
    expect(slotsForDate('2027-02-30',settings)).toEqual([]);
    expect(slotsForDate('2027-03-28',{...settings,openTime:'02:00',closeTime:'04:00',slotMinutes:60})).toHaveLength(1);
    expect(slotsForDate('2027-10-31',{...settings,openTime:'02:00',closeTime:'04:00',slotMinutes:60})).toHaveLength(1);
  });
  it('stores only token hashes and authenticated encrypted email secrets', () => {
    process.env.EMAIL_ENCRYPTION_KEY = Buffer.alloc(32,7).toString('base64');
    const token = newToken();
    expect(token).toHaveLength(43);
    expect(tokenHash(token)).not.toContain(token);
    const encrypted = seal(token);
    expect(encrypted).not.toContain(token);
    expect(unseal(encrypted)).toBe(token);
    expect(() => unseal(encrypted.slice(0,-5)+'aaaaa')).toThrow();
  });
  it('checks magic bytes, not the provided MIME alone', () => {
    expect(validImage(Buffer.from('not an image'),'image/png')).toBe(false);
    expect(validImage(Buffer.from([137,80,78,71,13,10,26,10]),'image/png')).toBe(true);
    expect(validImage(Buffer.alloc(5*1024*1024+1),'image/png')).toBe(false);
  });
  it('bounds JSON bodies even without a content-length header',async()=>{
    await expect(jsonBody(new Request('https://example.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:'x'.repeat(33000)})}))).rejects.toMatchObject({status:413});
    await expect(jsonBody(new Request('https://example.com',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}))).rejects.toMatchObject({status:415});
    await expect(jsonBody(new Request('https://example.com',{method:'POST',headers:{'content-type':'application/json'},body:'{'}))).rejects.toMatchObject({status:400});
  });
});
