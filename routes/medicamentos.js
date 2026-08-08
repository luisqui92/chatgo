// ChatGo Salud — Gestión de Medicación: lista de medicamentos activos/pasados
// de cada paciente. Carga manual del médico.
const { CONFIG, log } = require("../config");
const { Paciente, Medicamento } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── AGREGAR MEDICAMENTO ────────────────────────────────────────────────
  app.post("/medico/pacientes/:pacienteId/medicamentos", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const paciente = await Paciente.findOne({ _id: req.params.pacienteId, medicoPhone });
      if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

      const nombre = String(req.body?.nombre || "").trim();
      if (!nombre) return res.status(400).json({ error: "nombre es requerido" });

      const medicamento = await Medicamento.create({
        pacienteId: paciente._id,
        medicoPhone,
        nombre,
        dosis: String(req.body?.dosis || "").trim(),
        frecuencia: String(req.body?.frecuencia || "").trim(),
        fechaInicio: req.body?.fechaInicio ? new Date(req.body.fechaInicio) : null,
        fechaFin: req.body?.fechaFin ? new Date(req.body.fechaFin) : null,
        notas: String(req.body?.notas || "").trim(),
      });
      res.status(201).json({ ok: true, medicamento });
    } catch (e) {
      log.error("[MEDICAMENTO_CREAR]", e.message);
      res.status(500).json({ error: "Error agregando el medicamento" });
    }
  });

  // ─── EDITAR (ej. dar de baja poniendo fechaFin) ────────────────────────
  app.patch("/medico/medicamentos/:id", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const medicamento = await Medicamento.findOne({ _id: req.params.id, medicoPhone });
      if (!medicamento) return res.status(404).json({ error: "Medicamento no encontrado" });

      const campos = ["nombre", "dosis", "frecuencia", "notas"];
      for (const campo of campos) {
        if (req.body?.[campo] !== undefined) medicamento[campo] = String(req.body[campo]).trim();
      }
      if (req.body?.fechaInicio !== undefined) medicamento.fechaInicio = req.body.fechaInicio ? new Date(req.body.fechaInicio) : null;
      if (req.body?.fechaFin !== undefined) medicamento.fechaFin = req.body.fechaFin ? new Date(req.body.fechaFin) : null;

      await medicamento.save();
      res.json({ ok: true, medicamento });
    } catch (e) {
      log.error("[MEDICAMENTO_EDITAR]", e.message);
      res.status(500).json({ error: "Error editando el medicamento" });
    }
  });

  // ─── ELIMINAR ────────────────────────────────────────────────────────────
  app.delete("/medico/medicamentos/:id", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const r = await Medicamento.deleteOne({ _id: req.params.id, medicoPhone });
      if (r.deletedCount === 0) return res.status(404).json({ error: "Medicamento no encontrado" });
      res.json({ ok: true });
    } catch (e) {
      log.error("[MEDICAMENTO_ELIMINAR]", e.message);
      res.status(500).json({ error: "Error eliminando el medicamento" });
    }
  });
};
