// ═══════════════════════════════════════════════════════════════════════════
// IA de Despacho Inteligente
// Puntúa cada chofer candidato para un viaje y elige el más eficiente
// No solo "el más cercano" sino "el más eficiente para ESTE viaje"
// ═══════════════════════════════════════════════════════════════════════════

const { Chofer, EventoChofer } = require("./models");
const { log } = require("./config");

// Actualiza las métricas de un chofer después de cada evento
async function registrarEventoChofer(choferPhone, tipo, datos = {}) {
  try {
    await EventoChofer.create({
      choferPhone,
      tipo,
      viajeId: datos.viajeId,
      distanciaAlOrigen: datos.distanciaAlOrigen,
      segundosParaResponder: datos.segundosParaResponder,
      hora: new Date().getHours(),
      diaSemana: new Date().getDay(),
      zonaOrigen: datos.zonaOrigen,
    });

    // Recalcular métricas del chofer con los últimos 50 eventos
    await recalcularMetricasChofer(choferPhone);
  } catch (e) {
    log.error("[DESPACHO] registrarEvento:", e.message);
  }
}

async function recalcularMetricasChofer(choferPhone) {
  try {
    const eventos = await EventoChofer.find({ choferPhone })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    if (eventos.length < 3) return; // Necesitamos mínimo 3 eventos para calcular

    const ofertas = eventos.filter(e => e.tipo === "oferta_recibida").length;
    const aceptados = eventos.filter(e => e.tipo === "aceptado").length;
    const cancelados = eventos.filter(e => e.tipo === "cancelado").length;
    const completados = eventos.filter(e => e.tipo === "completado").length;

    const tasaAceptacion = ofertas > 0 ? (aceptados / ofertas) * 100 : null;
    const tasaCancelacion = (aceptados + completados) > 0
      ? (cancelados / (aceptados + completados)) * 100 : null;

    const tiemposRespuesta = eventos
      .filter(e => e.tipo === "aceptado" && e.segundosParaResponder)
      .map(e => e.segundosParaResponder);
    const tiempoPromedio = tiemposRespuesta.length > 0
      ? tiemposRespuesta.reduce((a, b) => a + b, 0) / tiemposRespuesta.length
      : null;

    // Zonas donde más trabaja
    const zonas = eventos
      .filter(e => e.zonaOrigen)
      .map(e => e.zonaOrigen);
    const zonasUnicas = [...new Set(zonas)];

    await Chofer.findOneAndUpdate(
      { phone: choferPhone },
      {
        tasaAceptacion: tasaAceptacion ? Math.round(tasaAceptacion) : null,
        tasaCancelacion: tasaCancelacion ? Math.round(tasaCancelacion) : null,
        tiempoPromedioAceptacion: tiempoPromedio ? Math.round(tiempoPromedio) : null,
        zonasConocidas: zonasUnicas.slice(0, 10),
      }
    );
  } catch (e) {
    log.error("[DESPACHO] recalcularMetricas:", e.message);
  }
}

// Puntúa un chofer para un viaje específico (0-100)
// Factores: distancia, rating, tasa aceptación, tasa cancelación, tiempo respuesta, zona
function puntuarChofer(chofer, distanciaKm, zonaOrigen) {
  let score = 50; // Base

  // 1. Distancia (máx 30 puntos) — más cerca = más puntos
  // 0km = 30pts, 5km = 15pts, 10km = 0pts
  const ptsDist = Math.max(0, 30 - distanciaKm * 3);
  score += ptsDist;

  // 2. Rating (máx 20 puntos)
  if (chofer.ratingCantidad >= 3) {
    const ptsRating = ((chofer.ratingPromedio - 1) / 4) * 20; // 1★=0, 5★=20
    score += ptsRating;
  }

  // 3. Tasa de aceptación (máx 15 puntos)
  if (chofer.tasaAceptacion !== null) {
    const ptsAcept = (chofer.tasaAceptacion / 100) * 15;
    score += ptsAcept;
  }

  // 4. Tasa de cancelación (hasta -15 puntos)
  if (chofer.tasaCancelacion !== null) {
    const penalCan = (chofer.tasaCancelacion / 100) * 15;
    score -= penalCan;
  }

  // 5. Tiempo de respuesta (máx 10 puntos)
  if (chofer.tiempoPromedioAceptacion !== null) {
    // < 10s = 10pts, > 25s = 0pts
    const ptsResp = Math.max(0, 10 - (chofer.tiempoPromedioAceptacion - 10) * 0.67);
    score += ptsResp;
  }

  // 6. Conoce la zona (5 puntos bonus)
  if (zonaOrigen && chofer.zonasConocidas?.includes(zonaOrigen)) {
    score += 5;
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}

// Selecciona el mejor chofer de una lista de candidatos
function seleccionarMejorChofer(candidatos, origenLat, origenLng, zonaOrigen) {
  if (!candidatos.length) return null;

  // Si hay menos de 3 eventos históricos, usar distancia simple
  const sinHistorial = candidatos.filter(c => c.tasaAceptacion === null);
  if (sinHistorial.length === candidatos.length) {
    log.info("[DESPACHO] Sin historial suficiente — usando distancia simple");
    return candidatos.reduce((a, b) =>
      a.distanciaAlUsuario < b.distanciaAlUsuario ? a : b
    );
  }

  // Puntuar y ordenar
  const puntuados = candidatos.map(c => ({
    ...c,
    scoreDespacho: puntuarChofer(c, c.distanciaAlUsuario, zonaOrigen),
  }));

  puntuados.sort((a, b) => b.scoreDespacho - a.scoreDespacho);

  const elegido = puntuados[0];
  log.info(`[DESPACHO] Elegido: ${elegido.nombre} score=${elegido.scoreDespacho} dist=${elegido.distanciaAlUsuario?.toFixed(2)}km`);

  if (puntuados.length > 1) {
    log.info(`[DESPACHO] Descartado: ${puntuados[1].nombre} score=${puntuados[1].scoreDespacho}`);
  }

  return elegido;
}

module.exports = { registrarEventoChofer, recalcularMetricasChofer, puntuarChofer, seleccionarMejorChofer };
