// ChatGo Salud — Pacientes: la entidad central del Kardex. Cada consulta
// (con su transcripción y nota clínica), medicamento y vacuna cuelga de un
// paciente real.
const { CONFIG, log } = require("../config");
const { Paciente, ConsultaMedica, Medicamento, Vacuna } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  // ─── CREAR PACIENTE ─────────────────────────────────────────────────────
  app.post("/medico/pacientes", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const nombre = String(req.body?.nombre || "").trim();
      if (!nombre) return res.status(400).json({ error: "nombre es requerido" });

      const fechaNacimiento = req.body?.fechaNacimiento ? new Date(req.body.fechaNacimiento) : null;
      const sexo = String(req.body?.sexo || "").trim();
      const telefono = String(req.body?.telefono || "").trim();
      const notas = String(req.body?.notas || "").trim();

      const paciente = await Paciente.create({ medicoPhone, nombre, fechaNacimiento, sexo, telefono, notas });
      res.status(201).json({ ok: true, paciente });
    } catch (e) {
      log.error("[PACIENTE_CREAR]", e.message);
      res.status(500).json({ error: "Error creando paciente" });
    }
  });

  // ─── LISTAR PACIENTES PROPIOS ───────────────────────────────────────────
  app.get("/medico/pacientes", requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const pacientes = await Paciente.find({ medicoPhone }).sort({ nombre: 1 }).lean();
      res.json({ pacientes });
    } catch (e) {
      log.error("[PACIENTE_LIST]", e.message);
      res.status(500).json({ error: "Error listando pacientes" });
    }
  });

  // ─── DETALLE DE PACIENTE: consultas, medicamentos y vacunas de una ──────
  // Se trae todo junto para que las pestañas del Kardex sean instantáneas
  // (sin pedir de nuevo al servidor cada vez que el médico cambia de pestaña).
  app.get("/medico/pacientes/:id", requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const paciente = await Paciente.findOne({ _id: req.params.id, medicoPhone }).lean();
      if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

      const [consultas, medicamentos, vacunas] = await Promise.all([
        ConsultaMedica.find({ pacienteId: paciente._id, medicoPhone })
          .select("estado notaClinicaEstado notaClinica.motivoConsulta notaClinica.diagnostico duracionSegundos createdAt")
          .sort({ createdAt: -1 })
          .lean(),
        Medicamento.find({ pacienteId: paciente._id, medicoPhone }).sort({ fechaFin: 1, createdAt: -1 }).lean(),
        Vacuna.find({ pacienteId: paciente._id, medicoPhone }).sort({ fecha: -1 }).lean(),
      ]);

      res.json({ paciente, consultas, medicamentos, vacunas });
    } catch (e) {
      log.error("[PACIENTE_DETALLE]", e.message);
      res.status(500).json({ error: "Error obteniendo paciente" });
    }
  });

  // ─── EDITAR PACIENTE (datos básicos + antecedentes) ────────────────────
  app.patch("/medico/pacientes/:id", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const paciente = await Paciente.findOne({ _id: req.params.id, medicoPhone });
      if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

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
    } catch (e) {
      log.error("[PACIENTE_EDITAR]", e.message);
      res.status(500).json({ error: "Error editando paciente" });
    }
  });
};
