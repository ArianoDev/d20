"use client";
import { useState, type FormEvent } from "react";
import {
  api,
  dateLabel,
  localDate,
  participantsFromText,
  time,
  type Booking,
  type Slot,
} from "./data";
import {
  Empty,
  Loading,
  Notice,
  PageHeading,
  ResourceError,
  useResource,
} from "./common";

export type Selection = {
  tableId: string;
  start: string;
  end: string;
  seats: number;
  name: string;
  remainingCapacity: number;
};
export function Availability({
  selected,
  onSelect,
  current,
}: {
  selected: Selection | null;
  onSelect: (value: Selection | null) => void;
  current?: Booking;
}) {
  const [date, setDate] = useState(
    current ? localDate(new Date(current.start)) : localDate(),
  );
  const resource = useResource<{ slots: Slot[] }>(
    `/api/availability?date=${date}`,
  );
  return (
    <section aria-labelledby="availability-title">
      <h2 id="availability-title">Scegli quando giocare</h2>
      <label className="date-field">
        Data
        <input
          type="date"
          required
          min={localDate()}
          value={date}
          onChange={(e) => {
            if (e.target.value) {
              setDate(e.target.value);
              onSelect(null);
            }
          }}
        />
      </label>
      <p className="hint">
        Orari locali della ludoteca (Europe/Rome). Anche le richieste in attesa
        occupano i posti.
      </p>
      {resource.loading ? (
        <Loading label="Verifica disponibilità..." />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : !resource.data?.slots.length ? (
        <Empty title="Nessuna fascia disponibile">
          La sala è chiusa in questa data o non ci sono fasce prenotabili.
          Scegli un altro giorno.
        </Empty>
      ) : (
        <div className="slots">
          {resource.data.slots.map((slot) => {
            const ownSlot =
              !!current &&
              Date.parse(current.start) === Date.parse(slot.start) &&
              Date.parse(current.end) === Date.parse(slot.end);
            const remainingCapacity =
              slot.remainingCapacity +
              (ownSlot ? current.participants.length : 0);
            return (
              <fieldset className="slot" key={slot.start}>
                <legend>
                  {time(slot.start)} – {time(slot.end)}
                </legend>
                <p className="hint">
                  {remainingCapacity} posti{" "}
                  {ownSlot
                    ? "disponibili per la modifica, inclusi i tuoi attuali"
                    : "liberi in sala"}
                </p>
                <div className="table-options">
                  {slot.tables.map((table) => {
                    const active =
                      selected?.start === slot.start &&
                      selected.tableId === table.id;
                    const ownTable = ownSlot && current.tableId === table.id;
                    const unavailable =
                      (ownSlot
                        ? table.occupied !== false && !ownTable
                        : !table.available) ||
                      remainingCapacity < 1 ||
                      Date.parse(slot.start) <= Date.now();
                    return (
                      <button
                        type="button"
                        className={`table-option ${active ? "selected" : ""}`}
                        aria-pressed={active}
                        disabled={unavailable}
                        key={table.id}
                        onClick={() =>
                          onSelect({
                            tableId: table.id,
                            name: table.name,
                            seats: table.seats,
                            start: slot.start,
                            end: slot.end,
                            remainingCapacity,
                          })
                        }
                      >
                        <strong>{table.name}</strong>
                        <span>{table.seats} posti</span>
                        <small>
                          {unavailable
                            ? "Non disponibile"
                            : active
                              ? "Selezionato"
                              : ownTable
                                ? "Tavolo attuale"
                                : "Disponibile"}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
    </section>
  );
}
export function BookingFlow({
  booking,
  token,
  onSaved,
}: {
  booking?: Booking;
  token?: string;
  onSaved?: (message: string) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [names, setNames] = useState(booking?.participants.join("\n") || "");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!selection) {
      setError("Scegli una fascia e un tavolo.");
      return;
    }
    const participants = participantsFromText(names);
    if (!participants.length) {
      setError("Inserisci almeno un partecipante.");
      return;
    }
    if (
      participants.length >
      Math.min(selection.seats, selection.remainingCapacity)
    ) {
      setError(
        "I partecipanti superano i posti disponibili al tavolo o in sala.",
      );
      return;
    }
    setBusy(true);
    const body = {
      tableId: selection.tableId,
      start: selection.start,
      end: selection.end,
      participants,
    };
    try {
      if (booking && token) {
        await api("/api/manage", {
          method: "POST",
          body: JSON.stringify({ token, action: "update", booking: body }),
        });
        onSaved?.(
          "Modifica inviata. La prenotazione è ora in attesa di conferma.",
        );
      } else {
        await api("/api/bookings", {
          method: "POST",
          body: JSON.stringify({
            ...body,
            email,
            website: new FormData(e.currentTarget).get("website") || "",
          }),
        });
        setSuccess(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (success)
    return (
      <div className="success-page">
        <span className="eyebrow">Richiesta inviata</span>
        <h1>Il tavolo è in attesa di conferma.</h1>
        <Notice>
          Controlla la tua email: riceverai il riepilogo e il link personale per
          modificare o cancellare la richiesta.
        </Notice>
        <p>
          La prenotazione sarà definitiva dopo la conferma della ludoteca. Se
          non trovi il messaggio, controlla anche la cartella spam.
        </p>
        <button
          className="secondary"
          onClick={() => {
            setSuccess(false);
            setSelection(null);
            setNames("");
            setEmail("");
          }}
        >
          Nuova prenotazione
        </button>
      </div>
    );
  return (
    <>
      {!booking && (
        <PageHeading title="Un tavolo per la tua compagnia">
          Scegli data, fascia e tavolo. Non serve un account: ti aggiorniamo via
          email.
        </PageHeading>
      )}
      <div className="booking-layout">
        <Availability
          selected={selection}
          onSelect={setSelection}
          current={booking}
        />
        <section className="booking-panel" aria-labelledby="booking-title">
          <span className="step-label">
            {booking ? "Aggiorna la richiesta" : "La tua richiesta"}
          </span>
          <h2 id="booking-title">
            {booking ? "Modifica prenotazione" : "Chi viene a giocare?"}
          </h2>
          {selection ? (
            <div className="selection-summary">
              <strong>{dateLabel(selection.start)}</strong>
              <span>
                {time(selection.start)} – {time(selection.end)} ·{" "}
                {selection.name}
              </span>
              <span>
                Fino a {Math.min(selection.seats, selection.remainingCapacity)}{" "}
                partecipanti
              </span>
            </div>
          ) : (
            <p className="hint">
              Seleziona un tavolo disponibile per continuare
              {booking
                ? ". Per cambiare solo i nomi, seleziona nuovamente data e fascia: la disponibilità sarà verificata dal server."
                : "."}
            </p>
          )}
          <form onSubmit={submit} className="stack">
            {!booking && (
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <span className="hint">
                  Qui riceverai il link privato per gestire la prenotazione.
                </span>
              </label>
            )}
            <label>
              Nomi dei partecipanti
              <textarea
                required
                rows={5}
                maxLength={1200}
                value={names}
                onChange={(e) => setNames(e.target.value)}
                placeholder={"Un nome per riga, incluso il tuo"}
                aria-describedby="participants-help"
              />
              <span id="participants-help" className="hint">
                Un nome per riga. {participantsFromText(names).length}{" "}
                partecipanti inseriti.
              </span>
            </label>
            <div className="honeypot" aria-hidden="true">
              <label>
                Sito web
                <input name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>
            {error && <Notice error>{error}</Notice>}
            <button type="submit" disabled={busy || !selection}>
              {busy
                ? "Invio in corso..."
                : booking
                  ? "Salva modifiche"
                  : "Richiedi prenotazione"}
            </button>
            <p className="hint">
              {booking
                ? "Ogni modifica richiede una nuova conferma della ludoteca."
                : "La richiesta rimane in attesa finché la ludoteca non la conferma. I tuoi dati non saranno visibili nel calendario."}
            </p>
          </form>
        </section>
      </div>
    </>
  );
}
