// ChatGo — Módulo AMBULANCIAS
//
// Emergencias médicas por WhatsApp: pide la ubicación PRIMERO (mínima fricción),
// clasifica la prioridad por palabras clave, y despacha la ambulancia más cercana
// reutilizando el motor del taxi — las ambulancias se registran como choferes con
// tipoVehiculo "ambulancia" y el filtro por tipo del motor hace el resto (GPS,
// reserva atómica, botones Aceptar/Rechazar, tracking en vivo, chat).
//
// Si no hay ambulancia disponible (la realidad de hoy en las sombras), guarda la
// solicitud, alerta al ADMIN con máxima prioridad y orienta al usuario a llamar
// a los servicios de emergencia oficiales. ChatGo complementa, nunca reemplaza,
// la llamada de emergencia.

const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { Solicitud, Viaje } = require("../db/models");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { obtenerDireccion, geocodificarConMemoria } = require("../services/google");
const { buscarChoferDisponibleTraccar, reservarChoferTraccar } = require("../services/traccar");

function textoDe(msg) {
  return msg?.text?.body?.trim() || "";
}

// Clasificación de prioridad por palabras clave (determinista y sin latencia —
// en una emergencia no hay tiempo para esperar a un modelo)
const SIGNOS_CRITICOS = /inconsciente|no respira|respira mal|dificultad para respirar|infarto|paro card|convulsion|sangr|hemorragia|atropell|choque|volcadura|grave|embarazada|parto|quemadura|electrocut|ahog|arma|bala|apuñal/i;
const SIGNOS_MEDIOS = /fractura|caida|caída|golpe fuerte|dolor fuerte|dolor de pecho|fiebre alta|corte|herida|mareo|desmayo/i;

function clasificarPrioridad(descripcion) {
  if (SIGNOS_CRITICOS.test(descripcion)) return "critica";
  if (SIGNOS_MEDIOS.test(descripcion)) return "media";
  return "normal";
}

async function iniciar(phone, msg, session) {
  await enviarMensaje(phone,
    "🚑 *ChatGo Ambulancias — Emergencia médica*\n\n" +
    "📍 Mándame *AHORA la ubicación* del incidente (pin de WhatsApp) o escribe la dirección exacta.\n\n" +
    "⚠️ _Si la emergencia es grave, llama también a los servicios de emergencia de tu ciudad._");
  await updateSession(phone, { ...(session || {}), modulo: "ambulancia", step: "mod_ambulancia_ubicacion" });
  return true;
}

async function procesar(phone, msg, buttonId, session) {
  const texto = textoDe(msg);

  if (/^cancelar$/i.test(texto)) {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Solicitud de ambulancia cancelada.");
    return true;
  }

  switch (session.step) {

    case "mod_ambulancia_ubicacion": {
      let punto = null;
      if (msg?.location) {
        const lat = parseFloat(msg.location.latitude ?? msg.location.lat);
        const lng = parseFloat(msg.location.longitude ?? msg.location.lng);
        if (!isNaN(lat) && !isNaN(lng)) {
          const nombre = msg.location.name || (await obtenerDireccion(lat, lng).catch(() => null)) || "Ubicación del incidente";
          punto = { lat, lng, nombre };
        }
      } else if (texto) {
        const geo = await geocodificarConMemoria(texto, session.ciudadUsuario || null).catch(() => null);
        if (geo && geo.lat) punto = { lat: geo.lat, lng: geo.lng, nombre: geo.nombre || texto };
      }
      if (!punto) {
        await enviarMensaje(phone, "📍 Necesito la ubicación exacta: toca el clip 📎 → *Ubicación* → *Enviar mi ubicación actual*.");
        return true;
      }
      await updateSession(phone, { ...session, ambUbicacion: punto, step: "mod_ambulancia_detalle" });
      await enviarMensaje(phone, `✅ Ubicación recibida: *${punto.nombre}*\n\n🩺 En pocas palabras: ¿*qué pasó* y cuántas personas necesitan ayuda?`);
      return true;
    }

    case "mod_ambulancia_detalle": {
      if (!texto) {
        await enviarMensaje(phone, "🩺 Escríbeme brevemente qué pasó (ej: _persona inconsciente_, _accidente de tránsito, 2 heridos_).");
        return true;
      }
      const descripcion = texto.substring(0, 300);
      const prioridad = clasificarPrioridad(descripcion);
      const ubi = session.ambUbicacion;

      // 1) Guardar la solicitud SIEMPRE (auditoría y operación manual)
      let solicitudId = null;
      try {
        const sol = await Solicitud.create({
          data: {
            tipo: "ambulancia",
            usuarioPhone: phone,
            estado: "nueva",
            detalle: { descripcion, prioridad },
            origenLat: ubi.lat,
            origenLng: ubi.lng,
            origenNombre: ubi.nombre,
          },
        });
        solicitudId = sol.id;
      } catch (e) {
        log.error("[MOD:ambulancia] Error guardando solicitud:", e.message);
      }

      // 2) Intentar despacho automático: ambulancias = choferes tipo "ambulancia"
      let despachada = false;
      try {
        const unidad = await buscarChoferDisponibleTraccar(ubi, [], "ambulancia");
        if (unidad) {
          const viaje = await Viaje.create({
            data: {
              usuarioPhone: phone,
              choferPhone: unidad.phone,
              choferTraccarId: unidad.traccarId,
              choferNombre: unidad.nombre,
              choferPlaca: unidad.placa,
              ciudad: detectarCiudadPorCoords(ubi.lat, ubi.lng),
              origenLat: ubi.lat,
              origenLng: ubi.lng,
              origenNombre: ubi.nombre,
              destinoLat: ubi.lat,
              destinoLng: ubi.lng,
              destinoNombre: "Traslado según evaluación médica",
              observaciones: `🚑 EMERGENCIA MÉDICA [prioridad ${prioridad.toUpperCase()}]: ${descripcion}`,
              distanciaKm: 0,
              precioTotal: 0,
              precioBase: 0,
              tipoVehiculo: "ambulancia",
              estado: "pendiente",
              fechaAsignacion: new Date(),
            },
          });
          const reservada = await reservarChoferTraccar(unidad.traccarId, viaje.id);
          if (reservada) {
            despachada = true;
            if (solicitudId) {
              await Solicitud.update({ where: { id: solicitudId }, data: { viajeId: viaje.id, estado: "asignada", asignadoPhone: unidad.phone } }).catch(() => {});
            }
            // Orden URGENTE a la ambulancia — los botones Aceptar/Rechazar
            // los procesa el flujo chofer existente (aceptar_viaje / rechazar_viaje)
            await enviarBotones(unidad.phone,
              `🚨🚑 *EMERGENCIA MÉDICA — PRIORIDAD ${prioridad.toUpperCase()}*\n\n` +
              `🩺 ${descripcion}\n` +
              `📍 ${ubi.nombre}\n` +
              `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}\n` +
              `📏 A ${unidad.distanciaAlUsuario?.toFixed(1) || "?"} km de ti\n\n` +
              `⏱️ *RESPONDE DE INMEDIATO*`,
              [
                { id: "aceptar_viaje", title: "🚑 VOY" },
                { id: "rechazar_viaje", title: "❌ No puedo" },
              ]);
            await updateSession(phone, { step: "esperando_chofer", viajeId: viaje.id.toString(), choferPhone: unidad.phone });
            await enviarMensaje(phone,
              `🚑 *Ambulancia localizada a ${unidad.distanciaAlUsuario?.toFixed(1) || "?"} km*\n\n` +
              `Estamos confirmando la unidad. En cuanto acepte te llega el enlace para verla llegar en tiempo real.\n\n` +
              `⚠️ _Mientras tanto: no muevas a la persona herida salvo peligro inminente._`);
          } else {
            await Viaje.delete({ where: { id: viaje.id } }).catch(() => {});
          }
        }
      } catch (e) {
        log.error("[MOD:ambulancia] Error en despacho:", e.message);
      }

      // 3) Sin unidad disponible → operación manual urgente
      if (!despachada) {
        await deleteSession(phone);
        await enviarMensaje(phone,
          `🚑 *Solicitud registrada — prioridad ${prioridad.toUpperCase()}*\n\n` +
          `🚨 *Llama YA a los servicios de emergencia de tu ciudad* (SAMU / Cruz Roja / 110) — no esperes.\n\n` +
          `Un operador de ChatGo también está viendo tu solicitud e intentará conseguirte una unidad.`);
      }

      // 4) Alerta al admin SIEMPRE (crítica o no)
      try {
        const icono = prioridad === "critica" ? "🔴🔴🔴" : prioridad === "media" ? "🟠" : "🟡";
        await enviarMensaje(CONFIG.ADMIN_PHONE,
          `${icono} *AMBULANCIA — PRIORIDAD ${prioridad.toUpperCase()}* ${despachada ? "(unidad despachada)" : "(SIN UNIDAD — OPERAR MANUAL)"}\n\n` +
          `👤 +${phone}\n🩺 ${descripcion}\n📍 ${ubi.nombre}\n` +
          `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}` +
          (solicitudId ? `\n🆔 ${solicitudId}` : ""));
      } catch (e) {
        log.error("[MOD:ambulancia] Error alertando admin:", e.message);
      }

      return true;
    }

    default:
      await deleteSession(phone);
      return false;
  }
}

module.exports = { id: "ambulancia", iniciar, procesar };
