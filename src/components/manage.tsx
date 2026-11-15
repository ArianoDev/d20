"use client";
import { useEffect, useRef, useState } from "react";
import {
  api,
  captureToken,
  dateLabel,
  statusLabels,
  time,
  type Booking,
  type Settings,
} from "./data";
import { Loading, Notice, PageHeading, useResource } from "./common";
import { BookingFlow } from "./booking";

export function Manage() {
  const settings = useResource<Settings>("/api/settings");
  const token = useRef("");
  const started = useRef(false);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function read() {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ booking: Booking }>("/api/manage", {
        method: "POST",
        body: JSON.stringify({ token: token.current, action: "read" }),
      });
      setBooking(data.booking);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    token.current = captureToken(window.location, window.history);
    if (!token.current) {
      setError(
        "Apri il link personale ricevuto via email. Per sicurezza il link non resta nella barra degli indirizzi: se hai ricaricato la pagina, riaprilo dall’email.",
      );
      setLoading(false);
      return;
    }
    void read();
  }, []);
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await api("/api/manage", {
        method: "POST",
        body: JSON.stringify({ token: token.current, action: "cancel" }),
      });
      setMessage("Prenotazione cancellata. Il tavolo è di nuovo disponibile.");
      setConfirm(false);
      await read();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active =
    booking?.status === "pending" || booking?.status === "confirmed";
  return (
    <>
      <PageHeading title="La tua prenotazione">
        Questo spazio è privato. Non condividere il link ricevuto via email.
      </PageHeading>
      {loading && <Loading label="Apertura della prenotazione..." />}
      {error && (
        <Notice error>
          {error}
          {token.current && (
            <div>
              <button className="secondary" onClick={read}>
                Riprova
              </button>
            </div>
          )}
        </Notice>
      )}
      {message && <Notice>{message}</Notice>}
      {booking && !loading && (
        <>
          <section className="private-summary">
            <div className="section-line">
              <h2>{dateLabel(booking.start)}</h2>
              <span className={`status ${booking.status}`}>
                {statusLabels[booking.status]}
              </span>
            </div>
            <p>
              {time(booking.start)} – {time(booking.end)}
            </p>
            <p>
              <strong>Tavolo:</strong>{" "}
              {settings.data?.tables.find(
                (table) => table.id === booking.tableId,
              )?.name || booking.tableId}
            </p>
            <p>
              <strong>Email:</strong> {booking.email}
            </p>
            <h3>Partecipanti</h3>
            <ul>
              {booking.participants.map((name, index) => (
                <li key={index}>{name}</li>
              ))}
            </ul>
            {active && (
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => {
                    setEditing(!editing);
                    setConfirm(false);
                  }}
                >
                  {editing ? "Chiudi modifica" : "Modifica prenotazione"}
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setConfirm(true);
                    setEditing(false);
                  }}
                >
                  Cancella prenotazione
                </button>
              </div>
            )}
            {!active && (
              <p>Questa prenotazione non può più essere modificata.</p>
            )}
            {confirm && (
              <div className="confirmation">
                <h3>Vuoi cancellare la prenotazione?</h3>
                <p>L’operazione libera il tavolo e non può essere annullata.</p>
                <div className="actions">
                  <button className="danger" disabled={busy} onClick={cancel}>
                    {busy ? "Cancellazione..." : "Conferma cancellazione"}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setConfirm(false)}
                    disabled={busy}
                  >
                    Mantieni prenotazione
                  </button>
                </div>
              </div>
            )}
          </section>
          {editing && active && (
            <BookingFlow
              booking={booking}
              token={token.current}
              onSaved={(message) => {
                setEditing(false);
                setMessage(message);
                void read();
              }}
            />
          )}
        </>
      )}
    </>
  );
}
