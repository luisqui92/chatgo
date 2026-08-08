// ChatGo Salud — Vacunación: registro de vacunas aplicadas por paciente.
const { CONFIG, log } = require("../config");
const { Paciente, Vacuna } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── AGREGAR VACUNA ─────────────────────────────────────────────────────
  app.post("/medico/pacientes/:pacienteId/vacunas", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const paciente = await Paciente.findOne({ _id: req.params.pacienteId, medicoPhone });
      if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

      const nombre = String(req.body?.nombre || "").trim();
      const fecha = req.body?.fecha ? new Date(req.body.fecha) : null;
      if (!nombre || !fecha) return res.status(400).json({ error: "nombre y fecha son requeridos" });

      const vacuna = await Vacuna.create({
        pacienteId: paciente._id,
        medicoPhone,
        nombre,
        dosis: String(req.body?.dosis || "").trim(),
        fecha,
        notas: String(req.body?.notas || "").trim(),
      });
      res.status(201).json({ ok: true, vacuna });
    } catch (e) {
      log.error("[VACUNA_CREAR]", e.message);
      res.status(500).json({ error: "Error agregando la vacuna" });
    }
  });

  // ─── ELIMINAR ────────────────────────────────────────────────────────────
  app.delete("/medico/vacunas/:id", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const r = await Vacuna.deleteOne({ _id: req.params.id, medicoPhone });
      if (r.deletedCount === 0) return res.status(404).json({ error: "Vacuna no encontrada" });
      res.json({ ok: true });
    } catch (e) {
      log.error("[VACUNA_ELIMINAR]", e.message);
      res.status(500).json({ error: "Error eliminando la vacuna" });
    }
  });
};
