// ChatGo Salud — Brief Clínico Inteligente: resumen ejecutivo del paciente,
// generado por IA a partir del historial de consultas, para que el médico
// lo lea ANTES de la próxima consulta. Se regenera solo cada vez que se
// completa la nota clínica de una consulta nueva de ese paciente.
const axios = require("axios");
const { CONFIG, log } = require("../config");
const { Paciente, ConsultaMedica } = require("../db/models");

const PROMPT_SISTEMA = `Eres un asistente clínico. A partir del historial de consultas anteriores
de un paciente (en español, ordenadas de la más vieja a la más nueva),
generá un "brief clínico" — un resumen ejecutivo para que el médico lo lea
ANTES de la próxima consulta.

RESPONDE SOLO JSON con esta estructura exacta:
{
  "estadoActual": "resumen breve del estado de salud actual del paciente",
  "cambiosDesdeUltimaConsulta": "qué cambió respecto a la consulta anterior, o null si el historial tiene una sola consulta",
  "medicamentosActivos": ["string", ...],
  "examenesPendientes": ["string", ...],
  "alertas": ["string", ...],
  "factoresRiesgo": ["string", ...],
  "preguntasSugeridas": ["string", ...],
  "diagnosticosDiferenciales": ["string", ...]
}

Reglas:
- Basate SOLO en el historial que te paso. NUNCA inventes datos clínicos que no estén ahí.
- "medicamentosActivos": los recetados en la consulta MÁS RECIENTE (asumí que siguen vigentes salvo que el historial diga lo contrario).
- "examenesPendientes": exámenes solicitados que no tengan resultado mencionado en una consulta posterior.
- Esto es una AYUDA para el médico, nunca reemplaza su criterio profesional — no lo repitas en el texto, pero tenelo presente en el tono (sugerí, no afirmes con certeza absoluta).
- Si el historial tiene una sola consulta, "cambiosDesdeUltimaConsulta" debe ser null.
- Usá arrays vacíos (no null) cuando no aplique una lista.`;

function formatearHistorial(consultas) {
  return consultas.map(c => {
    const n = c.notaClinica || {};
    const partes = [`Fecha: ${new Date(c.createdAt).toLocaleDateString("es-BO")}`];
    if (n.motivoConsulta) partes.push(`Motivo: ${n.motivoConsulta}`);
    if (n.sintomas?.length) partes.push(`Síntomas: ${n.sintomas.join(", ")}`);
    if (n.antecedentesRelevantes) partes.push(`Antecedentes: ${n.antecedentesRelevantes}`);
    if (n.diagnostico) partes.push(`Diagnóstico: ${n.diagnostico}`);
    if (n.plan) partes.push(`Plan: ${n.plan}`);
    if (n.medicamentosRecetados?.length) {
      partes.push(`Medicamentos: ${n.medicamentosRecetados.map(m => m.nombre + (m.dosis ? ` ${m.dosis}` : "") + (m.frecuencia ? ` (${m.frecuencia})` : "")).join(", ")}`);
    }
    if (n.examenesSolicitados?.length) partes.push(`Exámenes solicitados: ${n.examenesSolicitados.join(", ")}`);
    if (n.proximoControl) partes.push(`Próximo control: ${n.proximoControl}`);
    return partes.join("\n");
  }).join("\n\n---\n\n");
}

async function generarBrief(historialTexto) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPT_SISTEMA },
        { role: "user", content: historialTexto },
      ],
      max_tokens: 900,
      temperature: 0.2,
    },
    { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` }, timeout: CONFIG.TIMEOUT_OPENAI }
  );
  const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(content);
}

async function regenerarBriefClinico(pacienteId) {
  const paciente = await Paciente.findById(pacienteId);
  if (!paciente) return;

  const consultas = await ConsultaMedica.find({ pacienteId, estado: "completado", notaClinicaEstado: "completado" })
    .sort({ createdAt: 1 })
    .lean();
  if (consultas.length === 0) return; // nada todavía de donde armar un brief

  paciente.briefClinicoEstado = "generando";
  await paciente.save();

  try {
    const brief = await generarBrief(formatearHistorial(consultas));
    paciente.briefClinico = brief;
    paciente.briefClinicoEstado = "completado";
    paciente.briefClinicoActualizadoEn = new Date();
    await paciente.save();
  } catch (e) {
    log.error("[BRIEF_CLINICO]", e.response?.data || e.message);
    paciente.briefClinicoEstado = "error";
    paciente.briefClinicoError = e.message;
    await paciente.save();
  }
}

module.exports = { regenerarBriefClinico };
