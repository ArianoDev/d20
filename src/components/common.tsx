"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./data";

export function Navigation() {
  const path = usePathname();
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link href="/" className="brand">
          <span className="brand-mark">d20</span>
          <span>
            GRS Playroom
            <span className="brand-sub">Giochi da Tavolo e Giochi di Ruolo</span>
          </span>
        </Link>
        <nav aria-label="Navigazione principale">
          <Link
            href="/"
            aria-current={
              path === "/" || path.startsWith("/games") ? "page" : undefined
            }
          >
            Catalogo
          </Link>
          <Link
            href="/calendar"
            aria-current={path === "/calendar" ? "page" : undefined}
          >
            Prenota un tavolo
          </Link>
          <Link
            href="/admin"
            aria-current={path.startsWith("/admin") ? "page" : undefined}
          >
            Area admin
          </Link>
        </nav>
      </div>
    </header>
  );
}
export function Notice({
  error,
  children,
}: {
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Loading({
  label = "Caricamento in corso...",
}: {
  label?: string;
}) {
  return (
    <div role="status" className="loading">
      <span>{label}</span>
      <div className="skeleton" />
      <div className="skeleton short" />
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark" aria-hidden="true">
        d20
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function PageHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}
export function useResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<T>(url)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [url, version]);
  return { data, error, loading, reload: () => setVersion((v) => v + 1) };
}
export function ResourceError({
  error,
  retry,
}: {
  error: string;
  retry: () => void;
}) {
  return (
    <Notice error>
      <p>{error}</p>
      <button className="secondary" onClick={retry}>
        Riprova
      </button>
    </Notice>
  );
}
export function GameImage({
  src,
  title,
  className = "",
  priority = false,
}: {
  src?: string;
  title: string;
  className?: string;
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <div
        className={`image-fallback ${className}`}
        role="img"
        aria-label={`Immagine non disponibile per ${title}`}
      >
        <span>d20</span>
        <small>Immagine non disponibile</small>
      </div>
    );
  // Remote catalog images are validated by the API; native images do not require host configuration.
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      className={className}
      src={src}
      alt={title}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      onError={() => setFailed(true)}
    />
  );
}
