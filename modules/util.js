// ChatGo — Plataforma modular: utilidades compartidas
//
// textoDeMensaje() unifica texto y voz: si el mensaje es una nota de voz la
// transcribe (gpt-4o-transcribe con fallback whisper-1, el mismo motor que el
// taxi), así todos los módulos aceptan respuestas habladas sin código extra.

const { log } = require("../config");
const { obtenerUrlMedia } = require("../services/whatsapp");
const { transcribirAudio } = require("../services/openai");

function esAudio(msg) {
  return (msg?.type === "audio" || msg?.type === "voice") && !!(msg.audio?.id || msg.voice?.id);
}

// Devuelve { texto, esVoz }. Para texto plano no cuesta nada;
// para audio transcribe una sola vez por mensaje.
async function textoDeMensaje(msg) {
  if (msg?.text?.body?.trim()) return { texto: msg.text.body.trim(), esVoz: false };
  if (esAudio(msg)) {
    try {
      const url = await obtenerUrlMedia(msg.audio?.id || msg.voice?.id);
      const transcripcion = await transcribirAudio(url);
      if (transcripcion?.trim()) {
        log.info(`[MODULOS] Audio transcrito: "${transcripcion.trim().substring(0, 80)}"`);
        return { texto: transcripcion.trim(), esVoz: true };
      }
    } catch (e) {
      log.error("[MODULOS] Error transcribiendo audio:", e.message);
    }
  }
  return { texto: "", esVoz: false };
}

module.exports = { esAudio, textoDeMensaje };
