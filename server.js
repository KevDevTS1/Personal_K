import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import apiRouter from "./src/routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;

app.use(express.json());
app.use(express.static(__dirname));
app.use("/api", apiRouter);

const server = app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nError: el puerto ${PORT} ya está en uso.`);
    console.error(`Solución: ejecuta este comando y luego vuelve a correr npm start:\n`);
    console.error(`  Windows:  npx kill-port ${PORT}`);
    console.error(`  o cierra la terminal donde está corriendo el servidor anterior.\n`);
  } else {
    console.error("Error del servidor:", err.message);
  }
  process.exit(1);
});
