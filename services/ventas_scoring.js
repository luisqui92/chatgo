// Evaluación de una conversación de ventas con Claude (Anthropic Messages API).
// Devuelve el JSON estructurado del rubro y VALIDA que cada score tenga evidencia
// citada antes de aceptarlo. Sistema separado de ChatGo.
const axios = require("axios");
const { CONFIG, log } = require("../config");
const RUBRO = require("../config/rubro_ventas");

const DIMS = RUBRO.dimensiones.map(d => d.key);

function extraerJSON(txt) {
  if (!txt) return null;
  const m = txt.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : txt); } catch { return null; }
}

// Valida el output: 6 scores 1-10 + cada fortaleza/debilidad con cita no vacía
function validar(ev) {
  if (!ev || !ev.scores) return "Falta el objeto scores.";
  for (const k of DIMS) {
    const s = ev.scores[k];
    if (typeof s !== "number" || s < 1 || s > 10) return `Score inválido en "${k}" (debe ser 1-10).`;
  }
  const conCita = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every(x => x && x.texto && x.cita && String(x.cita).trim().length > 0);
  if (!conCita(ev.fortalezas)) return "Cada fortaleza necesita una cita textual.";
  if (!conCita(ev.debilidades)) return "Cada debilidad necesita una cita textual.";
  if (!ev.mejora_concreta || !String(ev.mejora_concreta).trim()) return "Falta la mejora concreta.";
  return null;
}

function promedio(scores) {
  const v = DIMS.map(k => scores[k]);
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
}

async function evaluarConversacion(conversacion, vendedorId) {
  if (!CONFIG.OPENAI_KEY) throw new Error("Falta OPENAI_KEY en el .env.");
  if (!conversacion || conversacion.trim().length < 20) throw new Error("La conversación es muy corta o está vacía. No se evalúa sin contexto real.");

  const dimsTxt = RUBRO.dimensiones.map((d, i) => `${i + 1}. ${d.nombre} (${d.key}): ${d.desc}`).join("\n");
  const system =
    "Sos un evaluador experto de conversaciones de ventas por WhatsApp. Tu objetivo es COACHING y MEJORA, " +
    "no despido ni ranking punitivo, así que el tono debe ser constructivo. Evaluás EXCLUSIVAMENTE con el rubro " +
    "dado, con escala " + RUBRO.escala + ". " + RUBRO.regla + " " +
    "NUNCA inventes evidencia: si algo no está en la conversación, no lo afirmes. " +
    "Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, con exactamente esta forma:\n" +
    '{ "scores": { ' + DIMS.map(k => `"${k}": <1-10>`).join(", ") + " }, " +
    '"fortalezas": [{ "texto": "...", "cita": "cita textual de la conversación" }], ' +
    '"debilidades": [{ "texto": "...", "cita": "cita textual de la conversación" }], ' +
    '"mejora_concreta": "una acción específica y accionable, no genérica", ' +
    '"analisis": { ' +
      '"probabilidad_cierre": <0-100, probabilidad de que la venta se cierre>, ' +
      '"factores": [{ "tipo": "positivo"|"riesgo", "texto": "factor breve, ej: Cliente preguntó por precio / Falta hablar de garantía" }], ' +
      '"emocion_cliente": "entusiasmado"|"indeciso"|"molesto"|"perdido"|"neutral", ' +
      '"emocion_evolucion": ["emocion al inicio", "...", "emocion al final"], ' +
      '"respuesta_ideal": { "situacion": "qué preguntó/dijo el cliente", "respuesta_actual": "lo que el vendedor respondió (cita)", "respuesta_ideal": "cómo debió responder para vender más" }, ' +
      '"dinero_perdido_bs": <número en bolivianos estimado que se pudo perder por errores, o 0>, ' +
      '"resumen_ejecutivo": "2-3 frases para un gerente, tono profesional", ' +
      '"alertas_riesgo": ["promesas o descuentos riesgosos / fuera de política que hizo el vendedor, si los hay"] ' +
    "} }";

  const userMsg = "RUBRO (6 dimensiones):\n" + dimsTxt + "\n\nCONVERSACIÓN A EVALUAR:\n\"\"\"\n" + conversacion.slice(0, 20000) + "\n\"\"\"";

  let data;
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: CONFIG.VENTAS_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
    }, {
      headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}`, "Content-Type": "application/json" },
      timeout: 90000,
    });
    data = res.data;
  } catch (e) {
    const det = e.response?.data?.error?.message || e.message;
    log.error("[VENTAS_SCORING]", det);
    throw new Error("OpenAI: " + det);
  }

  const txt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  const ev = extraerJSON(txt);
  const err = validar(ev);
  if (err) throw new Error("La evaluación no cumple el rubro: " + err);

  // Análisis extendido (best-effort: si algún campo no vino, no rompe)
  const a = ev.analisis || {};
  const analisis = {
    probabilidadCierre: typeof a.probabilidad_cierre === "number" ? Math.max(0, Math.min(100, Math.round(a.probabilidad_cierre))) : null,
    factores: Array.isArray(a.factores) ? a.factores : [],
    emocionCliente: a.emocion_cliente || null,
    emocionEvolucion: Array.isArray(a.emocion_evolucion) ? a.emocion_evolucion : [],
    respuestaIdeal: a.respuesta_ideal || null,
    dineroPerdido: typeof a.dinero_perdido_bs === "number" ? Math.round(a.dinero_perdido_bs) : null,
    resumenEjecutivo: a.resumen_ejecutivo || null,
    alertasRiesgo: Array.isArray(a.alertas_riesgo) ? a.alertas_riesgo.filter(Boolean) : [],
  };

  return {
    vendedorId,
    scores: ev.scores,
    promedio: promedio(ev.scores),
    fortalezas: ev.fortalezas,
    debilidades: ev.debilidades,
    mejora_concreta: ev.mejora_concreta,
    analisis,
  };
}

module.exports = { evaluarConversacion, validar, promedio, DIMS };
