// ChatGo Salud — genera la nota clínica estructurada a partir de la
// transcripción de una consulta (motivo, síntomas, diagnóstico, plan...),
// y detecta sugerencias nuevas para el Kardex (antecedentes, vacunas) que
// el médico puede aprobar con un toque. Es un segundo paso de IA, separado
// de la transcripción en sí.
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
  "proximoControl": "string o null",
  "antecedentesPersonalesNuevos": ["string", ...],
  "antecedentesFamiliaresNuevos": [{"parentesco":"string","condicion":"string"}],
  "vacunasMencionadas": [{"nombre":"string","dosis":"string o null","fecha":"YYYY-MM-DD o null"}]
}

Reglas:
- Si algo no se menciona en la transcripción, usá null o un array vacío.
- NUNCA inventes información clínica que no esté en el texto. Esto es un
  apoyo para el médico, no reemplaza su criterio profesional.
- "antecedentesPersonalesNuevos"/"antecedentesFamiliaresNuevos"/"vacunasMencionadas":
  te paso lo que el paciente YA tiene registrado (más abajo, si hay). Reportá
  SOLO lo que se menciona en esta transcripción y que NO esté ya en esa lista
  — no repitas algo que el paciente ya tenía anotado.`;

function construirContexto(contexto) {
  if (!contexto) return "";
  const partes = [];
  if (contexto.antecedentesPersonales?.length) {
    partes.push(`Antecedentes personales ya registrados: ${contexto.antecedentesPersonales.join("; ")}`);
  }
  if (contexto.antecedentesFamiliares?.length) {
    partes.push(`Antecedentes familiares ya registrados: ${contexto.antecedentesFamiliares.map(a => `${a.parentesco}: ${a.condicion}`).join("; ")}`);
  }
  if (contexto.medicamentosActivos?.length) {
    partes.push(`Medicamentos ya activos: ${contexto.medicamentosActivos.join(", ")}`);
  }
  if (partes.length === 0) return "";
  return `\n\n(Lo que el paciente ya tiene registrado, para no repetirlo como "nuevo":\n${partes.join("\n")})`;
}

async function generarNotaClinica(transcripcion, contexto) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPT_SISTEMA },
        { role: "user", content: transcripcion + construirContexto(contexto) },
      ],
      max_tokens: 1000,
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
