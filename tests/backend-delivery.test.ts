import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({after:vi.fn(),handle:vi.fn(),deliver:vi.fn()}));
vi.mock('next/server',()=>({after:mocks.after}));
vi.mock('../src/lib/api',()=>({handle:mocks.handle}));
vi.mock('../src/lib/email',()=>({deliverOutbox:mocks.deliver}));
import { POST } from '../src/app/api/[...path]/route';
beforeEach(()=>{vi.clearAllMocks();mocks.deliver.mockResolvedValue({sent:1,failed:0});});
it('automatically drains committed email after a successful mutation response',async()=>{
  mocks.handle.mockResolvedValue(Response.json({ok:true},{status:201}));
  const response=await POST(new Request('https://ludoteca.example/api/bookings',{method:'POST'}));
  expect(response.status).toBe(201);
  expect(mocks.after).toHaveBeenCalledOnce();
  await mocks.after.mock.calls[0][0]();
  expect(mocks.deliver).toHaveBeenCalledOnce();
});
it('does not schedule delivery for rejected mutations',async()=>{
  mocks.handle.mockResolvedValue(Response.json({error:'Conflitto'},{status:409}));
  await POST(new Request('https://ludoteca.example/api/bookings',{method:'POST'}));
  expect(mocks.after).not.toHaveBeenCalled();
});
