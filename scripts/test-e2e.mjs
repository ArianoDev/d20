import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// TEST_DATABASE_URL is opt-in and DESTRUCTIVE: the live suite migrates, truncates
// application tables and overwrites settings. Never point it at retained data.
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.UI_TEST_PORT || "3100");
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 54399)
  throw new Error("UI_TEST_PORT must be an integer from 1024 to 65535, excluding Auth port 54399.");
const base = `http://127.0.0.1:${port}`;
// Do not inherit production application/provider credentials or NODE_OPTIONS.
const env = {};
for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "CI", "PLAYWRIGHT_BROWSERS_PATH"])
  if (process.env[key] !== undefined) env[key] = process.env[key];
Object.assign(env, {
  NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
  APP_URL: base, UI_TEST_URL: base, UI_TEST_AUTH_PORT: "54399",
  DATABASE_URL: process.env.TEST_DATABASE_URL || "",
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || "",
  MIGRATION_DATABASE_URL: "", NODE_EXTRA_CA_CERTS: "",
  SUPABASE_URL: "http://127.0.0.1:54399", SUPABASE_ANON_KEY: "e2e-dummy-anon-key",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54399", NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-dummy-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_STORAGE_BUCKET: "e2e-unused",
  ADMIN_USER_IDS: "00000000-0000-4000-8000-000000000001",
  RESEND_API_KEY: "", EMAIL_FROM: "", EMAIL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  OUTBOX_SECRET: "", TRUST_PROXY: "false",
});

const children = new Set();
let stopping = false;
function start(script, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: "inherit", detached: true });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // The server can fail while a readiness request is pending.
  child.done.catch(() => {});
  return child;
}
function kill(child, signal) {
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function cleanup() {
  stopping = true;
  const running = [...children];
  for (const child of running) kill(child, "SIGTERM");
  const timer = setTimeout(() => {
    for (const child of running) kill(child, "SIGKILL");
  }, 5000);
  try { await Promise.allSettled(running.map(child => child.done)); }
  finally {
    clearTimeout(timer);
    // Next may leave a worker behind after its parent exits.
    for (const child of running) kill(child, "SIGKILL");
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  void cleanup();
});

async function freePort(value) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(value, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}
async function run(file) {
  if (stopping) throw new Error("E2E run interrupted.");
  const child = start("node_modules/vitest/vitest.mjs", ["run", file]);
  const result = await child.done;
  if (result.code !== 0) throw new Error(`${file} failed (${result.signal || result.code}).`);
}

try {
  await freePort(port);
  await freePort(54399);
  const server = start("node_modules/next/dist/bin/next", ["dev", "--hostname", "127.0.0.1", "--port", String(port)]);
  const deadline = Date.now() + 120000;
  for (;;) {
    if (stopping) throw new Error("E2E run interrupted.");
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("Isolated Next server exited before becoming ready.");
    try {
      // /api/health requires a database; /login works for the fixture-only run.
      const response = await fetch(`${base}/login`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      await response.arrayBuffer();
      if (response.status === 200) break;
    } catch { /* Next may still be starting or compiling. */ }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the isolated Next /login page.");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await run("tests/ui-browser.test.ts");
  if (env.TEST_DATABASE_URL) {
    console.log("Running destructive live browser tests against TEST_DATABASE_URL.");
    await run("tests/live-browser.test.ts");
  } else {
    console.log("Live PostgreSQL browser tests skipped: set a disposable TEST_DATABASE_URL to enable them.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode ||= 1;
} finally {
  await cleanup();
}
