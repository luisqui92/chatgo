// ═══════════════════════════════════════════════════════════════════════════
// IA de Seguridad y Anti-Fraude
// Detecta comportamientos sospechosos en viajes y choferes
// ═══════════════════════════════════════════════════════════════════════════

const { Viaje, Chofer, AlertaSeg, EventoChofer } = require("../db/models");
const { CONFIG, log } = require("../config");

// Verifica si un punto está muy lejos de la ruta esperada
function esDesvioSospechoso(posActual, destino, origenOriginal) {
  // Calcular distancia al destino
  const distAlDestino = distanciaSimple(posActual.lat, posActual.lng, destino.lat, destino.lng);
  const distOrigenDestino = distanciaSimple(origenOriginal.lat, origenOriginal.lng, destino.lat, destino.lng);

  // Si está más del 50% lejos del destino con respecto al recorrido total, es sospechoso
  if (distAlDestino > distOrigenDestino * 1.5 && distOrigenDestino > 2) {
    return { sospechoso: true, tipo: "desvio", distancia: distAlDestino };
  }
  return { sospechoso: false };
}

function distanciaSimple(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Verifica comportamiento sospechoso de un chofer
async function verificarComportamientoChofer(choferPhone) {
  try {
    const eventos = await EventoChofer.find({ choferPhone })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    if (eventos.length < 5) return null; // No hay suficientes datos

    const rechazos = eventos.filter(e => e.tipo === "rechazado").length;
    const cancelaciones = eventos.filter(e => e.tipo === "cancelado").length;
    const total = eventos.length;

    const alertas = [];

    // Demasiados rechazos recientes
    if (rechazos / total > 0.7) {
      alertas.push({ tipo: "muchos_rechazos", descripcion: `${rechazos}/${total} ofertas rechazadas recientemente` });
    }

    // Demasiadas cancelaciones
    if (cancelaciones / total > 0.4) {
      alertas.push({ tipo: "muchas_cancelaciones", descripcion: `${cancelaciones}/${total} viajes cancelados` });
    }

    // Acepta muy rápido (posible bot o GPS falso)
    const aceptaciones = eventos.filter(e => e.tipo === "aceptado" && e.segundosParaResponder < 2);
    if (aceptaciones.length > 3) {
      alertas.push({ tipo: "aceptacion_sospechosa", descripcion: "Acepta viajes en menos de 2 segundos repetidamente" });
    }

    return alertas.length > 0 ? alertas : null;
  } catch (e) {
    log.error("[SEGURIDAD] verificarComportamiento:", e.message);
    return null;
  }
}

// Detecta abuso de códigos promocionales
async function detectarAbusoPromo(usuarioPhone) {
  try {
    const { CodigoPromo } = require("../db/models");
    const codigosUsados = await CodigoPromo.countDocuments({ usadoPor: usuarioPhone });

    // Si usó más de 3 códigos, es sospechoso
    if (codigosUsados > 3) {
      log.warn(`[SEGURIDAD] Posible abuso de promos: ${usuarioPhone} usó ${codigosUsados} códigos`);
      return { abuso: true, codigosUsados };
    }
    return { abuso: false };
  } catch (e) {
    return { abuso: false };
  }
}

// Monitorea un viaje en curso para detectar anomalías
async function monitorearViajeEnCurso(viaje, posChofer, enviarMensajeFn) {
  try {
    const alertas = [];

    // 1. Verificar desvío de ruta
    if (viaje.destino?.lat && viaje.origen?.lat) {
      const desvio = esDesvioSospechoso(posChofer, viaje.destino, viaje.origen);
      if (desvio.sospechoso) {
        alertas.push({
          tipo: "desvio",
          descripcion: `Chofer a ${desvio.distancia.toFixed(1)}km del destino — posible desvío`,
        });
      }
    }

    // 2. Verificar tiempo excesivo en el viaje
    const tiempoEnCursoMin = (Date.now() - new Date(viaje.fechaAceptacion).getTime()) / 60000;
    const tiempoEsperadoMin = (viaje.distanciaKm || 5) * 4; // ~4 min/km
    if (tiempoEnCursoMin > tiempoEsperadoMin * 2.5 && tiempoEnCursoMin > 30) {
      alertas.push({
        tipo: "tiempo_excesivo",
        descripcion: `Viaje lleva ${Math.round(tiempoEnCursoMin)} min (esperado ~${Math.round(tiempoEsperadoMin)} min)`,
      });
    }

    if (alertas.length > 0) {
      // Marcar viaje con alerta
      await Viaje.findByIdAndUpdate(viaje._id, { alertaSeguridad: true });

      // Registrar alertas
      for (const alerta of alertas) {
        await AlertaSeg.create({
          viajeId: String(viaje._id),
          choferPhone: viaje.choferPhone,
          usuarioPhone: viaje.usuarioPhone,
          tipo: alerta.tipo,
          descripcion: alerta.descripcion,
          lat: posChofer.lat,
          lng: posChofer.lng,
        });
      }

      // Notificar al admin
      const msg = `🚨 *ALERTA DE SEGURIDAD*\n\n` +
        `Viaje: ${viaje._id}\n` +
        `Chofer: ${viaje.choferNombre} (+${viaje.choferPhone})\n` +
        `Pasajero: +${viaje.usuarioPhone}\n\n` +
        alertas.map(a => `⚠️ ${a.descripcion}`).join("\n");

      await enviarMensajeFn(CONFIG.ADMIN_PHONE, msg).catch(() => {});
      log.warn(`[SEGURIDAD] Alertas en viaje ${viaje._id}:`, alertas.map(a => a.tipo).join(", "));
    }

    return alertas;
  } catch (e) {
    log.error("[SEGURIDAD] monitorearViaje:", e.message);
    return [];
  }
}

module.exports = { verificarComportamientoChofer, detectarAbusoPromo, monitorearViajeEnCurso };
