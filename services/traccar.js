// ChatGo — Traccar GPS (optimizado)
const axios = require("axios");
const { CONFIG, log } = require("../config");
const { Chofer } = require("../db/models");
const { enPromoGratis, fechaStrBolivia } = require("../services/utils");

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
  // Choferes de PRUEBA (comodín): reciben TODOS los tipos de viaje sin importar
  // qué vehículo tengan registrado. Útil para testing. Quitar de esta lista para
  // que el chofer vuelva a comportarse normal.
  const CHOFERES_PRUEBA = ["59176496075"]; // ffjj (prueba)

  if (tipoVehiculo === "auto") {
    filtro.$and = [{
      $or: [
        { tipoVehiculo: "auto" },
        { tipoVehiculo: { $exists: false } },
        { tipoVehiculo: null },
        { tipoVehiculo: "" },
        { phone: { $in: CHOFERES_PRUEBA } }, // comodín de prueba
      ],
    }];
  } else if (tipoVehiculo) {
    // Para un tipo específico (van/moto): el tipo exacto O un chofer de prueba
    filtro.$and = [{
      $or: [
        { tipoVehiculo: tipoVehiculo },
        { phone: { $in: CHOFERES_PRUEBA } }, // comodín de prueba recibe todo
      ],
    }];
  }

  const choferes = await Chofer.find(filtro);
  if (!choferes.length) return null;

  // Lee del snapshot en memoria — sin llamadas extra a Traccar
  const ok = await asegurarSnapshot();
  if (!ok && snapshotActualizado === 0) {
    log.error("[TRACCAR_BUSCAR] Snapshot no disponible");
    return null;
  }

  const ahoraMs = Date.now();
  const candidatos = [];

  for (const chofer of choferes) {
    const dev = snapshotDispositivos[String(chofer.traccarId)];
    if (!dev || !dev.positionId) continue;
    const pos = snapshotPosiciones[String(chofer.traccarId)];
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
