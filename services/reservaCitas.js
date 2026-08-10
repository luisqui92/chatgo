// ChatGo Salud — Reserva de citas por WhatsApp: conversación guiada con
// opciones numeradas (no IA libre) — para algo tan estructurado como elegir
// un turno, una máquina de estados es más confiable que dejar que el
// paciente escriba libre y una IA interprete la fecha/hora.
const { Medico, Paciente, Cita, SesionCitaWA } = require("../db/models");
const { obtenerHorariosDisponibles, horarioSigueLibre } = require("./agenda");
const { crearEvento, eliminarEvento } = require("./googleCalendar");
const { CONFIG } = require("../config");

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function formatearDia(fechaStr) {
  const d = new Date(fechaStr + "T00:00:00");
  return `${DIAS_SEMANA[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}
function formatearHora(fecha) {
  return new Date(fecha).toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function formatearFechaCompleta(fecha) {
  return new Date(fecha).toLocaleString("es-BO", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function obtenerSesion(numero) {
  const doc = await SesionCitaWA.findOne({ numero }).lean();
  return doc || { numero, paso: "inicio", datos: {} };
}
async function guardarSesion(numero, paso, datos) {
  await SesionCitaWA.findOneAndUpdate({ numero }, { paso, datos }, { upsert: true });
}
async function limpiarSesion(numero) {
  await SesionCitaWA.deleteOne({ numero });
}

async function procesarMensajeEntrante(numero, texto, nombrePerfil) {
  const medicoPhone = CONFIG.SALUD_WHATSAPP_MEDICO_PHONE;
  if (!medicoPhone) return "Este número todavía no está configurado. Avisale a la clínica.";
  const medico = await Medico.findOne({ phone: medicoPhone }).lean();
  if (!medico) return "Este número todavía no está configurado. Avisale a la clínica.";

  const sesion = await obtenerSesion(numero);
  const t = texto.trim().toLowerCase();

  if (t === "cancelar" || t === "cancelar cita") {
    return iniciarCancelacion(medicoPhone, numero);
  }

  switch (sesion.paso) {
    case "confirmar_cancelacion":
      return confirmarCancelacion(medicoPhone, numero, t, sesion.datos);
    case "elegir_dia":
      return elegirDia(numero, t, sesion.datos);
    case "elegir_hora":
      return elegirHora(medicoPhone, numero, t, sesion.datos, medico.duracionConsultaMinutos);
    case "pedir_nombre":
      return pedirNombre(numero, texto, sesion.datos);
    case "pedir_motivo":
      return pedirMotivo(medicoPhone, numero, texto, sesion.datos, medico);
    default:
      return iniciarReserva(medicoPhone, numero);
  }
}

async function iniciarReserva(medicoPhone, numero) {
  const dias = await obtenerHorariosDisponibles(medicoPhone, 10);
  if (dias.length === 0) {
    return "Por ahora no tengo horarios disponibles cargados. Comunicate directo con la clínica para coordinar tu cita.";
  }
  const lineas = dias.map((d, i) => `${i + 1}) ${formatearDia(d.fecha)} — ${d.slots.length} horario${d.slots.length === 1 ? "" : "s"} libre${d.slots.length === 1 ? "" : "s"}`);
  await guardarSesion(numero, "elegir_dia", { dias: dias.map(d => ({ fecha: d.fecha, slots: d.slots.map(s => s.toISOString()) })) });
  return `¡Hola! 👋 Elegí un día para tu cita respondiendo con el número:\n\n${lineas.join("\n")}\n\nEscribí "cancelar" en cualquier momento si querés cancelar una cita ya agendada.`;
}

async function elegirDia(numero, t, datos) {
  const idx = parseInt(t, 10) - 1;
  const dia = datos.dias?.[idx];
  if (!dia) return `No entendí. Respondé con el número del día (1 a ${datos.dias?.length || 0}).`;
  const lineas = dia.slots.map((s, i) => `${i + 1}) ${formatearHora(s)}`);
  await guardarSesion(numero, "elegir_hora", { ...datos, diaElegido: dia });
  return `Horarios para el ${formatearDia(dia.fecha)}:\n\n${lineas.join("\n")}\n\nRespondé con el número del horario que te sirva.`;
}

async function elegirHora(medicoPhone, numero, t, datos, duracionConsultaMinutos) {
  const idx = parseInt(t, 10) - 1;
  const slot = datos.diaElegido?.slots?.[idx];
  if (!slot) return `No entendí. Respondé con el número del horario (1 a ${datos.diaElegido?.slots?.length || 0}).`;
  const libre = await horarioSigueLibre(medicoPhone, slot, duracionConsultaMinutos || 30);
  if (!libre) return 'Ups, ese horario se acaba de ocupar. Escribí cualquier cosa para ver los horarios disponibles de nuevo.';
  await guardarSesion(numero, "pedir_nombre", { ...datos, horaElegida: slot });
  return "¿A nombre de quién es la cita? Escribí el nombre completo.";
}

async function pedirNombre(numero, textoOriginal, datos) {
  const nombre = textoOriginal.trim();
  if (nombre.length < 2) return "Necesito un nombre válido para la cita.";
  await guardarSesion(numero, "pedir_motivo", { ...datos, pacienteNombre: nombre });
  return `Gracias, ${nombre.split(" ")[0]}. Por último, ¿cuál es el motivo de la consulta? (podés escribir "ninguno" si preferís no decirlo)`;
}

async function pedirMotivo(medicoPhone, numero, textoOriginal, datos, medico) {
  const motivo = textoOriginal.trim().toLowerCase() === "ninguno" ? "" : textoOriginal.trim();

  const paciente = await Paciente.findOne({ medicoPhone, telefono: numero }).lean();
  const cita = await Cita.create({
    medicoPhone,
    pacienteId: paciente?._id || null,
    pacienteNombre: datos.pacienteNombre,
    pacienteTelefono: numero,
    fecha: new Date(datos.horaElegida),
    duracionMinutos: medico.duracionConsultaMinutos || 30,
    motivo,
    estado: "confirmada",
    origen: "whatsapp",
  });

  if (medico.googleCalendarId) {
    const eventId = await crearEvento(medico.googleCalendarId, cita);
    if (eventId) await Cita.updateOne({ _id: cita._id }, { googleEventId: eventId });
  }

  await limpiarSesion(numero);
  return `✅ Listo, tu cita quedó confirmada para el ${formatearFechaCompleta(cita.fecha)}. Te esperamos.\n\nSi necesitás cancelarla, escribí "cancelar" en cualquier momento.`;
}

async function iniciarCancelacion(medicoPhone, numero) {
  const cita = await Cita.findOne({ medicoPhone, pacienteTelefono: numero, estado: "confirmada", fecha: { $gte: new Date() } }).sort({ fecha: 1 });
  if (!cita) {
    await limpiarSesion(numero);
    return "No encontré ninguna cita próxima a tu nombre. Si querés agendar una, escribí cualquier cosa.";
  }
  await guardarSesion(numero, "confirmar_cancelacion", { citaId: String(cita._id) });
  return `Tenés una cita para el ${formatearFechaCompleta(cita.fecha)}. ¿Confirmás que querés cancelarla? Respondé "sí" o "no".`;
}

async function confirmarCancelacion(medicoPhone, numero, t, datos) {
  if (t !== "si" && t !== "sí") {
    await limpiarSesion(numero);
    return "Ok, no cancelé nada.";
  }
  const cita = await Cita.findById(datos.citaId);
  if (cita) {
    cita.estado = "cancelada";
    await cita.save();
    const medico = await Medico.findOne({ phone: medicoPhone }).lean();
    if (medico?.googleCalendarId && cita.googleEventId) {
      await eliminarEvento(medico.googleCalendarId, cita.googleEventId);
    }
  }
  await limpiarSesion(numero);
  return "Listo, cancelé tu cita. Si querés agendar otra, escribí cualquier cosa.";
}

module.exports = { procesarMensajeEntrante };
