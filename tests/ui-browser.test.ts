import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";

const base = process.env.UI_TEST_URL;
const game = {
  id: "test-game",
  title: "Gioco di prova",
  minPlayers: 2,
  maxPlayers: 4,
  duration: 45,
  complexity: 2,
  description: "Descrizione del gioco usata solo nei test.",
  images: [],
  bggUrl: "https://boardgamegeek.com/boardgame/1",
  archived: false,
};
const slot = {
  start: "2027-11-20T17:00:00.000Z",
  end: "2027-11-20T19:00:00.000Z",
  remainingCapacity: 4,
  tables: [
    {
      id: "t1",
      name: "Tavolo Uno",
      seats: 4,
      available: true,
      occupied: false,
    },
  ],
};
const booking = {
  id: "private",
  email: "test@example.com",
  participants: ["Ada", "Bruno"],
  tableId: "t1",
  start: slot.start,
  end: slot.end,
  status: "confirmed",
};

describe.skipIf(!base)("UI browser flows (UI_TEST_URL)", () => {
  let browser: Browser;
  let authServer: Server | undefined;
  beforeAll(async () => {
    if (process.env.UI_TEST_AUTH_PORT) {
      authServer = createServer((_, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            id: "00000000-0000-4000-8000-000000000001",
            aud: "authenticated",
            role: "authenticated",
            email: "admin@example.com",
          }),
        );
      });
      await new Promise<void>((resolve) =>
        authServer!.listen(
          Number(process.env.UI_TEST_AUTH_PORT),
          "127.0.0.1",
          resolve,
        ),
      );
    }
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) =>
      authServer ? authServer.close(() => resolve()) : resolve(),
    );
  });
  async function page() {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.route("**/api/games", (route) =>
      route.fulfill({ json: { games: [game] } }),
    );
    await page.route("**/api/availability?*", (route) =>
      route.fulfill({ json: { slots: [slot] } }),
    );
    return page;
  }
  async function accessible(page: Page) {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  it("catalog filters, detail fields, mobile and dark accessibility", async () => {
    const p = await page();
    try {
      await p.goto(base!);
      const brandText = (await p.locator("a.brand").innerText()).replace(/\s+/g, " ").trim();
      expect(await p.getByRole("link", { name: brandText, exact: true }).count()).toBe(1);
      await p.getByRole("heading", { name: game.title }).waitFor();
      await p.getByLabel("Cerca nel catalogo").fill("inesistente");
      await p
        .getByRole("heading", { name: "Nessun gioco corrisponde alla ricerca" })
        .waitFor();
      await p.getByRole("button", { name: "Azzera filtri" }).click();
      await p.getByRole("link", { name: /Gioco di prova/ }).click();
      await p.getByRole("heading", { name: game.title, level: 1 }).waitFor();
      expect(await p.getByText(game.description).count()).toBe(1);
      expect(
        await p
          .getByRole("link", { name: /BoardGameGeek/ })
          .getAttribute("href"),
      ).toBe(game.bggUrl);
      await accessible(p);
      await p.setViewportSize({ width: 390, height: 844 });
      await p.emulateMedia({ colorScheme: "dark" });
      await accessible(p);
    } finally {
      await p.close();
    }
  });
  it("catalog keeps a compact desktop header and readable layouts in both themes", async () => {
    const p = await page();
    const games = Array.from({ length: 5 }, (_, index) => ({
      ...game,
      id: `layout-${index}`,
      title: index ? `Gioco cooperativo con un titolo molto lungo ${index}` : game.title,
      images: ["https://images.example.test/layout.png"],
    }));
    await p.route("**/api/games", (route) => route.fulfill({ json: { games } }));
    await p.route("https://images.example.test/**", (route) => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
    }));
    try {
      await p.setViewportSize({ width: 1280, height: 800 });
      await p.goto(base!);
      await p.getByRole("heading", { name: game.title }).waitFor();
      for (const width of [1280, 1024, 390, 320]) {
        await p.setViewportSize({ width, height: 800 });
        if (width >= 1024) {
          expect((await p.locator(".site-header").boundingBox())!.height).toBeLessThanOrEqual(80);
          const positions = await p.getByRole("navigation").getByRole("link").evaluateAll(
            (links) => links.map((link) => link.getBoundingClientRect().top),
          );
          expect(new Set(positions).size).toBe(1);
          const headlineLines = await p.getByRole("heading", { level: 1 }).evaluate(
            (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
          );
          expect(headlineLines).toBeLessThanOrEqual(2.01);
        }
        for (const colorScheme of ["light", "dark"] as const) {
          await p.emulateMedia({ colorScheme });
          await accessible(p);
        }
      }
      expect(await p.locator(".game-card > img").first().getAttribute("loading")).toBe("eager");
    } finally { await p.context().close(); }
  }, 60000);
  it("game detail keeps booking before long descriptions and prioritizes the cover", async () => {
    const p = await page();
    await p.route("**/api/games", (route) => route.fulfill({ json: { games: [{
      ...game,
      images: ["https://images.example.test/cover.png"],
      description: Array(20).fill(game.description).join("\n\n"),
    }] } }));
    await p.route("https://images.example.test/**", (route) => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
    }));
    try {
      await p.setViewportSize({ width: 1280, height: 800 });
      await p.goto(`${base}/games/${game.id}`);
      await p.getByRole("heading", { name: game.title, level: 1 }).waitFor();
      const action = p.locator(".game-detail").getByRole("link", { name: "Prenota un tavolo", exact: true });
      const actionBox = (await action.boundingBox())!;
      const descriptionBox = (await p.locator(".description").boundingBox())!;
      expect(actionBox.y + actionBox.height).toBeLessThan(descriptionBox.y);
      expect(actionBox.y + actionBox.height).toBeLessThan(800);
      const cover = p.getByRole("region", { name: "Immagini del gioco" }).getByRole("img");
      expect(await cover.getAttribute("loading")).toBe("eager");
      expect(await cover.getAttribute("fetchpriority")).toBe("high");
      await p.getByRole("heading", { name: "Il gioco", level: 2 }).waitFor();
      await accessible(p);
      await p.setViewportSize({ width: 320, height: 800 });
      await p.emulateMedia({ colorScheme: "dark" });
      await accessible(p);
    } finally { await p.context().close(); }
  });
  it("carousel controls remain reachable on a short desktop viewport", async () => {
    const p = await page();
    await p.route("**/api/games", (route) => route.fulfill({ json: { games: [{
      ...game,
      images: ["https://images.example.test/one.png", "https://images.example.test/two.png"],
      description: Array(20).fill(game.description).join("\n\n"),
    }] } }));
    await p.route("https://images.example.test/**", (route) => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
    }));
    try {
      await p.setViewportSize({ width: 1280, height: 500 });
      await p.goto(`${base}/games/${game.id}`);
      const gallery = p.getByRole("region", { name: "Immagini del gioco" });
      await gallery.getByRole("button", { name: "Immagine successiva" }).waitFor();
      await p.evaluate(() => window.scrollTo(0, 400));
      await p.waitForFunction(() => window.scrollY >= 400);
      for (const button of await gallery.getByRole("button").all()) {
        const box = (await button.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(500);
      }
      await gallery.getByRole("button", { name: "Immagine successiva" }).click();
      expect(await gallery.getByRole("status").textContent()).toBe("Immagine 2 di 2");
    } finally { await p.context().close(); }
  });
  it("catalog game-card photos stay white in light and dark mode", async () => {
    const p = await page();
    await p.route("**/api/games", (route) => route.fulfill({ json: { games: [
      { ...game, images: ["https://images.example.test/cover.png"] },
      { ...game, id: "without-cover", title: "Gioco senza copertina" },
    ] } }));
    await p.route("https://images.example.test/**", (route) => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
    }));
    try {
      await p.goto(base!);
      await p.getByRole("heading", { name: game.title }).waitFor();
      expect(await p.locator(".game-card > img").count()).toBe(1);
      const covers = p.locator(".game-card > img, .game-card > .image-fallback");
      for (const colorScheme of ["light", "dark"] as const) {
        await p.emulateMedia({ colorScheme });
        expect(await covers.evaluateAll((elements) => elements.map((el) => getComputedStyle(el).backgroundColor)))
          .toEqual(["rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
        await accessible(p);
      }
    } finally { await p.context().close(); }
  });
  it("game gallery shows one image with white background and accessible carousel navigation", async () => {
    const p = await page();
    const images = [1, 2, 3].map((n) => `https://images.example.test/game-${n}.png`);
    await p.route("**/api/games", (route) => route.fulfill({ json: { games: [{ ...game, images }] } }));
    await p.route("https://images.example.test/**", (route) => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
    }));
    try {
      await p.goto(`${base}/games/${game.id}`);
      await p.getByRole("heading", { name: game.title, level: 1 }).waitFor();
      const gallery = p.getByRole("region", { name: "Immagini del gioco" });
      expect(await gallery.count()).toBe(1);
      const image = gallery.getByRole("img");
      await image.waitFor();
      expect(await image.count()).toBe(1);
      expect(await image.getAttribute("src")).toBe(images[0]);
      expect(await gallery.getByRole("status").textContent()).toBe("Immagine 1 di 3");
      expect(await gallery.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
      await gallery.getByRole("button", { name: "Immagine successiva" }).click();
      expect(await image.getAttribute("src")).toBe(images[1]);
      expect(await gallery.getByRole("status").textContent()).toBe("Immagine 2 di 3");
      await p.keyboard.press("ArrowLeft");
      expect(await image.getAttribute("src")).toBe(images[0]);
      await gallery.getByRole("button", { name: "Immagine precedente" }).click();
      expect(await image.getAttribute("src")).toBe(images[2]);
      expect(await image.count()).toBe(1);
      await accessible(p);
      await p.setViewportSize({ width: 390, height: 844 });
      await p.emulateMedia({ colorScheme: "dark" });
      expect(await gallery.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
      expect(await image.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
      await accessible(p);
    } finally { await p.context().close(); }
  });
  it("game gallery hides carousel controls for a single image and handles missing or broken images", async () => {
    const p = await page();
    let images = ["https://images.example.test/broken.png"];
    await p.route("**/api/games", (route) => route.fulfill({ json: { games: [{ ...game, images }] } }));
    await p.route("https://images.example.test/**", (route) => route.fulfill({ status: 404 }));
    try {
      await p.goto(`${base}/games/${game.id}`);
      const gallery = p.getByRole("region", { name: "Immagini del gioco" });
      await gallery.getByRole("img", { name: /Immagine non disponibile/ }).waitFor();
      expect(await gallery.getByRole("button").count()).toBe(0);
      expect(await gallery.getByRole("status").count()).toBe(0);
      await p.emulateMedia({ colorScheme: "dark" });
      await accessible(p);
      images = [];
      await p.reload();
      await gallery.getByRole("img", { name: /Immagine non disponibile/ }).waitFor();
      expect(await gallery.getByRole("button").count()).toBe(0);
    } finally { await p.context().close(); }
  });
  it("books with email and names and displays pending success", async () => {
    const p = await page();
    const bodies: unknown[] = [];
    await p.route("**/api/bookings", async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    try {
      await p.goto(`${base}/calendar`);
      await p.getByRole("button", { name: /Tavolo Uno/ }).click();
      await p.getByLabel("Email", { exact: false }).fill("test@example.com");
      await p.getByLabel("Nomi dei partecipanti").fill("Ada\nBruno");
      await accessible(p);
      await p.getByRole("button", { name: "Richiedi prenotazione" }).click();
      await p
        .getByRole("heading", { name: "Il tavolo è in attesa di conferma." })
        .waitFor();
      expect(bodies).toEqual([
        {
          tableId: "t1",
          start: slot.start,
          end: slot.end,
          participants: ["Ada", "Bruno"],
          email: "test@example.com",
          website: "",
        },
      ]);
    } finally {
      await p.close();
    }
  });
  it("uses only POST bodies for a private token, supports editing own occupied table and cancellation", async () => {
    const p = await page();
    let current = { ...booking };
    const actions: string[] = [];
    await p.route("**/api/availability?*", (route) =>
      route.fulfill({
        json: {
          slots: [
            {
              ...slot,
              remainingCapacity: 0,
              tables: [{ ...slot.tables[0], available: false, occupied: true }],
            },
          ],
        },
      }),
    );
    await p.route("**/api/manage", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().url()).not.toContain("test-secret");
      const body = route.request().postDataJSON();
      expect(body.token).toBe("test-secret");
      actions.push(body.action);
      if (body.action === "update")
        current = { ...current, ...body.booking, status: "pending" };
      if (body.action === "cancel")
        current = { ...current, status: "cancelled" };
      await route.fulfill({ json: { booking: current } });
    });
    try {
      await p.goto(`${base}/manage#test-secret`);
      await p.getByRole("heading", { name: "Partecipanti" }).waitFor();
      expect(p.url()).toBe(`${base}/manage`);
      await p.getByRole("button", { name: "Modifica prenotazione" }).click();
      await p.getByRole("button", { name: /Tavolo Uno/ }).click();
      await p.getByLabel("Nomi dei partecipanti").fill("Ada");
      await p.getByRole("button", { name: "Salva modifiche" }).click();
      await p.getByText("Modifica inviata.", { exact: false }).waitFor();
      await p
        .getByRole("button", { name: "Cancella prenotazione", exact: true })
        .click();
      await p.getByRole("button", { name: "Conferma cancellazione" }).click();
      await p
        .getByText("Questa prenotazione non può più essere modificata.")
        .waitFor();
      expect(actions).toEqual(["read", "update", "read", "cancel", "read"]);
      await accessible(p);
    } finally {
      await p.close();
    }
  });
  it("allows transferring a full-room booking to empty B but never occupied C", async () => {
    const p = await page();
    let current = { ...booking };
    const updates: unknown[] = [];
    await p.route("**/api/availability?*", (route) =>
      route.fulfill({
        json: {
          slots: [
            {
              ...slot,
              remainingCapacity: 0,
              tables: [
                {
                  id: "t1",
                  name: "Tavolo A",
                  seats: 2,
                  available: false,
                  occupied: true,
                },
                {
                  id: "t2",
                  name: "Tavolo B",
                  seats: 2,
                  available: false,
                  occupied: false,
                },
                {
                  id: "t3",
                  name: "Tavolo C",
                  seats: 2,
                  available: false,
                  occupied: true,
                },
              ],
            },
          ],
        },
      }),
    );
    await p.route("**/api/manage", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "update") {
        updates.push(body.booking);
        current = { ...current, ...body.booking, status: "pending" };
      }
      await route.fulfill({ json: { booking: current } });
    });
    try {
      await p.goto(`${base}/calendar`);
      await p.getByRole("button", { name: /Tavolo B/ }).waitFor();
      expect(
        await p.getByRole("button", { name: /Tavolo B/ }).isDisabled(),
      ).toBe(true);
      await p.goto(`${base}/manage#transfer-secret`);
      await p.getByRole("button", { name: "Modifica prenotazione" }).click();
      const own = p.getByRole("button", { name: /Tavolo A/ });
      const empty = p.getByRole("button", { name: /Tavolo B/ });
      const occupied = p.getByRole("button", { name: /Tavolo C/ });
      await empty.waitFor();
      expect(await own.isDisabled()).toBe(false);
      expect(await occupied.isDisabled()).toBe(true);
      expect(await empty.isDisabled()).toBe(false);
      await empty.click();
      expect(await empty.getAttribute("aria-pressed")).toBe("true");
      expect(await occupied.isDisabled()).toBe(true);
      await p.getByRole("button", { name: "Salva modifiche" }).click();
      await p.getByText("Modifica inviata.", { exact: false }).waitFor();
      expect(updates).toEqual([
        {
          tableId: "t2",
          start: slot.start,
          end: slot.end,
          participants: booking.participants,
        },
      ]);
    } finally {
      await p.context().close();
    }
  });
  it("shows API errors, missing private links and enforces the actual admin server guard", async () => {
    const p = await page();
    await p.route("**/api/games", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Database non configurato." },
      }),
    );
    try {
      await p.goto(base!);
      await p
        .getByRole("alert")
        .getByText("Database non configurato.")
        .waitFor();
      await p.goto(`${base}/manage`);
      await p
        .getByRole("alert")
        .filter({ hasText: "Apri il link personale" })
        .waitFor();
      await p.goto(`${base}/admin`);
      await p.waitForURL(`${base}/login`);
      expect(
        await p
          .getByRole("heading", { name: "Accesso amministratore" })
          .count(),
      ).toBe(1);
      await p.setViewportSize({ width: 390, height: 844 });
      await accessible(p);
      await p.route("**/api/auth/login", (route) =>
        route.fulfill({
          status: 401,
          json: { error: "Credenziali non valide." },
        }),
      );
      await p.getByLabel("Email", { exact: true }).fill("admin@example.com");
      await p
        .getByLabel("Password", { exact: true })
        .fill("incorrect-test-password");
      await p.getByRole("button", { name: "Accedi", exact: true }).click();
      await p.getByText("Credenziali non valide.", { exact: true }).waitFor();
    } finally {
      await p.close();
    }
  });
  it.skipIf(!process.env.UI_TEST_AUTH_PORT)(
    "admin manages games, uploads images, settings and booking decisions behind the server guard",
    async () => {
      const p = await page();
      const settings = {
        roomCapacity: 12,
        tables: [{ id: "t1", name: "Tavolo Uno", seats: 4 }],
        openingDays: [2, 3, 4, 5, 6, 0],
        openTime: "18:00",
        closeTime: "24:00",
        slotMinutes: 120,
      };
      let games = [{ ...game, images: ["https://example.com/cover.png"] }];
      let currentBooking = { ...booking, status: "pending" };
      const writes: { url: string; body: Record<string, unknown> }[] = [];
      await p.route("**/api/auth/login", (route) =>
        route.fulfill({
          json: { ok: true },
          headers: {
            "Set-Cookie":
              "ludoteca_admin=test-admin-session; HttpOnly; SameSite=Strict; Path=/",
          },
        }),
      );
      await p.route("**/api/auth/logout", (route) =>
        route.fulfill({
          json: { ok: true },
          headers: {
            "Set-Cookie":
              "ludoteca_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          },
        }),
      );
      await p.route("**/api/settings", (route) =>
        route.fulfill({ json: settings }),
      );
      await p.route("**/api/admin/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === "GET") {
          await route.fulfill({
            json: path.endsWith("/games")
              ? { games }
              : { bookings: [currentBooking] },
          });
          return;
        }
        if (path.endsWith("/uploads")) {
          await route.fulfill({
            json: { url: "https://example.com/uploaded.png" },
          });
          return;
        }
        const body =
          request.method() === "DELETE" ? {} : request.postDataJSON();
        writes.push({ url: path, body });
        if (path.endsWith("/bookings"))
          currentBooking = { ...currentBooking, status: body.status };
        if (path === "/api/admin/games")
          games = [...games, { ...body, id: "new-game" }];
        if (path === "/api/admin/games/test-game" && request.method() === "PUT")
          games[0] = { ...body, id: "test-game" };
        if (request.method() === "DELETE")
          games = games.map((g) =>
            g.id === "new-game" ? { ...g, archived: true } : g,
          );
        await route.fulfill({ json: { ok: true } });
      });
      try {
        await p.goto(`${base}/login`);
        await p.getByLabel("Email", { exact: true }).fill("admin@example.com");
        await p
          .getByLabel("Password", { exact: true })
          .fill("valid-test-password");
        await p.getByRole("button", { name: "Accedi", exact: true }).click();
        await p.getByRole("button", { name: "Conferma", exact: true }).click();
        await p
          .getByText("Prenotazione confermata.", { exact: false })
          .waitFor();
        await p.getByRole("combobox").selectOption("confirmed");
        await p.getByRole("button", { name: "Rifiuta", exact: true }).click();
        await p.getByRole("button", { name: "Sì, rifiuta" }).click();
        await p
          .getByText("Prenotazione rifiutata.", { exact: false })
          .waitFor();
        await p
          .getByRole("button", { name: "Catalogo giochi", exact: true })
          .click();
        await p.getByRole("button", { name: "Modifica", exact: true }).click();
        await p.getByLabel("Titolo", { exact: true }).fill("Gioco aggiornato");
        await p
          .getByRole("button", { name: "Salva gioco", exact: true })
          .click();
        await p.getByRole("heading", { name: "Gioco aggiornato" }).waitFor();
        await p
          .getByRole("button", { name: "Aggiungi gioco", exact: true })
          .click();
        await p.getByLabel("Titolo", { exact: true }).fill("Gioco nuovo");
        await p
          .getByLabel("Descrizione", { exact: true })
          .fill("Descrizione solo per test");
        await p
          .getByLabel("Link BoardGameGeek", { exact: false })
          .fill(game.bggUrl);
        await p.getByLabel("Carica immagine").setInputFiles({
          name: "test.png",
          mimeType: "image/png",
          buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        });
        await p.getByRole("button", { name: "Rimuovi 1" }).waitFor();
        await accessible(p);
        await p
          .getByRole("button", { name: "Salva gioco", exact: true })
          .click();
        const row = p
          .getByRole("article")
          .filter({ has: p.getByRole("heading", { name: "Gioco nuovo" }) });
        await row
          .getByRole("button", { name: "Archivia", exact: true })
          .click();
        await p.getByRole("button", { name: "Conferma archiviazione" }).click();
        await p.getByText("Gioco archiviato:", { exact: false }).waitFor();
        await p.getByRole("button", { name: "Sala e orari" }).click();
        await p
          .getByLabel("Capienza complessiva della sala", { exact: false })
          .fill("16");
        await p.getByRole("button", { name: "Aggiungi tavolo" }).click();
        await p
          .getByRole("combobox", { name: "Posti", exact: true })
          .last()
          .selectOption("6");
        await p.setViewportSize({ width: 390, height: 844 });
        await p.emulateMedia({ colorScheme: "dark" });
        await accessible(p);
        await p.getByRole("button", { name: "Salva impostazioni" }).click();
        await p.getByText("Impostazioni salvate.", { exact: false }).waitFor();
        expect(writes.map((w) => w.url)).toEqual([
          "/api/admin/bookings",
          "/api/admin/bookings",
          "/api/admin/games/test-game",
          "/api/admin/games",
          "/api/admin/games/new-game",
          "/api/admin/settings",
        ]);
        expect(writes.at(-1)?.body.roomCapacity).toBe(16);
        expect(writes[3].body.images).toEqual([
          "https://example.com/uploaded.png",
        ]);
        await p.getByRole("button", { name: "Esci", exact: true }).click();
        await p.waitForURL(`${base}/login`);
      } finally {
        await p.context().close();
      }
    },
  );
});
