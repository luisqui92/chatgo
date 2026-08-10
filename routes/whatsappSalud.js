// ChatGo Salud — Estado del WhatsApp de reservas (Baileys): que el médico
// pueda ver desde la web si está conectado, o escanear el QR si no.
const { requireAuth } = require("../services/auth");
const { limitMedico } = require("../services/ratelimit");
const { obtenerEstado, reiniciarSesion } = require("../services/baileysWhatsapp");
const { asyncRoute } = require("../services/httpHelpers");

const requireMedico = requireAuth(["medico"]);

module.exports = function (app) {
  app.get("/medico/whatsapp/estado", requireMedico, asyncRoute(async (req, res) => {
    res.json(await obtenerEstado());
  }));

  // Para vincular un número distinto al que ya está conectado.
  app.post("/medico/whatsapp/reiniciar", limitMedico, requireMedico, asyncRoute(async (req, res) => {
    reiniciarSesion().catch(() => {}); // no bloquea la respuesta, la reconexión sigue sola
    res.json({ ok: true });
  }));
};
