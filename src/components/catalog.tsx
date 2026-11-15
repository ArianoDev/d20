"use client";
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { type Game, filterGames } from "./data";
import {
  Empty,
  GameImage,
  Loading,
  PageHeading,
  ResourceError,
  useResource,
} from "./common";

export function Catalog() {
  const resource = useResource<{ games: Game[] }>("/api/games");
  const [query, setQuery] = useState("");
  const [players, setPlayers] = useState("");
  const [duration, setDuration] = useState("");
  const [complexity, setComplexity] = useState("");
  const deferredQuery = useDeferredValue(query);
  const games = filterGames(
    resource.data?.games || [],
    deferredQuery,
    players,
    duration,
    complexity,
  );
  return (
    <>
      <section className="catalog-intro">
        <div>
          <span className="eyebrow">La nostra collezione</span>
          <h1>
            La prossima partita
            <br />
            comincia qui.
          </h1>
          <p>
            Cerca un gioco, scopri come si gioca e ritrova il tuo gruppo attorno
            a un tavolo.
          </p>
        </div>
        <Link className="button" href="/calendar">
          Prenota un tavolo <span aria-hidden="true">↗</span>
        </Link>
      </section>
      <section aria-label="Catalogo giochi">
        <form
          className="filters"
          onSubmit={(e) => e.preventDefault()}
          role="search"
        >
          <label className="search-field">
            Cerca nel catalogo
            <input
              type="search"
              placeholder="Titolo del gioco"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            Giocatori
            <select
              value={players}
              onChange={(e) => setPlayers(e.target.value)}
            >
              <option value="">Qualsiasi</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map((n) => (
                <option key={n} value={n}>
                  {n} persone
                </option>
              ))}
            </select>
          </label>
          <label>
            Durata massima
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              <option value="">Qualsiasi</option>
              {[30, 60, 90, 120, 180].map((n) => (
                <option key={n} value={n}>
                  {n} minuti
                </option>
              ))}
            </select>
          </label>
          <label>
            Complessità massima
            <select
              value={complexity}
              onChange={(e) => setComplexity(e.target.value)}
            >
              <option value="">Qualsiasi</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} / 5
                </option>
              ))}
            </select>
          </label>
        </form>
        {resource.loading ? (
          <Loading label="Stiamo aprendo lo scaffale..." />
        ) : resource.error ? (
          <ResourceError error={resource.error} retry={resource.reload} />
        ) : (
          <>
            <div className="section-line">
              <h2>I giochi</h2>
              <span aria-live="polite">
                {games.length} {games.length === 1 ? "gioco" : "giochi"}
              </span>
            </div>
            {games.length ? (
              <div className="game-grid">
                {games.map((g) => (
                  <Link
                    href={`/games/${encodeURIComponent(g.id)}`}
                    className="game-card"
                    key={g.id}
                  >
                    <GameImage src={g.images[0]} title={g.title} />
                    <div className="game-card-body">
                      <div className="game-card-title">
                        <h3>{g.title}</h3>
                        <span aria-hidden="true">↗</span>
                      </div>
                      <p>
                        {g.minPlayers}–{g.maxPlayers} giocatori{" "}
                        <span aria-hidden="true">·</span> {g.duration} min
                      </p>
                      <span className="tag">Complessità {g.complexity}/5</span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty
                title={
                  query || players || duration || complexity
                    ? "Nessun gioco corrisponde alla ricerca"
                    : "Lo scaffale si sta preparando"
                }
              >
                {query || players || duration || complexity ? (
                  <>
                    <span>Prova a cambiare i filtri.</span>{" "}
                    <button
                      className="text-button"
                      onClick={() => {
                        setQuery("");
                        setPlayers("");
                        setDuration("");
                        setComplexity("");
                      }}
                    >
                      Azzera filtri
                    </button>
                  </>
                ) : (
                  "I giochi compariranno qui quando la ludoteca li aggiungerà al catalogo."
                )}
              </Empty>
            )}
          </>
        )}
      </section>
    </>
  );
}
export function GameDetail({ id }: { id: string }) {
  const resource = useResource<{ games: Game[] }>("/api/games");
  const game = resource.data?.games.find((g) => g.id === id && !g.archived);
  if (resource.loading) return <Loading label="Caricamento scheda gioco..." />;
  if (resource.error)
    return <ResourceError error={resource.error} retry={resource.reload} />;
  if (!game)
    return (
      <>
        <PageHeading title="Gioco non trovato">
          Potrebbe essere stato archiviato.
        </PageHeading>
        <Link href="/">Torna al catalogo</Link>
      </>
    );
  return (
    <>
      <Link className="back-link" href="/">
        ← Tutti i giochi
      </Link>
      <div className="game-detail">
        <div className="gallery">
          {game.images.length ? (
            game.images.map((src, i) => (
              <GameImage
                key={src}
                src={src}
                title={`${game.title}, immagine ${i + 1}`}
              />
            ))
          ) : (
            <GameImage title={game.title} />
          )}
        </div>
        <article>
          <span className="eyebrow">Dallo scaffale al tavolo</span>
          <h1>{game.title}</h1>
          <dl className="game-stats">
            <div>
              <dt>Giocatori</dt>
              <dd>
                {game.minPlayers}–{game.maxPlayers}
              </dd>
            </div>
            <div>
              <dt>Durata</dt>
              <dd>{game.duration} min</dd>
            </div>
            <div>
              <dt>Complessità</dt>
              <dd>{game.complexity}/5</dd>
            </div>
          </dl>
          <p className="description">{game.description}</p>
          <div className="actions">
            <Link className="button" href="/calendar">
              Prenota un tavolo
            </Link>
            <a
              href={game.bggUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="button secondary"
            >
              BoardGameGeek ↗<span className="sr-only"> (nuova scheda)</span>
            </a>
          </div>
          <p className="hint">
            La prenotazione riserva il tavolo, non una copia del gioco.
          </p>
        </article>
      </div>
    </>
  );
}
