// ChatGo — Sesiones, Rate Limit, Lista de Espera
const crypto = require("crypto");
const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { horaStrBolivia, fechaStrBolivia } = require("../services/utils");
const { SessionState, ListaEspera, RateLimit, prisma } = require("../db/models");

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
  const doc = await SessionState.findUnique({ where: { phone } });
  const data = doc ? doc.data : null;
  if (data) sessionCache.set(phone, data);
  return data;
}

async function setSession(phone, data) {
  sessionCache.set(phone, data);
  await SessionState.upsert({
    where: { phone },
    update: { data },
    create: { phone, data },
  });
}

async function updateSession(phone, patch) {
  const current = (await getSession(phone)) || {};
  const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await setSession(phone, merged);
  return merged;
}

async function deleteSession(phone) {
  sessionCache.delete(phone);
  await SessionState.deleteMany({ where: { phone } });
}

async function ensureSession(phone, defaults = { step: "inicio" }) {
  let s = await getSession(phone);
  if (!s) { s = defaults; await setSession(phone, s); }
  return s;
}

async function addListaEspera(userPhone, session) {
  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
  const ciudad = detectarCiudadPorCoords(session.origen?.lat, session.origen?.lng) || session.ciudadUsuario || null;
  const data = {
    ciudad,
    origenLat: session.origen?.lat ?? null,
    origenLng: session.origen?.lng ?? null,
    origenNombre: session.origen?.nombre ?? null,
    destinoLat: session.destino?.lat ?? null,
    destinoLng: session.destino?.lng ?? null,
    destinoNombre: session.destino?.nombre ?? null,
    distancia: session.distancia ?? null,
    precio: session.precio ?? session.precioFinal ?? session.precioAuto ?? null,
    precioPorKm: session.precioPorKm ?? null,
    tipoVehiculoSolicitado: tipoSolicitado,
    ofertaActivaChoferId: null,
    ofertaActivaHasta: null,
  };
  return await ListaEspera.upsert({
    where: { userPhone },
    update: data,
    create: { userPhone, timestamp: new Date(), ...data },
  });
}

async function removeListaEspera(userPhone) {
  await ListaEspera.deleteMany({ where: { userPhone } });
}

async function checkRateLimit(phone) {
  const horaStr = horaStrBolivia();
  const newId = crypto.randomUUID();
  // Upsert atómico con incremento condicional (equivalente al pipeline de Mongo):
  // si ya existía un registro de esta misma hora, suma 1; si es otra hora, reinicia en 1.
  await prisma.$executeRaw`
    INSERT INTO ratelimits (id, phone, horaStr, count, createdAt, updatedAt)
    VALUES (${newId}, ${phone}, ${horaStr}, 1, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      count = IF(horaStr = ${horaStr}, count + 1, 1),
      horaStr = ${horaStr},
      updatedAt = NOW()
  `;
  const doc = await RateLimit.findUnique({ where: { phone } });
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
