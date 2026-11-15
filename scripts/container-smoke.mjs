// Read-only checks: never print response bodies, cookies or environment values.
const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('Specificare solo una origine HTTP(S), senza credenziali.');
}
const origin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : base.origin;
const request = (path, options = {}) => fetch(new URL(path, base), {
  redirect: 'manual', signal: AbortSignal.timeout(15000), ...options,
});
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function privateFields(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /^(email|participants|token|token_hash|payload|password|access_token|refresh_token)$/i.test(key) || privateFields(child));
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await request('/api/health');
      ready = response.status === 200 && (await response.json()).ok === true;
    } catch { /* Startup or DB not ready yet. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  check(ready, 'Health HTTP/database non disponibile.');
  console.info('OK health HTTP/database');
  for (const path of ['/', '/calendar', '/login', '/manage']) {
    check((await request(path)).status === 200, `Pagina pubblica non disponibile: ${path}`);
  }
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (const path of ['/api/games', '/api/settings', `/api/availability?date=${date}`]) {
    const response = await request(path);
    check(response.status === 200, 'API pubblica non disponibile.');
    check(!privateFields(await response.json()), 'Campo riservato in una API pubblica.');
  }
  console.info('OK pagine e API pubbliche, nessun campo privato noto');
  const admin = await request('/admin');
  const location = admin.headers.get('location');
  const httpRedirect = [302, 303, 307, 308].includes(admin.status) && location && new URL(location, base).pathname === '/login';
  // Next streaming can commit 200 before the server guard emits its redirect.
  const streamedRedirect = admin.status === 200 && /<meta\s+id="__next-page-redirect"\s+http-equiv="refresh"\s+content="\d+;url=\/login"\s*\/?\s*>/.test(await admin.text());
  check(httpRedirect || streamedRedirect, 'Guard server /admin non verificata.');
  for (const path of ['/api/admin/session', '/api/admin/bookings', '/api/admin/games', '/api/admin/settings']) {
    check((await request(path)).status === 401, 'API admin accessibile senza sessione.');
  }
  check((await request('/api/internal/outbox', { method: 'POST', headers: { Origin: origin } })).status === 401, 'Worker accessibile senza autorizzazione.');
  console.info('OK admin e worker protetti senza credenziali');
} catch (error) {
  console.error(error instanceof Error && !error.message.includes('fetch') ? error.message : 'Smoke test HTTP non riuscito.');
  process.exitCode = 1;
}
