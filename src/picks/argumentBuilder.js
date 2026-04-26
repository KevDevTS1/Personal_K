// Genera el argumento extenso (>=500 palabras) para cada pick usando Groq.
// Si falla o no hay key, retorna una plantilla estadistica como fallback.
//
// Cache en disco: data/arguments/<id>.json -> { text, model, generatedAt, words }

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { callGroq, isGroqAvailable } from "../data/llm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CACHE_DIR  = path.resolve(__dirname, "..", "..", "data", "arguments");

let _dirReady = false;
async function ensureDir() {
  if (_dirReady) return;
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
  _dirReady = true;
}

function pickHashKey(pick) {
  // Hash estable independiente de id efimero (Date.now()):
  // sport + market + selection + event + line + sourceDateKey
  const parts = [
    pick.sport, pick.market,
    pick.selection,
    pick.event,
    pick.lineLabel || pick.line || "",
    pick.sourceDateKey || pick.forDate || ""
  ].map(s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "_"));
  return parts.join("__").slice(0, 180);
}

async function readCached(key) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${key}.json`), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeCached(key, payload) {
  try {
    await fs.writeFile(
      path.join(CACHE_DIR, `${key}.json`),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  } catch (err) {
    console.warn(`[Args] No se pudo cachear ${key}: ${err.message}`);
  }
}

function countWords(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

// ──────────────────────────────────────────────────────────────────────────
// Prompt builder
// ──────────────────────────────────────────────────────────────────────────

function formatBookmakers(books) {
  if (!Array.isArray(books) || !books.length) return "Sin cuotas confirmadas en casas colombianas.";
  return books.map(b => {
    const ml = b.h2h ? `1=${b.h2h.home ?? "-"} X=${b.h2h.draw ?? "-"} 2=${b.h2h.away ?? "-"}` : "-";
    const tot = b.totals?.line ? `O/U ${b.totals.line}: O=${b.totals.over ?? "-"} U=${b.totals.under ?? "-"}` : "-";
    return `  - ${b.bookmaker}: ML[${ml}] / Totales[${tot}]`;
  }).join("\n");
}

function buildPrompt(pick) {
  const m = pick.modelProb != null ? `${(pick.modelProb * 100).toFixed(1)}%` : "n/d";
  const e = pick.edge != null ? `${(pick.edge * 100).toFixed(2)}%` : "n/d";
  const co = pick.coOddsContext;
  const ev = pick.eventDateUtc ? new Date(pick.eventDateUtc).toLocaleString("es-CO", { timeZone: "America/Bogota" }) : "fecha n/d";

  const dataSummary = `
DATOS DEL PICK
- Deporte: ${pick.sport}
- Liga: ${pick.league}
- Partido: ${pick.event} (${ev})
- Mercado: ${pick.marketLabel || pick.market}
- Selección: ${pick.selection}
- Cuota actual: ${pick.odds}
- Probabilidad del modelo: ${m}
- Edge sobre la cuota: ${e}
- Fuente de la cuota: ${pick.oddsSource || "modelo"}
- Marcador actual: ${pick.homeScore ?? "-"} - ${pick.awayScore ?? "-"}
- Estado: ${pick.liveStatus || pick.eventStatus || "programado"}

ARGUMENTO BASE DEL MODELO
${pick.argument || "Sin argumento técnico previo."}

CUOTAS DE CASAS COLOMBIANAS (si disponibles)
${formatBookmakers(co?.books)}

PROMEDIO COLOMBIA: ${co?.averaged ? JSON.stringify(co.averaged) : "no disponible"}
`.trim();

  const system = `Eres un analista profesional de apuestas deportivas con foco en el mercado colombiano (Wplay, Rushbet, Betsson CO, Yajuego, Sportium). Tu trabajo es producir argumentos honestos, basados en datos, en español. NUNCA inventes datos: si un dato no esta en el contexto, dilo explicitamente. NUNCA garantices el resultado: las apuestas son riesgo. Escribes en parrafos claros, sin listas con bullets dentro de cada seccion (las secciones SI llevan titulo en negrita). Audiencia: bettor colombiano informado.`;

  const user = `Genera un análisis de mínimo 500 palabras (idealmente 550-700) sobre este pronóstico. Usa exactamente estas 6 secciones, en este orden, con sus titulos en negrita usando markdown (** **):

**1. Contexto del partido**
Presenta el partido, la liga, el momento de cada equipo/jugador, importancia (jornada, eliminación, racha).

**2. Forma reciente y datos clave**
Forma de los últimos partidos, lesiones/bajas si las mencionan los datos, head-to-head si aplica, datos avanzados (xG, ritmo, defensa rival, lanzador probable, ranking, etc.) según el deporte. Sé especifico con los numeros del contexto.

**3. Análisis del mercado y la línea**
Por qué la línea está donde está, cómo se compara con tu proyección, factores que pueden moverla.

**4. Cuota de mercado vs probabilidad del modelo**
Compara la cuota promedio en casas colombianas (si hay) o cuotas EU (si no) con la probabilidad del modelo. Calcula valor esperado y explica el edge ${e}.

**5. Riesgos y advertencias**
Qué puede salir mal: variabilidad del deporte, datos faltantes, calidad del modelo, factor azar, alineaciones no confirmadas, clima, etc. Sé honesto sobre las limitaciones.

**6. Conclusión**
Cierre claro con la apuesta sugerida, tamaño relativo (conservador/moderado/agresivo) y nivel de confianza CUALITATIVO (alto/medio/bajo) sin inventar porcentajes.

REGLAS ESTRICTAS:
- Mínimo 500 palabras totales.
- En español neutro, claro, profesional.
- No uses bullets ni numeros sueltos dentro de las secciones (los titulos SI van numerados).
- No inventes nombres de jugadores, lesiones ni resultados pasados que no estén en el contexto.
- No prometas ganar. Aclara que es analisis informativo.

CONTEXTO:
${dataSummary}`;

  return { system, user };
}

// ──────────────────────────────────────────────────────────────────────────
// Plantilla fallback (sin Groq)
// ──────────────────────────────────────────────────────────────────────────

function fallbackTemplate(pick) {
  const m = pick.modelProb != null ? (pick.modelProb * 100).toFixed(1) + "%" : "n/d";
  const e = pick.edge != null ? (pick.edge * 100).toFixed(2) + "%" : "n/d";
  const ev = pick.eventDateUtc ? new Date(pick.eventDateUtc).toLocaleString("es-CO", { timeZone: "America/Bogota" }) : "fecha por confirmar";

  const co = pick.coOddsContext;
  const coTxt = co?.books?.length
    ? `Tenemos lectura de cuotas en ${co.books.length} casa(s) colombiana(s) (${co.books.map(b => b.bookmaker).join(", ")}). El promedio nacional es la referencia que usamos para el cálculo de valor.`
    : "No conseguimos lectura de cuotas en casas colombianas para este partido en este ciclo de scraping; el cálculo de valor utiliza la cuota actual del modelo o de The Odds API como referencia.";

  return [
    `**1. Contexto del partido**`,
    `${pick.event} es un compromiso de ${pick.league} programado para ${ev}. ${pick.argument || "El cruce ofrece elementos analíticos suficientes para evaluarlo desde la óptica del valor en cuotas."} Más allá del resultado, el interés del análisis está en encontrar mercados donde la cuota ofrecida por las casas colombianas no refleja con precisión la probabilidad real estimada por el modelo. Cuando esa diferencia existe, se le llama "edge" y es el motor de cualquier estrategia de apuesta sostenible a mediano plazo.`,
    ``,
    `**2. Forma reciente y datos clave**`,
    `El modelo se alimenta de datos abiertos: registros de victorias y derrotas de la temporada en curso provistos por ESPN, métricas avanzadas cuando están disponibles (xG en ligas top de Europa vía Understat, stats por jugador en NBA vía balldontlie, lanzador probable y bateo por equipo en MLB vía MLB Stats API). En este pick la señal principal viene del argumento técnico: ${pick.argument || "datos de forma y rendimiento agregados de la temporada"}. Faltarán siempre algunos elementos —alineación confirmada, clima, motivación intangible— y por eso conviene contrastar este análisis con noticias de última hora antes de cerrar la apuesta.`,
    ``,
    `**3. Análisis del mercado y la línea**`,
    `La selección elegida es: ${pick.selection}. La línea actual con la que trabajamos es ${pick.lineLabel || "la principal del mercado"} y la cuota disponible es ${pick.odds}. Las casas mueven sus líneas en función del volumen apostado y de la información que reciben (lesiones, alineaciones, clima); por eso el momento de tomar la apuesta importa: las cuotas de la mañana suelen ser distintas a las del cierre. Si la información es positiva para el lado que el modelo favorece, la cuota tiende a bajar y el valor desaparece; si es negativa, sube y el valor crece.`,
    ``,
    `**4. Cuota de mercado vs probabilidad del modelo**`,
    `${coTxt} La probabilidad estimada por el modelo es ${m}, lo que implica una cuota "justa" (sin margen de la casa) de aproximadamente ${pick.modelProb ? (1 / pick.modelProb).toFixed(2) : "n/d"}. Comparada con la cuota actual de ${pick.odds}, el edge calculado es ${e}. Un edge positivo significa que, repitiendo escenarios similares en el largo plazo, esta apuesta tiene esperanza matemática positiva. Un edge negativo significa lo contrario: aunque podamos ganar puntualmente, en serie larga perderemos.`,
    ``,
    `**5. Riesgos y advertencias**`,
    `Ningún modelo estadístico es infalible. Los datos pueden estar desactualizados, las alineaciones cambian, el clima afecta especialmente a deportes al aire libre, y la varianza es enorme en muestras pequeñas. Para apuestas en mercados secundarios (corners, tarjetas, props de jugador) la variabilidad es aún mayor que en el ganador del partido. Recomendación general: no apostar más del 1-2% del bankroll en una sola jugada, evitar combinadas de muchas piernas, y nunca perseguir pérdidas. El juego responsable es la única forma sostenible de operar.`,
    ``,
    `**6. Conclusión**`,
    `Con base en los datos disponibles, ${pick.selection} aparece como una apuesta ${Number(pick.edge) >= 0.05 ? "con valor relativo claro" : "con valor marginal"} para el partido ${pick.event}. La sugerencia es operarla en tamaño ${Number(pick.edge) >= 0.07 ? "moderado" : "conservador"} y verificar siempre las cuotas finales en tu casa de apuestas favorita antes de confirmar. Recuerda: este es un análisis informativo, no una promesa de ganancia. El juego implica riesgo y debe practicarse con moderación.`
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// API publica
// ──────────────────────────────────────────────────────────────────────────

/**
 * Genera o lee de cache el argumento de un pick.
 * Devuelve { text, model, words, fromCache }.
 */
export async function buildOrGetArgument(pick) {
  await ensureDir();
  const key = pickHashKey(pick);
  const cached = await readCached(key);
  if (cached?.text && countWords(cached.text) >= 500) {
    return { ...cached, fromCache: true };
  }

  if (isGroqAvailable()) {
    const { system, user } = buildPrompt(pick);
    const r = await callGroq({ system, user, maxTokens: 1500 });
    if (r?.text && countWords(r.text) >= 480) {
      const payload = {
        text: r.text,
        model: r.model,
        words: countWords(r.text),
        generatedAt: new Date().toISOString()
      };
      await writeCached(key, payload);
      return { ...payload, fromCache: false };
    }
  }

  const text = fallbackTemplate(pick);
  const payload = {
    text,
    model: "fallback-template",
    words: countWords(text),
    generatedAt: new Date().toISOString()
  };
  await writeCached(key, payload);
  return { ...payload, fromCache: false };
}

/**
 * Genera argumentos para muchos picks con concurrencia limitada.
 * Mutates pick.argumentLong in-place.
 */
export async function attachLongArguments(picks, concurrency = 4) {
  const queue = [...picks];
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (!p) return;
      try {
        const r = await buildOrGetArgument(p);
        p.argumentLong       = r.text;
        p.argumentWords      = r.words;
        p.argumentModel      = r.model;
        p.argumentFromCache  = r.fromCache;
      } catch (err) {
        console.warn(`[Args] pick ${p.id}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}
