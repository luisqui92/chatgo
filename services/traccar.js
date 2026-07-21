// ChatGo — Traccar GPS (optimizado)
const axios = require("axios");
const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { Chofer } = require("../db/models");
const { enPromoGratis, fechaStrBolivia, choferPagoAlDia } = require("../services/utils");

const TRACCAR_URL  = process.env.TRACCAR_URL  || "";
const TRACCAR_USER = process.env.TRACCAR_USER || "";
const TRACCAR_PASS = process.env.TRACCAR_PASS || "";

// Timeout corto para no colgar el bot si Traccar está lento
const TRACCAR_TIMEOUT = 3000;

// ─── CACHÉ GLOBAL DE POSICIONES ──────────────────────────────────────────────
// En lugar de consultar Traccar en cada request, mantenemos un snapshot
// de TODAS las posiciones y dispositivos, refrescado en background.
let snapshotPosiciones = {};   // deviceId -> posición
let snapshotDispositivos = {}; // deviceId -> dispositivo (con positionId)
let snapshotActualizado = 0;   // timestamp de la última actualización OK
const SNAPSHOT_TTL_MS = 6000;  // si el snapshot tiene menos de 6s, se usa directo

let refrescando = false;

function authHeader() {
  const b64 = Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString("base64");
  return { Authorization: `Basic ${b64}`, "Accept": "application/json" };
}

function isConfigured() {
  return TRACCAR_URL && TRACCAR_USER && TRACCAR_PASS;
}

// Refresca el snapshot completo con UNA sola llamada a cada endpoint.
// Se llama desde un interval en background y bajo demanda si está viejo.
async function refrescarSnapshot() {
  if (!isConfigured()) return false;
  if (refrescando) return false; // evitar refrescos concurrentes
  refrescando = true;
  try {
    const [devRes, posRes] = await Promise.all([
      axios.get(`${TRACCAR_URL}/api/devices`,   { headers: authHeader(), timeout: TRACCAR_TIMEOUT }),
      axios.get(`${TRACCAR_URL}/api/positions`, { headers: authHeader(), timeout: TRACCAR_TIMEOUT }),
    ]);

    const devs = {};
    for (const d of (devRes.data || [])) devs[String(d.id)] = d;

    const pos = {};
    for (const p of (posRes.data || [])) pos[String(p.deviceId)] = p;

    snapshotDispositivos = devs;
    snapshotPosiciones = pos;
    snapshotActualizado = Date.now();
    return true;
  } catch (e) {
    log.error("[TRACCAR_SNAPSHOT]", e.message);
    return false;
  } finally {
    refrescando = false;
  }
}

// Garantiza que el snapshot no esté viejo. Si lo está, lo refresca.
async function asegurarSnapshot() {
  if (Date.now() - snapshotActualizado < SNAPSHOT_TTL_MS) return true;
  return await refrescarSnapshot();
}

// ─── POSICIÓN DE UN CHOFER ───────────────────────────────────────────────────
async function obtenerUbicacionChofer(traccarId) {
  await asegurarSnapshot();

  const dev = snapshotDispositivos[String(traccarId)];
  if (!dev) throw new Error("Dispositivo no encontrado en Traccar");
  if (!dev.positionId) throw new Error("Sin posición disponible en Traccar");

  const pos = snapshotPosiciones[String(traccarId)];
  if (!pos) throw new Error("Sin posición disponible en Traccar");

  const minutos = Math.round((Date.now() - new Date(pos.fixTime).getTime()) / 60000);
  return { lat: pos.latitude, lng: pos.longitude, minutos };
}

// ─── DISTANCIA ───────────────────────────────────────────────────────────────
function distanciaEntrePuntos(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── BUSCAR CHOFER DISPONIBLE ────────────────────────────────────────────────
async function buscarChoferDisponibleTraccar(origenUsuario, excludeTraccarIds = [], tipoVehiculo = null) {
  if (!isConfigured()) return null;

  const ahora = new Date();
  await Chofer.updateMany({
    where: { reservadoHasta: { lt: ahora } },
    data: { viajeReservado: null, reservadoHasta: null },
  });

  // CHOFERES DE PRUEBA (SUPERCHOFERES forzados): se les asigna el viaje sin
  // importar ciudad/distancia/tiempo, mientras tengan GPS en vivo y no hayan
  // sido excluidos en este mismo intento (para no reintentar infinito si no
  // responden). El pago diario SÍ se exige igual que a cualquier chofer real —
  // el objetivo es poder probar el flujo de cobro de punta a punta.
  // Con VARIOS números se ve la SECUENCIA de llegada: el más cercano recibe
  // primero, y como cada rechazo/timeout lo agrega a excludeTraccarIds, el
  // siguiente intento cae en el siguiente superchofer más cercano.
  const pruebaPhones = CONFIG.CHOFER_PRUEBA_PHONES || (CONFIG.CHOFER_PRUEBA_PHONE ? [CONFIG.CHOFER_PRUEBA_PHONE] : []);
  if (pruebaPhones.length) {
    await asegurarSnapshot();
    const candidatosPrueba = [];
    for (const phone of pruebaPhones) {
      const choferPrueba = await Chofer.findUnique({ where: { phone } });
      // Ambulancias: servicio comunitario gratuito — sin exigencia de pago tampoco en pruebas
      const pagoOk = tipoVehiculo === "ambulancia" || enPromoGratis() || choferPagoAlDia(choferPrueba);
      if (!choferPrueba?.traccarId || !pagoOk || excludeTraccarIds.includes(choferPrueba.traccarId)) continue;
      const dev = snapshotDispositivos[String(choferPrueba.traccarId)];
      const pos = snapshotPosiciones[String(choferPrueba.traccarId)];
      if (!dev?.positionId || !pos) {
        log.warn(`[TRACCAR_PRUEBA] Chofer de prueba ${phone} sin posición GPS en vivo`);
        continue;
      }
      // Antigüedad REAL de la posición (antes estaba fija en 0). Si el GPS del
      // chofer no reportó hace rato, la distancia se calcula con una posición
      // vieja — mostrar los minutos deja eso a la vista.
      const minutosPos = pos.fixTime ? Math.round((Date.now() - new Date(pos.fixTime).getTime()) / 60000) : 0;
      candidatosPrueba.push({
        ...choferPrueba,
        ubicacion: { lat: pos.latitude, lng: pos.longitude, minutos: minutosPos },
        distanciaAlUsuario: distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.latitude, pos.longitude),
      });
    }
    if (candidatosPrueba.length) {
      candidatosPrueba.sort((a, b) => a.distanciaAlUsuario - b.distanciaAlUsuario);
      const elegido = candidatosPrueba[0];
      log.info(`[TRACCAR_PRUEBA] Forzando asignación al superchofer ${elegido.phone} (${candidatosPrueba.length} de prueba disponibles, más cercano a ${elegido.distanciaAlUsuario.toFixed(1)} km)`);
      return elegido;
    }
    log.warn(`[TRACCAR_PRUEBA] Ningún chofer de prueba disponible con GPS en vivo, sigue flujo normal`);
  }

  const hoyStr = fechaStrBolivia();
  const where = {
    estado: "libre",
    traccarId: { not: null, notIn: excludeTraccarIds },
    viajeReservado: null,
  };

  const and = [];
  // AMBULANCIAS: servicio comunitario GRATUITO — las unidades de la red nunca
  // pagan cuota. La exigencia de pago aplica solo al resto de los servicios.
  if (!enPromoGratis() && tipoVehiculo !== "ambulancia") {
    // Exigir pago al día a TODOS los choferes, incluyendo el de prueba —
    // el objetivo del chofer de prueba es validar el flujo de cobro de punta a punta.
    and.push({ pagoDiarioAprobado: true, pagoDiarioFechaStr: hoyStr });
  }
  // "todo" = SUPERCHOFER: recibe cualquier tipo de solicitud (auto, moto,
  // van, ambulancia, delivery). Útil para el chofer de pruebas y para
  // choferes multiservicio reales.
  if (tipoVehiculo === "auto") {
    and.push({ OR: [{ tipoVehiculo: "auto" }, { tipoVehiculo: "" }, { tipoVehiculo: "todo" }] });
  } else if (tipoVehiculo) {
    and.push({ OR: [{ tipoVehiculo }, { tipoVehiculo: "todo" }] });
  }
  if (and.length) where.AND = and;

  const choferes = await Chofer.findMany({ where });
  if (!choferes.length) return null;

  // Lee del snapshot en memoria — sin llamadas extra a Traccar
  const ok = await asegurarSnapshot();
  if (!ok && snapshotActualizado === 0) {
    log.error("[TRACCAR_BUSCAR] Snapshot no disponible");
    return null;
  }

  const ahoraMs = Date.now();
  const candidatos = [];

  // MODO DEMO: para presentaciones, ignora los filtros de distancia/tiempo
  // para que el chofer reciba el viaje aunque esté lejos (ej: pasajero en Santa
  // Cruz, chofer en Cochabamba). Se activa con la variable de entorno MODO_DEMO=true.
  // OJO: el filtro de ciudad real (no demo) NUNCA se ignora, ni siquiera en demo,
  // porque cruzar ciudades en pedidos reales rompe el match pasajero-chofer.
  const modoDemo = String(process.env.MODO_DEMO || "").toLowerCase() === "true";
  const ciudadOrigen = detectarCiudadPorCoords(origenUsuario.lat, origenUsuario.lng);

  for (const chofer of choferes) {
    const dev = snapshotDispositivos[String(chofer.traccarId)];
    if (!dev || !dev.positionId) continue;
    const pos = snapshotPosiciones[String(chofer.traccarId)];
    if (!pos) continue;
    if (!modoDemo && ciudadOrigen) {
      const ciudadChofer = detectarCiudadPorCoords(pos.latitude, pos.longitude);
      if (ciudadChofer && ciudadChofer !== ciudadOrigen) continue;
    }
    const minutos = Math.round((ahoraMs - new Date(pos.fixTime).getTime()) / 60000);
    if (minutos > 10) continue;
    const dist = distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.latitude, pos.longitude);
    if (dist > 10) continue;
    candidatos.push({
      ...chofer,
      ubicacion: { lat: pos.latitude, lng: pos.longitude, minutos },
      distanciaAlUsuario: dist,
    });
  }

  if (!candidatos.length) return null;
  candidatos.sort((a, b) => a.distanciaAlUsuario - b.distanciaAlUsuario);
  return candidatos[0];
}

// ─── RESERVA ─────────────────────────────────────────────────────────────────
async function reservarChoferTraccar(traccarId, viajeId) {
  const reservadoHasta = new Date(Date.now() + (CONFIG.TIMEOUT_ACEPTACION_CHOFER + 10) * 1000);
  const { count } = await Chofer.updateMany({
    where: { traccarId, estado: "libre", viajeReservado: null },
    data: { viajeReservado: String(viajeId), reservadoHasta },
  });
  if (count === 0) return null;
  return await Chofer.findUnique({ where: { traccarId } });
}

async function liberarReservaChoferTraccar(traccarId) {
  await Chofer.update({ where: { traccarId }, data: { viajeReservado: null, reservadoHasta: null } });
}

// ─── FRECUENCIA DE REPORTE ───────────────────────────────────────────────────
async function setFrecuenciaReporte(traccarId, segundos) {
  if (!isConfigured()) return;
  try {
    await axios.post(`${TRACCAR_URL}/api/commands/send`, {
      deviceId: parseInt(traccarId),
      type: "setReportingInterval",
      attributes: { frequency: segundos },
    }, {
      headers: { ...authHeader(), "Content-Type": "application/json" },
      timeout: TRACCAR_TIMEOUT,
    });
  } catch (e) {
    log.error(`[TRACCAR_FREQ]`, e.message);
  }
}

// ─── REFRESCO EN BACKGROUND ──────────────────────────────────────────────────
// Mantiene el snapshot caliente. Una sola llamada cada 5s sirve a TODO el bot,
// sin importar cuántos viajes o consultas haya simultáneamente.
if (isConfigured()) {
  setInterval(() => { refrescarSnapshot(); }, 5000);
  // Primer refresco al arrancar
  refrescarSnapshot();
}

function getAppUrl() {
  return process.env.APP_URL || "https://chatgo-production.up.railway.app";
}

function generarLinkRastreoPropio(viajeId) {
  const apiUrl = encodeURIComponent(`${getAppUrl()}/track/${viajeId}/pos`);
  return `https://chatgo.ia.bo/rastreo.html?id=${viajeId}&api=${apiUrl}`;
}

module.exports = {
  obtenerUbicacionChofer,
  buscarChoferDisponibleTraccar,
  reservarChoferTraccar,
  liberarReservaChoferTraccar,
  setFrecuenciaReporte,
  isTraccarConfigured: isConfigured,
  generarLinkRastreoPropio,
  distanciaEntrePuntos,
};
