// Whitelist de mercados habilitados por deporte.
// El motor de analisis NO debe emitir picks fuera de estos mercados.
//
// Pedidos por el usuario:
// - Futbol:     ganador, doble oportunidad, esquinas, tarjetas, total goles, handicaps,
//               + props de jugador y combinadas (decision adicional acordada)
// - Baloncesto: player props (pts/reb/ast/stl/blk/tov + combos), ganador, puntos por equipo,
//               puntos totales, handicaps. Enfasis en player props.
// - Tenis:      ATP/WTA tour, mercados estandar (no detallados especificamente)
// - Beisbol:    total carreras, handicaps (run line), ganador, player props principales

export const ENABLED_MARKETS = {
  futbol: new Set([
    "moneyline",            // Ganador
    "double_chance",        // Doble oportunidad (1X / X2 / 12)
    "corners",              // Tiros de esquina
    "cards",                // Tarjetas
    "totals",               // Total de goles
    "handicap",             // Handicap asiatico
    "player_props",         // Props de jugador (goles, asistencias, tiros)
    "combo_same_game"       // Combinada mismo partido
  ]),
  baloncesto: new Set([
    "moneyline",            // Ganador
    "spread",               // Handicap por puntos
    "totals",               // Puntos totales del partido
    "team_totals",          // Puntos por equipo
    "player_props",         // Props (pts, reb, ast, stl, blk, tov + combos)
    "combo_same_game"       // Combinada mismo partido
  ]),
  tenis: new Set([
    "moneyline",            // Ganador
    "totals",               // Total de juegos / sets
    "player_props"          // Tie-break, juegos primer set, etc.
  ]),
  beisbol: new Set([
    "moneyline",            // Ganador
    "totals",               // Total de carreras
    "run_line",             // Handicap (-1.5 / +1.5)
    "player_props",         // Ponches lanzador, hits, RBI, bases totales, etc.
    "combo_same_game"
  ])
};

export function isMarketEnabled(sport, market) {
  return ENABLED_MARKETS[sport]?.has(market) ?? false;
}

// Etiquetas humanas de cada mercado (incluye nuevos)
export const MARKET_LABELS = {
  moneyline:        "Ganador",
  double_chance:    "Doble oportunidad",
  totals:           "Totales",
  spread:           "Handicap",
  handicap:         "Handicap asiatico",
  run_line:         "Run line",
  team_totals:      "Total por equipo",
  corners:          "Tiros de esquina",
  cards:            "Tarjetas amarillas",
  player_props:     "Prop de jugador / equipo",
  combo_same_game:  "Combinada mismo partido"
};

export function humanMarketLabel(market) {
  return MARKET_LABELS[market] || market;
}

// Catalogo agrupado por deporte (para UI/dropdowns).
export const MARKET_OPTIONS_BY_SPORT = {
  futbol: [
    { value: "",                 label: "Todos los mercados" },
    { value: "moneyline",        label: "Ganador del partido" },
    { value: "double_chance",    label: "Doble oportunidad" },
    { value: "handicap",         label: "Handicap asiatico" },
    { value: "totals",           label: "Total de goles" },
    { value: "corners",          label: "Tiros de esquina" },
    { value: "cards",            label: "Tarjetas amarillas" },
    { value: "player_props",     label: "Prop de jugador" },
    { value: "combo_same_game",  label: "Combinada mismo partido" }
  ],
  baloncesto: [
    { value: "",                 label: "Todos los mercados" },
    { value: "moneyline",        label: "Ganador del partido" },
    { value: "spread",           label: "Handicap por puntos" },
    { value: "totals",           label: "Total de puntos" },
    { value: "team_totals",      label: "Puntos por equipo" },
    { value: "player_props",     label: "Prop de jugador" },
    { value: "combo_same_game",  label: "Combinada mismo partido" }
  ],
  tenis: [
    { value: "",                 label: "Todos los mercados" },
    { value: "moneyline",        label: "Ganador del partido" },
    { value: "totals",           label: "Total de juegos / sets" },
    { value: "player_props",     label: "Tie-break / Set 1" }
  ],
  beisbol: [
    { value: "",                 label: "Todos los mercados" },
    { value: "moneyline",        label: "Ganador del partido" },
    { value: "totals",           label: "Total de carreras" },
    { value: "run_line",         label: "Run line (handicap)" },
    { value: "player_props",     label: "Prop de jugador / equipo" },
    { value: "combo_same_game",  label: "Combinada mismo partido" }
  ]
};
