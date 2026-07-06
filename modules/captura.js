// ChatGo — Plataforma modular: fábrica de módulos de captura
//
// Genera módulos conversacionales simples que hacen N preguntas, guardan la
// solicitud estructurada en la tabla `solicitudes` y la reenvían al ADMIN_PHONE
// para operación manual "detrás de escena". Es el esqueleto sobre el que después
// se monta la automatización real de cada vertical (catálogos, colegios, etc.).
//
// Contrato de módulo: { iniciar(phone, msg, session), procesar(phone, msg, buttonId, session) }

const { CONFIG, log } = require("../config");
const { Solicitud } = require("../db/models");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje } = require("../services/whatsapp");

function textoDe(msg) {
  if (msg?.text?.body?.trim()) return msg.text.body.trim();
  return "";
}

function crearModuloCaptura({ id, titulo, preguntas, cierre }) {
  const stepDe = (i) => `mod_${id}_p${i}`;

  async function preguntar(phone, session, indice) {
    await updateSession(phone, { ...session, modulo: id, step: stepDe(indice), modRespuestas: session.modRespuestas || {} });
    await enviarMensaje(phone, preguntas[indice].texto);
  }

  async function iniciar(phone, msg, session) {
    await enviarMensaje(phone, `${titulo}\n\n_Escribe CANCELAR en cualquier momento para salir._`);
    await preguntar(phone, { ...(session || {}), modRespuestas: {} }, 0);
    return true;
  }

  async function procesar(phone, msg, buttonId, session) {
    const texto = textoDe(msg);

    if (/^cancelar$/i.test(texto)) {
      await deleteSession(phone);
      await enviarMensaje(phone, "❌ Solicitud cancelada. Escribe *hola* cuando quieras pedir algo.");
      return true;
    }

    const indice = parseInt(session.step.replace(`mod_${id}_p`, ""), 10);
    if (isNaN(indice) || indice >= preguntas.length) {
      await deleteSession(phone);
      return false;
    }

    const pregunta = preguntas[indice];
    const respuestas = { ...(session.modRespuestas || {}) };

    // Capturar respuesta: ubicación (si la pregunta la acepta) o texto
    if (pregunta.aceptaUbicacion && msg?.location) {
      const lat = parseFloat(msg.location.latitude ?? msg.location.lat);
      const lng = parseFloat(msg.location.longitude ?? msg.location.lng);
      respuestas[pregunta.campo] = { lat, lng, tipo: "ubicacion" };
    } else if (texto) {
      respuestas[pregunta.campo] = texto;
    } else {
      await enviarMensaje(phone, "🙏 No entendí tu respuesta. " + pregunta.texto);
      return true;
    }

    const siguiente = indice + 1;
    if (siguiente < preguntas.length) {
      await preguntar(phone, { ...session, modRespuestas: respuestas }, siguiente);
      return true;
    }

    // Última respuesta → guardar solicitud y avisar al admin
    let solicitudId = null;
    try {
      const ubi = Object.values(respuestas).find(r => r && r.tipo === "ubicacion");
      const sol = await Solicitud.create({
        data: {
          tipo: id,
          usuarioPhone: phone,
          estado: "nueva",
          detalle: respuestas,
          origenLat: ubi?.lat ?? null,
          origenLng: ubi?.lng ?? null,
        },
      });
      solicitudId = sol.id;
    } catch (e) {
      log.error(`[MOD:${id}] Error guardando solicitud:`, e.message);
    }

    await deleteSession(phone);
    await enviarMensaje(phone, cierre);

    // Aviso al admin para operar en las sombras
    try {
      const resumen = Object.entries(respuestas)
        .map(([campo, valor]) => `• ${campo}: ${typeof valor === "object" ? `📍 ${valor.lat},${valor.lng}` : valor}`)
        .join("\n");
      await enviarMensaje(CONFIG.ADMIN_PHONE,
        `🆕 *Solicitud ${id.toUpperCase()}*\n👤 +${phone}\n${resumen}${solicitudId ? `\n🆔 ${solicitudId}` : ""}`);
    } catch (e) {
      log.error(`[MOD:${id}] Error avisando al admin:`, e.message);
    }

    return true;
  }

  return { id, iniciar, procesar };
}

module.exports = { crearModuloCaptura };
