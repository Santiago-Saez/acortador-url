#!/usr/bin/env node
// Compara modo sync vs async levantando el servidor en dos puertos.
// Simula un writer lento con CLICK_WRITE_DELAY_MS=40 para evidenciar la diferencia.
//
// Uso: node scripts/compare-modes.mjs [requests] [concurrency]
import { spawn } from "node:child_process";

const REQUESTS = process.argv[2] || "1000";
const CONCURRENCY = process.argv[3] || "50";
const DELAY = process.env.CLICK_WRITE_DELAY_MS || "40";

async function boot(port, mode) {
  const p = spawn("node", ["src/index.js"], {
    env: {
      ...process.env, PORT: String(port), CLICK_MODE: mode,
      CLICK_WRITE_DELAY_MS: DELAY, DB_PATH: `/tmp/opencode/acortador-${mode}.sqlite`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => process.stdout.write(`[${mode}] ${d}`));
  await new Promise((r) => setTimeout(r, 1200));
  return p;
}

async function createLink(port) {
  const r = await fetch(`http://localhost:${port}/links`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/demo" }),
  });
  const j = await r.json();
  return `http://localhost:${port}/${j.code}`;
}

async function load(url) {
  const p = spawn("node", ["scripts/load-test.mjs", url, REQUESTS, CONCURRENCY], { stdio: "inherit" });
  await new Promise((res) => p.on("close", res));
}

for (const mode of ["sync", "async"]) {
  const port = mode === "sync" ? 3101 : 3102;
  console.log(`\n=== modo ${mode} (CLICK_WRITE_DELAY_MS=${DELAY}) ===`);
  const srv = await boot(port, mode);
  try {
    const url = await createLink(port);
    console.log(`link: ${url}`);
    await load(url);
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log("\nEsperado: en modo sync p50 ≈ DELAY ms; en async p50 << DELAY ms.");
