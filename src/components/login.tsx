"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "./data";
import { Notice, PageHeading } from "./common";
export function Login() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      router.replace("/admin");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="auth-panel">
      <PageHeading title="Accesso amministratore">
        Il catalogo e le prenotazioni sono pubblici. Questo accesso è riservato
        a chi gestisce la ludoteca.
      </PageHeading>
      <form className="stack" onSubmit={submit}>
        <label>
          Email
          <input type="email" name="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </label>
        {error && <Notice error>{error}</Notice>}
        <button disabled={busy}>
          {busy ? "Accesso in corso..." : "Accedi"}
        </button>
      </form>
    </div>
  );
}
