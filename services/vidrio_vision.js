// Lee una FOTO de medidas anotadas (a mano o impresas) y extrae las piezas de
// vidrio con IA de visión (OpenAI gpt-4o). Devuelve una lista para que el
// operario la CORROBORE antes de calcular. Reusa OPENAI_KEY.
const axios = require("axios");
const { CONFIG, log } = require("../config");

function extraerJSON(txt) {
  if (!txt) return null;
  const m = txt.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : txt); } catch { return null; }
}

// imagenDataUrl: "data:image/jpeg;base64,...."
async function extraerMedidasDeFoto(imagenDataUrl) {
  if (!CONFIG.OPENAI_KEY) throw new Error("Falta OPENAI_KEY en el .env.");
  if (!imagenDataUrl || !/^data:image\//.test(imagenDataUrl)) throw new Error("Imagen inválida.");

  const system =
    "Sos el asistente de una vidriería en Bolivia. En la foto hay MEDIDAS de vidrios " +
    "anotadas (a mano o impresas). Tu tarea es leer cada pieza y devolver sus medidas. " +
    "REGLAS: 1) Convertí TODO a centímetros. Si un número trae decimales y es menor a 10 " +
    "(ej 1.20, 0.80) es METROS → multiplicá por 100. Si es un entero de 2-3 dígitos (ej 120, 80) " +
    "ya está en cm. 2) 'ancho x alto' o 'base x altura': el primero es ancho, el segundo alto. " +
    "3) Detectá la CANTIDAD si dice '2 de', 'x3', etc. (por defecto 1). 4) Si aparece el tipo de " +
    "vidrio (doble, 4mm, bronce, incoloro, espejo, catedral), ponelo. 5) Si NO estás seguro de una " +
    "medida, bajá su 'confianza'. NUNCA inventes medidas que no ves. " +
    "Respondé SOLO un JSON con esta forma: " +
    '{ "piezas": [{ "ancho_cm": <num>, "alto_cm": <num>, "cantidad": <num>, "tipo": "<texto o vacío>", "original": "<lo que dice el papel>", "confianza": <0-1> }], "nota": "<aclaración breve, ej: asumí metros>" }';

  let data;
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: CONFIG.CARP_VISION_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: [
          { type: "text", text: "Extraé todas las medidas de vidrio de esta foto." },
          { type: "image_url", image_url: { url: imagenDataUrl } },
        ] },
      ],
    }, {
      headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}`, "Content-Type": "application/json" },
      timeout: 60000,
    });
    data = res.data;
  } catch (e) {
    const det = e.response?.data?.error?.message || e.message;
    log.error("[VIDRIO_VISION]", det);
    throw new Error("OpenAI: " + det);
  }

  const txt = data.choices?.[0]?.message?.content || "";
  const ev = extraerJSON(txt);
  if (!ev || !Array.isArray(ev.piezas)) throw new Error("No pude leer medidas en la foto. Probá con una foto más clara y de cerca.");

  const piezas = ev.piezas
    .map(p => ({
      ancho: Math.round(Number(p.ancho_cm) || 0),
      alto: Math.round(Number(p.alto_cm) || 0),
      cantidad: Math.max(1, parseInt(p.cantidad) || 1),
      tipo: String(p.tipo || "").trim(),
      original: String(p.original || "").trim(),
      confianza: typeof p.confianza === "number" ? p.confianza : null,
    }))
    .filter(p => p.ancho > 0 && p.alto > 0);

  if (!piezas.length) throw new Error("No se detectaron medidas válidas en la foto.");
  return { piezas, nota: ev.nota || "" };
}

module.exports = { extraerMedidasDeFoto };
