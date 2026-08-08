// ChatGo Salud — Vinculación de celular como micrófono remoto.
// Pensado para médicos con computadora de escritorio sin micrófono: vinculan
// el celular una vez al día con un código, lo dejan al lado de la compu con
// la pantalla prendida, y desde la compu controlan cuándo arranca y termina
// la grabación (el celular pregunta cada 1-2s si hay una orden pendiente).
const { CONFIG, log } = require("../config");
const { Vinculacion } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { fechaStrBolivia } = require("../services/utils");

const requireMedico = requireAuth(["medico"]);

function generarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
}

// Trae (o crea) la vinculación de hoy para este médico. Si cambió el día
// desde la última vez, se resetea: código nuevo, desvinculado.
async function obtenerOCrearHoy(medicoPhone) {
  const hoy = fechaStrBolivia();
  let v = await Vinculacion.findOne({ medicoPhone });
  if (!v) {
    v = await Vinculacion.create({ medicoPhone, codigo: generarCodigo(), fechaStr: hoy });
  } else if (v.fechaStr !== hoy) {
    v.codigo = generarCodigo();
    v.fechaStr = hoy;
    v.vinculado = false;
    v.estado = "esperando";
    v.comandoPendiente = undefined;
    v.consultaId = null;
    await v.save();
  }
  return v;
}

module.exports = function (app) {
  // ─── ESTADO ACTUAL (compu y celular la usan para saber qué pasa) ───────
  app.get("/medico/vinculacion", requireMedico, async (req, res) => {
    try {
      const v = await obtenerOCrearHoy(req.adminUser.usuario);
      res.json({ vinculacion: v });
    } catch (e) {
      log.error("[VINCULACION_GET]", e.message);
      res.status(500).json({ error: "Error obteniendo la vinculación" });
    }
  });

  // ─── EL CELULAR CONFIRMA EL CÓDIGO ──────────────────────────────────────
  app.post("/medico/vinculacion/vincular", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const codigo = String(req.body?.codigo || "").trim();
      const v = await obtenerOCrearHoy(medicoPhone);
      if (codigo !== v.codigo) return res.status(401).json({ error: "Código incorrecto" });
      v.vinculado = true;
      v.estado = "armado";
      await v.save();
      res.json({ ok: true, vinculacion: v });
    } catch (e) {
      log.error("[VINCULACION_VINCULAR]", e.message);
      res.status(500).json({ error: "Error vinculando el celular" });
    }
  });

  // ─── LA COMPU MANDA UNA ORDEN (iniciar/detener) ─────────────────────────
  app.post("/medico/vinculacion/comando", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const accion = String(req.body?.accion || "").trim();
      if (!["iniciar", "detener"].includes(accion)) return res.status(400).json({ error: "accion inválida" });

      const v = await obtenerOCrearHoy(medicoPhone);
      if (!v.vinculado) return res.status(409).json({ error: "Todavía no hay ningún celular vinculado hoy" });

      v.comandoPendiente = {
        accion,
        pacienteId: req.body?.pacienteId || null,
        pacienteNombre: req.body?.pacienteNombre || "",
        emitidoEn: new Date(),
      };
      await v.save();
      res.json({ ok: true, vinculacion: v });
    } catch (e) {
      log.error("[VINCULACION_COMANDO]", e.message);
      res.status(500).json({ error: "Error mandando el comando" });
    }
  });

  // ─── EL CELULAR REPORTA QUE CAMBIÓ DE ESTADO (y limpia la orden) ───────
  app.post("/medico/vinculacion/estado", limitMedico, requireMedico, async (req, res) => {
    try {
      const medicoPhone = req.adminUser.usuario;
      const estado = String(req.body?.estado || "").trim();
      if (!["armado", "grabando"].includes(estado)) return res.status(400).json({ error: "estado inválido" });

      const v = await obtenerOCrearHoy(medicoPhone);
      v.estado = estado;
      v.comandoPendiente = undefined;
      v.consultaId = req.body?.consultaId || (estado === "grabando" ? null : v.consultaId);
      await v.save();
      res.json({ ok: true, vinculacion: v });
    } catch (e) {
      log.error("[VINCULACION_ESTADO]", e.message);
      res.status(500).json({ error: "Error actualizando el estado" });
    }
  });
};
