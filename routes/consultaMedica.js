// ChatGo — Consultas médicas: transcripción de audio largo con diarización (Deepgram)
// Prototipo: médicos suben el audio de la consulta (grabado en el celular o PC) y
// reciben la transcripción separada por hablante. Login simple por teléfono,
// sin contraseña — solo médicos ya registrados/activos pueden entrar.
const express = require("express");
const { CONFIG, log } = require("../config");
const { Medico, ConsultaMedica } = require("../db/models");
const { generarToken, requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { transcribirConsultaMedica } = require("../services/deepgram");

const requireMedico = requireAuth(["medico"]);

// Acepta el audio como body crudo (no JSON): el cliente manda
// Content-Type: audio/ogg (o wav/mp3/m4a/webm) y el archivo tal cual.
const audioRaw = express.raw({ type: "audio/*", limit: "80mb" });

module.exports = function (app) {
  // ─── REGISTRO ───────────────────────────────────────────────────────────
  app.post("/medico/registro", limitMedico, async (req, res) => {
    try {
      const phone = String(req.body?.phone || "").trim();
      const nombre = String(req.body?.nombre || "").trim();
      const especialidad = String(req.body?.especialidad || "").trim();
      if (!phone || !nombre) return res.status(400).json({ error: "phone y nombre son requeridos" });

      const medico = await Medico.findOneAndUpdate(
        { phone },
        { $setOnInsert: { phone, nombre, especialidad, activo: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      res.json({ ok: true, phone: medico.phone, nombre: medico.nombre });
    } catch (e) {
      log.error("[MEDICO_REGISTRO]", e.message);
      res.status(500).json({ error: "Error registrando médico" });
    }
  });

  // ─── LOGIN (sin contraseña — solo médicos activos) ─────────────────────
  app.post("/medico/login", limitMedico, async (req, res) => {
    try {
      const phone = String(req.body?.phone || "").trim();
      if (!phone) return res.status(400).json({ error: "phone es requerido" });

      const medico = await Medico.findOne({ phone, activo: true });
      if (!medico) return res.status(401).json({ error: "Médico no encontrado o inactivo" });

      const token = generarToken(medico.phone, "medico");
      res.json({ token, phone: medico.phone, nombre: medico.nombre });
    } catch (e) {
      log.error("[MEDICO_LOGIN]", e.message);
      res.status(500).json({ error: "Error en login" });
    }
  });

  // ─── SUBIR AUDIO DE CONSULTA → TRANSCRIBIR ─────────────────────────────
  app.post("/medico/consultas", limitMedico, requireMedico, audioRaw, async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const audioBuffer = req.body;
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      return res.status(400).json({ error: "Falta el audio (Content-Type debe ser audio/*)" });
    }

    const pacienteNombre = String(req.query.pacienteNombre || "").trim();
    const consulta = await ConsultaMedica.create({ medicoPhone, pacienteNombre, estado: "procesando" });

    try {
      const { transcripcionCompleta, segmentos, duracionSegundos } =
        await transcribirConsultaMedica(audioBuffer, req.headers["content-type"]);

      consulta.estado = "completado";
      consulta.transcripcionCompleta = transcripcionCompleta;
      consulta.segmentos = segmentos;
      consulta.duracionSegundos = duracionSegundos;
      await consulta.save();

      res.status(201).json({ ok: true, consulta });
    } catch (e) {
      log.error("[CONSULTA_MEDICA] Error transcribiendo:", e.response?.data || e.message);
      consulta.estado = "error";
      consulta.error = e.response?.data?.err_msg || e.message;
      await consulta.save();
      res.status(502).json({ ok: false, error: "No se pudo transcribir el audio", consultaId: consulta._id });
    }
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
