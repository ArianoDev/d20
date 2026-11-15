# Produzione: Coolify, Supabase, Resend e Tailscale Funnel

## Architettura

Internet HTTPS -> Tailscale Funnel sul server -> porta loopback pubblicata da Coolify -> container Next sulla porta 3000. Visitatori e amministratori usano un browser normale: **nessun client Tailscale e nessun account per i visitatori**. Funnel rende pubblica anche la pagina login; non e un controllo di accesso admin.

PostgreSQL, Supabase Auth/Storage e Resend sono esterni. Nessun volume applicativo contiene dati permanenti; immagini su Storage, prenotazioni e outbox nel DB. Usare un progetto Supabase dedicato o verificare attentamente l'impatto SQL su un progetto condiviso. Non pubblicare mai PostgreSQL su Internet per far funzionare Funnel.

## Segreti e Build

Le variabili sono elencate e descritte in `.env.example`. In Coolify aggiungerle come variabili **runtime**, non build arguments. Usare i nomi server `SUPABASE_URL` e `SUPABASE_ANON_KEY`, non i fallback `NEXT_PUBLIC_*`, che Next puo incorporare nei bundle. La build non deve avere credenziali e non richiede servizi raggiungibili.

Il Dockerfile usa Node 24 bookworm-slim, `npm ci`, output Next standalone, utente `node` e porta 3000. `runner` non contiene gli strumenti dev come `tsx`; `migrations` e un job separato e include le dipendenze dev necessarie. Il contesto esclude `.env*` eccetto il modello vuoto, chiavi e certificati comuni, cache e `.git`. Non mettere segreti in altri file nel contesto; controllare il contesto anche prima di build CI. I certificati personalizzati si montano a runtime.

```sh
docker build --target runner -t d20-ludoteca:release .
docker build --target migrations -t d20-ludoteca:migrations .
```

Preferire tag immutabili per release e registrare il digest; aggiornare periodicamente Node e dipendenze con verifica dei test. Mai passare `MIGRATION_DATABASE_URL`, URL di test o password admin al servizio web. La password admin non e una variabile dell'app: viene inserita al login.

## PostgreSQL e TLS

Usare connessione diretta o pooler **session mode** compatibile con il proprio progetto Supabase e rete del server. Evitare transaction pooling non verificato con questo driver/uso transazionale. Il pool applicativo ha massimo 10 connessioni per replica: dimensionare limiti del progetto e numero di repliche.

In produzione specificare `sslmode=verify-full` nella URL PostgreSQL, mantenendo la verifica CA e hostname. Non usare `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized=false` o modalita `no-verify`. Non considerare la sola cifratura equivalente alla verifica del server. Se la CA del progetto non e nel trust store Node, scaricarla da un canale Supabase fidato e montarla read-only, per esempio in `/run/certs/postgres-ca.pem`, impostando `NODE_EXTRA_CA_CERTS` a quel percorso **all'avvio**. Non aggiungere opzioni SSL in conflitto nella URL; collaudare la connessione con il driver `pg` dell'app. `sslmode=disable` e accettabile soltanto per un DB di test locale isolato.

Le URL contengono password: codificare i caratteri riservati percent-encoding senza incollare credenziali in shell history, ticket o output CI. Usare il database scelto nel percorso della URL. Con alcuni pooler Supabase il nome utente include anche il riferimento progetto: verificare il supporto del ruolo personalizzato nella dashboard; se non supportato usare la connessione diretta raggiungibile dal server, senza ripiegare sul ruolo privilegiato.

## Migrazioni e Privilegi

1. Salvare backup e verificare un ripristino prima di cambiare lo schema. Usare una connessione privilegiata del progetto come `MIGRATION_DATABASE_URL`; deve poter creare ruolo, tabelle e policy. Non e la connessione runtime.
2. Eseguire il job sulla stessa release prima di avviare il servizio. Il runner tiene un registro `schema_migrations`, applica SQL ordinati in transazione e usa un advisory lock. Non modificare migrazioni gia applicate.
3. Abilitare il login dedicato e impostare la password come sotto. Assegnare la URL risultante a `DATABASE_URL` del solo servizio web.
4. Eseguire health e una verifica dei permessi. Dopo future migrazioni riesaminare i grant: nessun grant automatico a tutte le tabelle future.

```sh
# File protetto con sola MIGRATION_DATABASE_URL e, se serve, NODE_EXTRA_CA_CERTS.
docker run --rm --env-file /percorso/protetto/migrations.env d20-ludoteca:migrations
```

Se occorre una CA privata, aggiungere il bind mount read-only allo stesso percorso indicato nel file env. In alternativa, da checkout fidato della release, installare anche le dipendenze dev (`npm ci`, non `--omit=dev`) ed eseguire `npm run db:migrate` con env esportata, oppure `node --env-file=/percorso/protetto/migrations.env --import tsx scripts/migrate.ts`. Non tentare `npm run db:migrate` dentro `runner` e non migrare automaticamente a ogni avvio del server web.

La migrazione iniziale crea `ludoteca_app` come **NOLOGIN**, non owner e senza bypass RLS. Dopo averla applicata, collegarsi come amministratore con `psql` al database applicativo ed eseguire esattamente questo SQL. `\password` chiede la password senza inserirla nella query o nella history. Il blocco dinamico concede CONNECT al database corrente, senza assumere che si chiami `postgres`.

```sql
ALTER ROLE ludoteca_app LOGIN;
\password ludoteca_app

DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ludoteca_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO ludoteca_app;
REVOKE CREATE ON SCHEMA public FROM ludoteca_app;
REVOKE ALL ON TABLE public.schema_migrations FROM ludoteca_app;
REVOKE ALL ON TABLE public.settings, public.games, public.bookings,
  public.outbox, public.rate_limits FROM PUBLIC;
REVOKE ALL ON TABLE public.settings, public.games, public.bookings,
  public.outbox, public.rate_limits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.settings, public.games,
  public.bookings, public.outbox, public.rate_limits TO ludoteca_app;
```

La migrazione ha gia assegnato gli attributi restrittivi: `ALTER ROLE` cambia soltanto `LOGIN`. Non aggiungere `NOSUPERUSER` al comando: anche la forma negativa richiede privilegi superuser non disponibili al ruolo `postgres` di Supabase gestito. Verificare gli attributi con le query sotto, anziche tentare di reimpostarli.

`anon` e `authenticated` esistono in Supabase; su PostgreSQL locale il relativo REVOKE va omesso se tali ruoli non esistono (la migrazione gia gestisce il caso). Gli ID sono UUID; la migrazione 002 concede inoltre il solo `USAGE` su `outbox_sequence_no_seq` al runtime per ordinare le notifiche. Non concedere ownership, `BYPASSRLS`, appartenenza a ruoli privilegiati, `CREATE` o accesso a `auth`/`storage` al login runtime. Non usare `GRANT ... ON ALL TABLES` o default privileges generalizzati.

I grant sono additivi: se `public` concede CREATE a `PUBLIC`, il REVOKE sul solo login non basta. Verificare `has_schema_privilege('ludoteca_app','public','CREATE')`; su un database dedicato, se vero, eseguire `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`. Su database condiviso coordinare questo cambiamento con gli altri servizi invece di revocare alla cieca. Verificare inoltre che un ruolo omonimo preesistente non sia owner o membro di ruoli aggiuntivi. Le policy `server_only` danno accesso ai dati al solo backend: non sostituiscono i controlli admin applicativi e non proteggono una credenziale runtime rubata.

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
FROM pg_roles WHERE rolname = 'ludoteca_app';
SELECT has_schema_privilege('ludoteca_app', 'public', 'CREATE') AS must_be_false,
       has_table_privilege('ludoteca_app', 'public.schema_migrations', 'SELECT') AS must_be_false;
SELECT relname, relrowsecurity FROM pg_class
WHERE oid IN ('public.settings'::regclass, 'public.games'::regclass,
 'public.bookings'::regclass, 'public.outbox'::regclass, 'public.rate_limits'::regclass);
```

Infine collegarsi **con la URL runtime**: `SELECT data FROM public.settings;` deve riuscire; tentare `SELECT * FROM public.schema_migrations;` deve essere negato. Health da solo non verifica questi privilegi.

## Supabase Auth e Storage

Disabilitare il signup pubblico nella dashboard Supabase Auth, inclusi provider non usati e accessi anonimi. Creare/invitare manualmente gli amministratori, verificare email e usare password robuste. Configurare Site URL con l'origine HTTPS di Funnel e solo redirect necessari, senza wildcard ampie. Riportare gli UUID Auth in `ADMIN_USER_IDS`, separati da virgole: non email, non un ruolo modificabile dal client. Una allowlist vuota nega ogni amministratore.

Il login usa email/password, salva soltanto l'access token in cookie `HttpOnly`, `SameSite=Strict`, `Secure` in produzione e con durata `expires_in` ricevuta da Auth. Non esiste refresh automatico: alla scadenza del JWT si accede di nuovo. Configurare una scadenza ragionevole nel progetto Auth e verificare il comportamento. Ogni operazione admin verifica utente e allowlist sul server. Rimuovere un UUID e ridistribuire la configurazione per revocare l'autorizzazione; non considerare il solo logout una garanzia di invalidazione immediata di ogni JWT gia emesso.

Creare esplicitamente il bucket indicato in `SUPABASE_STORAGE_BUCKET` e impostarlo **public** per la lettura delle copertine. Non caricarvi dati personali. Non creare policy INSERT/UPDATE/DELETE per `anon` o `authenticated`; rimuovere eventuali policy permissive gia presenti e verificare che un upload pubblico venga rifiutato. La lettura pubblica non deve diventare scrittura pubblica. Solo il backend, dopo il guard admin, usa `SUPABASE_SERVICE_ROLE_KEY` per caricare immagini. Il bucket pubblico non richiede una policy di scrittura o un login visitatore.

Configurare limiti bucket coerenti con 5 MB e MIME PNG/JPEG/WebP. L'app controlla dimensioni e firma iniziale del file; non e un antivirus o un decoder completo. Gli URL prodotti devono essere HTTPS. Gli oggetti hanno nome casuale sotto `games/` e cache lunga: niente sovrascritture; pianificare la pulizia degli oggetti orfani con inventario/backup. La service-role e molto privilegiata e resta esclusivamente server-side.

## Resend e Outbox

Verificare il dominio in Resend con i record DNS richiesti, configurare `RESEND_API_KEY` con il minimo ambito disponibile e `EMAIL_FROM` su quel dominio. Provare consegna reale a un destinatario autorizzato, controllare spam/bounce e limiti del piano; le suite simulate non verificano DNS o recapito.

`EMAIL_ENCRYPTION_KEY` deve decodificare in **32 byte** base64. Generarla una volta e conservarla cifrata insieme alle procedure di ripristino, separata dal DB. Tutte le repliche e release devono usare la stessa chiave. Perderla o cambiarla con messaggi pendenti rende illeggibile l'outbox; la rotazione richiede svuotamento della coda o una migrazione fidata di ricifratura, non un semplice redeploy. I backup dell'outbox richiedono la chiave originale. `OUTBOX_SECRET` e un altro segreto casuale di almeno 32 caratteri, non la chiave di cifratura.

Configurare un job Coolify o timer sul server **ogni minuto**, senza sovrapposizioni e con timeout di almeno 300 secondi. Chiamare `POST /api/internal/outbox` con entrambi gli header:

```text
Origin: <origine identica ad APP_URL>
Authorization: Bearer <OUTBOX_SECRET>
```

Esempio per un job Node 24 con `APP_URL`, `OUTBOX_SECRET` e `OUTBOX_ENDPOINT` iniettati dal gestore segreti; `OUTBOX_ENDPOINT` e una variabile del job, non dell'app, e puo indicare `http://127.0.0.1:3000/api/internal/outbox` sul server. L'origine resta quella pubblica anche quando il trasporto e locale:

```sh
node --input-type=module -e '
const r = await fetch(process.env.OUTBOX_ENDPOINT, {
  method: "POST",
  headers: {Origin: new URL(process.env.APP_URL).origin,
    Authorization: `Bearer ${process.env.OUTBOX_SECRET}`},
  signal: AbortSignal.timeout(300000)
});
if (!r.ok) process.exit(1);
const {sent, failed} = await r.json();
console.log(JSON.stringify({sent, failed}));
if (failed) process.exitCode = 1;
'
```

Non attivare shell tracing o stampare header. HTTP 200 puo comunque contenere `failed > 0`: monitorare il corpo aggregato e l'eta del messaggio pendente piu vecchio. Ogni chiamata elabora al massimo 25 messaggi con lock di riga e `SKIP LOCKED`, mantenendo l'ordine per prenotazione anche con worker concorrenti. Un messaggio fallito blocca le notifiche successive della stessa prenotazione, preservando il link iniziale. Le eventuali vecchie righe senza associazione create prima della migrazione 002 sono barriere globali fino alla consegna, senza cancellarne il contenuto cifrato. Dopo un errore il backoff parte da 60 secondi e raddoppia fino al limite effettivo di 61.440 secondi; i tentativi continuano senza massimo automatico. La chiave di idempotenza Resend e l'UUID outbox: riduce i duplicati ma non garantisce exactly-once oltre la finestra del provider. Dopo successo `payload` viene azzerato e resta il metadato di consegna. Nessuna pulizia o allerta e automatica.

## Coolify e Funnel

1. Sul server Linux installare Docker/Coolify e Tailscale aggiornati. Proteggere SSH e dashboard Coolify, aggiornare il sistema e mantenere firewall restrittivo. Abilitare MagicDNS, HTTPS e permessi Funnel secondo le policy del proprio tailnet. Non pubblicare dashboard, API Docker o DB tramite Funnel.
2. Creare una risorsa applicativa dal repository, build pack Dockerfile, Dockerfile alla root, target `runner` se selezionabile (e comunque l'ultimo stage). Impostare porta interna **3000**, `HOSTNAME=0.0.0.0`, `PORT=3000`, env runtime e nessun segreto build. Nessun volume dati richiesto.
3. Per la topologia diretta qui descritta, disabilitare l'esposizione tramite domini/proxy pubblico Coolify e configurare il mapping Docker **`127.0.0.1:3000:3000`**. Non basta indicare `3000:3000`: espone su tutte le interfacce. Se la UI Coolify non supporta un bind IP, usare la risorsa Docker Compose equivalente con `ports: ["127.0.0.1:3000:3000"]`, immagine costruita da questo Dockerfile e medesime env. Verificare il risultato con `docker ps` e `ss -lnt` sul server. Non mantenere in parallelo un secondo ingresso pubblico al container.
4. Configurare il probe HTTP `GET /api/health`, porta 3000, intervallo 30 s, timeout almeno 15 s, start period 30 s, tre tentativi. Deve essere sano prima di abilitare traffico. Il probe esegue una query DB ma non dipende da Auth o Resend; monitorare questi separatamente.
5. Prima di creare email o accedere, determinare il nome pubblico del nodo con `tailscale status`/dashboard e assegnare `APP_URL` alla sua origine `https://<nodo>.<tailnet>.ts.net`, senza path. Ridistribuire la configurazione e impostare Supabase Site URL coerente.
6. Pubblicare esclusivamente la root dell'app, senza prefisso: routing, asset e link email presuppongono `/`. Avviare Funnel persistente sul server:

```sh
sudo tailscale funnel --bg --https=443 --set-path=/ http://127.0.0.1:3000
tailscale funnel status
```

`--set-path=/` configura il prefisso root, non un URL applicativo sotto `/ludoteca`. Non usare `APP_URL` con sottopercorso: servirebbe una modifica al codice/configurazione non prevista. La sintassi dipende dalla versione Tailscale: controllare `tailscale funnel --help` e aggiornare se l'opzione non e disponibile; vedere il [riferimento CLI ufficiale](https://tailscale.com/kb/1311/tailscale-funnel). Per rimuovere questa sola pubblicazione: `sudo tailscale funnel --bg --https=443 --set-path=/ off`; evitare `reset` se il nodo ospita altri servizi. Non usare contemporaneamente configurazioni Serve/Funnel in conflitto sulla stessa porta/path.

Funnel termina HTTPS e inoltra HTTP solo sul loopback. Il nome `.ts.net` deve corrispondere a `APP_URL`; non assumere supporto trasparente a domini personalizzati. Da una rete esterna senza Tailscale verificare catalogo, calendario, redirect `/admin`, login, cookie Secure, richieste POST e link email. Non disabilitare i controlli Origin per aggirare un errore 403: correggere l'origine canonica e il routing.

### IP e Proxy Fidati

Lasciare `TRUST_PROXY=false` finche l'intera catena non e verificata. In questa modalita i limiti sono condivisi tra visitatori per scope, quindi possono essere piu restrittivi. Con `true` il backend accetta **il primo valore di `x-forwarded-for`**: se un client puo iniettarlo puo aggirare i limiti. Il bind loopback non dimostra che Funnel sanitizzi questo header.

Abilitare `true` soltanto dietro un proxy controllato che rimuove i valori inviati dal client e ricostruisce l'header da una sorgente IP realmente fidata. Non basta appendere `$proxy_add_x_forwarded_for`; non fidarsi di header arbitrari o del solo `X-Forwarded-Proto`. Con Funnel la connessione locale puo apparire come loopback: se non esiste una sorgente IP verificabile, mantenere il limite condiviso. Testare richieste esterne con header contraffatti e impedire ingressi diretti che saltino il proxy. Questa versione non interpreta automaticamente header d'identita Tailscale come autenticazione.

## Esercizio, Privacy e Ripristino

- Pianificare backup PostgreSQL e Storage, cifrati e con accesso ristretto, includendo ruoli/policy e inventario oggetti; i backup DB non includono automaticamente i file Storage. Abilitare PITR se disponibile e verificarne il piano/costo. Custodire chiave outbox e segreti separatamente; provare periodicamente un ripristino in un ambiente isolato senza inviare email reali.
- Definire e pubblicare informativa privacy, finalita e base giuridica, titolare/contatti, responsabili e regioni dati di Supabase/Resend/hosting; raccogliere solo nomi necessari e email del referente. Le immagini sono pubbliche: niente persone o dati sensibili senza adeguata base.
- Stabilire una retention esplicita prima dell'apertura: per esempio prenotazioni concluse 90 giorni, metadati outbox 30 giorni, rate limit scaduti 7 giorni e backup 30 giorni, da validare con il titolare. Sono scelte operative proposte, **non scadenze implementate**. Non cancellare automaticamente `pending` o prenotazioni attive. Implementare un job amministrativo separato e revisionato per cancellazione/anonimizzazione, rispettando richieste degli interessati e obblighi applicabili.
- La cancellazione logica della prenotazione non elimina i dati personali dal DB. I token non hanno TTL autonomo: chi possiede il link puo leggere la propria prenotazione finche esiste, anche dopo uno stato terminale. Pianificare cancellazione fisica secondo retention, attenzione a inoltri email e recupero account del referente.
- Disabilitare log dei corpi richieste/risposte, cookie, `Authorization`, URL DB e payload outbox su proxy, APM, scheduler e provider. Non mettere token gestione in query, analytics o ticket. Il frammento riduce le fughe lato HTTP ma resta sensibile nel messaggio email e nel browser.
- Monitorare disponibilita DB, health, errori 5xx, backlog/eta outbox, tentativi, bounce Resend, spazio Storage e limiti connessioni. `SELECT count(*), min(created_at) FROM public.outbox WHERE sent_at IS NULL;` fornisce un aggregato senza leggere payload. Pulire i rate limit scaduti tramite job fidato: non esiste cleanup incluso.
- Per rollback conservare l'immagine precedente, ma verificare compatibilita schema prima di ridistribuirla. Le migrazioni non hanno down automatico: in caso di incompatibilita usare una correzione forward o un ripristino pianificato. Bloccare scheduler e traffico durante ripristini incoerenti, poi verificare coda e idempotenza prima di riattivare.

## Verifica di Rilascio

Eseguire i comandi del README: typecheck, unitari, DB sacrificabile, browser con gate abilitati, build container e smoke. Lo smoke non richiede segreti e non stampa risposte sensibili. Se il container usa `APP_URL` pubblico ma lo smoke lo raggiunge su loopback, passare lo stesso `APP_URL` nell'ambiente dello script per l'header Origin del controllo worker.

Prima dell'apertura collaudare inoltre una prenotazione e una conferma reali, recapito email/link personale, upload immagine, sessione scaduta, revoca UUID e ripristino backup. Eseguire le prove pubbliche da un browser senza Tailscale. Registrare separatamente controlli riusciti, saltati e bloccati: una build riuscita non dimostra la configurazione dei servizi esterni.
