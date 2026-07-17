// ChatGo — Módulo BUS (demo con las 25 líneas simuladas)
//
// El pasajero pregunta "¿qué línea me lleva del correo a la universidad?"
// y recibe SU línea con SOLO el micro que viene hacia él (no toda la flota):
// nombre de línea, a cuántos metros le queda la parada, ETA del micro más
// próximo, y un link para verlo venir en vivo en el mapa (/bus/:id).
//
// Flujo: pregunta (texto o audio, parseada con la MISMA IA del taxi) →
// resolver origen/destino (pin o texto con el geocoder validado) → respuesta.

const { CONFIG, log } = require("../config");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje } = require("../services/whatsapp");
const { geocodificarConMemoria, obtenerDireccion } = require("../services/google");
const { extraerUbicaciones } = require("../services/openai");
const { buscarLineasParaViaje, microMasProximo } = require("../services/buslineas");
const { textoDeMensaje } = require("./util");

function linkBus(lineaId, parada) {
  const base = CONFIG.APP_URL || "https://api.chatgo.ia.bo";
  return `${base}/bus/${lineaId}?p=${parada.lat.toFixed(5)},${parada.lng.toFixed(5)}`;
}

async function resolverPuntoBus(msg, texto) {
  const lat = parseFloat(msg?.location?.latitude ?? msg?.location?.lat);
  const lng = parseFloat(msg?.location?.longitude ?? msg?.location?.lng);
  if (!isNaN(lat) && !isNaN(lng)) {
    const nombre = (await obtenerDireccion(lat, lng).catch(() => null)) || "Tu ubicación";
    return { lat, lng, nombre };
  }
  if (texto) {
    const g = await geocodificarConMemoria(texto, "Cochabamba").catch(() => null);
    // Para una parada de micro, un resultado _incierto alcanza (tolerancia a pie)
    if (g?.lat) return { lat: g.lat, lng: g.lng, nombre: g.nombre || texto };
  }
  return null;
}

// Respuesta final: la línea + SOLO el micro que viene hacia el pasajero.
// opts.conservarSesion: cuando se llama desde el flujo TAXI (cross-sell), la
// sesión del pedido de taxi NO se toca — el pasajero puede seguir y pedir Auto.
async function responderLinea(phone, origen, destino, opts = {}) {
  const candidatas = buscarLineasParaViaje(origen, destino);
  if (!candidatas.length) {
    if (!opts.conservarSesion) await deleteSession(phone);
    await enviarMensaje(phone,
      `😕 Ninguna de nuestras líneas cubre el tramo\n📍 ${origen.nombre}\n🏁 ${destino.nombre}\n\n` +
      (opts.conservarSesion
        ? `🚖 Seguí con tu taxi: elegí Auto, Moto o Van arriba 👆`
        : `🚖 Si querés, pedí un taxi: escribí a dónde vas y te cotizamos al toque.`));
    return true;
  }

  const mejor = candidatas[0];
  const micro = microMasProximo(mejor.linea, mejor.pO.t);
  const alternativa = candidatas[1]
    ? `\n_También te sirve la ${candidatas[1].linea.nombre} (parada a ${candidatas[1].pO.distM} m)._`
    : "";

  if (!opts.conservarSesion) await deleteSession(phone);
  await enviarMensaje(phone,
    `🚌 *${mejor.linea.nombre}* (${mejor.linea.origen} → ${mejor.linea.destino})\n\n` +
    `📍 Tu parada queda a *${mejor.pO.distM} m* de donde estás\n` +
    `🏁 Te deja a *${mejor.pD.distM} m* de tu destino\n\n` +
    `🚌 El más próximo (Micro ${micro.id}) llega a tu parada en *~${micro.etaMin} min* ` +
    `(está a ${micro.kmDeDistancia} km)\n\n` +
    `🗺️ Miralo venir en vivo:\n${linkBus(mejor.linea.id, origen)}` +
    alternativa +
    (opts.conservarSesion ? `\n\n🚖 _¿Preferís el taxi al final? Elegí Auto, Moto o Van arriba 👆_` : "") +
    `\n\n_🚧 DEMO: líneas simuladas de ChatGo Bus._`);
  log.info(`[MOD:bus] ${phone}: ${origen.nombre} → ${destino.nombre} = ${mejor.linea.nombre}, micro ${micro.id} en ${micro.etaMin} min`);
  return true;
}

async function iniciar(phone, msg, session) {
  const base = { ...(session || {}), modulo: "bus", step: "mod_bus_pregunta" };
  const { texto } = await textoDeMensaje(msg);
  // Si la pregunta de entrada ya trae el tramo ("qué línea me lleva del correo
  // a la universidad"), procesarla directo sin repreguntar
  if (texto && /\bde\b|\bdesde\b|\bal?\b/i.test(texto) && texto.split(/\s+/).length >= 4) {
    await updateSession(phone, base);
    return await procesar(phone, msg, null, base);
  }
  await enviarMensaje(phone,
    "🚌 *ChatGo Bus*\n\n¿De dónde a dónde querés ir?\n\n_Ej: \"del correo a la UMSS\" — por texto o audio._\n\nEscribe CANCELAR para salir.");
  await updateSession(phone, base);
  return true;
}

async function procesar(phone, msg, buttonId, session) {
  const { texto } = await textoDeMensaje(msg);

  if (/^cancelar$/i.test(texto)) {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Listo. Escribe *bus* cuando quieras saber qué línea te lleva. 🚌");
    return true;
  }

  switch (session.step) {

    // ── 1. La pregunta completa: extraer origen y destino con la IA del taxi ──
    case "mod_bus_pregunta": {
      // ¿Mandó un pin directamente? → es su origen, falta el destino
      if (msg?.location) {
        const origen = await resolverPuntoBus(msg, null);
        if (origen) {
          await updateSession(phone, { ...session, step: "mod_bus_destino", busOrigen: origen });
          await enviarMensaje(phone, `✅ Estás en: *${origen.nombre}*\n\n🏁 ¿A dónde querés ir?`);
          return true;
        }
      }
      if (!texto) {
        await enviarMensaje(phone, "🙏 Contame de dónde a dónde vas (texto o audio), o mandame tu 📍 ubicación.");
        return true;
      }

      const ubi = await extraerUbicaciones(texto).catch(() => null);
      const txtOrigen = (ubi?.origenDetalle?.texto || ubi?.origen || "").trim();
      const txtDestino = (ubi?.destinoDetalle?.texto || ubi?.destino || "").trim();

      if (!txtDestino && !txtOrigen) {
        await enviarMensaje(phone, `🤔 No entendí el recorrido. Decime por ejemplo: _"del correo a la UMSS"_ o mandá tu 📍 ubicación.`);
        return true;
      }

      // Resolver lo que tengamos
      const origen = txtOrigen ? await resolverPuntoBus(null, txtOrigen) : null;
      const destino = txtDestino ? await resolverPuntoBus(null, txtDestino) : null;

      if (origen && destino) return await responderLinea(phone, origen, destino);

      if (destino && !origen) {
        await updateSession(phone, { ...session, step: "mod_bus_origen", busDestino: destino });
        await enviarMensaje(phone, `🏁 Destino: *${destino.nombre}*\n\n📍 ¿Desde dónde salís? Mandame tu ubicación (pin) o escribí el lugar.`);
        return true;
      }
      if (origen && !destino) {
        await updateSession(phone, { ...session, step: "mod_bus_destino", busOrigen: origen });
        await enviarMensaje(phone, `📍 Origen: *${origen.nombre}*\n\n🏁 ¿A dónde querés ir?`);
        return true;
      }

      await enviarMensaje(phone, `😕 No pude ubicar "${txtOrigen || txtDestino}". Probá con otro nombre o mandá tu 📍 pin.`);
      return true;
    }

    // ── 2. Falta el origen ─────────────────────────────────────────────────
    case "mod_bus_origen": {
      const origen = await resolverPuntoBus(msg, texto);
      if (!origen) { await enviarMensaje(phone, "🙏 Mandame tu 📍 ubicación o escribí el lugar de donde salís."); return true; }
      return await responderLinea(phone, origen, session.busDestino);
    }

    // ── 3. Falta el destino ────────────────────────────────────────────────
    case "mod_bus_destino": {
      const destino = await resolverPuntoBus(msg, texto);
      if (!destino) { await enviarMensaje(phone, "🙏 Escribime a dónde vas o mandá el 📍 pin del lugar."); return true; }
      return await responderLinea(phone, session.busOrigen, destino);
    }

    default:
      await deleteSession(phone);
      return false;
  }
}

module.exports = { id: "bus", iniciar, procesar, responderLinea };
