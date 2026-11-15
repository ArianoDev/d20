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
    <div className="catalog-page">
      <section className="catalog-intro">
        <div>
          <h1>La prossima partita comincia qui.</h1>
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
                {games.map((g, index) => (
                  <Link
                    href={`/games/${encodeURIComponent(g.id)}`}
                    className="game-card"
                    key={g.id}
                  >
                    <GameImage src={g.images[0]} title={g.title} priority={index === 0} />
                    <div className="game-card-body">
                      <div className="game-card-title">
                        <h3>{g.title}</h3>
                        <span aria-hidden="true">↗</span>
                      </div>
                      <div className="game-card-meta">
                        <span>{g.minPlayers}-{g.maxPlayers} giocatori</span>
                        <span>{g.duration} min</span>
                      </div>
                      <span className="game-card-complexity">Complessità {g.complexity}/5</span>
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
    </div>
  );
}
function GameGallery({ game }: { game: Game }) {
  const [index, setIndex] = useState(0);
  const multiple = game.images.length > 1;
  function move(step: number) {
    setIndex((current) => (current + step + game.images.length) % game.images.length);
  }
  return (
    <section
      className="gallery"
      aria-label="Immagini del gioco"
      aria-roledescription={multiple ? "carosello" : undefined}
      onKeyDown={(event) => {
        if (multiple && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          move(event.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <GameImage
        key={index}
        priority
        src={game.images[index]}
        title={game.images.length ? `${game.title}, immagine ${index + 1}` : game.title}
      />
      {multiple && (
        <div className="gallery-controls">
          <button type="button" aria-label="Immagine precedente" onClick={() => move(-1)}>
            Precedente
          </button>
          <output aria-live="polite" aria-atomic="true">
            <span className="sr-only">Immagine </span>{index + 1} di {game.images.length}
          </output>
          <button type="button" aria-label="Immagine successiva" onClick={() => move(1)}>
            Successiva
          </button>
        </div>
      )}
    </section>
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
        <GameGallery key={game.id} game={game} />
        <article className="game-summary">
          <h1>{game.title}</h1>
          <dl className="game-stats">
            <div>
              <dt>Giocatori</dt>
              <dd>
                {game.minPlayers}-{game.maxPlayers}
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
          <section className="game-description" aria-labelledby="description-title">
            <h2 id="description-title">Il gioco</h2>
            <p className="description">{game.description}</p>
          </section>
        </article>
      </div>
    </>
  );
}
