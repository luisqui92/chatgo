// ChatGo — WhatsApp Cloud API
const axios = require("axios");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const url = require("url");
const os = require("os");
const FormData = require("form-data");
const { CONFIG, log } = require("../config");

async function enviarMensaje(to, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: texto } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] enviarMensaje:", e.response?.data?.error?.message || e.message);
  }
}

async function enviarBotones(to, texto, botones) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: texto },
          action: {
            buttons: botones.slice(0, 3).map(b => ({
              type: "reply",
              reply: { id: b.id, title: b.title.substring(0, 20) },
            })),
          },
        },
      },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] enviarBotones:", e.response?.data?.error?.message || e.message);
  }
}

async function enviarImagen(to, imageUrl, caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] enviarImagen:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarImagenPorId(to, imageId, caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { id: imageId, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarImagen:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarAudioPorId(to, audioId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "audio", audio: { id: audioId } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarAudio:", e.response?.data?.error?.message || e.message);
  }
}

// ─── ENVIAR VOZ (TTS): sube audio MP3 a WhatsApp y lo envía ─────────────────
// Replica el método probado del bot parroquial: FormData + Blob NATIVOS de Node 18+
// (NO la librería form-data, que Meta a veces rechaza).
async function enviarVoz(to, audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) {
    log.warn("[WSP] enviarVoz: buffer vacío");
    return false;
  }
  try {
    // 1) Subir el audio usando Blob + FormData nativos (igual que el bot que funcionaba)
    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const formData = new FormData();
    formData.append("file", blob, "audio.mp3");
    formData.append("messaging_product", "whatsapp");
    formData.append("type", "audio/mpeg");

    const upRes = await fetch(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
        body: formData,
      }
    );
    const upData = await upRes.json();
    if (!upData.id) {
      log.error(`[WSP] enviarVoz: error subiendo audio: ${JSON.stringify(upData)}`);
      return false;
    }
    log.info(`[WSP] enviarVoz: audio subido, media_id=${upData.id}`);

    // 2) Enviar el audio con el media_id
    const sendRes = await fetch(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "audio",
          audio: { id: upData.id },
        }),
      }
    );
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      log.error(`[WSP] enviarVoz: error enviando audio: ${JSON.stringify(sendData)}`);
      return false;
    }
    log.info(`[WSP] enviarVoz: audio enviado a ${to}`);
    return true;
  } catch (e) {
    log.error(`[WSP] enviarVoz falló: ${e.message}`);
    return false;
  }
}

async function reenviarVideoPorId(to, videoId, caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "video", video: { id: videoId, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarVideo:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarUbicacion(to, lat, lng, name = "", address = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "location", location: { latitude: lat, longitude: lng, name, address } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarUbicacion:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarDocumentoPorId(to, docId, filename = "", caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "document", document: { id: docId, filename, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarDocumento:", e.response?.data?.error?.message || e.message);
  }
}

async function relayMensajeChat(de, hacia, mensaje, etiquetaQuien) {
  if (mensaje.type === "text" && mensaje.text?.body?.trim()) {
    await enviarMensaje(hacia, `💬 *Mensaje de ${etiquetaQuien}:*\n${mensaje.text.body.trim()}`);
    return true;
  }
  if ((mensaje.type === "audio" || mensaje.type === "voice") && (mensaje.audio?.id || mensaje.voice?.id)) {
    await enviarMensaje(hacia, `🎤 _Audio de ${etiquetaQuien}:_`);
    await reenviarAudioPorId(hacia, mensaje.audio?.id || mensaje.voice?.id);
    return true;
  }
  if (mensaje.type === "image" && mensaje.image?.id) {
    const cap = mensaje.image.caption ? `📸 De ${etiquetaQuien}:\n${mensaje.image.caption}` : `📸 Foto de ${etiquetaQuien}`;
    await reenviarImagenPorId(hacia, mensaje.image.id, cap);
    return true;
  }
  if (mensaje.type === "video" && mensaje.video?.id) {
    const cap = mensaje.video.caption ? `🎥 De ${etiquetaQuien}:\n${mensaje.video.caption}` : `🎥 Video de ${etiquetaQuien}`;
    await reenviarVideoPorId(hacia, mensaje.video.id, cap);
    return true;
  }
  if (mensaje.type === "location" && mensaje.location) {
    const lat = parseFloat(mensaje.location.latitude ?? mensaje.location.lat);
    const lng = parseFloat(mensaje.location.longitude ?? mensaje.location.lng ?? mensaje.location.lon);
    if (!isNaN(lat) && !isNaN(lng)) {
      await enviarMensaje(hacia, `📍 _${etiquetaQuien.charAt(0).toUpperCase() + etiquetaQuien.slice(1)} comparte ubicación:_`);
      await reenviarUbicacion(hacia, lat, lng, mensaje.location.name || "", mensaje.location.address || "");
      return true;
    }
  }
  if (mensaje.type === "document" && mensaje.document?.id) {
    await reenviarDocumentoPorId(
      hacia,
      mensaje.document.id,
      mensaje.document.filename || "documento",
      mensaje.document.caption ? `📎 De ${etiquetaQuien}: ${mensaje.document.caption}` : `📎 Documento de ${etiquetaQuien}`
    );
    return true;
  }
  if (mensaje.type === "sticker") {
    await enviarMensaje(hacia, `🎨 ${etiquetaQuien.charAt(0).toUpperCase() + etiquetaQuien.slice(1)} te envió un sticker.`);
    return true;
  }
  return false;
}

async function descargarImagenMeta(mediaId) {
  const urlRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  const binRes = await axios.get(urlRes.data.url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  return Buffer.from(binRes.data);
}

async function obtenerUrlMedia(mediaId) {
  const res = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  return res.data.url;
}

function verificarFirmaMeta(req) {
  if (!CONFIG.META_APP_SECRET) return true; // advertencia ya logueada al inicio
  const sigHeader = req.headers["x-hub-signature-256"];
  if (!sigHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", CONFIG.META_APP_SECRET).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { enviarMensaje, enviarBotones, enviarImagen, enviarVoz, reenviarImagenPorId, reenviarAudioPorId, reenviarVideoPorId, reenviarUbicacion, reenviarDocumentoPorId, relayMensajeChat, descargarImagenMeta, obtenerUrlMedia, verificarFirmaMeta };
