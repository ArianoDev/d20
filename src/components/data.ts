export type Game = {
  id: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  duration: number;
  complexity: number;
  description: string;
  images: string[];
  bggUrl: string;
  archived: boolean;
};
export type Table = { id: string; name: string; seats: number };
export type Settings = {
  roomCapacity: number;
  tables: Table[];
  openingDays: number[];
  openTime: string;
  closeTime: string;
  slotMinutes: number;
};
export type Slot = {
  start: string;
  end: string;
  tables: (Table & { available: boolean; occupied: boolean })[];
  remainingCapacity: number;
};
export type Booking = {
  id: string;
  email: string;
  participants: string[];
  tableId: string;
  start: string;
  end: string;
  status: "pending" | "confirmed" | "rejected" | "cancelled";
};
export const statusLabels = {
  pending: "In attesa",
  confirmed: "Confermata",
  rejected: "Rifiutata",
  cancelled: "Cancellata",
};
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      cache: "no-store",
      headers: {
        ...(options?.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options?.headers,
      },
    });
  } catch {
    throw new Error("Connessione non riuscita. Controlla la rete e riprova.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      data?.error ||
        (response.status === 401
          ? "Sessione scaduta. Accedi di nuovo."
          : "Servizio non disponibile. Riprova tra poco o contatta la ludoteca."),
    );
  return data as T;
}
export function filterGames(
  games: Game[],
  query: string,
  players: string,
  duration: string,
  complexity: string,
) {
  return games.filter(
    (g) =>
      !g.archived &&
      g.title
        .toLocaleLowerCase("it")
        .includes(query.trim().toLocaleLowerCase("it")) &&
      (!players || (g.minPlayers <= +players && g.maxPlayers >= +players)) &&
      (!duration || g.duration <= +duration) &&
      (!complexity || g.complexity <= +complexity),
  );
}
export function captureToken(
  location: { hash: string; pathname: string },
  history: {
    replaceState: (
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) => void;
  },
) {
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  return token;
}
export function participantsFromText(value: string) {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
export function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function time(value: string) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
export function dateLabel(value: string) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}
