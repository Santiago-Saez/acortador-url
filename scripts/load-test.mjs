#!/usr/bin/env node
// Prueba de carga sencilla: mide latencia de redirección con concurrencia.
// Uso:
//   node scripts/load-test.mjs [baseUrl] [requests] [concurrency]
// Ejemplo:
//   npm start & sleep 1; node scripts/load-test.mjs http://localhost:3000/ABC1234 2000 50

const baseUrl = process.argv[2] || process.env.LOAD_URL;
if (!baseUrl) {
  console.error("Uso: node scripts/load-test.mjs <url-corta> [requests] [concurrency]");
  process.exit(1);
}
const REQUESTS = Number(process.argv[3] || 1000);
const CONCURRENCY = Number(process.argv[4] || 50);

const latencies = [];
let ok = 0, fail = 0;
const started = performance.now();
let next = 0;

async function worker() {
  while (true) {
    const i = next++;
    if (i >= REQUESTS) return;
    const t0 = performance.now();
    try {
      const r = await fetch(baseUrl, { redirect: "manual" });
      await r.arrayBuffer().catch(() => {});
      if ([301, 302, 303, 307, 308].includes(r.status)) ok++;
      else fail++;
    } catch {
      fail++;
    }
    latencies.push(performance.now() - t0);
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, worker));
const total = performance.now() - started;
latencies.sort((a, b) => a - b);
const q = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];

console.log(`requests=${REQUESTS} concurrency=${CONCURRENCY} ok=${ok} fail=${fail}`);
console.log(`rps=${(REQUESTS / (total / 1000)).toFixed(1)} total=${total.toFixed(0)}ms`);
console.log(`p50=${q(0.5).toFixed(2)}ms p95=${q(0.95).toFixed(2)}ms p99=${q(0.99).toFixed(2)}ms max=${q(1).toFixed(2)}ms`);
