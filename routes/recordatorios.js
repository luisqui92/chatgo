// ChatGo Salud — Recordatorios Médicos: una sola lista de "qué se viene" en
// todo el panel del médico (vencimientos, controles, vacunas pendientes),
// no por paciente. Se ve en el dashboard. Mandarlo solo por WhatsApp queda
// pendiente hasta resolver esa integración.
const { Paciente, Recordatorio } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── CREAR ────────────────────────────────────────────────────────────
  app.post("/medico/pacientes/:pacienteId/recordatorios", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.pacienteId, medicoPhone }, "Paciente no encontrado");

    const titulo = String(req.body?.titulo || "").trim();
    const fecha = req.body?.fecha ? new Date(req.body.fecha) : null;
    if (!titulo || !fecha) throw new ErrorHttp(400, "titulo y fecha son requeridos");

    const recordatorio = await Recordatorio.create({
      pacienteId: paciente._id,
      pacienteNombre: paciente.nombre,
      medicoPhone,
      tipo: String(req.body?.tipo || "otro").trim(),
      titulo,
      fecha,
      notas: String(req.body?.notas || "").trim(),
    });
    res.status(201).json({ ok: true, recordatorio });
  }));

  // ─── LISTAR PENDIENTES (de todo el panel, no de un paciente puntual) ───
  app.get("/medico/recordatorios", requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const recordatorios = await Recordatorio.find({ medicoPhone, completado: false }).sort({ fecha: 1 }).limit(100).lean();
    res.json({ recordatorios });
  }));

  // ─── MARCAR COMPLETADO ───────────────────────────────────────────────
  app.patch("/medico/recordatorios/:id", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const recordatorio = await Recordatorio.findOneAndUpdate(
      { _id: req.params.id, medicoPhone },
      { completado: Boolean(req.body?.completado) },
      { new: true }
    );
    if (!recordatorio) throw new ErrorHttp(404, "Recordatorio no encontrado");
    res.json({ ok: true, recordatorio });
  }));

  // ─── ELIMINAR ────────────────────────────────────────────────────────
  app.delete("/medico/recordatorios/:id", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const r = await Recordatorio.deleteOne({ _id: req.params.id, medicoPhone });
    if (r.deletedCount === 0) throw new ErrorHttp(404, "Recordatorio no encontrado");
    res.json({ ok: true });
  }));
};
