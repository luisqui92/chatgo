// ChatGo Salud — Centro de Estudios: laboratorios, radiografías, ecografías,
// tomografías, resonancias, ECG, fotos clínicas. Los archivos se guardan en
// disco fuera de /public (no quedan accesibles sin pasar por acá) y solo se
// sirven al médico dueño del paciente, igual que cualquier otro dato clínico.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Paciente, Estudio } = require("../db/models");
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

const DIR_ESTUDIOS = path.join(__dirname, "..", "uploads", "estudios");
fs.mkdirSync(DIR_ESTUDIOS, { recursive: true });

const EXT_POR_MIME = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "application/pdf": ".pdf",
};
function extensionParaMime(mime) {
  if (EXT_POR_MIME[mime]) return EXT_POR_MIME[mime];
  const sub = String(mime || "").split("/")[1];
  return sub ? "." + sub.replace(/[^a-z0-9]/gi, "").slice(0, 10) : ".bin";
}

// Acepta el archivo como body crudo, igual que el audio de las consultas.
const archivoRaw = express.raw({ type: ["image/*", "application/pdf"], limit: "20mb" });

module.exports = function (app) {
  // ─── SUBIR ESTUDIO ───────────────────────────────────────────────────────
  app.post("/medico/pacientes/:pacienteId/estudios", limitMedico, requireMedico, archivoRaw, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const paciente = await obtenerOFallar(Paciente, { _id: req.params.pacienteId, medicoPhone }, "Paciente no encontrado");

    const archivo = req.body;
    if (!Buffer.isBuffer(archivo) || archivo.length === 0) {
      throw new ErrorHttp(400, "Falta el archivo (Content-Type debe ser image/* o application/pdf)");
    }
    const nombre = String(req.query.nombre || "").trim();
    const fecha = req.query.fecha ? new Date(req.query.fecha) : null;
    if (!nombre || !fecha) throw new ErrorHttp(400, "nombre y fecha son requeridos");
    const tipo = String(req.query.tipo || "otro").trim();

    const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
    const archivoNombre = crypto.randomUUID() + extensionParaMime(mime);
    fs.writeFileSync(path.join(DIR_ESTUDIOS, archivoNombre), archivo);

    const estudio = await Estudio.create({
      pacienteId: paciente._id, medicoPhone, tipo, nombre,
      archivoNombre, archivoMime: mime, archivoTamano: archivo.length,
      fecha, notas: String(req.query.notas || "").trim(),
    });
    res.status(201).json({ ok: true, estudio });
  }));

  // ─── VER/DESCARGAR EL ARCHIVO ────────────────────────────────────────────
  app.get("/medico/estudios/:id/archivo", requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const estudio = await obtenerOFallar(Estudio, { _id: req.params.id, medicoPhone }, "Estudio no encontrado");
    const ruta = path.join(DIR_ESTUDIOS, estudio.archivoNombre);
    if (!fs.existsSync(ruta)) throw new ErrorHttp(404, "Archivo no encontrado");
    res.setHeader("Content-Type", estudio.archivoMime);
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.sendFile(ruta);
  }));

  // ─── ELIMINAR ────────────────────────────────────────────────────────────
  app.delete("/medico/estudios/:id", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    const medicoPhone = req.adminUser.usuario;
    const estudio = await Estudio.findOneAndDelete({ _id: req.params.id, medicoPhone });
    if (!estudio) throw new ErrorHttp(404, "Estudio no encontrado");
    fs.unlink(path.join(DIR_ESTUDIOS, estudio.archivoNombre), () => {});
    res.json({ ok: true });
  }));
};
