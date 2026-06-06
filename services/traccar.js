// ChatGo — Traccar GPS
const axios = require("axios");
const { CONFIG, log } = require("../config");
const { Chofer } = require("../db/models");
const { enPromoGratis, fechaStrBolivia } = require("../services/utils");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// TRACCAR_URL ej: https://traccar-production-056d.up.railway.app
// TRACCAR_USER / TRACCAR_PASS: credenciales del admin
const TRACCAR_URL  = process.env.TRACCAR_URL  || "";
const TRACCAR_USER = process.env.TRACCAR_USER || "";
const TRACCAR_PASS = process.env.TRACCAR_PASS || "";

// Cache de posiciones: traccarId -> { pos, expira }
const posCache = new Map();
const POS_CACHE_MS = 8 * 1000;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function authHeader() {
  const b64 = Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString("base64");
  return {
    Authorization: `Basic ${b64}`,
    "Accept": "application/json",
  };
}

function isConfigured() {
  return TRACCAR_URL && TRACCAR_USER && TRACCAR_PASS;
}

// ─── POSICIÓN DE UN CHOFER ───────────────────────────────────────────────────
async function _obtenerUbicacionRaw(traccarId) {
  if (!isConfigured()) throw new Error("Traccar no configurado");

  // Obtener positionId del dispositivo
  const devRes = await axios.get(`${TRACCAR_URL}/api/devices`, {
    headers: authHeader(),
    params: { id: traccarId },
    timeout: 8000,
  });
  const device = devRes.data?.[0];
  if (!device) throw new Error("Dispositivo no encontrado en Traccar");
  if (!device.positionId) throw new Error("Sin posición disponible en Traccar");

  // Obtener la posición por su ID
  const posRes = await axios.get(`${TRACCAR_URL}/api/positions`, {
    headers: authHeader(),
    params: { id: device.positionId },
    timeout: 8000,
  });
  const pos = posRes.data?.[0];
  if (!pos) throw new Error("Sin posición disponible en Traccar");

  const minutos = Math.round((Date.now() - new Date(pos.fixTime).getTime()) / 60000);
  log.info(`[TRACCAR] Posición device ${traccarId}: lat=${pos.latitude} lng=${pos.longitude} minutos=${minutos}`);
  return { lat: pos.latitude, lng: pos.longitude, minutos };
}

async function obtenerUbicacionChofer(traccarId) {
  const cached = posCache.get(traccarId);
  if (cached && cached.expira > Date.now()) return cached.pos;
  const pos = await _obtenerUbicacionRaw(traccarId);
  posCache.set(traccarId, { pos, expira: Date.now() + POS_CACHE_MS });
  return pos;
}

// ─── BUSCAR CHOFER DISPONIBLE ────────────────────────────────────────────────
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

async function buscarChoferDisponibleTraccar(origenUsuario, excludeTraccarIds = [], tipoVehiculo = null) {
  if (!isConfigured()) return null;

  const ahora = new Date();
  await Chofer.updateMany(
    { reservadoHasta: { $lt: ahora } },
    { $set: { viajeReservado: null, reservadoHasta: null } }
  );

  const hoyStr = fechaStrBolivia();
  const filtro = {
    estado: "libre",
    traccarId: { $exists: true, $ne: null, $nin: excludeTraccarIds },
    $or: [{ viajeReservado: null }, { viajeReservado: { $exists: false } }],
  };
  if (!enPromoGratis()) {
    filtro["pagoDiario.aprobado"] = true;
    filtro["pagoDiario.fechaStr"] = hoyStr;
  }
  if (tipoVehiculo === "auto") {
    filtro.$and = [{
      $or: [
        { tipoVehiculo: "auto" },
        { tipoVehiculo: { $exists: false } },
        { tipoVehiculo: null },
        { tipoVehiculo: "" },
      ],
    }];
  } else if (tipoVehiculo) {
    filtro.tipoVehiculo = tipoVehiculo;
  }

  const choferes = await Chofer.find(filtro);
  if (!choferes.length) return null;

  // Obtener dispositivos con su positionId
  let dispositivos = [];
  try {
    const devRes = await axios.get(`${TRACCAR_URL}/api/devices`, {
      headers: authHeader(),
      timeout: 8000,
    });
    dispositivos = devRes.data || [];
  } catch (e) {
    log.error("[TRACCAR_BUSCAR] Error obteniendo dispositivos:", e.message);
    return null;
  }

  // Obtener posiciones por IDs
  const positionIds = dispositivos
    .filter(d => d.positionId)
    .map(d => d.positionId);

  let posicionesTraccar = [];
  if (positionIds.length > 0) {
    try {
      const posRes = await axios.get(`${TRACCAR_URL}/api/positions`, {
        headers: authHeader(),
        params: { id: positionIds.join(",") },
        timeout: 8000,
      });
      posicionesTraccar = posRes.data || [];
    } catch (e) {
      log.error("[TRACCAR_BUSCAR] Error obteniendo posiciones:", e.message);
    }
  }

  // Mapa deviceId -> posicion
  const posMap = {};
  for (const pos of posicionesTraccar) {
    posMap[String(pos.deviceId)] = pos;
  }

  const ahoraMs = Date.now();
  const candidatos = [];

  for (const chofer of choferes) {
    const dev = dispositivos.find(d => String(d.id) === String(chofer.traccarId));
    if (!dev || !dev.positionId) continue;
    const pos = posMap[String(chofer.traccarId)];
    if (!pos) continue;
    const minutos = Math.round((ahoraMs - new Date(pos.fixTime).getTime()) / 60000);
    if (minutos > 10) continue;
    const dist = distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.latitude, pos.longitude);
    if (dist > 10) continue;
    candidatos.push({
      ...chofer.toObject(),
      ubicacion: { lat: pos.latitude, lng: pos.longitude, minutos },
      distanciaAlUsuario: dist,
    });
  }

  if (!candidatos.length) return null;

  // Elegir el más cercano (mismo criterio simple que Wialon)
  candidatos.sort((a, b) => a.distanciaAlUsuario - b.distanciaAlUsuario);
  return candidatos[0];
}

// ─── RESERVA ─────────────────────────────────────────────────────────────────
async function reservarChoferTraccar(traccarId, viajeId) {
  const reservadoHasta = new Date(Date.now() + (CONFIG.TIMEOUT_ACEPTACION_CHOFER + 10) * 1000);
  return await Chofer.findOneAndUpdate(
    {
      traccarId,
      estado: "libre",
      $or: [{ viajeReservado: null }, { viajeReservado: { $exists: false } }],
    },
    { $set: { viajeReservado: String(viajeId), reservadoHasta } },
    { new: true }
  );
}

async function liberarReservaChoferTraccar(traccarId) {
  await Chofer.updateOne({ traccarId }, { $set: { viajeReservado: null, reservadoHasta: null } });
}

// ─── FRECUENCIA DE REPORTE ───────────────────────────────────────────────────
// Cambia el intervalo de reporte del dispositivo (30s libre, 10s en viaje)
async function setFrecuenciaReporte(traccarId, segundos) {
  if (!isConfigured()) return;
  try {
    // Traccar permite enviar comandos al dispositivo
    await axios.post(`${TRACCAR_URL}/api/commands/send`, {
      deviceId: parseInt(traccarId),
      type: "setReportingInterval",
      attributes: { frequency: segundos },
    }, {
      headers: { ...authHeader(), "Content-Type": "application/json" },
      timeout: 5000,
    });
    log.info(`[TRACCAR] Frecuencia ${segundos}s → device ${traccarId}`);
  } catch (e) {
    log.error(`[TRACCAR_FREQ]`, e.message);
  }
}

// ─── LIMPIEZA CACHE ───────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of posCache.entries()) {
    if (data.expira < now) posCache.delete(id);
  }
}, 5 * 60 * 1000);

module.exports = {
  obtenerUbicacionChofer,
  buscarChoferDisponibleTraccar,
  reservarChoferTraccar,
  liberarReservaChoferTraccar,
  setFrecuenciaReporte,
  isTraccarConfigured: isConfigured,
};
