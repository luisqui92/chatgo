// ChatGo — Módulo FAVOR (mandados y encargos)
//
// El primer módulo 100% funcional de la plataforma: un mandado ES un viaje con
// instrucciones, así que reutiliza completo el motor del taxi — asignación
// atómica por GPS, chat pasajero-chofer, tracking en vivo y rating.
//
// Flujo: qué necesita → punto de recogida → punto de entrega → precio → confirmar
// Al confirmar se crea la Solicitud y se despacha por asignarChofer(); el chofer
// ve el mandado en las observaciones de la orden.

const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { Usuario, Solicitud } = require("../db/models");
const { getSession, updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { geocodificarConMemoria, obtenerDireccion, calcularDistancia } = require("../services/google");
const { calcularPrecio } = require("../services/utils");
const { asignarChofer } = require("../flows/viaje");
const { textoDeMensaje } = require("./util");

// Extrae un punto {lat,lng,nombre} de un pin de WhatsApp o de texto geocodificado
async function resolverPunto(msg, texto, ciudadUsuario) {
  if (msg?.location) {
    const lat = parseFloat(msg.location.latitude ?? msg.location.lat);
    const lng = parseFloat(msg.location.longitude ?? msg.location.lng);
    if (!isNaN(lat) && !isNaN(lng)) {
      const nombre = msg.location.name || (await obtenerDireccion(lat, lng)) || "Ubicación por pin";
      return { lat, lng, nombre };
    }
  }
  if (texto) {
    const geo = await geocodificarConMemoria(texto, ciudadUsuario);
    if (geo && geo.lat) return { lat: geo.lat, lng: geo.lng, nombre: geo.nombre || texto };
  }
  return null;
}

async function iniciar(phone, msg, session) {
  await enviarMensaje(phone,
    "🛍️ *ChatGo Favor — mandados y encargos*\n\n" +
    "Te mandamos un móvil para recoger documentos, comprar medicamentos, entregar paquetes o hacer compras.\n\n" +
    "¿Qué necesitas? Descríbeme el mandado.\n\n_Escribe CANCELAR en cualquier momento para salir._");
  await updateSession(phone, { ...(session || {}), modulo: "favor", step: "mod_favor_detalle" });
  return true;
}

async function procesar(phone, msg, buttonId, session) {
  // Acepta texto o nota de voz (se transcribe una sola vez por mensaje)
  const { texto } = await textoDeMensaje(msg);

  if (/^cancelar$/i.test(texto) || buttonId === "mod_favor_cancelar") {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Mandado cancelado. Escribe *favor* cuando necesites otro.");
    return true;
  }

  const usuario = await Usuario.findUnique({ where: { phone } }).catch(() => null);
  const ciudadUsuario = usuario?.ciudad || null;

  switch (session.step) {

    case "mod_favor_detalle": {
      if (!texto) {
        await enviarMensaje(phone, "🙏 Escríbeme en texto qué necesitas (ej: _recoger unos documentos y llevarlos a mi oficina_).");
        return true;
      }
      await updateSession(phone, { ...session, favorDetalle: texto.substring(0, 300), step: "mod_favor_recogida" });
      await enviarMensaje(phone, "📍 ¿*Dónde se recoge*? Mándame la ubicación (pin) o escribe la dirección.");
      return true;
    }

    case "mod_favor_recogida": {
      const punto = await resolverPunto(msg, texto, ciudadUsuario);
      if (!punto) {
        await enviarMensaje(phone, "🙏 No pude ubicar ese punto. Mándame el pin de ubicación o una dirección más específica (calle y esquina).");
        return true;
      }
      await updateSession(phone, { ...session, favorOrigen: punto, step: "mod_favor_entrega" });
      await enviarMensaje(phone, `✅ Recogida: *${punto.nombre}*\n\n🏁 ¿*Dónde se entrega*? Mándame la ubicación (pin) o escribe la dirección.`);
      return true;
    }

    case "mod_favor_entrega": {
      const punto = await resolverPunto(msg, texto, ciudadUsuario);
      if (!punto) {
        await enviarMensaje(phone, "🙏 No pude ubicar ese punto. Mándame el pin de ubicación o una dirección más específica.");
        return true;
      }
      const origen = session.favorOrigen;
      const dist = await calcularDistancia(origen, punto);
      if (!dist || !dist.km) {
        await deleteSession(phone);
        await enviarMensaje(phone, "😕 No pude calcular la ruta del mandado. Intenta de nuevo escribiendo *favor*.");
        return true;
      }
      const base = calcularPrecio(dist.km, "auto");
      const precio = Math.round(base.total + CONFIG.FAVOR_TARIFA_BASE_BS);

      await updateSession(phone, {
        ...session,
        favorDestino: punto,
        favorDistancia: dist.km,
        favorPrecio: precio,
        favorPrecioPorKm: base.precioPorKm,
        step: "mod_favor_confirmar",
      });
      await enviarBotones(phone,
        `🛍️ *Resumen del mandado*\n\n` +
        `📝 ${session.favorDetalle}\n` +
        `📍 Recogida: ${origen.nombre}\n` +
        `🏁 Entrega: ${punto.nombre}\n` +
        `📏 Distancia: ${dist.km} km\n\n` +
        `💰 *Precio: Bs ${precio}*` + (base.esNocturno ? "\n🌙 _Incluye recargo nocturno_" : ""),
        [
          { id: "mod_favor_si", title: "✅ Confirmar" },
          { id: "mod_favor_cancelar", title: "❌ Cancelar" },
        ]);
      return true;
    }

    case "mod_favor_confirmar": {
      if (buttonId !== "mod_favor_si" && !/^(si|sí|confirmar|ok|dale)$/i.test(texto)) {
        await enviarMensaje(phone, "Toca *Confirmar* para pedir el mandado o escribe *CANCELAR* para salir.");
        return true;
      }

      let solicitudId = null;
      try {
        const sol = await Solicitud.create({
          data: {
            tipo: "favor",
            usuarioPhone: phone,
            estado: "confirmada",
            detalle: { descripcion: session.favorDetalle },
            origenLat: session.favorOrigen.lat,
            origenLng: session.favorOrigen.lng,
            origenNombre: session.favorOrigen.nombre,
            destinoLat: session.favorDestino.lat,
            destinoLng: session.favorDestino.lng,
            destinoNombre: session.favorDestino.nombre,
            precioBs: session.favorPrecio,
          },
        });
        solicitudId = sol.id;
      } catch (e) {
        log.error("[MOD:favor] Error guardando solicitud:", e.message);
      }

      // Montar la sesión con el formato del motor taxi y despachar.
      // El detalle del mandado viaja en las observaciones: el chofer lo ve en la orden.
      const sesionViaje = {
        step: "calculando",
        origen: session.favorOrigen,
        destino: session.favorDestino,
        ubicaciones: { origen: session.favorOrigen, destino: session.favorDestino },
        distancia: session.favorDistancia,
        precio: session.favorPrecio,
        precioBase: session.favorPrecio,
        precioPorKm: session.favorPrecioPorKm,
        observaciones: `🛍️ MANDADO (sin pasajero): ${session.favorDetalle}`,
        tipoVehiculoSolicitado: null,
        esFavor: true,
        solicitudId,
      };
      await updateSession(phone, sesionViaje);
      await asignarChofer(phone, sesionViaje);

      // Vincular el viaje generado a la solicitud (si ya se asignó)
      try {
        if (solicitudId) {
          const s = await getSession(phone);
          if (s?.viajeId) {
            await Solicitud.update({ where: { id: solicitudId }, data: { viajeId: s.viajeId, estado: "asignada" } });
          }
        }
      } catch (e) {
        log.error("[MOD:favor] Error vinculando viaje:", e.message);
      }
      return true;
    }

    default:
      await deleteSession(phone);
      return false;
  }
}

module.exports = { id: "favor", iniciar, procesar };
