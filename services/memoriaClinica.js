// ChatGo Salud — Memoria Clínica Conversacional: el médico pregunta en
// lenguaje natural sobre la historia de UN paciente puntual y la IA responde
// basándose solo en lo que hay registrado (nunca inventa, nunca da consejo
// médico nuevo). No queda guardado en la base — es una consulta puntual.
const axios = require("axios");
const { CONFIG, log } = require("../config");

const PROMPT_SISTEMA = `Sos un asistente clínico que responde preguntas de un médico sobre la
historia de UN paciente puntual, en español. Abajo te paso TODA la
información registrada de ese paciente: antecedentes, medicamentos,
vacunas, mediciones (evolución clínica), estudios y un resumen de cada
consulta anterior.

Reglas:
- Respondé SOLO con información que esté en el contexto que te paso. Si no
  está, decilo claramente ("No tengo esa información registrada") — nunca
  inventes ni asumas.
- Sé breve y directo, como si le contestaras a un colega médico.
- Si la respuesta depende de una fecha o consulta puntual, mencioná la fecha.
- No dés consejos médicos nuevos ni diagnósticos — solo reportá lo que ya
  está en el historial.`;

function fechaStr(d) {
  return d ? new Date(d).toLocaleDateString("es-BO") : "";
}

function construirContextoPaciente(ctx) {
  const partes = [`Paciente: ${ctx.nombre}${ctx.edad != null ? `, ${ctx.edad} años` : ""}${ctx.sexo ? `, ${ctx.sexo}` : ""}`];

  if (ctx.antecedentesPersonales?.length) {
    partes.push(`Antecedentes personales: ${ctx.antecedentesPersonales.join("; ")}`);
  }
  if (ctx.antecedentesFamiliares?.length) {
    partes.push(`Antecedentes familiares: ${ctx.antecedentesFamiliares.map(a => `${a.parentesco}: ${a.condicion}`).join("; ")}`);
  }
  if (ctx.medicamentos?.length) {
    partes.push("Medicamentos:\n" + ctx.medicamentos.map(m =>
      `- ${m.nombre}${m.dosis ? " " + m.dosis : ""}${m.frecuencia ? " (" + m.frecuencia + ")" : ""} — ${m.fechaFin ? "finalizado " + fechaStr(m.fechaFin) : "activo"}`
    ).join("\n"));
  }
  if (ctx.vacunas?.length) {
    partes.push("Vacunas:\n" + ctx.vacunas.map(v => `- ${v.nombre}${v.dosis ? " " + v.dosis : ""} (${fechaStr(v.fecha)})`).join("\n"));
  }
  if (ctx.mediciones?.length) {
    partes.push("Mediciones (evolución clínica):\n" + ctx.mediciones.map(m =>
      `- ${m.tipo}: ${m.valor}${m.valorSecundario != null ? "/" + m.valorSecundario : ""} (${fechaStr(m.fecha)})`
    ).join("\n"));
  }
  if (ctx.estudios?.length) {
    partes.push("Estudios cargados:\n" + ctx.estudios.map(e => `- ${e.tipo}: ${e.nombre} (${fechaStr(e.fecha)})`).join("\n"));
  }
  if (ctx.consultas?.length) {
    partes.push("Historial de consultas (de la más vieja a la más nueva):\n" + ctx.consultas.map(c => {
      const n = c.notaClinica || {};
      const campos = [
        n.motivoConsulta && `Motivo: ${n.motivoConsulta}`,
        n.sintomas?.length && `Síntomas: ${n.sintomas.join(", ")}`,
        n.diagnostico && `Diagnóstico: ${n.diagnostico}`,
        n.plan && `Plan: ${n.plan}`,
        n.medicamentosRecetados?.length && `Recetado: ${n.medicamentosRecetados.map(m => m.nombre).join(", ")}`,
      ].filter(Boolean).join(" | ");
      return `- [${fechaStr(c.createdAt)}] ${campos || "(sin nota clínica)"}`;
    }).join("\n"));
  }
  return partes.join("\n\n");
}

async function responderPregunta(pregunta, ctx) {
  const contexto = construirContextoPaciente(ctx);
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPT_SISTEMA },
        { role: "user", content: `Datos del paciente:\n\n${contexto}\n\n---\n\nPregunta del médico: ${pregunta}` },
      ],
      max_tokens: 500,
      temperature: 0.2,
    },
    { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` }, timeout: CONFIG.TIMEOUT_OPENAI }
  );
  return res.data.choices[0].message.content.trim();
}

module.exports = { responderPregunta };
