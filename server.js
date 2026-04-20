import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import apiRouter from "./src/routes/api.js";
import trackerRouter from "./src/routes/tracker.js";
import { warmup, startAutoRefresh } from "./src/cache/feeds.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;

app.use(express.json());
app.use(express.static(__dirname));
app.use("/api", apiRouter);
app.use("/api/tracker", trackerRouter);

// Serve favicon silently to avoid 404 noise
app.get("/favicon.ico", (_req, res) => res.status(204).end());

const server = app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
  // Pre-fetch feeds so first request is served from cache, not cold
  warmup();
  startAutoRefresh();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nError: el puerto ${PORT} ya está en uso.`);
    console.error(`  Windows:  npx kill-port ${PORT}\n`);
  } else {
    console.error("Error del servidor:", err.message);
  }
  process.exit(1);
});
