// ChatGo — OpenAI (Whisper + GPT)
const axios = require("axios");
const https = require("https");
const http = require("http");
const url = require("url");
const os = require("os");
const FormData = require("form-data");
const { CONFIG, log } = require("../config");

async function transcribirAudio(audioUrl) {
  const audioRes = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  const formData = new FormData();
  formData.append("file", Buffer.from(audioRes.data), { filename: "audio.ogg", contentType: "audio/ogg" });
  formData.append("model", "whisper-1");
  formData.append("language", "es");

  const res = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    {
      headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}`, ...formData.getHeaders() },
      timeout: CONFIG.TIMEOUT_OPENAI,
    }
  );
  return res.data.text;
}

async function extraerUbicaciones(texto) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Eres un asistente de taxi en Cochabamba, Bolivia. Tu única tarea es extraer el origen y destino de mensajes de voz.

REGLA MÁS IMPORTANTE: SIEMPRE extrae origen y destino aunque no conozcas las calles. Las calles de Cochabamba pueden ser desconocidas — eso es normal. Extrae el texto EXACTAMENTE como lo dijo el pasajero.

Responde SOLO JSON: {"origen": "texto exacto", "destino": "texto exacto"}
Si no hay alguno, usa null.

Patrones de extracción:
- "desde X hasta Y" → origen=X, destino=Y
- "de X a Y" → origen=X, destino=Y  
- "quiero ir de X a Y" → origen=X, destino=Y
- "recógeme en X y llévame a Y" → origen=X, destino=Y
- "estoy en X" → origen=X, destino=null
- "llévame a X" → origen=null, destino=X
- "quiero ir a X" → origen=null, destino=X

Contexto local (ayuda a limpiar el texto):
- "esquina", "esq", "con", "y" entre calles = intersección, escríbelo como "Calle A esquina Calle B"
- "Papa Paulo" = "Av. Papa Paulo" (avenida real en Cochabamba)
- "16 de Julio" = calle real en Cochabamba
- "Jata" = calle real en Cochabamba

Ejemplos:
- "quiero ir desde la avenida Papa Paulo y Venezuela hasta la calle 16 de Julio y Jata" → {"origen": "Av. Papa Paulo esquina Venezuela", "destino": "calle 16 de Julio esquina Jata"}
- "recógeme en la Cancha esquina Punata y llévame al hospital Viedma" → {"origen": "mercado la Cancha esquina Punata", "destino": "hospital Viedma"}
- "estoy en Heroínas con Ayacucho" → {"origen": "Av. Heroínas esquina Ayacucho", "destino": null}

NUNCA devuelvas null si hay referencias de calles en el texto, aunque no las conozcas.
NUNCA el origen y destino pueden ser el mismo lugar.`,
          },
          { role: "user", content: texto },
        ],
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` },
        timeout: CONFIG.TIMEOUT_OPENAI,
      }
    );
    const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(content);
  } catch {
    return { origen: null, destino: null };
  }
}

async function validarComprobantePago(imageBase64) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `¿Esta imagen es un comprobante de pago válido (captura de transferencia, QR pagado, Tigo Money, banco, etc.)?
JSON:
{
  "es_comprobante": true/false,
  "monto": "monto si es visible o null",
  "tipo": "transferencia/qr/tigo_money/otro/ninguno"
}
Solo JSON.`,
              },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            ],
          },
        ],
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` },
        timeout: CONFIG.TIMEOUT_OPENAI,
      }
    );
    const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(content);
  } catch (e) {
    log.error("[VALIDAR_COMPROBANTE]", e.message);
    return { es_comprobante: false, _error: true };
  }
}

module.exports = { transcribirAudio, extraerUbicaciones, validarComprobantePago };
