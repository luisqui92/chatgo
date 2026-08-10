// ChatGo Salud — Vacunación: registro de vacunas aplicadas por paciente.
const { Paciente, Vacuna } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── AGREGAR VACUNA ─────────────────────────────────────────────────────
  app.post("/medico/pacientes/:pacienteId/vacunas", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.pacienteId, medicoPhone }, "Paciente no encontrado");

    const nombre = String(req.body?.nombre || "").trim();
    const fecha = req.body?.fecha ? new Date(req.body.fecha) : null;
    if (!nombre || !fecha) throw new ErrorHttp(400, "nombre y fecha son requeridos");

    const vacuna = await Vacuna.create({
      pacienteId: paciente._id,
      medicoPhone,
      nombre,
      dosis: String(req.body?.dosis || "").trim(),
      fecha,
      notas: String(req.body?.notas || "").trim(),
    });
    res.status(201).json({ ok: true, vacuna });
  }));

  // ─── ELIMINAR ────────────────────────────────────────────────────────────
  app.delete("/medico/vacunas/:id", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const r = await Vacuna.deleteOne({ _id: req.params.id, medicoPhone });
    if (r.deletedCount === 0) throw new ErrorHttp(404, "Vacuna no encontrada");
    res.json({ ok: true });
  }));
};
