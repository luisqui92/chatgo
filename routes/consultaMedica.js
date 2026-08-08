// ChatGo — Consultas médicas: transcripción de audio largo con diarización (AssemblyAI)
// Prototipo: médicos suben el audio de la consulta (grabado en el celular o PC) y
// reciben la transcripción separada por hablante. Login con teléfono + contraseña —
// solo médicos ya registrados/activos pueden entrar. Mismo cluster de MongoDB que
// el resto de chatgo (colecciones separadas: medicos, consultamedicas).
const express = require("express");
const { CONFIG, log } = require("../config");
const { Medico, Paciente, ConsultaMedica } = require("../db/models");
const { generarToken, requireAuth, hashPassword } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { transcribirConsultaMedica, crearTokenStreaming } = require("../services/assemblyai");
const { generarNotaClinica } = require("../services/notaClinica");
const { regenerarBriefClinico } = require("../services/briefClinico");

const requireMedico = requireAuth(["medico"]);

// Acepta el audio como body crudo (no JSON): el cliente manda
// Content-Type: audio/ogg (o wav/mp3/m4a/webm) y el archivo tal cual.
const audioRaw = express.raw({ type: "audio/*", limit: "80mb" });

module.exports = function (app) {

  // ─── TOKEN PARA VISTA PREVIA EN VIVO (el navegador se conecta directo
  // al WebSocket de AssemblyAI mientras graba; nunca se manda la API key) ──
  app.get("/medico/transcripcion-token", requireMedico, async (req, res) => {
    try {
      const token = await crearTokenStreaming();
      res.json({ token });
    } catch (e) {
      log.error("[TRANSCRIPCION_TOKEN]", e.response?.data || e.message);
      res.status(502).json({ error: "No se pudo generar el token de transcripción en vivo" });
    }
  });

  // ─── REGISTRO ───────────────────────────────────────────────────────────
  app.post("/medico/registro", limitMedico, async (req, res) => {
    try {
      const phone = String(req.body?.phone || "").trim();
      const nombre = String(req.body?.nombre || "").trim();
      const especialidad = String(req.body?.especialidad || "").trim();
      const password = String(req.body?.password || "");
      if (!phone || !nombre) return res.status(400).json({ error: "phone y nombre son requeridos" });
      if (password.length < 8) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });

      const yaExiste = await Medico.findOne({ phone });
      if (yaExiste) return res.status(409).json({ error: "Ese teléfono ya está registrado" });

      const medico = await Medico.create({ phone, nombre, especialidad, passwordHash: hashPassword(password), activo: true });
      res.json({ ok: true, phone: medico.phone, nombre: medico.nombre });
    } catch (e) {
      log.error("[MEDICO_REGISTRO]", e.message);
      res.status(500).json({ error: "Error registrando médico" });
    }
  });

  // ─── LOGIN (usuario = teléfono + contraseña) ────────────────────────────
  app.post("/medico/login", limitMedico, async (req, res) => {
    try {
      const phone = String(req.body?.phone || "").trim();
      const password = String(req.body?.password || "");
      if (!phone || !password) return res.status(400).json({ error: "phone y password son requeridos" });

      const medico = await Medico.findOne({ phone, activo: true });
      if (!medico || medico.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: "Teléfono o contraseña incorrectos" });
      }

      const token = generarToken(medico.phone, "medico");
      res.json({ token, phone: medico.phone, nombre: medico.nombre });
    } catch (e) {
      log.error("[MEDICO_LOGIN]", e.message);
      res.status(500).json({ error: "Error en login" });
    }
  });

  // ─── SUBIR AUDIO DE CONSULTA → TRANSCRIBIR (en segundo plano) ──────────
  // Con consultas de 30-45 min, esperar la transcripción entera en el mismo
  // pedido HTTP no funciona (nginx corta conexiones largas). Por eso acá solo
  // se guarda el audio y se responde al toque; la transcripción sigue sola
  // en background y la web se fija después (polling) cuando termina.
  app.post("/medico/consultas", limitMedico, requireMedico, audioRaw, async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const audioBuffer = req.body;
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      return res.status(400).json({ error: "Falta el audio (Content-Type debe ser audio/*)" });
    }

    const pacienteId = String(req.query.pacienteId || "").trim();
    if (!pacienteId) return res.status(400).json({ error: "Falta pacienteId — elegí o creá un paciente antes de grabar" });
    const paciente = await Paciente.findOne({ _id: pacienteId, medicoPhone });
    if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

    const consulta = await ConsultaMedica.create({
      medicoPhone, pacienteId: paciente._id, pacienteNombre: paciente.nombre, estado: "procesando",
    });

    res.status(202).json({ ok: true, consulta });

    transcribirConsultaMedica(audioBuffer)
      .then(async ({ transcripcionCompleta, segmentos, duracionSegundos }) => {
        consulta.estado = "completado";
        consulta.transcripcionCompleta = transcripcionCompleta;
        consulta.segmentos = segmentos;
        consulta.duracionSegundos = duracionSegundos;
        await consulta.save();

        try {
          consulta.notaClinica = await generarNotaClinica(transcripcionCompleta);
          consulta.notaClinicaEstado = "completado";
        } catch (e) {
          log.error("[NOTA_CLINICA]", e.response?.data || e.message);
          consulta.notaClinicaEstado = "error";
          consulta.notaClinicaError = e.message;
        }
        await consulta.save();

        if (consulta.notaClinicaEstado === "completado") {
          regenerarBriefClinico(consulta.pacienteId).catch(e => log.error("[BRIEF_CLINICO]", e.message));
        }
      })
      .catch(async (e) => {
        log.error("[CONSULTA_MEDICA] Error transcribiendo:", e.response?.data || e.message);
        consulta.estado = "error";
        consulta.error = e.response?.data?.error || e.message;
        await consulta.save();
      });
  });

  // ─── LISTAR CONSULTAS PROPIAS ───────────────────────────────────────────
  app.get("/medico/consultas", requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const consultas = await ConsultaMedica.find({ medicoPhone })
        .select("pacienteNombre estado duracionSegundos createdAt")
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      res.json({ consultas });
    } catch (e) {
      log.error("[MEDICO_CONSULTAS_LIST]", e.message);
      res.status(500).json({ error: "Error listando consultas" });
    }
  });

  // ─── DETALLE DE UNA CONSULTA (transcripción completa) ──────────────────
  app.get("/medico/consultas/:id", requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const consulta = await ConsultaMedica.findOne({ _id: req.params.id, medicoPhone }).lean();
      if (!consulta) return res.status(404).json({ error: "Consulta no encontrada" });
      res.json({ consulta });
    } catch (e) {
      log.error("[MEDICO_CONSULTA_DETALLE]", e.message);
      res.status(500).json({ error: "Error obteniendo consulta" });
    }
  });
};
