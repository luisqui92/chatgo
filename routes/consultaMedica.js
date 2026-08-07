// ChatGo — Consultas médicas: transcripción de audio largo con diarización (AssemblyAI)
// Prototipo: médicos suben el audio de la consulta (grabado en el celular o PC) y
// reciben la transcripción separada por hablante. Login con teléfono + contraseña —
// solo médicos ya registrados/activos pueden entrar. Datos en MySQL (Cloud SQL),
// separado por completo de la base de MongoDB que usa el bot de taxis.
const express = require("express");
const { CONFIG, log } = require("../config");
const sql = require("../db/sqlSalud");
const { generarToken, requireAuth, hashPassword } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { transcribirConsultaMedica } = require("../services/assemblyai");

const requireMedico = requireAuth(["medico"]);

// Acepta el audio como body crudo (no JSON): el cliente manda
// Content-Type: audio/ogg (o wav/mp3/m4a/webm) y el archivo tal cual.
const audioRaw = express.raw({ type: "audio/*", limit: "80mb" });

module.exports = function (app) {
  // Si todavía no se configuró MYSQL_SALUD_URL, avisar en vez de tirar 500 raros
  app.use("/medico", (req, res, next) => {
    if (!sql.estaConfigurado()) {
      return res.status(503).json({ error: "Módulo de salud no configurado (falta MYSQL_SALUD_URL)" });
    }
    next();
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

      const yaExiste = await sql.medicoBuscarPorPhone(phone);
      if (yaExiste) return res.status(409).json({ error: "Ese teléfono ya está registrado" });

      await sql.medicoCrear({ phone, nombre, especialidad, passwordHash: hashPassword(password) });
      res.json({ ok: true, phone, nombre });
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

      const medico = await sql.medicoBuscarPorPhone(phone);
      if (!medico || !medico.activo || medico.password_hash !== hashPassword(password)) {
        return res.status(401).json({ error: "Teléfono o contraseña incorrectos" });
      }

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
    const id = await sql.consultaCrear({ medicoPhone, pacienteNombre });

    try {
      const { transcripcionCompleta, segmentos, duracionSegundos } =
        await transcribirConsultaMedica(audioBuffer);

      await sql.consultaMarcarCompletada(id, { transcripcionCompleta, segmentos, duracionSegundos });
      res.status(201).json({ ok: true, consulta: { id, pacienteNombre, estado: "completado", transcripcionCompleta, segmentos, duracionSegundos } });
    } catch (e) {
      log.error("[CONSULTA_MEDICA] Error transcribiendo:", e.response?.data || e.message);
      await sql.consultaMarcarError(id, e.response?.data?.error || e.message);
      res.status(502).json({ ok: false, error: "No se pudo transcribir el audio", consultaId: id });
    }
  });

  // ─── LISTAR CONSULTAS PROPIAS ───────────────────────────────────────────
  app.get("/medico/consultas", requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const consultas = await sql.consultaListarPorMedico(medicoPhone);
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
      const consulta = await sql.consultaObtenerDetalle(req.params.id, medicoPhone);
      if (!consulta) return res.status(404).json({ error: "Consulta no encontrada" });
      res.json({ consulta });
    } catch (e) {
      log.error("[MEDICO_CONSULTA_DETALLE]", e.message);
      res.status(500).json({ error: "Error obteniendo consulta" });
    }
  });
};
