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

3. **tipo="personal"** cuando el usuario dice algo propio:
   - "mi casa", "casa", "a casa", "estoy en casa" → lugar_personal="casa"
   - "mi trabajo", "al trabajo", "la oficina", "mi oficina" → lugar_personal="trabajo"

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
