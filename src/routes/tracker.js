import { Router } from "express";
import { getAllBets, addBet, updateBetResult, deleteBet, computeStats } from "../data/tracker.js";

const router = Router();

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
    const { sport, league, event, market, marketLabel, selection, odds, stake,
            modelProb, modelEdge, modelConfidence, argument } = req.body;
    if (!event || !selection || !odds || !stake) {
      return res.status(400).json({ error: "Faltan campos: event, selection, odds, stake" });
    }
    const bet = addBet({ sport, league, event, market, marketLabel, selection,
      odds: Number(odds), stake: Number(stake),
      modelProb: Number(modelProb) || null,
      modelEdge: Number(modelEdge) || null,
      modelConfidence: Number(modelConfidence) || null,
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
