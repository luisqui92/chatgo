// ChatGo — Wialon GPS
const axios = require("axios");
const https = require("https");
const http = require("http");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Chofer } = require("../db/models");
const { enPromoGratis, fechaStrBolivia } = require("../services/utils");


const wialonCache = { eid: null, expira: 0 };

async function wialonLogin() {
  if (wialonCache.eid && Date.now() < wialonCache.expiresAt) return wialonCache.eid;
  const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
    params: {
      svc: "token/login",
      params: JSON.stringify({ token: CONFIG.WIALON_TOKEN }),
    },
    timeout: CONFIG.TIMEOUT_WIALON,
  });
  if (!res.data.eid) {
    wialonCache = { eid: null, expiresAt: 0 };
    throw new Error("Wialon login failed");
  }
  wialonCache = { eid: res.data.eid, expiresAt: Date.now() + 4 * 60 * 1000 };
  return res.data.eid;
}

function wialonInvalidateCache() {
  wialonCache = { eid: null, expiresAt: 0 };
}

async function obtenerUbicacionChofer(wialonId) {
  let eid;
  try { eid = await wialonLogin(); }
  catch { throw new Error("No se pudo conectar con Wialon"); }

  const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
    params: {
      svc: "core/search_item",
      params: JSON.stringify({ id: parseInt(wialonId), flags: 4294967295 }),
      sid: eid,
    },
    timeout: CONFIG.TIMEOUT_WIALON,
  });
  if (res.data?.error === 1) { wialonInvalidateCache(); throw new Error("Sesión Wialon expirada"); }
  const item = res.data.item;
  if (!item) throw new Error("Unidad no encontrada en Wialon");
  if (!item.pos) throw new Error("Sin GPS disponible");
  const pos = item.pos;
  const minutos = Math.round((Date.now() / 1000 - (pos.t || 0)) / 60);
  return { lat: pos.y, lng: pos.x, minutos };
}

// Construye la URL base de la app

function getAppUrl() {
  if (CONFIG.APP_URL) return CONFIG.APP_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return "http://localhost:3000";
}

// Genera el link de rastreo en chatgo.ia.bo
// La página estática llama a Railway API para obtener la posición

function generarLinkRastreoPropio(viajeId) {
  const apiUrl = encodeURIComponent(`${getAppUrl()}/track/${viajeId}/pos`);
  return `https://chatgo.ia.bo/rastreo.html?id=${viajeId}&api=${apiUrl}`;
}

async function generarLinkLocator(wialonId) {
  try {
    const eid = await wialonLogin();
    const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "locator/create_hash",
        params: JSON.stringify({ items: [parseInt(wialonId)], duration: CONFIG.LOCATOR_DURACION, type: 0 }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (res.data?.hash) return `https://hosting.wialon.com/locator/index.html?t=${res.data.hash}`;
    throw new Error("No hash");
  } catch (e) {
    log.error("[LOCATOR]", e.message);
    try {
      const pos = await obtenerUbicacionChofer(wialonId);
      return `https://www.google.com/maps?q=${pos.lat},${pos.lng}`;
    } catch {
      return "https://hosting.wialon.com/";
    }
  }
}

// FIX BUG#5 — busqueda bulk Wialon con regex pattern correcto

async function buscarChoferDisponible(origenUsuario, excludeWialonIds = [], tipoVehiculo = null) {
  const ahora = new Date();
  await Chofer.updateMany(
    { reservadoHasta: { $lt: ahora } },
    { $set: { viajeReservado: null, reservadoHasta: null } }
  );

  const hoyStr = fechaStrBolivia();
  const filtro = {
    estado: "libre",
    wialonId: { $nin: excludeWialonIds },
    $or: [{ viajeReservado: null }, { viajeReservado: { $exists: false } }],
  };
  if (!enPromoGratis()) {
    filtro["pagoDiario.aprobado"] = true;
    filtro["pagoDiario.fechaStr"] = hoyStr;
  }
  // ⚡ FIX tipoVehiculo: choferes del flujo VIEJO no tienen este campo.
  // Si filtramos { tipoVehiculo:"auto" } exacto, quedan invisibles al bot.
  // "auto" => incluye también campo ausente/null/"" (se asumen auto).
  // "moto" => match exacto (una moto debe estar declarada explícitamente).
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
  if (!choferes.length) {
    log.info(`[BUSCAR] No hay choferes ${tipoVehiculo || ""} libres (query Mongo vacío)`);
    return null;
  }

  // FIX: usar propName "sys_name" con wildcard "*" para traer TODAS las unidades
  // y filtrar localmente por ID. Esto evita el bug con propValueMask y IDs numéricos.
  let itemsWialon = [];
  try {
    const eid = await wialonLogin();
    const wialonIds = choferes.map(c => parseInt(c.wialonId)).filter(id => !isNaN(id));
    if (wialonIds.length === 0) return null;

    const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "core/search_items",
        params: JSON.stringify({
          spec: {
            itemsType: "avl_unit",
            propName: "sys_name",
            propValueMask: "*",
            sortType: "sys_name",
          },
          force: 1,
          // Flags Wialon: 1=BASE, 1024=LAST_MESSAGE (incluye posición).
          // 256 era CUSTOM_PROPS (NO posición) — ese era el bug viejo.
          flags: 1 | 1024,
          from: 0,
          to: 0xFFFFFFFF, // ⚡ FIX: traer TODAS las unidades (antes "to:0" traía 1)
        }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (res.data?.error === 1) { wialonInvalidateCache(); throw new Error("Sesión Wialon expirada"); }
    const idSet = new Set(wialonIds);
    itemsWialon = (res.data.items || []).filter(i => idSet.has(i.id));
    log.info(`[BUSCAR] Wialon devolvió ${res.data.items?.length || 0} unidades, ${itemsWialon.length} matchean con choferes`);
    if (itemsWialon.length > 0 && !itemsWialon[0].pos) {
      log.info(`[BUSCAR_DEBUG] keys=${JSON.stringify(Object.keys(itemsWialon[0]))} sample=${JSON.stringify(itemsWialon[0]).slice(0,400)}`);
    }
  } catch (e) {
    log.error("[BUSCAR_BULK]", e.message);
    return null;
  }

  const ahoraSeg = Math.floor(Date.now() / 1000);
  let dSinUnit = 0, dSinPos = 0, dGpsViejo = 0, dLejos = 0;

  // Construir lista de candidatos válidos (con GPS activo y dentro del radio)
  const candidatos = [];
  for (const chofer of choferes) {
    const itemW = itemsWialon.find(i => i.id === parseInt(chofer.wialonId));
    if (!itemW) { dSinUnit++; continue; }
    const pos = itemW.pos || itemW.lpos || (itemW.lmsg && itemW.lmsg.pos) || null;
    if (!pos) { dSinPos++; continue; }
    const tsRaw = pos.t || (itemW.lmsg && itemW.lmsg.t) || 0;
    const minutosGps = Math.round((ahoraSeg - tsRaw) / 60);
    if (minutosGps > 10) { dGpsViejo++; continue; }
    const dist = distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.y, pos.x);
    if (dist > 10) { dLejos++; continue; }
    candidatos.push({
      ...chofer.toObject(),
      ubicacion: { lat: pos.y, lng: pos.x, minutos: minutosGps },
      distanciaAlUsuario: dist,
    });
  }

  if (!candidatos.length) {
    log.info(`[BUSCAR] ${choferes.length} libres - sinUnit:${dSinUnit} sinPos:${dSinPos} gpsViejo:${dGpsViejo} lejos:${dLejos}`);
    return null;
  }

  // IA DE DESPACHO: seleccionar el mejor chofer (no solo el más cercano)
  const mejorChofer = seleccionarMejorChofer(candidatos, origenUsuario.lat, origenUsuario.lng, null);

  if (mejorChofer) {
    log.info(`[BUSCAR] IA eligió ${mejorChofer.nombre} a ${mejorChofer.distanciaAlUsuario?.toFixed(2)}km score=${mejorChofer.scoreDespacho || "N/A"}`);
    // Registrar que se le envió una oferta
    registrarEventoChofer(mejorChofer.phone, "oferta_recibida", {
      distanciaAlOrigen: mejorChofer.distanciaAlUsuario,
    }).catch(() => {});
  }

  return mejorChofer;
}

async function reservarChofer(wialonId, viajeId) {
  const reservadoHasta = new Date(Date.now() + (CONFIG.TIMEOUT_ACEPTACION_CHOFER + 10) * 1000);
  return await Chofer.findOneAndUpdate(
    {
      wialonId,
      estado: "libre",
      $or: [{ viajeReservado: null }, { viajeReservado: { $exists: false } }],
    },
    { $set: { viajeReservado: String(viajeId), reservadoHasta } },
    { new: true }
  );
}

async function liberarReservaChofer(wialonId) {
  await Chofer.updateOne({ wialonId }, { $set: { viajeReservado: null, reservadoHasta: null } });
}

module.exports = { wialonLogin, wialonInvalidateCache, obtenerUbicacionChofer, getAppUrl, generarLinkRastreoPropio, generarLinkLocator, buscarChoferDisponible, reservarChofer, liberarReservaChofer };
