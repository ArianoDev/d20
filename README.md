# D20 Ludoteca

Catalogo giochi e prenotazioni pubbliche senza account visitatore. Solo gli amministratori accedono tramite Supabase Auth. Next.js 16, React 19 e TypeScript; PostgreSQL per i dati, Supabase Storage per immagini e Resend per email. Container stateless Node.js 24, pubblicato con Coolify e Tailscale Funnel.

## Sviluppo

Prerequisiti: Node.js 24, npm, PostgreSQL dedicato e, per le integrazioni reali, un progetto Supabase e un dominio mittente Resend verificato.

```sh
npm ci
cp .env.example .env.local
```

Compilare `.env.local` senza committarlo. Per iniziare servono `APP_URL` (in locale `http://localhost:3000`), `DATABASE_URL`, `EMAIL_ENCRYPTION_KEY`; login, immagini ed email richiedono anche le rispettive variabili Supabase/Resend. Non lasciare variabili opzionali vuote se si intende usare un fallback nel codice: le stringhe vuote non attivano `??`.

Generare separatamente una chiave di cifratura e un segreto worker, conservandoli nel gestore segreti. I comandi stampano nuovi segreti: eseguirli soltanto in un terminale fidato, non nei log CI.

```sh
openssl rand -base64 32
openssl rand -hex 32
```

Next carica `.env.local`, ma lo script migrazioni e Vitest **non** lo caricano automaticamente. Esportare le variabili necessarie nella shell oppure usare un file dedicato in sintassi dotenv compatibile con Node (valori con spazi tra virgolette):

```sh
node --env-file=.env.local --import tsx scripts/migrate.ts
npm run dev
```

Le migrazioni usano `MIGRATION_DATABASE_URL` se presente, altrimenti `DATABASE_URL`. Usare un ruolo privilegiato solo per le migrazioni, mai per il servizio web: vedere [deployment e SQL dei permessi](docs/DEPLOYMENT.md). Il server non migra automaticamente all'avvio. Non usare il database di produzione per lo sviluppo.

## Comportamento

- `/`: catalogo ricercabile e filtri; `/games/:id`: dettaglio con link BoardGameGeek.
- `/calendar`: fasce e disponibilita senza nomi o email; prenotazione con email e partecipanti.
- `/manage#…`: link personale ricevuto per email. Il token nel frammento viene rimosso dall'URL e inviato nel corpo POST, mai nella query.
- `/login` e `/admin`: amministrazione catalogo, upload, prenotazioni, tavoli e orari con guard lato server e API protette.
- Impostazioni iniziali: 12 posti complessivi, tavoli da 2/4/6; aperto domenica e da martedi a sabato, 18:00-24:00, fasce di 120 minuti, fuso `Europe/Rome` con ora legale.
- Le richieste `pending` occupano tavolo e capienza senza scadenza automatica. Conferma, rifiuto e cancellazione sono amministrabili; modificare una confermata la riporta in attesa. Le scritture e i controlli di capienza sono transazionali.
- Le email vengono accodate nella stessa transazione; dopo la risposta il server tenta la consegna. Uno scheduler outbox ogni minuto e necessario per garantire i retry anche senza altre visite. Le notifiche della stessa prenotazione restano ordinate anche dopo errori del provider. Il token resta riutilizzabile per la propria prenotazione; stati terminali non permettono ulteriori modifiche.

## Test

```sh
npm run typecheck
npm test
npm run build
```

`npm test` usa Vitest: unitari backend/UI e confini esterni simulati. Senza `TEST_DATABASE_URL` salta l'integrazione PostgreSQL; senza `UI_TEST_URL` salta i browser. Un risultato verde con suite saltate non dimostra queste integrazioni.

**Database reale, distruttivo:** predisporre un database vuoto e sacrificabile e una URL con privilegi sufficienti a creare schema, policy e ruolo. I test eseguono migrazioni, `TRUNCATE` e reset impostazioni. Non collegarli a dati da conservare.

```sh
# Esportare prima TEST_DATABASE_URL dal gestore segreti.
npm run test:db
```

**Browser, responsive e accessibilita:** Vitest usa Chromium via Playwright. Il runner avvia e arresta Next e il mock Auth su loopback, senza ereditare credenziali dei provider. Richiede libere le porte 3100 e 54399 (`UI_TEST_PORT` cambia la prima). Non eseguire mentre un altro server dev usa lo stesso checkout. Installare il browser, quindi:

```sh
npx playwright install chromium
# Su Linux CI, se necessario: npx playwright install --with-deps chromium
npm run test:e2e
# Con TEST_DATABASE_URL esportata: include anche browser -> API -> PostgreSQL reale.
# ATTENZIONE: migra e tronca le tabelle del database sacrificabile indicato.
```

La prima suite intercetta le API business e attraversa il guard admin reale. La seconda (`tests/live-browser.test.ts`), abilitata con `TEST_DATABASE_URL`, non intercetta le API business: verifica catalogo, creazione, link cifrato email, conferma, modifica, rollback conflitto, cancellazione e privacy attraverso Next e PostgreSQL. Solo Auth e simulato; Resend e disabilitato e l'outbox verificata nel DB. Nessuna suite certifica i servizi Supabase/Resend di produzione.

In alternativa, per eseguire solo la prima suite contro un server gia avviato, usare **solo in locale** un secondo processo Next con Auth fittizio e un UUID consentito:

```sh
# Terminale A: server isolato, mai esposto in rete pubblica.
APP_URL=http://localhost:3100 SUPABASE_URL=http://127.0.0.1:54399 SUPABASE_ANON_KEY=ui-test-only ADMIN_USER_IDS=00000000-0000-4000-8000-000000000001 npm run dev -- --hostname 127.0.0.1 --port 3100
# Terminale B: crea il mock Auth sulla porta indicata e avvia tutti i flussi UI.
UI_TEST_URL=http://localhost:3100 UI_TEST_AUTH_PORT=54399 npx vitest run tests/ui-browser.test.ts
```

Non avviare altre suite che sovrascrivono lo stesso `.next` durante build o browser test. Il mock Auth non e una configurazione di autenticazione valida per ambienti condivisi.

## Container

```sh
docker build --target runner -t d20-ludoteca:test .
docker run -d --name d20-ludoteca-smoke --env-file /percorso/protetto/runtime.env -p 127.0.0.1:3000:3000 d20-ludoteca:test
node scripts/container-smoke.mjs http://127.0.0.1:3000
docker inspect --format '{{.State.Health.Status}}' d20-ludoteca-smoke
docker stop d20-ludoteca-smoke
docker rm d20-ludoteca-smoke
```

Il file runtime deve contenere configurazione reale e `APP_URL` HTTPS in produzione; per verificare il worker locale con quell'origine esportare lo stesso `APP_URL` anche per lo smoke script. Da Docker Desktop un PostgreSQL pubblicato sull'host alla porta 55432 e raggiungibile tramite `host.docker.internal:55432` (su Linux configurare esplicitamente host-gateway se necessario).

Lo smoke esegue controlli HTTP non distruttivi: health con query DB, pagine/API pubbliche e assenza di campi riservati noti, redirect admin e rifiuto delle API admin/worker senza credenziali. Con lo streaming Next il redirect server puo essere una risposta 200 con meta refresh a `/login`, non necessariamente un 307. Non effettua login, prenotazioni o invii email, non stampa corpi o segreti e non prova l'assenza assoluta di fughe dati. `/api/health` prova `SELECT 1`, non schema, Auth, Storage o Resend.

Istruzioni complete per TLS database, privilegi, job migrazioni, scheduler email, backup e pubblicazione Internet: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Esiti effettivi della consegna, copertura dei requisiti e verifiche esterne ancora necessarie: [docs/VERIFICATION.md](docs/VERIFICATION.md).
