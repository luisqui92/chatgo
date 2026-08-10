// ChatGo Salud — Pacientes: la entidad central del Kardex. Cada consulta
// (con su transcripción y nota clínica), medicamento y vacuna cuelga de un
// paciente real.
const { Paciente, ConsultaMedica, Medicamento, Vacuna, Medicion, Estudio, Receta } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── CREAR PACIENTE ─────────────────────────────────────────────────────
  app.post("/medico/pacientes", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const nombre = String(req.body?.nombre || "").trim();
    if (!nombre) throw new ErrorHttp(400, "nombre es requerido");

    const fechaNacimiento = req.body?.fechaNacimiento ? new Date(req.body.fechaNacimiento) : null;
    const sexo = String(req.body?.sexo || "").trim();
    const telefono = String(req.body?.telefono || "").trim();
    const notas = String(req.body?.notas || "").trim();

    const paciente = await Paciente.create({ medicoPhone, nombre, fechaNacimiento, sexo, telefono, notas });
    res.status(201).json({ ok: true, paciente });
  }));

  // ─── LISTAR PACIENTES PROPIOS ───────────────────────────────────────────
  app.get("/medico/pacientes", requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const pacientes = await Paciente.find({ medicoPhone }).sort({ nombre: 1 }).lean();
    res.json({ pacientes });
  }));

  // ─── DETALLE DE PACIENTE: consultas, medicamentos y vacunas de una ──────
  // Se trae todo junto para que las pestañas del Kardex sean instantáneas
  // (sin pedir de nuevo al servidor cada vez que el médico cambia de pestaña).
  app.get("/medico/pacientes/:id", requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.id, medicoPhone }, "Paciente no encontrado");

    const [consultas, medicamentos, vacunas, mediciones, estudios, recetas] = await Promise.all([
      ConsultaMedica.find({ pacienteId: paciente._id, medicoPhone })
        .select("estado notaClinicaEstado notaClinica.motivoConsulta notaClinica.diagnostico duracionSegundos createdAt")
        .sort({ createdAt: -1 })
        .lean(),
      Medicamento.find({ pacienteId: paciente._id, medicoPhone }).sort({ fechaFin: 1, createdAt: -1 }).lean(),
      Vacuna.find({ pacienteId: paciente._id, medicoPhone }).sort({ fecha: -1 }).lean(),
      Medicion.find({ pacienteId: paciente._id, medicoPhone }).sort({ fecha: 1 }).lean(),
      Estudio.find({ pacienteId: paciente._id, medicoPhone }).select("-archivoNombre").sort({ fecha: -1 }).lean(),
      Receta.find({ pacienteId: paciente._id, medicoPhone }).sort({ fecha: -1 }).lean(),
    ]);

    res.json({ paciente, consultas, medicamentos, vacunas, mediciones, estudios, recetas });
  }));

  // ─── EDITAR PACIENTE (datos básicos + antecedentes) ────────────────────
  app.patch("/medico/pacientes/:id", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.id, medicoPhone }, "Paciente no encontrado");

    const campos = ["nombre", "sexo", "telefono", "notas"];
    for (const campo of campos) {
      if (req.body?.[campo] !== undefined) paciente[campo] = String(req.body[campo]).trim();
    }
    if (req.body?.fechaNacimiento !== undefined) {
      paciente.fechaNacimiento = req.body.fechaNacimiento ? new Date(req.body.fechaNacimiento) : null;
    }
    if (Array.isArray(req.body?.antecedentesPersonales)) {
      paciente.antecedentesPersonales = req.body.antecedentesPersonales.map(s => String(s).trim()).filter(Boolean);
    }
    if (Array.isArray(req.body?.antecedentesFamiliares)) {
      paciente.antecedentesFamiliares = req.body.antecedentesFamiliares
        .map(a => ({ parentesco: String(a?.parentesco || "").trim(), condicion: String(a?.condicion || "").trim() }))
        .filter(a => a.parentesco || a.condicion);
    }

    await paciente.save();
    res.json({ ok: true, paciente });
  }));

  // ─── AGREGAR UN ANTECEDENTE PERSONAL ────────────────────────────────────
  // Endpoint chico aparte del PATCH de arriba porque esto se usa desde la
  // pantalla de "Sugerencias del Kardex" (detalle de consulta), que no tiene
  // cargado el array completo del paciente para reenviarlo.
  app.post("/medico/pacientes/:id/antecedentes-personales", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const texto = String(req.body?.texto || "").trim();
    if (!texto) throw new ErrorHttp(400, "texto es requerido");

    const paciente = await Paciente.findOneAndUpdate(
      { _id: req.params.id, medicoPhone },
      { $addToSet: { antecedentesPersonales: texto } },
      { new: true }
    );
    if (!paciente) throw new ErrorHttp(404, "Paciente no encontrado");
    res.status(201).json({ ok: true, paciente });
  }));

  // ─── AGREGAR UN ANTECEDENTE FAMILIAR ────────────────────────────────────
  app.post("/medico/pacientes/:id/antecedentes-familiares", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const parentesco = String(req.body?.parentesco || "").trim();
    const condicion = String(req.body?.condicion || "").trim();
    if (!parentesco && !condicion) throw new ErrorHttp(400, "parentesco o condicion son requeridos");

    const paciente = await Paciente.findOneAndUpdate(
      { _id: req.params.id, medicoPhone },
      { $push: { antecedentesFamiliares: { parentesco, condicion } } },
      { new: true }
    );
    if (!paciente) throw new ErrorHttp(404, "Paciente no encontrado");
    res.status(201).json({ ok: true, paciente });
  }));
};
