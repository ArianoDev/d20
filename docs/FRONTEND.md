# Restyling Pubblico

Checkpoint prima del lavoro: `bc6511d` (`feat: refine game galleries and playroom branding`). Il restyling successivo non e incluso in quel commit.

## Audit e Direzione

Intervento conservativo su catalogo e scheda gioco, non una nuova landing promozionale. Il catalogo e l'immagine reale dei giochi restano il contenuto principale: nessun gioco, recensione, contatore commerciale o dato dimostrativo aggiunto al database.

- Identita preservata: verde `#235a44`, fondo chiaro `#f7f8f4`, corrispondenti token dark gia presenti, simbolo d20 e testi del brand personalizzati dall'utente.
- Gerarchia precedente: header desktop da 90 px, font Arial, filtri su pannello marcato, metadati delle carte compressi e azioni della scheda dopo la descrizione completa.
- Gerarchia nuova: header da 76 px, Geist Sans locale, introduzione piu compatta, copertine quadrate, metadati separati e azioni prima della descrizione.
- `DESIGN_VARIANCE: 4`, `MOTION_INTENSITY: 3`, `VISUAL_DENSITY: 4`. Solo feedback hover/active; nessuna animazione automatica o libreria di motion aggiunta.
- Fondazione: Next.js e CSS nativo esistenti. Nessuna migrazione Tailwind o introduzione di un secondo design system.
- Tipografia: pacchetto `geist`, integrazione `geist/font/sans` basata su font locali Next.js. Nessuna richiesta a Google Fonts durante la build.
- Forme: scala esistente preservata, superfici da 12 px e controlli da 6-7 px. Le carte raggruppano singoli giochi, non sezioni promozionali intercambiabili.

## Vincoli Preservati

- Route, metadati SEO, navigazione primaria, nomi/ordine dei campi, filtri e destinazioni delle CTA invariati.
- Descrizioni, statistiche e immagini provengono dai dati esistenti. Nessun cambiamento a API, schema, autorizzazioni o prenotazioni.
- Carosello a immagine singola con navigazione tastiera e stato accessibile; controlli nascosti per una singola immagine.
- Sfondo delle copertine e della gallery sempre bianco, anche in dark mode, come richiesto esplicitamente. E una superficie di prodotto, non un'inversione del tema del sito.
- Gallery fissa solo con spazio disponibile: posizione normale su mobile e viewport alte al massimo 640 px, per non nascondere i pulsanti sui display bassi.
- Prima copertina e immagine attiva della scheda caricate con priorita; altre copertine lazy. Dimensioni riservate tramite aspect ratio.
- Stati vuoti, caricamento, errore e immagine non disponibile mantenuti. Nessuna nuova dipendenza da provider esterni.

## Verifiche Eseguite

- Nuovi test riprodotti prima delle correzioni: altezza header oltre 80 px, CTA dopo descrizioni lunghe, controlli sticky fuori viewport su schermo da 1280x500.
- `npm run typecheck` e `npm run build`: superati.
- Suite unitaria/backend senza DB: 16 test passati. Le integrazioni DB distruttive non sono state rieseguite sui dati locali dell'utente.
- Tutti i 12 test di `tests/ui-browser.test.ts` superati su un server di produzione isolato, con Auth simulato e connessione al database in sola lettura. Include controlli axe WCAG 2/2.1 A/AA, viewport da 320 a 1280 px, temi chiaro/scuro, filtri, carosello, errori e flusso admin.
- Screenshot delle pagine reali esaminati su desktop chiaro e mobile scuro; le suite browser verificano anche le combinazioni di tema e dimensione complementari.
- `docker build --target runner -t d20-ludoteca:frontend .`: superato. Avvio standalone con DB in sola lettura, health, catalogo, dettaglio e caricamento font verificati; container di prova poi rimosso.
- Lighthouse sulla homepage locale in produzione con catalogo reale: performance 98, accessibilita 100, best practices 96, SEO 100. Misura locale, non certificazione di tutte le pagine o del deployment remoto.
- `npm audit --omit=dev`: nessuna vulnerabilita segnalata al controllo.

La revisione indipendente ha identificato il caso sticky su schermi bassi, riprodotto e corretto con test. I servizi Supabase/Resend reali e il deployment remoto non sono stati riconfigurati o ricollaudati per questo intervento frontend.
