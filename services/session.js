// ChatGo — Sesiones, Rate Limit, Lista de Espera
const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { horaStrBolivia, fechaStrBolivia } = require("../services/utils");
const { SessionState, ListaEspera, RateLimit } = require("../db/models");

const sessionCache = new Map();
const processedMsgIds = new Map();

function yaProcesoMensaje(msgId) {
  const now = Date.now();
  // Limpiar entradas viejas
  for (const [id, ts] of processedMsgIds.entries()) {
    if (now - ts > CONFIG.MSG_DEDUP_TTL) processedMsgIds.delete(id);
  }
  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.set(msgId, now);
  return false;
}

async function getSession(phone) {
  if (sessionCache.has(phone)) return sessionCache.get(phone);
  const doc = await SessionState.findOne({ phone });
  const data = doc ? doc.data : null;
  if (data) sessionCache.set(phone, data);
  return data;
}

async function setSession(phone, data) {
  sessionCache.set(phone, data);
  await SessionState.findOneAndUpdate(
    { phone },
    { phone, data },
    { upsert: true, new: true }
  );
}

async function updateSession(phone, patch) {
  const current = (await getSession(phone)) || {};
  const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await setSession(phone, merged);
  return merged;
}

async function deleteSession(phone) {
  sessionCache.delete(phone);
  await SessionState.deleteOne({ phone });
}

async function ensureSession(phone, defaults = { step: "inicio" }) {
  let s = await getSession(phone);
  if (!s) { s = defaults; await setSession(phone, s); }
  return s;
}

async function addListaEspera(userPhone, session) {
  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
  const ciudad = detectarCiudadPorCoords(session.origen?.lat, session.origen?.lng) || session.ciudadUsuario || null;
  const existente = await ListaEspera.findOne({ userPhone });
  if (existente) {
    existente.ciudad = ciudad;
    existente.origen = session.origen;
    existente.destino = session.destino;
    existente.distancia = session.distancia;
    existente.precio = session.precio;
    existente.precioPorKm = session.precioPorKm;
    existente.tipoVehiculoSolicitado = tipoSolicitado;
    existente.ofertaActivaWialonId = null;
    existente.ofertaActivaHasta = null;
    await existente.save();
    return existente;
  }
  return await ListaEspera.create({
    userPhone,
    ciudad,
    origen: session.origen,
    destino: session.destino,
    distancia: session.distancia,
    precio: session.precio,
    precioPorKm: session.precioPorKm,
    tipoVehiculoSolicitado: tipoSolicitado,
    timestamp: new Date(),
  });
}

async function removeListaEspera(userPhone) {
  await ListaEspera.deleteOne({ userPhone });
}

async function checkRateLimit(phone) {
  const horaStr = horaStrBolivia();
  const doc = await RateLimit.findOneAndUpdate(
    { phone },
    [
      {
        $set: {
          phone,
          horaStr,
          count: {
            $cond: [{ $eq: ["$horaStr", horaStr] }, { $add: ["$count", 1] }, 1],
          },
        },
      },
    ],
    { upsert: true, new: true }
  );
  return doc.count <= CONFIG.MAX_MENSAJES_POR_HORA;
}


// ─── TTL del sessionCache — evita memory leak ───────────────────────────────
// sessionCache guarda timestamps lastSet — los entries viejos se eliminan cada 5 min
setInterval(() => {
  try {
    const expiraMs = 30 * 60 * 1000; // 30 min sin uso → fuera del cache
    const now = Date.now();
    let eliminados = 0;
    for (const [key, val] of sessionCache.entries()) {
      const lastSet = val?._cachedAt || 0;
      if (now - lastSet > expiraMs) {
        sessionCache.delete(key);
        eliminados++;
      }
    }
    // Limpiar también processedMsgIds (no debe crecer ilimitado)
    if (processedMsgIds.size > 5000) {
      const keys = Array.from(processedMsgIds.keys()).slice(0, 2000);
      for (const k of keys) processedMsgIds.delete(k);
    }
    if (eliminados > 0) log.info(`[CACHE_CLEANUP] sessionCache: -${eliminados} entries`);
  } catch (e) {
    log.warn("[CACHE_CLEANUP]", e.message);
  }
}, 5 * 60 * 1000);

module.exports = { getSession, setSession, updateSession, deleteSession, ensureSession, addListaEspera, removeListaEspera, checkRateLimit, sessionCache, processedMsgIds, yaProcesoMensaje };
