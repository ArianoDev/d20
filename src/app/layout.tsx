import type { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/common";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "d20 | Ludoteca", template: "%s | d20 Ludoteca" },
  description:
    "Sfoglia i giochi della ludoteca e prenota un tavolo per la tua prossima partita.",
  referrer: "no-referrer",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <body>
        <a className="skip-link" href="#main">
          Vai al contenuto
        </a>
        <Navigation />
        <main id="main" className="container">
          {children}
        </main>
        <footer className="site-footer">
          <div>
            <strong>D20 Playroom</strong>
            <span>Esperienze da condividere, un gioco alla volta.</span>
          </div>
          <div>
            <span>Orari in fuso Europe/Rome</span>
            <Link href="/manage">Gestisci una prenotazione</Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
