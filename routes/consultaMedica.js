// ChatGo — Consultas médicas: transcripción de audio largo con diarización
// (AssemblyAI). Médicos suben el audio de la consulta (grabado en el celular
// o PC) y reciben la transcripción separada por hablante + nota clínica.
// Login/registro vive aparte en routes/medicoAuth.js.
const express = require("express");
const { log } = require("../config");
const { Paciente, ConsultaMedica, Medicamento } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { transcribirConsultaMedica, crearTokenStreaming } = require("../services/assemblyai");
const { generarNotaClinica } = require("../services/notaClinica");
const { regenerarBriefClinico } = require("../services/briefClinico");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

// Acepta el audio como body crudo (no JSON): el cliente manda
// Content-Type: audio/ogg (o wav/mp3/m4a/webm) y el archivo tal cual.
const audioRaw = express.raw({ type: "audio/*", limit: "80mb" });

module.exports = function (app) {

  // ─── TOKEN PARA VISTA PREVIA EN VIVO (el navegador se conecta directo
  // al WebSocket de AssemblyAI mientras graba; nunca se manda la API key) ──
  app.get("/medico/transcripcion-token", requireMedico, asyncRoute(async (req, res) => {
    try {
      const token = await crearTokenStreaming();
      res.json({ token });
    } catch (e) {
      log.error("[TRANSCRIPCION_TOKEN]", e.response?.data || e.message);
      throw new ErrorHttp(502, "No se pudo generar el token de transcripción en vivo");
    }
  }));

  // ─── SUBIR AUDIO DE CONSULTA → TRANSCRIBIR (en segundo plano) ──────────
  // Con consultas de 30-45 min, esperar la transcripción entera en el mismo
  // pedido HTTP no funciona (nginx corta conexiones largas). Por eso acá solo
  // se guarda el audio y se responde al toque; la transcripción sigue sola
  // en background y la web se fija después (polling) cuando termina.
  app.post("/medico/consultas", limitMedico, requireMedico, audioRaw, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const audioBuffer = req.body;
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw new ErrorHttp(400, "Falta el audio (Content-Type debe ser audio/*)");
    }

    const pacienteId = String(req.query.pacienteId || "").trim();
    if (!pacienteId) throw new ErrorHttp(400, "Falta pacienteId — elegí o creá un paciente antes de grabar");
    const paciente = await obtenerOFallar(Paciente, { _id: pacienteId, medicoPhone }, "Paciente no encontrado");

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
          const medicamentosActivos = await Medicamento.find({ pacienteId: paciente._id, medicoPhone, fechaFin: null })
            .select("nombre").lean();
          consulta.notaClinica = await generarNotaClinica(transcripcionCompleta, {
            antecedentesPersonales: paciente.antecedentesPersonales || [],
            antecedentesFamiliares: paciente.antecedentesFamiliares || [],
            medicamentosActivos: medicamentosActivos.map(m => m.nombre),
          });
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
  }));

  // ─── LISTAR CONSULTAS PROPIAS ───────────────────────────────────────────
  app.get("/medico/consultas", requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const consultas = await ConsultaMedica.find({ medicoPhone })
      .select("pacienteNombre estado duracionSegundos createdAt")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ consultas });
  }));

  // ─── DETALLE DE UNA CONSULTA (transcripción completa) ──────────────────
  app.get("/medico/consultas/:id", requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const consulta = await obtenerOFallar(ConsultaMedica, { _id: req.params.id, medicoPhone }, "Consulta no encontrada");
    res.json({ consulta });
  }));
};
