import { createApp } from "./app.js";
import { flushClicks } from "./clicks.js";

const PORT = Number(process.env.PORT || 3000);
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`Acortador en http://localhost:${PORT} (redirect=${process.env.REDIRECT_STATUS || 302})`);
});

async function shutdown() {
  try {
    await flushClicks(); // no perder clics en memoria al apagar
  } finally {
    server.close(() => process.exit(0));
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
