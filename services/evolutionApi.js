// ChatGo Salud — Evolution API: envío de mensajes de WhatsApp para las
// reservas de citas de Vitalis (número separado del bot de taxis, que usa
// la API oficial de Meta). Evolution API hay que auto-hospedarla (Docker) y
// conectarla escaneando un QR con un número de WhatsApp normal — no es la
// API oficial de Meta, así que Meta podría banear el número si detecta uso
// automatizado. Ver la checklist de configuración.
const axios = require("axios");
const { CONFIG, log } = require("../config");

function configurado() {
  return Boolean(CONFIG.EVOLUTION_API_URL && CONFIG.EVOLUTION_API_KEY);
}

// Acepta el número en cualquier formato razonable; si viene sin código de
// país (8 dígitos, formato boliviano local) le agrega el 591.
function normalizarNumero(numero) {
  let n = String(numero || "").replace(/\D/g, "");
  if (n.length === 8) n = "591" + n;
  return n;
}

async function enviarTexto(numero, texto) {
  if (!configurado()) {
    log.warn("[EVOLUTION_API] No configurado (EVOLUTION_API_URL/EVOLUTION_API_KEY) — no se mandó el mensaje");
    return null;
  }
  const res = await axios.post(
    `${CONFIG.EVOLUTION_API_URL}/message/sendText/${CONFIG.EVOLUTION_INSTANCE}`,
    { number: normalizarNumero(numero), text: texto },
    { headers: { apikey: CONFIG.EVOLUTION_API_KEY }, timeout: 15000 }
  );
  return res.data;
}

// Extrae remitente + texto de un evento de webhook "message.upsert" de
// Evolution API. Devuelve null si no es un mensaje de texto entrante válido
// (mensajes propios, multimedia sin texto, etc.)
function parsearMensajeEntrante(body) {
  const data = body?.data;
  if (!data || data.key?.fromMe) return null;
  const texto = data.message?.conversation || data.message?.extendedTextMessage?.text;
  if (!texto) return null;
  const numero = String(data.key?.remoteJid || "").split("@")[0];
  if (!numero) return null;
  return { numero, texto: texto.trim(), nombre: data.pushName || "" };
}

module.exports = { configurado, enviarTexto, normalizarNumero, parsearMensajeEntrante };
