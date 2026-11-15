# Verifiche di Consegna

Eseguite il 14 novembre 2026 su macOS, Node 26 locale, immagine Linux Node 24 e PostgreSQL 16 in Docker. Nessun deploy remoto, commit o push eseguito. Il file preesistente `AGENT.md` non e stato modificato.

## Comandi ed Esiti

| Comando | Esito verificato |
| --- | --- |
| `npm install`, successivamente `npm uninstall @supabase/ssr` | Dipendenze installate; rimossa integrazione SSR inutilizzata |
| `npm run typecheck` | Superato |
| `TEST_DATABASE_URL=<db locale sacrificabile> npm test` | 51 passati, 8 browser saltati in questo comando |
| `TEST_DATABASE_URL=<db locale sacrificabile> npm run test:e2e` | 6 browser con fixture + 2 browser/API/PostgreSQL reali passati; nessun test saltato |
| `npm run build` | Build produzione superata, senza credenziali di build |
| `npm audit --omit=dev` | Nessuna vulnerabilita segnalata al momento della verifica |
| `docker build --target runner -t d20-ludoteca:test .` | Superato dopo l'ultima modifica applicativa |
| `docker build --target migrations -t d20-ludoteca:migrations .` | Superato |
| `docker run --rm -e MIGRATION_DATABASE_URL=... d20-ludoteca:migrations` | Migrazioni completate, inclusa riesecuzione senza duplicazioni |
| Avvio `runner` con URL DB del ruolo `ludoteca_app` abilitato al LOGIN nel solo DB di test | Container avviato; health Docker `healthy` |
| `APP_URL=https://ludoteca.example node scripts/container-smoke.mjs http://127.0.0.1:3310` | Health DB, API/pagine pubbliche, protezione admin/worker superati |
| `UI_TEST_URL=http://127.0.0.1:3310 npx vitest run tests/ui-browser.test.ts` | 5 passati sul container produzione; solo admin autenticato saltato, gia passato nel runner dedicato |
| Controllo runtime con `docker exec` | UID 1000; `tsx`, TypeScript e Vitest assenti dall'immagine web |
| Lighthouse sul catalogo vuoto del container locale | Performance 98/100, accessibilita 100/100; non e una misura del deployment remoto o di un catalogo popolato |

I 51 test e gli 8 browser costituiscono 59 casi distinti. Le suite DB sono distruttive: non usare dati da conservare. Il runner browser isola i segreti e simula Auth, non introduce bypass nell'applicazione. Lo script e2e avvia e arresta i processi necessari; Chromium deve essere installato con `npx playwright install chromium`.

## Copertura AGENT.md

| Requisito di test | Implementazione e prova |
| --- | --- |
| 1. Catalogo e campi | Schema Zod, CRUD reale PostgreSQL, filtri e dettaglio browser, archivio e upload admin |
| 2. Accesso pubblico/admin | Guard server, allowlist UUID, controlli API per ogni operazione; login browser con provider Auth fittizio |
| 3. Sala e tavoli | Capienze 2/4/6, impostazioni persistenti, rifiuto configurazioni incompatibili con prenotazioni attive |
| 4. Creazione | Email e nomi obbligatori, limiti tavolo/sala, fasce esatte Europe/Rome e DST |
| 5. Stati | Pending/confirmed/rejected/cancelled, terminali non riattivabili, conferma/rifiuto admin |
| 6. Concorrenza | PostgreSQL reale: create/create, update/update, update/create, update/admin e settings/create; conflitti tavolo e capienza |
| 7. Link | Token casuali 256 bit, hash, token invalido/manomesso, riutilizzo documentato; fragment rimosso, token solo nel corpo POST |
| 8. Modifica | Pending resta pending, confirmed torna pending, conflitto lascia dati e outbox invariati; cambio tavolo con sala piena |
| 9. Email | Provider simulato, outbox cifrata transazionale, recupero dopo errore, idempotenza e ordine anche con due worker |
| 10. Privacy | Nessun dato personale nelle API/calendario pubblici; accesso privato con token; admin autorizzato vede dettagli; test deny RLS anon/authenticated |
| 11. Container | Build multi-stage, avvio reale, migrazioni separate, login DB ridotto, health DB e smoke HTTP |
| 12. Accessibilita | Axe WCAG 2 A/AA e 2.1 A/AA, desktop/mobile e dark mode, errori form e API; Lighthouse e revisione screenshot |

## Revisione e Correzioni

Una revisione indipendente ha controllato privacy, autorizzazioni, transazioni e interfacce. Corrette e verificate con regressioni: ordine notifiche dopo retry, disponibilita di cambio tavolo a sala piena, troncamento delle prenotazioni admin oltre 1000 record, istruzione LOGIN incompatibile con i privilegi Supabase gestiti. Lighthouse ha inoltre identificato un nome accessibile del marchio incoerente col testo visibile: test riprodotto in errore, correzione minimale e riesecuzione browser/Lighthouse riuscite.

## Configurazione Esterna Non Verificata

- Progetto Supabase reale: connessione TLS e login dedicato, applicazione migrazioni, Auth con signup disabilitato e UUID admin, bucket Storage pubblico in sola lettura per i visitatori.
- Resend reale: chiave, dominio e mittente verificati, DNS, recapito, bounce e quote. I test simulano il provider e controllano la coda, non la posta ricevuta.
- Coolify e server Linux: segreti runtime, mapping loopback, scheduler outbox ogni minuto, backup e monitoraggio. Senza scheduler non e garantito il retry a sito inattivo.
- Funnel reale: policy tailnet, nome HTTPS pubblico coerente con `APP_URL`, accesso da rete esterna senza client Tailscale. Nessuna verifica remota eseguita.
- IP fidati: senza proxy verificato il rate limit e volutamente condiviso per scope. Non abilitare `TRUST_PROXY=true` con header contraffabili; documentata la sanitizzazione necessaria.
- Informativa privacy, retention, contatti del titolare e prove di ripristino spettano alla messa in esercizio. Le cancellazioni delle prenotazioni sono logiche; non e inclusa una cancellazione automatica dei dati o delle richieste pending.

Non sono noti blocchi locali residui dopo le verifiche. La configurazione e il collaudo dei servizi esterni sono prerequisiti ancora necessari per l'apertura pubblica, non controlli gia superati. Procedura dettagliata in `DEPLOYMENT.md`.
