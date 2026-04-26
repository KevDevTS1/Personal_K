import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import apiRouter from "./src/routes/api.js";
import trackerRouter from "./src/routes/tracker.js";
import { warmup, startAutoRefresh } from "./src/cache/feeds.js";
import { startAutoEvaluator } from "./src/data/autoEvaluator.js";

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

function maskKey(k) {
  if (!k) return "no configurada";
  return `OK (${k.slice(0, 4)}…${k.slice(-4)})`;
}

const server = app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
  console.log("[ENV] GROQ_API_KEY        :", maskKey(process.env.GROQ_API_KEY));
  const oddsEnabled = String(process.env.ODDS_API_ENABLED || "false").toLowerCase() === "true";
  console.log("[ENV] ODDS_API_KEY        :", maskKey(process.env.ODDS_API_KEY), oddsEnabled ? "· ENABLED" : "· secundaria/apagada (ODDS_API_ENABLED=false)");
  console.log("[ENV] RAPIDAPI_KEY        :", maskKey(process.env.RAPIDAPI_KEY));
  console.log("[ENV] OPENWEATHER_API_KEY :", maskKey(process.env.OPENWEATHER_API_KEY));
  console.log("[ENV] FOOTBALLDATA_API_KEY:", maskKey(process.env.FOOTBALLDATA_API_KEY));
  console.log("[ENV] THESPORTSDB_KEY     :", maskKey(process.env.THESPORTSDB_KEY) === "—" ? "free key '3' (sin registro)" : maskKey(process.env.THESPORTSDB_KEY));
  // Pre-fetch feeds so first request is served from cache, not cold
  warmup();
  startAutoRefresh();
  startAutoEvaluator();
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
