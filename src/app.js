import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { CODE_RE, generateUniqueCode, hashPassword, verifyPassword } from "./codes.js";
import { logClick, clickQueueStats, flushClicks, normalizeCountry } from "./clicks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function createApp() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));
  app.use(express.static(PUBLIC_DIR));

  const redirectStatus = Number(process.env.REDIRECT_STATUS || 302);
  const REDIRECT = redirectStatus === 301 ? 301 : 302; // solo 301 o 302

  const baseUrl = () =>
    (process.env.BASE_URL || "").replace(/\/$/, "") || null;

  const shortUrlFor = (req, code) =>
    `${baseUrl() || `${req.protocol}://${req.get("host")}`}/${code}`;

  // ---------- POST /links ----------
  app.post("/links", (req, res) => {
    const { url, expiresAt, expiresInSeconds, password } = req.body ?? {};

    if (typeof url !== "string" || url.trim() === "") {
      return res.status(400).json({ error: "url es requerida" });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "url no válida" });
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "solo se permiten URLs http(s)" });
    }

    let expires_at = null;
    if (expiresAt != null) {
      const t = Date.parse(expiresAt);
      if (Number.isNaN(t)) return res.status(400).json({ error: "expiresAt no válido (ISO 8601)" });
      expires_at = t;
    } else if (expiresInSeconds != null) {
      const s = Number(expiresInSeconds);
      if (!Number.isFinite(s) || s <= 0) {
        return res.status(400).json({ error: "expiresInSeconds debe ser > 0" });
      }
      expires_at = Date.now() + Math.floor(s * 1000);
    }

    let password_hash = null;
    if (password != null && password !== "") {
      if (typeof password !== "string" || password.length < 4) {
        return res.status(400).json({ error: "password mínimo 4 caracteres" });
      }
      password_hash = hashPassword(password);
    }

    const exists = (code) => db.prepare("SELECT 1 FROM links WHERE code = ?").get(code);
    const code = generateUniqueCode(exists);
    const now = Date.now();

    db.prepare(
      "INSERT INTO links (code, url, created_at, expires_at, password_hash) VALUES (?, ?, ?, ?, ?)"
    ).run(code, parsed.toString(), now, expires_at, password_hash);

    res.status(201).json({
      code,
      shortUrl: shortUrlFor(req, code),
      url: parsed.toString(),
      expiresAt: expires_at ? new Date(expires_at).toISOString() : null,
      hasPassword: password_hash !== null,
    });
  });

  // ---------- Info + stats (antes de /:code para no colisionar) ----------
  app.get("/api/links/:code", (req, res) => {
    const { code } = req.params;
    if (!CODE_RE.test(code)) return res.status(400).json({ error: "código no válido" });
    const link = db.prepare("SELECT * FROM links WHERE code = ?").get(code);
    if (!link) return res.status(404).json({ error: "no encontrado" });
    const total = db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE code = ?").get(code).n;
    res.json({
      code: link.code,
      url: link.url,
      createdAt: new Date(link.created_at).toISOString(),
      expiresAt: link.expires_at ? new Date(link.expires_at).toISOString() : null,
      hasPassword: link.password_hash !== null,
      clicks: total,
    });
  });

  app.get("/api/links/:code/stats", (req, res) => {
    const { code } = req.params;
    if (!CODE_RE.test(code)) return res.status(400).json({ error: "código no válido" });
    const link = db.prepare("SELECT code FROM links WHERE code = ?").get(code);
    if (!link) return res.status(404).json({ error: "no encontrado" });

    const total = db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE code = ?").get(code).n;
    const byDay = db
      .prepare("SELECT day, COUNT(*) AS count FROM clicks WHERE code = ? GROUP BY day ORDER BY day")
      .all(code);
    const byCountry = db
      .prepare(
        "SELECT country, COUNT(*) AS count FROM clicks WHERE code = ? GROUP BY country ORDER BY count DESC"
      )
      .all(code);
    const byReferrer = db
      .prepare(
        "SELECT referrer, COUNT(*) AS count FROM clicks WHERE code = ? GROUP BY referrer ORDER BY count DESC"
      )
      .all(code);

    res.json({ code, total, byDay, byCountry, byReferrer });
  });

  app.get("/api/_health", (_req, res) => {
    res.json({ ok: true, redirect: REDIRECT, clicks: clickQueueStats() });
  });

  // ---------- GET /:code → redirección ----------
  app.get("/:code", async (req, res) => {
    const { code } = req.params;
    if (!CODE_RE.test(code)) return res.status(404).send("Not found");

    const link = db.prepare("SELECT * FROM links WHERE code = ?").get(code);
    if (!link) return res.status(404).send("Not found");

    if (link.expires_at && Date.now() > link.expires_at) {
      return res.status(410).send("Link expirado");
    }

    if (link.password_hash) {
      const given = req.query.password ?? req.query.p ?? req.get("x-link-password") ?? "";
      if (!given || !verifyPassword(String(given), link.password_hash)) {
        if (req.accepts("html")) {
          return res.status(401).send(passwordForm(code));
        }
        return res.status(401).json({ error: "password requerido", hint: "reintenta con ?password=..." });
      }
    }

    // El registro NO bloquea la respuesta en modo async (ver src/clicks.js):
    // allí solo se hace queue.push (sin I/O), así que el await no espera nada.
    // En modo sync sí espera al INSERT: solo existe para la comparativa.
    try {
      await logClick(link.code, req);
    } catch (e) {
      console.error("[clicks]", e.message);
    }

    return res.redirect(REDIRECT, link.url);
  });

  return app;
}

function passwordForm(code) {
  return `<!doctype html><meta charset="utf-8"><title>Password requerido</title>
<body style="font-family:system-ui;max-width:480px;margin:4rem auto">
<h1>Enlace protegido</h1>
<form method="get" action="/${code}">
<input type="password" name="password" placeholder="Contraseña" required
 style="padding:.5rem;width:100%;box-sizing:border-box">
<button style="margin-top:.5rem;padding:.5rem 1rem">Abrir</button>
</form></body>`;
}

// País expuesto para tests (cabecera X-Country), documentado en README.
export { normalizeCountry, flushClicks };
