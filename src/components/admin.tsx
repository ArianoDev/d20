"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  dateLabel,
  statusLabels,
  time,
  type Booking,
  type Game,
  type Settings,
} from "./data";
import {
  Empty,
  GameImage,
  Loading,
  Notice,
  PageHeading,
  ResourceError,
  useResource,
} from "./common";

export function Admin() {
  const [tab, setTab] = useState("bookings");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function logout() {
    setBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <div className="admin-heading">
        <PageHeading title="La ludoteca, in ordine">
          Richieste, giochi e organizzazione della sala.
        </PageHeading>
        <button className="secondary" onClick={logout} disabled={busy}>
          {busy ? "Uscita..." : "Esci"}
        </button>
      </div>
      {error && <Notice error>{error}</Notice>}
      <nav className="admin-tabs" aria-label="Sezioni amministrazione">
        {[
          ["bookings", "Prenotazioni"],
          ["games", "Catalogo giochi"],
          ["settings", "Sala e orari"],
        ].map(([id, label]) => (
          <button
            className={tab === id ? "active" : "secondary"}
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "bookings" ? (
        <AdminBookings />
      ) : tab === "games" ? (
        <AdminGames />
      ) : (
        <AdminSettings />
      )}
    </>
  );
}
function AdminBookings() {
  const resource = useResource<{ bookings: Booking[] }>("/api/admin/bookings");
  const settings = useResource<Settings>("/api/settings");
  const [filter, setFilter] = useState("pending");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function change(id: string, status: string) {
    setBusy(id);
    setError("");
    setSuccess("");
    try {
      await api("/api/admin/bookings", {
        method: "PATCH",
        body: JSON.stringify({ id, status }),
      });
      setSuccess(
        status === "confirmed"
          ? "Prenotazione confermata. Aggiornamento email predisposto."
          : "Prenotazione rifiutata. Aggiornamento email predisposto.",
      );
      resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const bookings =
    resource.data?.bookings.filter((b) => !filter || b.status === filter) || [];
  return (
    <section>
      <div className="section-line">
        <h2>Prenotazioni</h2>
        <label>
          Stato
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Tutti gli stati</option>
            {Object.entries(statusLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <Notice error>{error}</Notice>}
      {success && <Notice>{success}</Notice>}
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : !bookings.length ? (
        <Empty title="Nessuna prenotazione in questo elenco">
          Le richieste ricevute compariranno qui, con i contatti e i
          partecipanti.
        </Empty>
      ) : (
        <div className="booking-list">
          {bookings.map((b) => (
            <article className="admin-booking" key={b.id}>
              <div className="section-line">
                <h3>{dateLabel(b.start)}</h3>
                <span className={`status ${b.status}`}>
                  {statusLabels[b.status]}
                </span>
              </div>
              <p>
                {time(b.start)} – {time(b.end)} ·{" "}
                {settings.data?.tables.find((t) => t.id === b.tableId)?.name ||
                  "Tavolo"}{" "}
                · {b.participants.length} persone
              </p>
              <a href={`mailto:${b.email}`}>{b.email}</a>
              <p>{b.participants.join(", ")}</p>
              {(b.status === "pending" || b.status === "confirmed") && (
                <div className="actions">
                  {b.status === "pending" && (
                    <button
                      disabled={!!busy}
                      onClick={() => change(b.id, "confirmed")}
                    >
                      {busy === b.id ? "Aggiornamento..." : "Conferma"}
                    </button>
                  )}
                  <RejectButton
                    disabled={!!busy}
                    onConfirm={() => change(b.id, "rejected")}
                  />
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function RejectButton({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <span className="inline-confirm">
      <span>Rifiutare la prenotazione?</span>
      <button className="danger" disabled={disabled} onClick={onConfirm}>
        Sì, rifiuta
      </button>
      <button
        className="secondary"
        disabled={disabled}
        onClick={() => setConfirm(false)}
      >
        Indietro
      </button>
    </span>
  ) : (
    <button
      className="danger"
      disabled={disabled}
      onClick={() => setConfirm(true)}
    >
      Rifiuta
    </button>
  );
}

function AdminGames() {
  const resource = useResource<{ games: Game[] }>("/api/admin/games");
  const [editing, setEditing] = useState<Game | "new" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [archiving, setArchiving] = useState<Game | null>(null);
  const [busy, setBusy] = useState(false);
  async function archive() {
    if (!archiving) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/games/${encodeURIComponent(archiving.id)}`, {
        method: "DELETE",
      });
      setMessage("Gioco archiviato: non è più visibile nel catalogo pubblico.");
      setArchiving(null);
      resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (editing)
    return (
      <GameEditor
        game={editing === "new" ? undefined : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setMessage("Gioco salvato.");
          resource.reload();
        }}
      />
    );
  return (
    <section>
      <div className="section-line">
        <h2>Catalogo giochi</h2>
        <button onClick={() => setEditing("new")}>Aggiungi gioco</button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {archiving && (
        <div className="confirmation">
          <h3>Archiviare {archiving.title}?</h3>
          <p>Il gioco non comparirà più nel catalogo pubblico.</p>
          <div className="actions">
            <button className="danger" onClick={archive} disabled={busy}>
              {busy ? "Archiviazione..." : "Conferma archiviazione"}
            </button>
            <button
              className="secondary"
              onClick={() => setArchiving(null)}
              disabled={busy}
            >
              Annulla
            </button>
          </div>
        </div>
      )}
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : !resource.data?.games.length ? (
        <Empty title="Il catalogo è ancora vuoto">
          Aggiungi il primo gioco con descrizione, immagini e link
          BoardGameGeek.
        </Empty>
      ) : (
        <div className="admin-game-list">
          {resource.data.games.map((g) => (
            <article key={g.id} className="admin-game">
              <GameImage src={g.images[0]} title={g.title} />
              <div>
                <h3>{g.title}</h3>
                <p>
                  {g.minPlayers}–{g.maxPlayers} giocatori · {g.duration} min
                  {g.archived ? " · Archiviato" : ""}
                </p>
              </div>
              <div className="actions">
                <button className="secondary" onClick={() => setEditing(g)}>
                  Modifica
                </button>
                {!g.archived && (
                  <button className="danger" onClick={() => setArchiving(g)}>
                    Archivia
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function GameEditor({
  game,
  onClose,
  onSaved,
}: {
  game?: Game;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [images, setImages] = useState<string[]>(game?.images || []);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      setError("Scegli un’immagine JPEG, PNG o WebP di massimo 5 MB.");
      return;
    }
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const data = await api<{ url: string }>("/api/admin/uploads", {
        method: "POST",
        body: form,
      });
      setImages((current) => [...current, data.url]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    const minPlayers = Number(f.get("minPlayers"));
    const maxPlayers = Number(f.get("maxPlayers"));
    if (maxPlayers < minPlayers) {
      setError("Il massimo dei giocatori deve essere almeno pari al minimo.");
      return;
    }
    if (!images.length) {
      setError("Aggiungi almeno un’immagine.");
      return;
    }
    setBusy(true);
    try {
      await api(
        game
          ? `/api/admin/games/${encodeURIComponent(game.id)}`
          : "/api/admin/games",
        {
          method: game ? "PUT" : "POST",
          body: JSON.stringify({
            title: f.get("title"),
            minPlayers,
            maxPlayers,
            duration: Number(f.get("duration")),
            complexity: Number(f.get("complexity")),
            description: f.get("description"),
            bggUrl: f.get("bggUrl"),
            images,
            archived: f.get("archived") === "on",
          }),
        },
      );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function addUrl() {
    try {
      const url = new URL(imageUrl);
      if (url.protocol !== "https:") throw new Error();
      setImages((current) => [...current, url.href]);
      setImageUrl("");
      setError("");
    } catch {
      setError("Inserisci un URL immagine HTTPS valido.");
    }
  }
  return (
    <section>
      <div className="section-line">
        <h2>{game ? "Modifica gioco" : "Aggiungi un gioco"}</h2>
        <button className="secondary" onClick={onClose} disabled={busy}>
          Torna al catalogo
        </button>
      </div>
      <form className="editor stack" onSubmit={save}>
        <label>
          Titolo
          <input
            name="title"
            required
            maxLength={200}
            defaultValue={game?.title}
          />
        </label>
        <div className="form-grid">
          <label>
            Minimo giocatori
            <input
              type="number"
              name="minPlayers"
              required
              min={1}
              max={100}
              defaultValue={game?.minPlayers || 2}
            />
          </label>
          <label>
            Massimo giocatori
            <input
              type="number"
              name="maxPlayers"
              required
              min={1}
              max={100}
              defaultValue={game?.maxPlayers || 4}
            />
          </label>
          <label>
            Durata (minuti)
            <input
              type="number"
              name="duration"
              required
              min={1}
              max={1440}
              defaultValue={game?.duration || 60}
            />
          </label>
          <label>
            Complessità (1–5)
            <input
              type="number"
              name="complexity"
              required
              min={1}
              max={5}
              step="0.1"
              defaultValue={game?.complexity || 1}
            />
          </label>
        </div>
        <label>
          Descrizione
          <textarea
            name="description"
            rows={6}
            required
            maxLength={10000}
            defaultValue={game?.description}
          />
        </label>
        <label>
          Link BoardGameGeek
          <input
            type="url"
            name="bggUrl"
            required
            pattern="https://boardgamegeek\.com/boardgame/[0-9]+.*"
            placeholder="https://boardgamegeek.com/boardgame/..."
            defaultValue={game?.bggUrl}
          />
          <span className="hint">
            URL HTTPS della scheda del gioco su BoardGameGeek.
          </span>
        </label>
        <fieldset>
          <legend>Immagini del gioco</legend>
          <p className="hint">
            La prima immagine è la copertina. JPEG, PNG o WebP, massimo 5 MB.
          </p>
          <div className="image-editor">
            {images.map((src, index) => (
              <div key={`${src}-${index}`}>
                <GameImage src={src} title={`Immagine ${index + 1}`} />
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    setImages(images.filter((_, i) => i !== index))
                  }
                >
                  Rimuovi {index + 1}
                </button>
                {index > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setImages([src, ...images.filter((_, i) => i !== index)])
                    }
                  >
                    Usa come copertina
                  </button>
                )}
              </div>
            ))}
          </div>
          <label>
            Carica immagine
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={uploading}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {uploading && <p role="status">Caricamento immagine...</p>}
          <div className="url-add">
            <label>
              Oppure aggiungi URL HTTPS
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={!imageUrl}
              onClick={addUrl}
            >
              Aggiungi URL
            </button>
          </div>
        </fieldset>
        {game && (
          <label className="checkbox">
            <input
              type="checkbox"
              name="archived"
              defaultChecked={game.archived}
            />
            Archiviato (non visibile al pubblico)
          </label>
        )}
        {error && <Notice error>{error}</Notice>}
        <div className="actions">
          <button disabled={busy || uploading}>
            {busy ? "Salvataggio..." : "Salva gioco"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            Annulla
          </button>
        </div>
      </form>
    </section>
  );
}
function AdminSettings() {
  const resource = useResource<Settings>("/api/settings");
  return (
    <section>
      <h2>Sala, tavoli e orari</h2>
      <p className="hint">
        Le modifiche vengono validate rispetto alle prenotazioni attive. Gli
        orari sono nel fuso Europe/Rome.
      </p>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : (
        resource.data && <SettingsEditor initial={resource.data} />
      )}
    </section>
  );
}
function SettingsEditor({ initial }: { initial: Settings }) {
  const [tables, setTables] = useState(initial.tables);
  const [days, setDays] = useState(initial.openingDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({
          roomCapacity: Number(f.get("roomCapacity")),
          tables,
          openingDays: days,
          openTime: f.get("openTime"),
          closeTime: f.get("closeTime"),
          slotMinutes: Number(f.get("slotMinutes")),
        }),
      });
      setSuccess("Impostazioni salvate. Il calendario pubblico è aggiornato.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="editor stack" onSubmit={save}>
      <label>
        Capienza complessiva della sala
        <input
          name="roomCapacity"
          type="number"
          min={1}
          max={1000}
          required
          defaultValue={initial.roomCapacity}
        />
        <span className="hint">
          Conta le persone, non il numero dei tavoli.
        </span>
      </label>
      <fieldset>
        <legend>Tavoli</legend>
        <div className="stack">
          {tables.map((t, index) => (
            <div className="table-editor" key={t.id}>
              <label>
                Nome tavolo
                <input
                  required
                  maxLength={80}
                  value={t.name}
                  onChange={(e) =>
                    setTables(
                      tables.map((t, i) =>
                        i === index ? { ...t, name: e.target.value } : t,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Posti
                <select
                  value={t.seats}
                  onChange={(e) =>
                    setTables(
                      tables.map((t, i) =>
                        i === index ? { ...t, seats: +e.target.value } : t,
                      ),
                    )
                  }
                >
                  {[2, 4, 6].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="danger"
                aria-label={`Rimuovi ${t.name}`}
                onClick={() => setTables(tables.filter((_, i) => i !== index))}
              >
                Rimuovi
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="secondary add-table"
          onClick={() =>
            setTables([
              ...tables,
              {
                id: crypto.randomUUID(),
                name: `Tavolo ${tables.length + 1}`,
                seats: 4,
              },
            ])
          }
        >
          Aggiungi tavolo
        </button>
        <p className="hint">
          Rimuovere un tavolo con prenotazioni attive può essere impedito dal
          server.
        </p>
      </fieldset>
      <fieldset>
        <legend>Giorni di apertura</legend>
        <div className="days">
          {[
            "Domenica",
            "Lunedì",
            "Martedì",
            "Mercoledì",
            "Giovedì",
            "Venerdì",
            "Sabato",
          ].map((day, index) => (
            <label className="checkbox" key={day}>
              <input
                type="checkbox"
                checked={days.includes(index)}
                onChange={(e) =>
                  setDays(
                    e.target.checked
                      ? [...days, index]
                      : days.filter((d) => d !== index),
                  )
                }
              />
              {day}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-grid">
        <label>
          Apertura
          <input
            name="openTime"
            type="time"
            required
            defaultValue={initial.openTime}
          />
        </label>
        <label>
          Chiusura
          <input
            name="closeTime"
            type="text"
            required
            pattern="([01][0-9]|2[0-4]):[0-5][0-9]"
            defaultValue={initial.closeTime}
          />
          <span className="hint">Formato HH:MM. Usa 24:00 per mezzanotte.</span>
        </label>
        <label>
          Durata fascia (minuti)
          <input
            name="slotMinutes"
            type="number"
            min={15}
            max={720}
            step={15}
            required
            defaultValue={initial.slotMinutes}
          />
        </label>
      </div>
      {error && <Notice error>{error}</Notice>}
      {success && <Notice>{success}</Notice>}
      <button disabled={busy}>
        {busy ? "Salvataggio..." : "Salva impostazioni"}
      </button>
    </form>
  );
}
