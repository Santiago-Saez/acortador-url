# Acortador de URLs

API mínima + página estática (`/`) con SQLite, códigos base62 de 7 caracteres
y registro de clics **asíncrono** (fuera del camino crítico de la redirección).

## Requisitos

Node ≥ 22. Sin dependencias nativas (usa `node:sqlite` + `express`).

## Puesta en marcha

```bash
npm install
cp .env.example .env   # opcional
npm start              # http://localhost:3000
```

Variables (`REDIRECT_STATUS`, `PORT`, `BASE_URL`, `DB_PATH`):

```bash
PORT=3000
REDIRECT_STATUS=302
BASE_URL=http://localhost:3000
DB_PATH=./data.sqlite
# Internas (carga / comparativa):
CLICK_MODE=async            # async | sync (sync solo para la demo comparativa)
CLICK_WRITE_DELAY_MS=0      # retrasa artificialmente el writer para evidenciar async
```

## API

### `POST /links` — crear código corto

```bash
curl -s -X POST localhost:3000/links \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/art","expiresInSeconds":3600,"password":"secreto"}'
# → {"code":"aB3xK9q","shortUrl":"http://localhost:3000/aB3xK9q",...}
```

- `url` (requerido, `http(s)`), `expiresAt` (ISO) o `expiresInSeconds`,
  `password` (opcional, mín. 4; se guarda `scrypt(salt, pw)`).
- El código es **base62 (`[0-9A-Za-z]`), 7 caracteres** (`62^7 ≈ 3.5 billones`).
  Se genera con `crypto.randomInt` y se reintenta ante colisión
  (ver `src/codes.js:generateUniqueCode`). La columna `code` es `PRIMARY KEY`,
  así que una colisión residual fallaría con error en vez de duplicar.

### `GET /:code` — redirección

```bash
curl -i localhost:3000/aB3xK9q
# HTTP/1.1 302 Found
# Location: https://example.com/art
```

- Link inexistente → `404`; caducado → `410 Gone`.
- Con contraseña → `401` (formulario HTML o JSON con pista `?password=...`):
  `GET /:code?password=secreto`.

### Stats

```bash
curl localhost:3000/api/links/aB3xK9q/stats
# {"code":"...","total":12,
#  "byDay":[{"day":"2026-11-18","count":12}],
#  "byCountry":[{"country":"AR","count":7},...],
#  "byReferrer":[{"referrer":"google.com","count":5},{"referrer":"direct","count":7}]}
```

- `GET /api/links/:code` → metadatos + total.
- País: se lee de `CF-IPCountry` / `X-Country` (lo que pondría un CDN);
  sin GeoIP local el valor es `unknown`. En producción se resolvería la IP
  con MaxMind GeoIP2 en este mismo punto (`src/clicks.js:normalizeCountry`).
- Referente: host de `Referer`, o `"direct"`.

## 301 vs 302: por qué importa para las estadísticas

| | 301 (Moved Permanently) | 302 (Found) |
|---|---|---|
| Caché del navegador | **Cacheable por defecto**: tras el primer clic el navegador puede ir directo al destino sin volver a pedir `/:code`. | **No se cachea**: cada clic vuelve a pasar por el servidor. |
| Efecto en stats | **Subcuenta**: solo ves el primer clic por usuario/navegador; el resto son invisibles. | **Cuenta real**: cada visita genera un hit y un evento de clic. |
| Cambio de destino | Peligroso: la caché vieja sigue apuntando al destino anterior. | Seguro: puedes cambiar `url` y surte efecto inmediato. |

**Por eso el valor por defecto es `302`** (`REDIRECT_STATUS=302`): un acortador
vive de medir cada clic. Se ofrece `301` solo como opción de configuración
para enlaces inmutables donde se quiera ahorrar tráfico a costa de perder
visibilidad (`REDIRECT_STATUS=301 npm start`).

## El registro de clics no ralentiza la redirección

Ruta crítica de `GET /:code` (`src/app.js`):

1. `SELECT` del link (lectura imprescindible).
2. `void logClick(...)` — **sin `await`**.
3. `res.redirect()` inmediato.

En modo `async` (default), `logClick` solo hace `queue.push(event)` (~ns) y un
`setInterval` cada 200 ms persiste el lote en **una transacción**
(`src/clicks.js:flushLoop`). El `INSERT` nunca ocurre entre la petición y la
respuesta. Al apagar, se hace `flushClicks()` para no perder eventos.

### Demostración: prueba de carga sencilla

Se simula un escritor lento (`CLICK_WRITE_DELAY_MS=40`) para que la
diferencia sea visible incluso en local:

```bash
node scripts/compare-modes.mjs 1000 50
```

Resultado típico (800 req, concurrencia 20, writer simulado de 80 ms):

```
=== modo sync (CLICK_WRITE_DELAY_MS=80) ===
requests=800 concurrency=20 ok=800 fail=0
rps=232.2 total=3445ms
p50=82.02ms p95=105.45ms p99=126.33ms max=156.64ms

=== modo async (CLICK_WRITE_DELAY_MS=80) ===
requests=800 concurrency=20 ok=800 fail=0
rps=1533.0 total=522ms
p50=9.84ms p95=24.98ms p99=40.28ms max=82.59ms
```

Además, tras la carga en modo async los 800 clics están persistidos
(`total` del endpoint de stats coincide con `requests`): la cola en memoria
con flush transaccional no pierde eventos, solo los saca del camino crítico.

> Los números exactos varían por máquina; lo invariante es que en `sync`
> `p50 ≈ DELAY` (la redirección espera al writer) mientras que en `async`
> `p50 << DELAY` (la redirección responde antes de escribir).

Prueba individual contra un link cualquiera:

```bash
npm start &
CODE=$(curl -s -X POST localhost:3000/links -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).code))")
node scripts/load-test.mjs http://localhost:3000/$CODE 1000 50
```

## Diseño (resumen)

```
GET /:code → SELECT link → checks (404/410/401) → queue.push(click) → 301/302
                                        ↓ (cada 200 ms, en transacción)
                                   INSERT INTO clicks …
GET /api/links/:code/stats → SELECT ... GROUP BY day / country / referrer
```

Tablas: `links(code PK, url, created_at, expires_at, password_hash)`,
`clicks(id, code, ts, day, country, referrer)` con índices por `(code, …)`.
