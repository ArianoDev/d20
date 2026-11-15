import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { migrate, pool } from "../src/lib/db";
import { tokenHash, unseal } from "../src/lib/domain";

// DESTRUCTIVE: only use a disposable TEST_DATABASE_URL. This suite migrates it,
// truncates bookings/outbox/rate_limits/games and replaces the room settings.
// Run through scripts/test-e2e.mjs so Next and this process share a runtime key.
const base = process.env.UI_TEST_URL;
const database = process.env.TEST_DATABASE_URL;
const adminId = "00000000-0000-4000-8000-000000000001";
const accessToken = "live-test-admin-access-token";
const settings = {
  roomCapacity: 12,
  tables: [
    { id: "live-a", name: "Tavolo Live A", seats: 4 },
    { id: "live-b", name: "Tavolo Live B", seats: 4 },
  ],
  openingDays: [0, 1, 2, 3, 4, 5, 6],
  openTime: "18:00",
  closeTime: "20:00",
  slotMinutes: 120,
};
const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

describe.skipIf(!base || !database)("live browser -> Next API -> PostgreSQL (disposable database)", () => {
  let browser: Browser | undefined;
  let auth: Server | undefined;
  let migrated = false;
  let databaseOpened = false;

  beforeAll(async () => {
    if (process.env.DATABASE_URL !== database || process.env.APP_URL !== base)
      throw new Error("Use the E2E runner: DATABASE_URL must equal TEST_DATABASE_URL and APP_URL must equal UI_TEST_URL.");
    if (!process.env.EMAIL_ENCRYPTION_KEY || process.env.RESEND_API_KEY || process.env.EMAIL_FROM)
      throw new Error("Use a runtime encryption key and disable the real email provider.");
    if (process.env.SUPABASE_URL !== "http://127.0.0.1:54399" || process.env.UI_TEST_AUTH_PORT !== "54399")
      throw new Error("Live tests require the isolated loopback Auth provider on port 54399.");
    const origin = new URL(base!);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
      throw new Error("Live tests must target the isolated loopback Next server.");

    const user = { id: adminId, aud: "authenticated", role: "authenticated", email: "admin@example.com" };
    auth = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST" && request.url === "/auth/v1/token?grant_type=password") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const credentials = JSON.parse(body);
        if (credentials.email === user.email && credentials.password === "live-test-password") {
          response.end(JSON.stringify({
            access_token: accessToken, refresh_token: "live-test-refresh-token",
            token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
          }));
          return;
        }
      } else if (request.method === "GET" && request.url === "/auth/v1/user" && request.headers.authorization === `Bearer ${accessToken}`) {
        response.end(JSON.stringify(user));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "invalid_credentials", message: "Invalid test credentials" }));
    });
    await new Promise<void>((resolve, reject) => {
      auth!.once("error", reject);
      auth!.listen(54399, "127.0.0.1", resolve);
    });
    databaseOpened = true;
    await migrate();
    migrated = true;
    browser = await chromium.launch({ headless: true });
  }, 60000);

  beforeEach(async () => {
    await pool().query("TRUNCATE bookings, outbox, rate_limits, games");
    await pool().query("UPDATE settings SET data=$1 WHERE id=true", [JSON.stringify(settings)]);
  });

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (auth?.listening) await new Promise<void>((resolve, reject) => auth!.close(error => error ? reject(error) : resolve()));
      } finally {
        try {
          if (migrated) await pool().query("TRUNCATE bookings, outbox, rate_limits, games");
        } finally {
          if (databaseOpened) await pool().end();
        }
      }
    }
  });

  async function login(page: Page) {
    await page.goto(`${base}/admin`);
    await page.waitForURL(`${base}/login`);
    await page.getByLabel("Email", { exact: true }).fill("admin@example.com");
    await page.getByLabel("Password", { exact: true }).fill("live-test-password");
    const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/login");
    await page.getByRole("button", { name: "Accedi", exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect((await result.allHeaders())["set-cookie"]).toContain("HttpOnly");
    await page.waitForURL(`${base}/admin`);
  }

  async function decision(context: BrowserContext, id: string, status: "confirmed" | "rejected", expected = 200) {
    const response = await context.request.patch(`${base}/api/admin/bookings`, {
      headers: { Origin: base! }, data: { id, status },
    });
    expect(response.status()).toBe(expected);
    if (expected === 200) {
      expect((await response.json()).booking.status).toBe(status);
      expect((await pool().query("SELECT status FROM bookings WHERE id=$1", [id])).rows[0].status).toBe(status);
    }
  }

  it("renders the real admin-created catalog and protects admin writes", async () => {
    const context = await browser!.newContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const game = {
        title: "Azul Live PostgreSQL", minPlayers: 2, maxPlayers: 4, duration: 45,
        complexity: 2, description: "Mosaici salvati dal vero endpoint amministratore.",
        // No external image service needs to be available for the catalog flow.
        images: ["https://example.invalid/live-cover.png"],
        bggUrl: "https://boardgamegeek.com/boardgame/230802/azul",
      };
      const denied = await context.request.post(`${base}/api/admin/games`, { headers: { Origin: base! }, data: game });
      expect(denied.status()).toBe(401);
      expect((await pool().query("SELECT * FROM games")).rowCount).toBe(0);
      await login(page);
      const created = await context.request.post(`${base}/api/admin/games`, { headers: { Origin: base! }, data: game });
      expect(created.status()).toBe(201);
      const { game: saved } = await created.json();
      expect((await pool().query("SELECT data FROM games WHERE id=$1", [saved.id])).rows[0].data).toMatchObject(game);

      const publicContext = await browser!.newContext();
      try {
        const visitor = await publicContext.newPage();
        visitor.setDefaultTimeout(15000);
        await visitor.goto(base!);
        await visitor.getByRole("heading", { name: game.title }).waitFor();
        await visitor.getByLabel("Cerca nel catalogo").fill("nessun-risultato-live");
        await visitor.getByRole("heading", { name: "Nessun gioco corrisponde alla ricerca" }).waitFor();
        await visitor.getByRole("button", { name: "Azzera filtri" }).click();
        await visitor.getByRole("link", { name: new RegExp(game.title) }).click();
        await visitor.getByRole("heading", { name: game.title, level: 1 }).waitFor();
        expect(await visitor.getByText(game.description).count()).toBe(1);
        expect(await visitor.getByRole("link", { name: /BoardGameGeek/ }).getAttribute("href")).toBe(game.bggUrl);
      } finally { await publicContext.close(); }
    } finally { await context.close(); }
  }, 60000);

  it("books publicly, reads its encrypted email link, edits confirmed to pending, rolls back a conflicting edit and cancels", async () => {
    const visitor = await browser!.newContext();
    const admin = await browser!.newContext();
    try {
      const page = await visitor.newPage();
      const adminPage = await admin.newPage();
      page.setDefaultTimeout(15000);
      adminPage.setDefaultTimeout(15000);
      await login(adminPage);
      await page.goto(`${base}/calendar`);
      // Wait for hydration and the initial availability before changing the date.
      await page.getByRole("button", { name: /Tavolo Live A/ }).waitFor();
      const datedSlots = page.waitForResponse(r => new URL(r.url()).pathname === "/api/availability" && new URL(r.url()).searchParams.get("date") === date);
      await page.getByLabel("Data", { exact: true }).fill(date);
      expect((await datedSlots).status()).toBe(200);
      await page.getByRole("button", { name: /Tavolo Live A/ }).click();
      await page.getByLabel("Email", { exact: false }).fill("live-guest@example.com");
      await page.getByLabel("Nomi dei partecipanti").fill("Ada Live\nBruno Live");
      const creation = page.waitForResponse(r => new URL(r.url()).pathname === "/api/bookings");
      await page.getByRole("button", { name: "Richiedi prenotazione" }).click();
      const response = await creation;
      expect(response.status()).toBe(201);
      expect(await response.json()).toEqual({ ok: true });
      await page.getByRole("heading", { name: "Il tavolo è in attesa di conferma." }).waitFor();
      const original = (await pool().query("SELECT * FROM bookings")).rows[0];
      expect(original).toMatchObject({ email: "live-guest@example.com", participants: ["Ada Live", "Bruno Live"], table_id: "live-a", status: "pending" });
      const outbox = (await pool().query("SELECT * FROM outbox WHERE booking_id=$1 ORDER BY sequence_no", [original.id])).rows;
      expect(outbox).toHaveLength(1);
      expect(outbox[0].payload).not.toContain("live-guest@example.com");
      const email = JSON.parse(unseal(outbox[0].payload));
      expect(email.to).toBe("live-guest@example.com");
      expect(email.text).toContain("Ada Live, Bruno Live");
      const link = email.text.match(/http:\/\/[^\s]+\/manage#[A-Za-z0-9_-]{43}/)?.[0];
      expect(link).toBeDefined();
      const token = new URL(link!).hash.slice(1);
      expect(new URL(link!).origin).toBe(base);
      expect(original.token_hash).toBe(tokenHash(token));

      // Next's after() attempts delivery; missing provider credentials cause backoff.
      await expect.poll(async () => (await pool().query("SELECT attempts FROM outbox WHERE id=$1", [outbox[0].id])).rows[0].attempts).toBe(1);
      const retry = await admin.request.post(`${base}/api/admin/outbox`, { headers: { Origin: base! } });
      expect(retry.status()).toBe(200);
      expect(await retry.json()).toEqual({ sent: 0, failed: 0 });
      const retained = (await pool().query("SELECT * FROM outbox WHERE id=$1", [outbox[0].id])).rows[0];
      expect(retained.payload).toBe(outbox[0].payload);
      expect(retained.sent_at).toBeNull();
      expect(retained.attempts).toBe(1);
      expect(new Date(retained.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

      const availabilityResponse = await visitor.request.get(`${base}/api/availability?date=${date}`);
      expect(availabilityResponse.status()).toBe(200);
      const availability = await availabilityResponse.json();
      expect(availability.slots[0]).toMatchObject({ remainingCapacity: 10, tables: [{ id: "live-a", occupied: true, available: false }, { id: "live-b", occupied: false, available: true }] });
      for (const path of ["games", "settings", `availability?date=${date}`]) {
        const publicResponse = await visitor.request.get(`${base}/api/${path}`);
        expect(publicResponse.status()).toBe(200);
        const text = await publicResponse.text();
        for (const secret of [original.email, "Ada Live", "Bruno Live", token, original.token_hash, original.id, '"email"', '"participants"', '"token"'])
          expect(text).not.toContain(secret);
      }
      await page.goto(`${base}/calendar`);
      await page.getByRole("button", { name: /Tavolo Live A/ }).waitFor();
      const publicSlots = page.waitForResponse(r => new URL(r.url()).pathname === "/api/availability" && new URL(r.url()).searchParams.get("date") === date);
      await page.getByLabel("Data", { exact: true }).fill(date);
      expect((await publicSlots).status()).toBe(200);
      const occupied = page.getByRole("button", { name: /Tavolo Live A/ });
      await occupied.waitFor();
      expect(await occupied.isDisabled()).toBe(true);
      const publicHtml = await page.content();
      for (const secret of [original.email, "Ada Live", "Bruno Live", token]) expect(publicHtml).not.toContain(secret);
      expect((await visitor.request.get(`${base}/api/admin/bookings`)).status()).toBe(401);
      const adminList = await admin.request.get(`${base}/api/admin/bookings`);
      expect(adminList.status()).toBe(200);
      expect(adminList.headers()["cache-control"]).toContain("private, no-store");
      expect((await adminList.json()).bookings[0]).toMatchObject({ id: original.id, email: original.email, participants: original.participants });

      await decision(admin, original.id, "confirmed");
      const requests: { method: string; url: string; body: { token: string; action: string } }[] = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/manage")
          requests.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
      });
      await page.goto(link!);
      await page.getByText("Confermata", { exact: true }).waitFor();
      expect(page.url()).toBe(`${base}/manage`);
      await page.getByRole("heading", { name: "Partecipanti" }).waitFor();
      await page.getByRole("button", { name: "Modifica prenotazione", exact: true }).click();
      await page.getByRole("button", { name: /Tavolo Live A/ }).click();
      await page.getByLabel("Nomi dei partecipanti").fill("Ada Live\nCarla Live");
      await page.getByRole("button", { name: "Salva modifiche" }).click();
      await page.getByText("Modifica inviata.", { exact: false }).waitFor();
      await page.getByText("In attesa", { exact: true }).waitFor();
      const edited = (await pool().query("SELECT * FROM bookings WHERE id=$1", [original.id])).rows[0];
      expect(edited).toMatchObject({ status: "pending", participants: ["Ada Live", "Carla Live"], email: original.email, table_id: "live-a" });

      await page.getByRole("button", { name: "Modifica prenotazione", exact: true }).click();
      await page.getByRole("button", { name: /Tavolo Live B/ }).click();
      // Another client wins B after the browser selected it, before saving.
      const blocker = await visitor.request.post(`${base}/api/bookings`, {
        headers: { Origin: base! }, data: { email: "blocker@example.com", participants: ["Dora Live"], tableId: "live-b", start: edited.start_at.toISOString(), end: edited.end_at.toISOString() },
      });
      expect(blocker.status()).toBe(201);
      const beforeFailure = (await pool().query("SELECT * FROM outbox WHERE booking_id=$1 ORDER BY sequence_no", [original.id])).rows;
      const conflict = page.waitForResponse(r => new URL(r.url()).pathname === "/api/manage" && r.request().postDataJSON().action === "update");
      await page.getByLabel("Nomi dei partecipanti").fill("Must Not Persist");
      await page.getByRole("button", { name: "Salva modifiche" }).click();
      expect((await conflict).status()).toBe(409);
      await page.getByRole("alert").filter({ hasText: "Il tavolo e gia occupato" }).waitFor();
      expect((await pool().query("SELECT * FROM bookings WHERE id=$1", [original.id])).rows[0]).toEqual(edited);
      expect((await pool().query("SELECT * FROM outbox WHERE booking_id=$1 ORDER BY sequence_no", [original.id])).rows).toEqual(beforeFailure);

      const blockedBooking = (await pool().query("SELECT id FROM bookings WHERE email='blocker@example.com'")).rows[0];
      await decision(admin, blockedBooking.id, "rejected");
      await decision(admin, blockedBooking.id, "confirmed", 409);
      await page.getByRole("button", { name: "Cancella prenotazione", exact: true }).click();
      await page.getByRole("button", { name: "Conferma cancellazione" }).click();
      await page.getByText("Questa prenotazione non può più essere modificata.").waitFor();
      await page.getByText("Cancellata", { exact: true }).waitFor();
      expect((await pool().query("SELECT status FROM bookings WHERE id=$1", [original.id])).rows[0].status).toBe("cancelled");
      await decision(admin, original.id, "confirmed", 409);
      const finalAvailability = await visitor.request.get(`${base}/api/availability?date=${date}`);
      expect((await finalAvailability.json()).slots[0]).toMatchObject({ remainingCapacity: 12, tables: [{ available: true, occupied: false }, { available: true, occupied: false }] });
      expect(requests.map(r => r.body.action)).toEqual(["read", "update", "read", "update", "cancel", "read"]);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(`${base}/api/manage`);
        expect(request.body.token).toBe(token);
      }
      const notifications = (await pool().query("SELECT payload FROM outbox WHERE booking_id=$1 ORDER BY sequence_no", [original.id])).rows;
      expect(notifications.map(row => JSON.parse(unseal(row.payload)).text.split("\n")[0])).toEqual([
        "Prenotazione: pending", "Prenotazione: confirmed", "Prenotazione: pending", "Prenotazione: cancelled",
      ]);
    } finally { await Promise.all([visitor.close(), admin.close()]); }
  }, 90000);
});
