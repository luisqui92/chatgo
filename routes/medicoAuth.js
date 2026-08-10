// ChatGo Salud — Registro y login de médicos (teléfono + contraseña).
const { Medico } = require("../db/models");
const { generarToken, hashPassword } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { asyncRoute, ErrorHttp } = require("../services/httpHelpers");

module.exports = function (app) {
  // ─── REGISTRO ───────────────────────────────────────────────────────────
  app.post("/medico/registro", limitMedico, asyncRoute(async (req, res) => {
    const phone = String(req.body?.phone || "").trim();
    const nombre = String(req.body?.nombre || "").trim();
    const especialidad = String(req.body?.especialidad || "").trim();
    const password = String(req.body?.password || "");
    if (!phone || !nombre) throw new ErrorHttp(400, "phone y nombre son requeridos");
    if (password.length < 8) throw new ErrorHttp(400, "La contraseña debe tener al menos 8 caracteres");

    const yaExiste = await Medico.findOne({ phone });
    if (yaExiste) throw new ErrorHttp(409, "Ese teléfono ya está registrado");

    const medico = await Medico.create({ phone, nombre, especialidad, passwordHash: hashPassword(password), activo: true });
    res.json({ ok: true, phone: medico.phone, nombre: medico.nombre });
  }));

  // ─── LOGIN (usuario = teléfono + contraseña) ────────────────────────────
  app.post("/medico/login", limitMedico, asyncRoute(async (req, res) => {
    const phone = String(req.body?.phone || "").trim();
    const password = String(req.body?.password || "");
    if (!phone || !password) throw new ErrorHttp(400, "phone y password son requeridos");

    const medico = await Medico.findOne({ phone, activo: true });
    if (!medico || medico.passwordHash !== hashPassword(password)) {
      throw new ErrorHttp(401, "Teléfono o contraseña incorrectos");
    }

    const token = generarToken(medico.phone, "medico");
    res.json({ token, phone: medico.phone, nombre: medico.nombre });
  }));
};
