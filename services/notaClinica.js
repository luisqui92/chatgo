// ChatGo Salud — genera la nota clínica estructurada a partir de la
// transcripción de una consulta (motivo, síntomas, diagnóstico, plan...).
// Es un segundo paso de IA, separado de la transcripción en sí.
const axios = require("axios");
const { CONFIG, log } = require("../config");

const PROMPT_SISTEMA = `Eres un asistente clínico. A partir de la transcripción de una consulta
médica en español (puede tener errores de transcripción, y a veces no queda
100% claro quién es el médico y quién el paciente), generá una nota clínica
estructurada.

RESPONDE SOLO JSON con esta estructura exacta:
{
  "motivoConsulta": "string breve o null",
  "sintomas": ["string", ...],
  "antecedentesRelevantes": "string o null",
  "diagnostico": "string o null",
  "diagnosticosDiferenciales": ["string", ...],
  "plan": "string o null",
  "medicamentosRecetados": [{"nombre":"string","dosis":"string o null","frecuencia":"string o null"}],
  "examenesSolicitados": ["string", ...],
  "proximoControl": "string o null"
}

Si algo no se menciona en la transcripción, usá null o un array vacío.
NUNCA inventes información clínica que no esté en el texto. Esto es un
apoyo para el médico, no reemplaza su criterio profesional.`;

async function generarNotaClinica(transcripcion) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPT_SISTEMA },
        { role: "user", content: transcripcion },
      ],
      max_tokens: 800,
      temperature: 0.1,
    },
    {
      headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` },
      timeout: CONFIG.TIMEOUT_OPENAI,
    }
  );
  const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(content);
}

module.exports = { generarNotaClinica };
