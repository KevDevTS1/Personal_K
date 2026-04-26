import { Router } from "express";
import { getAllBets, addBet, updateBetResult, deleteBet, computeStats } from "../data/tracker.js";
import { autoEvaluatePendingBets } from "../data/autoEvaluator.js";

const router = Router();

// POST /api/tracker/auto-evaluate — corre el auto-evaluador on-demand
router.post("/auto-evaluate", async (_req, res) => {
  try {
    const result = await autoEvaluatePendingBets({ verbose: true });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tracker/bets — lista completa
router.get("/bets", (_req, res) => {
  try { res.json(getAllBets()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tracker/stats — estadísticas y ROI
router.get("/stats", (_req, res) => {
  try { res.json(computeStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tracker/bets — registrar nueva apuesta
router.post("/bets", (req, res) => {
  try {
    const {
      sport, league, leagueSlug, event,
      homeTeam, awayTeam, eventDateUtc, sourceDateKey,
      market, marketLabel, sideLabel, lineLabel, selection,
      odds, stake,
      modelProb, modelEdge, score, scoreLabel, argument
    } = req.body;
    if (!event || !selection || !odds || !stake) {
      return res.status(400).json({ error: "Faltan campos: event, selection, odds, stake" });
    }
    const bet = addBet({
      sport, league, leagueSlug, event,
      homeTeam: homeTeam || null,
      awayTeam: awayTeam || null,
      eventDateUtc: eventDateUtc || null,
      sourceDateKey: sourceDateKey || null,
      market, marketLabel,
      sideLabel: sideLabel || null,
      lineLabel: lineLabel || null,
      selection,
      odds: Number(odds), stake: Number(stake),
      modelProb: Number(modelProb) || null,
      modelEdge: Number(modelEdge) || null,
      score: Number(score) || null,
      scoreLabel: scoreLabel || null,
      argument: argument || null,
    });
    res.status(201).json(bet);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/tracker/bets/:id — marcar resultado
router.patch("/bets/:id", (req, res) => {
  try {
    const { result, oddsActual } = req.body;
    if (!["win","loss","push","pending"].includes(result)) {
      return res.status(400).json({ error: "result debe ser: win | loss | push | pending" });
    }
    const updated = updateBetResult(req.params.id, result, oddsActual ? Number(oddsActual) : null);
    if (!updated) return res.status(404).json({ error: "Apuesta no encontrada" });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/tracker/bets/:id
router.delete("/bets/:id", (req, res) => {
  try {
    const ok = deleteBet(req.params.id);
    if (!ok) return res.status(404).json({ error: "Apuesta no encontrada" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
