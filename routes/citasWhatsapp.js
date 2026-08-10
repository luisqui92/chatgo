// ChatGo Salud — Webhook de Evolution API: acá llegan los mensajes que los
// pacientes mandan al WhatsApp de reservas de Vitalis. No hay médico
// logueado en esta llamada (es Evolution API la que pega acá), así que el
// secreto va en la URL para que nadie más pueda mandar mensajes en tu nombre.
const { CONFIG, log } = require("../config");
const { parsearMensajeEntrante, enviarTexto } = require("../services/evolutionApi");
const { procesarMensajeEntrante } = require("../services/reservaCitas");

module.exports = function (app) {
  app.post("/webhook/vitalis-whatsapp/:secret", async (req, res) => {
    if (!CONFIG.EVOLUTION_WEBHOOK_SECRET || req.params.secret !== CONFIG.EVOLUTION_WEBHOOK_SECRET) {
      return res.sendStatus(403);
    }
    res.sendStatus(200); // Evolution API espera una respuesta rápida; el resto sigue solo

    try {
      const msg = parsearMensajeEntrante(req.body);
      if (!msg) return;
      const respuesta = await procesarMensajeEntrante(msg.numero, msg.texto, msg.nombre);
      if (respuesta) await enviarTexto(msg.numero, respuesta);
    } catch (e) {
      log.error("[VITALIS_WHATSAPP]", e.response?.data || e.message);
    }
  });
};
