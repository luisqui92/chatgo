// ChatGo Salud — Memoria Clínica Conversacional: preguntas en lenguaje
// natural sobre la historia de un paciente puntual ("¿cuándo fue su última
// crisis asmática?"). No se persiste la conversación, es una consulta al toque.
const { log } = require("../config");
const { Paciente, ConsultaMedica, Medicamento, Vacuna, Medicion, Estudio } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { responderPregunta } = require("../services/memoriaClinica");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  app.post("/medico/pacientes/:id/preguntar", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.id, medicoPhone }, "Paciente no encontrado");

    const pregunta = String(req.body?.pregunta || "").trim();
    if (!pregunta) throw new ErrorHttp(400, "pregunta es requerida");

    const [consultas, medicamentos, vacunas, mediciones, estudios] = await Promise.all([
      ConsultaMedica.find({ pacienteId: paciente._id, medicoPhone, estado: "completado" })
        .select("notaClinica createdAt")
        .sort({ createdAt: 1 })
        .lean(),
      Medicamento.find({ pacienteId: paciente._id, medicoPhone }).lean(),
      Vacuna.find({ pacienteId: paciente._id, medicoPhone }).lean(),
      Medicion.find({ pacienteId: paciente._id, medicoPhone }).sort({ fecha: 1 }).lean(),
      Estudio.find({ pacienteId: paciente._id, medicoPhone }).select("-archivoNombre").lean(),
    ]);

    const edad = paciente.fechaNacimiento
      ? Math.floor((Date.now() - new Date(paciente.fechaNacimiento).getTime()) / (365.25 * 24 * 3600 * 1000))
      : null;

    try {
      const respuesta = await responderPregunta(pregunta, {
        nombre: paciente.nombre, edad, sexo: paciente.sexo,
        antecedentesPersonales: paciente.antecedentesPersonales || [],
        antecedentesFamiliares: paciente.antecedentesFamiliares || [],
        medicamentos, vacunas, mediciones, estudios, consultas,
      });
      res.json({ ok: true, respuesta });
    } catch (e) {
      log.error("[MEMORIA_CLINICA]", e.response?.data || e.message);
      throw new ErrorHttp(502, "No se pudo generar la respuesta");
    }
  }));
};
