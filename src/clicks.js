import { insertClicksBatch } from "./db.js";

const CLICK_MODE = process.env.CLICK_MODE === "sync" ? "sync" : "async";
const WRITE_DELAY_MS = Number(process.env.CLICK_WRITE_DELAY_MS || 0);
const FLUSH_INTERVAL_MS = Number(process.env.CLICK_FLUSH_MS || 200);
const MAX_BATCH = Number(process.env.CLICK_MAX_BATCH || 500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const queue = [];
let flushing = false;
let dropped = 0;

async function flushLoop() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, MAX_BATCH);
      try {
        if (WRITE_DELAY_MS > 0) await sleep(WRITE_DELAY_MS); // simula un writer lento
        insertClicksBatch(batch);
      } catch (err) {
        dropped += batch.length;
        console.error("[clicks] error al persistir lote:", err.message);
      }
    }
  } finally {
    flushing = false;
  }
}

if (CLICK_MODE === "async") {
  const t = setInterval(() => {
    if (queue.length > 0) void flushLoop();
  }, FLUSH_INTERVAL_MS);
  t.unref();
}

function buildEvent(code, req) {
  const now = Date.now();
  return {
    code,
    ts: now,
    day: new Date(now).toISOString().slice(0, 10), // YYYY-MM-DD en UTC
    country: normalizeCountry(req),
    referrer: normalizeReferrer(req),
  };
}

/**
 * País: en producción se resolvería con GeoIP (p. ej. MaxMind) a partir de la IP.
 * Para no arrastrar una base de datos binaria, se acepta la cabecera
 * `CF-IPCountry` / `X-Country` (útil para tests y CDNs) y sino "unknown".
 */
export function normalizeCountry(req) {
  const h =
    req.get("cf-ipcountry") || req.get("x-country") || req.get("x-vercel-ip-country");
  if (h && /^[A-Za-z]{2}$/.test(h.trim())) return h.trim().toUpperCase();
  return "unknown";
}

/** Referente: se guarda el host para agregar; "direct" si no hay cabecera. */
export function normalizeReferrer(req) {
  const raw = req.get("referer") || req.get("referrer") || "";
  if (!raw) return "direct";
  try {
    return new URL(raw).hostname.slice(0, 120) || "direct";
  } catch {
    return String(raw).slice(0, 120) || "direct";
  }
}

/**
 * Punto clave del diseño:
 * - modo "async" (default): solo push a memoria, 0 awaits en el request.
 *   La redirección responde antes de tocar el disco.
 * - modo "sync": inserta en SQLite ANTES de redirigir (para la comparativa
 *   de la prueba de carga).
 */
export async function logClick(code, req) {
  const event = buildEvent(code, req);
  if (CLICK_MODE === "sync") {
    if (WRITE_DELAY_MS > 0) await sleep(WRITE_DELAY_MS);
    insertClicksBatch([event]); // bloquea la redirección a propósito
    return { mode: "sync" };
  }
  queue.push(event); // <— la redirección NO espera esto
  if (queue.length >= MAX_BATCH) void flushLoop();
  return { mode: "async", queued: queue.length };
}

export function clickQueueStats() {
  return { mode: CLICK_MODE, pending: queue.length, dropped };
}

export async function flushClicks() {
  await flushLoop();
}
