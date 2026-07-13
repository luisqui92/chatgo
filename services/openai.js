// ChatGo — OpenAI (Whisper + GPT)
const axios = require("axios");
const https = require("https");
const http = require("http");
const url = require("url");
const os = require("os");
const FormData = require("form-data");
const { CONFIG, log } = require("../config");

async function transcribirAudioConModelo(audioBuffer, modelo, filename = "audio.ogg", contentType = "audio/ogg") {
  const formData = new FormData();
  formData.append("file", Buffer.from(audioBuffer), { filename, contentType });
  formData.append("model", modelo);
  formData.append("language", "es");
  // Prompt con lugares locales para mejorar reconocimiento de nombres de Cochabamba
  // (evita errores como "Juan de la Rosa" -> "Juan de la tosa"). Se pueden agregar mas lugares.
  formData.append("prompt", "Pedido de taxi en Cochabamba, Bolivia. Lugares y barrios comunes: Juan de la Rosa, Plaza Sucre, Plaza Colon, Plaza 14 de Septiembre, Plaza Quintanilla, Plazuela Constitucion, Cala Cala, Sarco, Tupuraya, Recoleta, Las Cuadras, Sacaba, Quillacollo, Tiquipaya, Vinto, Colcapirhua, Mayorazgo, Temporal, Hipodromo, Muyurina, Pacata, Sarcobamba, Villa Busch, Alalay, Ticti, Itocta, Valle Hermoso, Piñami, UMSS, Cine Center, Mercado La Cancha, Mercado 25 de Mayo, Aeropuerto Wilstermann, Hospital Viedma, Hospital del Niño, Avenida America, Avenida Heroinas, Avenida Ayacucho, Avenida Blanco Galindo, Avenida Circunvalacion, Avenida Villazon, Avenida Pando, Avenida Melchor Perez, Avenida Oquendo, Calle Jordan.");

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

async function transcribirAudio(audioUrl) {
  const audioRes = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  // Intentar primero con el modelo nuevo (gpt-4o-transcribe = menos errores).
  // Si falla por cualquier razon (ej: formato ogg), usar whisper-1 como respaldo.
  try {
    return await transcribirAudioConModelo(audioRes.data, "gpt-4o-transcribe");
  } catch (e) {
    log.warn("[TRANSCRIBIR] gpt-4o-transcribe fallo, usando whisper-1:", e.response?.data?.error?.message || e.message);
    return await transcribirAudioConModelo(audioRes.data, "whisper-1");
  }
}

async function extraerUbicacionesDetalle(texto) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Eres un asistente de taxi en Cochabamba, Bolivia. Extraes origen y destino de mensajes de voz/texto.

RESPONDE SOLO JSON con esta estructura exacta:
{
  "origen": {
    "tipo": "esquina" | "lugar" | "personal" | "vago" | null,
    "texto": "texto descriptivo",
    "calle1": "primera calle (solo si tipo=esquina)",
    "calle2": "segunda calle (solo si tipo=esquina)",
    "zona": "centro / sur / norte / sacaba / quillacollo / etc (si se menciona)",
    "lugar_personal": "casa / trabajo / null"
  },
  "destino": { ...mismo formato... }
}

REGLAS:

1. **tipo="esquina"** cuando hay DOS calles conectadas con "esquina", "esq", "con", "y", "entre":
   - "Ayacucho y Sucre" → calle1=Ayacucho, calle2=Sucre, tipo=esquina
   - "Av. América esquina Pando" → calle1=Av. América, calle2=Pando
   - "Heroínas con San Martín" → calle1=Heroínas, calle2=San Martín
   - "entre Beni y Potosí" → si solo hay 1 referencia previa de calle, NO es esquina; pero "Av. América entre Beni y Potosí" → calle1=Av. América, calle2=Beni (tomar la primera)

2. **tipo="lugar"** cuando es un sitio con nombre propio:
   - "Cine Center", "UMSS", "Aeropuerto Wilstermann", "Mall Las Américas", "Plaza Colón", "Hospital Viedma", "Mercado La Cancha"
   - IMPORTANTE: si el texto dice "Plaza", "Plazuela", "Mercado", "Parque", "Hospital", "Mall", "Cine", "Estadio", "Coliseo", "Terminal" seguido de un nombre, ESE TIPO ES PARTE DEL NOMBRE y se conserva completo en "texto".
     - "Plaza Sucre" → texto="Plaza Sucre" (NO "Sucre", que es una calle distinta)
     - "Mercado 25 de Mayo" → texto="Mercado 25 de Mayo" (NO "25 de Mayo")
     - "Plazuela Constitución" → texto="Plazuela Constitución"
   - NUNCA recortes el tipo de lugar. "Plaza X" jamás debe quedar solo como "X".

3. **tipo="personal"** cuando el usuario dice algo propio:
   - "mi casa", "casa", "a casa", "estoy en casa" → lugar_personal="casa"
   - "mi trabajo", "al trabajo", "la oficina", "mi oficina" → lugar_personal="trabajo"
   - ⚠️ CASA DE OTRA PERSONA: "casa de Ana", "donde mi tía", "la casa de mi hermano"
     NO es la casa del usuario. Usar tipo="personal", lugar_personal=null,
     texto=frase completa en minúsculas (ej: "casa de ana") — es un lugar con alias propio.

4. **tipo="vago"** cuando es una zona/calle SIN suficiente especificidad:
   - "Cala Cala" sola (zona muy grande)
   - "el centro", "la cancha" sola
   - "Av. América" sin esquina (avenida muy larga)
   - "Sacaba" sola, "Quillacollo" sola
   - "Recoleta" sola, "Sarco" solo, "Tupuraya" solo
   - Una calle sola: "Ayacucho", "Heroínas", "Sucre"

5. **Detectar zona** si el usuario la menciona:
   - "Ayacucho de Sacaba" → zona="sacaba"
   - "centro" → zona="centro"
   - "del norte" → zona="norte"

EJEMPLOS:

Texto: "quiero ir desde Ayacucho y Sucre hasta el Cine Center"
JSON: {"origen": {"tipo":"esquina","texto":"Ayacucho y Sucre","calle1":"Ayacucho","calle2":"Sucre","zona":null,"lugar_personal":null}, "destino": {"tipo":"lugar","texto":"Cine Center","calle1":null,"calle2":null,"zona":null,"lugar_personal":null}}

Texto: "estoy en Cala Cala y voy a UMSS"
JSON: {"origen": {"tipo":"vago","texto":"Cala Cala","calle1":null,"calle2":null,"zona":null,"lugar_personal":null}, "destino": {"tipo":"vago","texto":"UMSS","calle1":null,"calle2":null,"zona":null,"lugar_personal":null}}

(UMSS también es vago porque tiene varias puertas — Medicina, Economía, etc.)

Texto: "llévame a mi casa"
JSON: {"origen": null, "destino": {"tipo":"personal","texto":"mi casa","calle1":null,"calle2":null,"zona":null,"lugar_personal":"casa"}}

Texto: "estoy en mi trabajo, llévame a la plaza 14 de septiembre"
JSON: {"origen": {"tipo":"personal","texto":"mi trabajo","calle1":null,"calle2":null,"zona":null,"lugar_personal":"trabajo"}, "destino": {"tipo":"lugar","texto":"Plaza 14 de Septiembre","calle1":null,"calle2":null,"zona":null,"lugar_personal":null}}

Texto: "de Heroínas y San Martín al hospital Viedma"
JSON: {"origen": {"tipo":"esquina","texto":"Heroínas y San Martín","calle1":"Heroínas","calle2":"San Martín","zona":null,"lugar_personal":null}, "destino": {"tipo":"lugar","texto":"Hospital Viedma","calle1":null,"calle2":null,"zona":null,"lugar_personal":null}}

Texto: "quiero ir al estadio"
JSON: {"origen": null, "destino": {"tipo":"vago","texto":"Estadio","calle1":null,"calle2":null,"zona":null,"lugar_personal":null}}

Texto: "quiero ir de mi casa a la casa de Ana"
JSON: {"origen": {"tipo":"personal","texto":"mi casa","calle1":null,"calle2":null,"zona":null,"lugar_personal":"casa"}, "destino": {"tipo":"personal","texto":"casa de ana","calle1":null,"calle2":null,"zona":null,"lugar_personal":null}}

(Estadio Capriles es grande, varias entradas — vago)

NUNCA inventes calles. Si solo hay 1 calle, NO es esquina.
NUNCA origen y destino iguales.`,
          },
          { role: "user", content: texto },
        ],
        max_tokens: 400,
        temperature: 0.1,
      },
      {
        headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` },
        timeout: CONFIG.TIMEOUT_OPENAI,
      }
    );
    const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(content);
  } catch (e) {
    return { origen: null, destino: null };
  }
}

// ─── WRAPPER de compatibilidad ──────────────────────────────────────────────
// El código viejo espera {origen: "texto", destino: "texto"}
// El nuevo devuelve {origen: {tipo, texto, calle1, calle2, ...}, destino: {...}}
// Esta función devuelve AMBOS formatos a la vez
async function extraerUbicaciones(texto) {
  const detalle = await extraerUbicacionesDetalle(texto);
  return {
    // Formato viejo (compatibilidad)
    origen: detalle.origen?.texto || null,
    destino: detalle.destino?.texto || null,
    // Formato nuevo (con detalles)
    origenDetalle: detalle.origen || null,
    destinoDetalle: detalle.destino || null,
  };
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

// ─── TEXT-TO-SPEECH: genera audio amigable desde texto (modo adulto mayor) ──
// Devuelve un Buffer con el audio MP3 (formato probado con WhatsApp).
// Usa la API de TTS de OpenAI. Voz "nova" = femenina, natural en español.
async function generarAudioDesdeTexto(texto, voz = "nova") {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      {
        model: "tts-1",
        voice: voz,
        speed: 1.15,
        input: texto.substring(0, 600),
        response_format: "mp3",
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000, // 60s específico para TTS (más margen que el general)
        responseType: "arraybuffer",
      }
    );
    const buffer = Buffer.from(res.data);
    log.info(`[TTS] Audio MP3 generado OK (${buffer.length} bytes)`);
    return buffer;
  } catch (e) {
    let detalle = e.message;
    if (e.response?.data) {
      try { detalle = Buffer.from(e.response.data).toString("utf8"); } catch {}
    }
    log.error(`[TTS] Falló: ${detalle}`);
    return null;
  }
}

// Transcribe audio grabado en el NAVEGADOR (canal web): webm/opus o mp4
// según el dispositivo. Mismo motor y mismo prompt de lugares de Cochabamba.
async function transcribirAudioWeb(audioBuffer, mime = "audio/webm") {
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("mpeg") ? "mp3" : mime.includes("ogg") ? "ogg" : "webm";
  try {
    return await transcribirAudioConModelo(audioBuffer, "gpt-4o-transcribe", `audio.${ext}`, mime);
  } catch (e) {
    log.warn("[TRANSCRIBIR_WEB] gpt-4o-transcribe fallo, usando whisper-1:", e.response?.data?.error?.message || e.message);
    return await transcribirAudioConModelo(audioBuffer, "whisper-1", `audio.${ext}`, mime);
  }
}

module.exports = { transcribirAudio, transcribirAudioWeb, extraerUbicaciones, validarComprobantePago, generarAudioDesdeTexto };
