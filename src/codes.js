import crypto from "node:crypto";

export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const CODE_LENGTH = 7;
export const CODE_RE = /^[0-9A-Za-z]{7}$/;

export function randomCode(length = CODE_LENGTH) {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += BASE62[crypto.randomInt(62)];
  }
  return s;
}

/** Genera un código único comprobando colisiones en DB. */
export function generateUniqueCode(exists) {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    if (!exists(code)) return code;
  }
  // Probabilidad de llegar aquí: despreciable (62^7 ≈ 3.5e12).
  // Aun así, se sigue intentando en vez de fallar.
  let code;
  do {
    code = randomCode();
  } while (exists(code));
  return code;
}

// --- Contraseñas: scrypt + salt (sin dependencias externas) ---

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored).split(":");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const derived = crypto.scryptSync(password, salt, 32).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}
