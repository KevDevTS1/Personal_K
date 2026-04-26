# Despliegue en servidor (VPS, Railway, etc.)

1. **Clonar o actualizar el código**
   ```bash
   git clone https://github.com/KevDevTS1/Personal_K.git
   cd Personal_K
   git pull origin main
   ```

2. **Dependencias**
   ```bash
   npm install --production
   ```

3. **Variables de entorno (no se suben a Git)**
   - En tu máquina local crea o copia el archivo **`.env`** (está en `.gitignore`).
   - En el servidor: copia el mismo **`.env`** con SSH/SCP, o define las variables en el panel (Railway, Render, etc.).
   - Plantilla: **`.env.example`** — copia y rellena:
     ```bash
     cp .env.example .env
     nano .env
     ```
   - Mínimo recomendado para producción: `GROQ_API_KEY`, `OPENWEATHER_API_KEY`, `FOOTBALLDATA_API_KEY` (y `ODDS_API_KEY` solo si `ODDS_API_ENABLED=true`).

4. **Puerto**
   - Por defecto `8787`. En producción suele mapearse con `PORT` (Heroku, Railway, etc.).

5. **Proceso en segundo plano (ej. PM2)**
   ```bash
   npm install -g pm2
   pm2 start server.js --name infobet
   pm2 save
   pm2 startup
   ```

6. **Caché en disco** (`data/`) se crea sola; no hace falta commitearla. El repositorio ignora caché y `data/bets.json` del tracker.

7. Tras cada deploy: `git pull && npm install && pm2 restart infobet` (o el nombre que uses).
