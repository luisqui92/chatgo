// ChatGo Salud — Evolución Clínica: signos vitales/indicadores (presión,
// glucosa, peso, saturación, etc.) para graficar tendencias del paciente.
const { Paciente, Medicion } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── AGREGAR MEDICIÓN ────────────────────────────────────────────────────
  app.post("/medico/pacientes/:pacienteId/mediciones", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.pacienteId, medicoPhone }, "Paciente no encontrado");

    const tipo = String(req.body?.tipo || "").trim();
    const valor = Number(req.body?.valor);
    const fecha = req.body?.fecha ? new Date(req.body.fecha) : null;
    if (!tipo || Number.isNaN(valor) || !fecha) throw new ErrorHttp(400, "tipo, valor y fecha son requeridos");

    const valorSecundario = req.body?.valorSecundario !== undefined && req.body?.valorSecundario !== null
      ? Number(req.body.valorSecundario) : null;
    if (valorSecundario !== null && Number.isNaN(valorSecundario)) throw new ErrorHttp(400, "valorSecundario inválido");

    const medicion = await Medicion.create({
      pacienteId: paciente._id,
      medicoPhone,
      tipo,
      valor,
      valorSecundario,
      fecha,
      notas: String(req.body?.notas || "").trim(),
    });
    res.status(201).json({ ok: true, medicion });
  }));

  // ─── ELIMINAR ────────────────────────────────────────────────────────────
  app.delete("/medico/mediciones/:id", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const r = await Medicion.deleteOne({ _id: req.params.id, medicoPhone });
    if (r.deletedCount === 0) throw new ErrorHttp(404, "Medición no encontrada");
    res.json({ ok: true });
  }));
};
