// ChatGo Salud — Receta Digital: se genera a partir de lo recetado en una
// consulta (o a mano) y queda lista para imprimir/guardar como PDF desde el
// navegador. Mandarla directo por WhatsApp queda pendiente hasta resolver
// la integración (Evolution API) — por ahora, el médico la imprime/descarga.
const { Paciente, Medico, Receta } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── CREAR RECETA ────────────────────────────────────────────────────────
  // Crearla ya es el acto de aprobación del médico (viene de una consulta que
  // ya revisó, o la escribió a mano); no hay un estado de "borrador" aparte.
  app.post("/medico/pacientes/:pacienteId/recetas", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.pacienteId, medicoPhone }, "Paciente no encontrado");

    const medicamentos = (Array.isArray(req.body?.medicamentos) ? req.body.medicamentos : [])
      .map(m => ({
        nombre: String(m?.nombre || "").trim(),
        dosis: String(m?.dosis || "").trim(),
        frecuencia: String(m?.frecuencia || "").trim(),
        duracion: String(m?.duracion || "").trim(),
      }))
      .filter(m => m.nombre);
    if (medicamentos.length === 0) throw new ErrorHttp(400, "Agregá al menos un medicamento");

    const fecha = req.body?.fecha ? new Date(req.body.fecha) : new Date();

    const receta = await Receta.create({
      pacienteId: paciente._id,
      medicoPhone,
      consultaId: req.body?.consultaId || null,
      medicamentos,
      indicaciones: String(req.body?.indicaciones || "").trim(),
      fecha,
    });
    res.status(201).json({ ok: true, receta });
  }));

  // ─── VER UNA RECETA (con datos de médico/paciente para el encabezado) ──
  app.get("/medico/recetas/:id", requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const receta = await obtenerOFallar(Receta, { _id: req.params.id, medicoPhone }, "Receta no encontrada");
    const [paciente, medico] = await Promise.all([
      Paciente.findById(receta.pacienteId).select("nombre fechaNacimiento sexo").lean(),
      Medico.findOne({ phone: medicoPhone }).select("nombre especialidad").lean(),
    ]);
    res.json({ receta, paciente, medico });
  }));

  // ─── ELIMINAR ────────────────────────────────────────────────────────────
  app.delete("/medico/recetas/:id", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const r = await Receta.deleteOne({ _id: req.params.id, medicoPhone });
    if (r.deletedCount === 0) throw new ErrorHttp(404, "Receta no encontrada");
    res.json({ ok: true });
  }));
};
