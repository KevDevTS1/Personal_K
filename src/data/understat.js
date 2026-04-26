// Understat: xG, xGA y forma reciente para las 5 grandes ligas europeas.
// Sin API oficial: scrapeamos el JSON embebido en cada pagina de equipo.
//
// Endpoint: https://understat.com/league/<league>
// El HTML contiene varios `JSON.parse('...')` con datos de equipos y jugadores
// que extraemos por regex.

const UNDERSTAT_LEAGUES = {
  "eng.1": "EPL",
  "esp.1": "La_liga",
  "ita.1": "Serie_A",
  "ger.1": "Bundesliga",
  "fra.1": "Ligue_1"
};

// cache (slug -> { teams: Map<normName, stats>, fetchedAt })
const _cache = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 minutos

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function decodeHexEscapes(payload) {
  return payload.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
}

function extractJsonVar(html, varName) {
  // Patron tipico: var teamsData = JSON.parse('\x7b...\x7d');
  const regex = new RegExp(`var\\s+${varName}\\s*=\\s*JSON\\.parse\\('([^']+)'\\)`);
  const m = html.match(regex);
  if (!m) return null;
  try {
    return JSON.parse(decodeHexEscapes(m[1]));
  } catch {
    return null;
  }
}

async function fetchLeagueTeams(slug) {
  const understatLeague = UNDERSTAT_LEAGUES[slug];
  if (!understatLeague) return null;

  const cached = _cache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.teams;

  try {
    const url = `https://understat.com/league/${understatLeague}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; InfoBet/1.0)" },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const teamsData = extractJsonVar(html, "teamsData");
    if (!teamsData) return null;

    const teams = new Map();
    for (const teamId of Object.keys(teamsData)) {
      const t = teamsData[teamId];
      if (!t?.title) continue;
      const games = Array.isArray(t.history) ? t.history : [];
      const last = games.slice(-10);
      const sumStat = (key) => last.reduce((s, g) => s + (Number(g[key]) || 0), 0);
      const n = Math.max(1, last.length);
      teams.set(normName(t.title), {
        title: t.title,
        xgPerGame:    sumStat("xG") / n,
        xgaPerGame:   sumStat("xGA") / n,
        ppdaPerGame:  sumStat("ppda_coef") / n || null,
        scoredPerGame: sumStat("scored") / n,
        concededPerGame: sumStat("missed") / n,
        ptsPerGame:   sumStat("pts") / n,
        sample: n
      });
    }

    _cache.set(slug, { teams, fetchedAt: Date.now() });
    return teams;
  } catch (err) {
    console.warn(`[Understat] ${slug}: ${err.message}`);
    return null;
  }
}

/**
 * Devuelve stats agregadas xG/xGA/PPDA para un partido si la liga esta soportada.
 * Retorna null si no hay datos.
 */
export async function getUnderstatMatchStats(leagueSlug, homeName, awayName) {
  if (!UNDERSTAT_LEAGUES[leagueSlug]) return null;
  const teams = await fetchLeagueTeams(leagueSlug);
  if (!teams) return null;

  const hn = normName(homeName);
  const an = normName(awayName);

  // exact match primero, luego contains
  let home = teams.get(hn);
  let away = teams.get(an);
  if (!home) for (const [k, v] of teams) if (k.includes(hn) || hn.includes(k)) { home = v; break; }
  if (!away) for (const [k, v] of teams) if (k.includes(an) || an.includes(k)) { away = v; break; }
  if (!home || !away) return null;

  return { home, away, source: "understat" };
}

export function isUnderstatLeague(slug) {
  return Boolean(UNDERSTAT_LEAGUES[slug]);
}
