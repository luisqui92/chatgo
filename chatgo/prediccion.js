// ═══════════════════════════════════════════════════════════════════════════
// IA de Predicción de Demanda
// Aprende patrones de viajes para predecir zonas calientes
// y alertar a choferes antes de que explote la demanda
// ═══════════════════════════════════════════════════════════════════════════

const { Demanda, Viaje, Chofer } = require("../db/models");
const { CONFIG, log } = require("../config");

// Convierte coordenadas a una zona aproximada (cuadrante de ~500m)
function coordsAZonaKey(lat, lng, hora, diaSemana) {
  const latR = Math.round(lat * 200) / 200; // ~500m de precisión
  const lngR = Math.round(lng * 200) / 200;
  return `${latR}_${lngR}_${hora}_${diaSemana}`;
}

// Registra un viaje en la base de demanda (se llama cuando termina un viaje)
async function registrarViajeEnDemanda(viaje) {
  try {
    if (!viaje.origen?.lat) return;

    const fechaInicio = new Date(viaje.fechaInicio);
    const ahora = new Date(fechaInicio.getTime() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const hora = ahora.getHours();
    const diaSemana = ahora.getDay();
    const zonaKey = coordsAZonaKey(viaje.origen.lat, viaje.origen.lng, hora, diaSemana);

    const tiempoEspera = viaje.fechaAceptacion && viaje.fechaInicio
      ? (new Date(viaje.fechaAceptacion) - new Date(viaje.fechaInicio)) / 1000
      : 0;

    await Demanda.findOneAndUpdate(
      { zonaKey },
      {
        $inc: { totalViajes: 1, totalEsperaSegundos: tiempoEspera },
        $set: {
          lat: viaje.origen.lat,
          lng: viaje.origen.lng,
          nombreZona: viaje.origen.nombre?.split(",")[0] || "Zona",
          diaSemana, hora,
          ultimaActualizacion: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    log.error("[PREDICCION] registrarViaje:", e.message);
  }
}

// Obtiene las zonas con más demanda para la hora y día actual
async function obtenerZonasCalientes(limite = 3) {
  try {
    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const hora = ahora.getHours();
    const diaSemana = ahora.getDay();

    // Buscar zonas con datos de la misma hora y día de la semana
    const zonas = await Demanda.find({ hora, diaSemana })
      .sort({ totalViajes: -1 })
      .limit(limite)
      .lean();

    return zonas;
  } catch (e) {
    log.error("[PREDICCION] obtenerZonasCalientes:", e.message);
    return [];
  }
}

// Genera el mensaje de alerta para choferes
async function generarAlertaZonasChoferes() {
  try {
    const zonas = await obtenerZonasCalientes(3);
    if (!zonas.length) return null;

    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const hora = ahora.getHours();
    const siguienteHora = (hora + 1) % 24;

    // Solo alertar si la zona tiene suficientes datos (mínimo 5 viajes históricos)
    const zonasRelevantes = zonas.filter(z => z.totalViajes >= 5);
    if (!zonasRelevantes.length) return null;

    const listaZonas = zonasRelevantes
      .map(z => `📍 ${z.nombreZona}`)
      .join("\n");

    return `📊 *Predicción de demanda*\n\n` +
      `En los próximos 30-60 min habrá alta demanda en:\n\n${listaZonas}\n\n` +
      `_Basado en el historial de esta hora del día._`;
  } catch (e) {
    log.error("[PREDICCION] generarAlerta:", e.message);
    return null;
  }
}

// Envía alertas de zonas calientes a choferes libres (se llama cada hora)
async function enviarAlertasChoferes(enviarMensajeFn) {
  try {
    const mensaje = await generarAlertaZonasChoferes();
    if (!mensaje) return;

    const choferesLibres = await Chofer.find({ estado: "libre" }).lean();
    log.info(`[PREDICCION] Enviando alerta a ${choferesLibres.length} choferes libres`);

    for (const chofer of choferesLibres) {
      try {
        await enviarMensajeFn(chofer.phone, mensaje);
        await new Promise(r => setTimeout(r, 500)); // Throttle para no saturar la API
      } catch { /* ignorar fallo individual */ }
    }
  } catch (e) {
    log.error("[PREDICCION] enviarAlertas:", e.message);
  }
}

module.exports = { registrarViajeEnDemanda, obtenerZonasCalientes, generarAlertaZonasChoferes, enviarAlertasChoferes };
