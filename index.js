// ═══════════════════════════════════════════════════════════════════════════
// ChatGo - Bot de Taxi por WhatsApp (HARDENED v3)
// RastreoPlus - Cochabamba, Bolivia
// v3: timeout chofer 30s, lista espera activa, historial, cancelación, rating, soporte
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const FormData = require("form-data");
const crypto = require("crypto");

const app = express();

// ─── CONFIGURACIÓN ─────────────────────────────────────────────────────────
const CONFIG = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  META_APP_SECRET: process.env.META_APP_SECRET,
  GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY,
  WIALON_TOKEN: process.env.WIALON_TOKEN,
  OPENAI_KEY: process.env.OPENAI_KEY,
  MONGODB_URI: process.env.MONGODB_URI,
  ADMIN_PHONE: process.env.ADMIN_PHONE || "59162741818",
  QR_IMAGE_URL: process.env.QR_IMAGE_URL,

  TIMEOUT_OPENAI: 45000,
  TIMEOUT_GOOGLE: 10000,
  TIMEOUT_WIALON: 15000,
  TIMEOUT_META: 15000,

  // Timeouts de flujo (segundos)
  TIMEOUT_ACEPTACION_CHOFER: 30,
  ESPERA_NOTIFICAR_SIN_CHOFER: 120, // 2 min
  ESPERA_TIMEOUT_TOTAL: 300, // 5 min
  ESPERA_OFERTA_VIGENCIA: 45,

  LOCATOR_DURACION: 21600,
  OFFSET_HORAS: -4,
  MAX_MENSAJES_POR_HORA: 80,
};

// ─── LOGGER ────────────────────────────────────────────────────────────────
const log = {
  info: (...args) => console.log(new Date().toISOString(), "[INFO]", ...args),
  warn: (...args) => console.warn(new Date().toISOString(), "[WARN]", ...args),
  error: (...args) => console.error(new Date().toISOString(), "[ERROR]", ...args),
  debug: (...args) => console.log(new Date().toISOString(), "[DEBUG]", ...args),
};

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── MONGODB ────────────────────────────────────────────────────────────────
mongoose
  .connect(CONFIG.MONGODB_URI)
  .then(() => log.info("✅ MongoDB conectado"))
  .catch((e) => log.error("❌ Error MongoDB:", e.message));

const usuarioSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    nombre: String,
    aceptoTerminos: { type: Boolean, default: false },
    fechaRegistro: { type: Date, default: Date.now },
    viajesTotal: { type: Number, default: 0 },
    rutasFrecuentes: [
      {
        origen: { lat: Number, lng: Number, nombre: String },
        destino: { lat: Number, lng: Number, nombre: String },
        contador: { type: Number, default: 1 },
      },
    ],
  },
  { timestamps: true }
);

const choferSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    wialonId: { type: String, unique: true, sparse: true, index: true },
    placa: String,
    nombre: String,
    tipoVehiculo: { type: String, enum: ["auto", "moto"], default: "auto", index: true },
    estado: { type: String, default: "offline", index: true },
    pagoDiario: {
      fecha: Date,
      fechaStr: String,
      pagado: { type: Boolean, default: false },
      aprobado: { type: Boolean, default: false },
      comprobanteValidado: { type: Boolean, default: false },
    },
    viajesTotal: { type: Number, default: 0 },
    aceptoTerminos: { type: Boolean, default: false },
    fechaRegistro: { type: Date, default: Date.now },

    viajeReservado: { type: String, default: null },
    reservadoHasta: Date,

    // Rating promedio del chofer (para futuro)
    ratingPromedio: { type: Number, default: 0 },
    ratingCantidad: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const viajeSchema = new mongoose.Schema(
  {
    usuarioPhone: { type: String, index: true },
    choferPhone: { type: String, index: true },
    choferWialonId: { type: String, index: true },
    choferNombre: String,
    choferPlaca: String,
    origen: { lat: Number, lng: Number, nombre: String },
    destino: { lat: Number, lng: Number, nombre: String },
    distanciaKm: Number,
    precioTotal: Number,
    precioPorKm: Number,
    tipoVehiculo: { type: String, enum: ["auto", "moto"], default: "auto" },
    estado: { type: String, default: "pendiente", index: true },
    fechaInicio: { type: Date, default: Date.now },
    fechaAsignacion: Date,
    fechaAceptacion: Date,
    fechaFin: Date,
    llegadaNotificada: { type: Boolean, default: false }, // llegada al destino
    llegadaOrigenNotificada: { type: Boolean, default: false }, // chofer llegó al pasajero (≤50m)
    cancelacionMotivo: String,

    // Rating del pasajero al chofer
    ratingPasajero: Number, // 1-5
    comentarioPasajero: String,
    ratingSolicitado: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const sessionSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Lista de espera con oferta activa
const listaEsperaSchema = new mongoose.Schema(
  {
    userPhone: { type: String, unique: true, index: true },
    origen: { lat: Number, lng: Number, nombre: String },
    destino: { lat: Number, lng: Number, nombre: String },
    distancia: Number,
    precio: Number,
    precioPorKm: Number,
    tipoVehiculoSolicitado: { type: String, enum: ["auto", "moto", null], default: null },
    timestamp: { type: Date, default: Date.now },
    notificado: { type: Boolean, default: false }, // ya se avisó "no hay chofer"

    // Oferta activa cuando aparece un chofer
    ofertaActivaWialonId: { type: String, default: null },
    ofertaActivaHasta: { type: Date, default: null },
    ofertasRechazadas: { type: [String], default: [] },
  },
  { timestamps: true }
);

const rateLimitSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    horaStr: String,
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);
const SessionState = mongoose.model("SessionState", sessionSchema, "sessionstates");
const ListaEspera = mongoose.model("ListaEspera", listaEsperaSchema, "listaesperas");
const RateLimit = mongoose.model("RateLimit", rateLimitSchema, "ratelimits");

// ═══════════════════════════════════════════════════════════════════════════
// FECHA Y ZONA HORARIA (Bolivia UTC-4)
// ═══════════════════════════════════════════════════════════════════════════

function fechaStrBolivia(date = new Date()) {
  const boliviaTime = new Date(date.getTime() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
  return boliviaTime.toISOString().slice(0, 10);
}

function horaStrBolivia(date = new Date()) {
  const boliviaTime = new Date(date.getTime() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
  return boliviaTime.toISOString().slice(0, 13);
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION STORE (Mongo + cache en RAM)
// ═══════════════════════════════════════════════════════════════════════════

const sessionCache = new Map();

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
  const merged = { ...current, ...patch };
  await setSession(phone, merged);
  return merged;
}

async function deleteSession(phone) {
  sessionCache.delete(phone);
  await SessionState.deleteOne({ phone });
}

async function ensureSession(phone, defaults = { step: "inicio" }) {
  let s = await getSession(phone);
  if (!s) {
    s = defaults;
    await setSession(phone, s);
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTA DE ESPERA
// ═══════════════════════════════════════════════════════════════════════════

async function addListaEspera(userPhone, session) {
  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
  // Si ya existe, preservar timestamp y ofertasRechazadas; si no, crear fresca
  const existente = await ListaEspera.findOne({ userPhone });
  if (existente) {
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

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMIT
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

function calcularPrecio(km, tipoVehiculo = "auto") {
  let precioPorKm, minimo;

  if (tipoVehiculo === "moto") {
    // 🏍️ MOTO — escalonado descendente, ~30% más barato que auto
    if (km < 4) precioPorKm = 2.5;
    else if (km < 10) precioPorKm = 2.0;
    else precioPorKm = 1.5;
    minimo = 5;
  } else {
    // 🚗 AUTO — escalonado descendente
    if (km < 4) precioPorKm = 3.5;
    else if (km < 10) precioPorKm = 2.5;
    else precioPorKm = 2.0;
    minimo = 6;
  }

  const total = Math.round(Math.max(km * precioPorKm, minimo));
  return { total, precioPorKm, minimo, tipoVehiculo };
}

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

function validarPlaca(p) {
  if (!p) return false;
  const limpia = String(p).replace(/[\s\-\.]/g, "").toUpperCase();
  return /^(\d{3,4}[A-Z]{3}|[A-Z]{3}\d{3,4})$/.test(limpia);
}

function normalizarPlaca(p) {
  if (!p) return "";
  return String(p).replace(/[\s\-\.]/g, "").toUpperCase();
}

// Acorta un nombre largo para caber en el botón (máx 20 chars con prefijo)
function acortarParaBoton(texto, maxLen = 17) {
  if (!texto) return "";
  const limpio = String(texto).split(",")[0].trim();
  if (limpio.length <= maxLen) return limpio;
  return limpio.substring(0, maxLen - 1) + "…";
}

// Detectar intento de cancelar en texto libre
function esIntentoCancelar(texto) {
  if (!texto) return false;
  const t = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const patrones = [
    "cancelar",
    "cancela",
    "cancelalo",
    "cancelado",
    "ya no quiero",
    "ya no",
    "anular",
    "anula",
  ];
  return patrones.some((p) => t === p || t.startsWith(p + " ") || t.endsWith(" " + p));
}

// Detectar pedido de ayuda/soporte
function esPedidoAyuda(texto) {
  if (!texto) return false;
  const t = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const patrones = ["ayuda", "soporte", "urgencia", "emergencia", "hablar con alguien", "admin"];
  return patrones.some((p) => t === p || t.startsWith(p + " ") || t.includes(" " + p));
}

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE MAPS
// ═══════════════════════════════════════════════════════════════════════════

async function calcularDistancia(origen, destino) {
  try {
    const res = await axios.get(
      "https://maps.googleapis.com/maps/api/distancematrix/json",
      {
        params: {
          origins: `${origen.lat},${origen.lng}`,
          destinations: `${destino.lat},${destino.lng}`,
          key: CONFIG.GOOGLE_MAPS_KEY,
          mode: "driving",
        },
        timeout: CONFIG.TIMEOUT_GOOGLE,
      }
    );

    if (res.data.status !== "OK") {
      log.warn("[GOOGLE_MAPS] Status:", res.data.status, res.data.error_message);
      throw new Error("fallback");
    }
    const element = res.data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") throw new Error("fallback");

    return {
      km: Math.round((element.distance.value / 1000) * 10) / 10,
      duracion: element.duration.text,
      esAproximado: false,
    };
  } catch (e) {
    const kmLinea = distanciaEntrePuntos(origen.lat, origen.lng, destino.lat, destino.lng);
    const km = Math.round(kmLinea * 1.3 * 10) / 10;
    return { km, duracion: `~${Math.round(km * 3)} min`, esAproximado: true };
  }
}

async function geocodificarDireccion(direccion) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: `${direccion}, Cochabamba, Bolivia`,
        key: CONFIG.GOOGLE_MAPS_KEY,
      },
      timeout: CONFIG.TIMEOUT_GOOGLE,
    });
    if (!res.data.results?.length) return null;
    const loc = res.data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, nombre: res.data.results[0].formatted_address };
  } catch {
    return null;
  }
}

async function obtenerDireccion(lat, lng) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { latlng: `${lat},${lng}`, key: CONFIG.GOOGLE_MAPS_KEY, language: "es" },
      timeout: CONFIG.TIMEOUT_GOOGLE,
    });
    if (!res.data.results?.length) return null;
    const comps = res.data.results[0].address_components;
    const calle = comps.find((c) => c.types.includes("route"))?.long_name || "";
    const numero = comps.find((c) => c.types.includes("street_number"))?.long_name || "";
    const barrio =
      comps.find((c) => c.types.includes("neighborhood") || c.types.includes("sublocality"))
        ?.long_name || "";
    if (calle) return numero ? `${calle} ${numero}` : barrio ? `${calle}, ${barrio}` : calle;
    return res.data.results[0].formatted_address.split(",")[0];
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WIALON
// ═══════════════════════════════════════════════════════════════════════════

let wialonCache = { eid: null, expiresAt: 0 };

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
  try {
    eid = await wialonLogin();
  } catch {
    throw new Error("No se pudo conectar con Wialon");
  }
  const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
    params: {
      svc: "core/search_item",
      params: JSON.stringify({ id: parseInt(wialonId), flags: 4294967295 }),
      sid: eid,
    },
    timeout: CONFIG.TIMEOUT_WIALON,
  });
  if (res.data?.error === 1) {
    wialonInvalidateCache();
    throw new Error("Sesión Wialon expirada");
  }
  const item = res.data.item;
  if (!item) throw new Error("Unidad no encontrada en Wialon");
  if (!item.pos) throw new Error("Sin GPS disponible");
  const pos = item.pos;
  const minutos = Math.round((Date.now() / 1000 - (pos.t || 0)) / 60);
  return { lat: pos.y, lng: pos.x, minutos };
}

async function generarLinkLocator(wialonId) {
  try {
    const eid = await wialonLogin();
    const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "locator/create_hash",
        params: JSON.stringify({
          items: [parseInt(wialonId)],
          duration: CONFIG.LOCATOR_DURACION,
          type: 0,
        }),
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
    "pagoDiario.aprobado": true,
    "pagoDiario.fechaStr": hoyStr,
  };
  // Filtrar por tipo de vehículo si se especifica (auto/moto)
  if (tipoVehiculo) filtro.tipoVehiculo = tipoVehiculo;

  const choferes = await Chofer.find(filtro);
  if (!choferes.length) {
    log.info(`[BUSCAR] No hay choferes ${tipoVehiculo || ""} libres con pago al día`);
    return null;
  }

  // Llamada BULK a Wialon: 1 request en lugar de N (mucho más rápido)
  let itemsWialon = [];
  try {
    const eid = await wialonLogin();
    const wialonIds = choferes.map((c) => parseInt(c.wialonId)).filter((id) => !isNaN(id));
    if (wialonIds.length === 0) return null;

    const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "core/search_items",
        params: JSON.stringify({
          spec: {
            itemsType: "avl_unit",
            propName: "sys_id",
            propValueMask: wialonIds.join(","),
            sortType: "sys_name",
          },
          force: 1,
          flags: 4294967295,
          from: 0,
          to: 0,
        }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (res.data?.error === 1) {
      wialonInvalidateCache();
      throw new Error("Sesión Wialon expirada en bulk search");
    }
    itemsWialon = res.data.items || [];
  } catch (e) {
    log.error("[BUSCAR_BULK]", e.message);
    return null;
  }

  // Procesar distancias localmente (rápido, sin más llamadas a red)
  let mejorChofer = null;
  let menorDist = Infinity;
  const ahoraSeg = Math.floor(Date.now() / 1000);

  for (const chofer of choferes) {
    const itemW = itemsWialon.find((i) => i.id === parseInt(chofer.wialonId));
    if (!itemW || !itemW.pos) continue;

    const pos = itemW.pos;
    const minutosGps = Math.round((ahoraSeg - (pos.t || 0)) / 60);

    // Descartar GPS viejo (más de 10 min)
    if (minutosGps > 10) continue;

    const dist = distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.y, pos.x);
    if (dist > 10) continue;

    if (dist < menorDist) {
      menorDist = dist;
      mejorChofer = {
        ...chofer.toObject(),
        ubicacion: { lat: pos.y, lng: pos.x, minutos: minutosGps },
        distanciaAlUsuario: dist,
      };
    }
  }

  if (mejorChofer) {
    log.info(`[BUSCAR] Asignado ${mejorChofer.nombre} a ${menorDist.toFixed(2)}km (${tipoVehiculo || "cualquier tipo"})`);
  } else {
    log.info(`[BUSCAR] ${choferes.length} libres pero ninguno cerca o con GPS activo`);
  }

  return mejorChofer;
}

async function reservarChofer(wialonId, viajeId) {
  const reservadoHasta = new Date(Date.now() + (CONFIG.TIMEOUT_ACEPTACION_CHOFER + 10) * 1000);
  const res = await Chofer.findOneAndUpdate(
    {
      wialonId,
      estado: "libre",
      $or: [{ viajeReservado: null }, { viajeReservado: { $exists: false } }],
    },
    { $set: { viajeReservado: String(viajeId), reservadoHasta } },
    { new: true }
  );
  return res;
}

async function liberarReservaChofer(wialonId) {
  await Chofer.updateOne(
    { wialonId },
    { $set: { viajeReservado: null, reservadoHasta: null } }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OPENAI
// ═══════════════════════════════════════════════════════════════════════════

async function transcribirAudio(audioUrl) {
  const audioRes = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  const formData = new FormData();
  formData.append("file", Buffer.from(audioRes.data), {
    filename: "audio.ogg",
    contentType: "audio/ogg",
  });
  formData.append("model", "whisper-1");
  formData.append("language", "es");

  const res = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    {
      headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}`, ...formData.getHeaders() },
      timeout: CONFIG.TIMEOUT_OPENAI,
    }
  );
  return res.data.text;
}

async function extraerUbicaciones(texto) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Extrae origen y destino de mensajes de taxi en Cochabamba, Bolivia.
Responde SOLO JSON: {"origen": "lugar", "destino": "lugar"}
Si no hay alguno, usa null.
La gente dice cosas como: "recógeme en X esquina Y", "llévame al Z". Extrae referencias completas.`,
          },
          { role: "user", content: texto },
        ],
        max_tokens: 150,
      },
      {
        headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` },
        timeout: CONFIG.TIMEOUT_OPENAI,
      }
    );
    const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(content);
  } catch {
    return { origen: null, destino: null };
  }
}

async function validarComprobantePago(imageBase64) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `¿Esta imagen es un comprobante de pago válido (captura de transferencia, QR pagado, Tigo Money, banco, etc.)?
JSON:
{
  "es_comprobante": true/false,
  "monto": "monto si es visible o null",
  "tipo": "transferencia/qr/tigo_money/otro/ninguno"
}
Solo JSON.`,
              },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
              },
            ],
          },
        ],
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` },
        timeout: CONFIG.TIMEOUT_OPENAI,
      }
    );
    const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(content);
  } catch (e) {
    log.error("[VALIDAR_COMPROBANTE]", e.message);
    return { es_comprobante: false, _error: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WHATSAPP META
// ═══════════════════════════════════════════════════════════════════════════

async function enviarMensaje(to, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: texto } },
      {
        headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
        timeout: CONFIG.TIMEOUT_META,
      }
    );
  } catch (e) {
    log.error("[WSP] enviarMensaje:", e.response?.data?.error?.message || e.message);
  }
}

async function enviarBotones(to, texto, botones) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: texto },
          action: {
            buttons: botones.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.substring(0, 20) },
            })),
          },
        },
      },
      {
        headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
        timeout: CONFIG.TIMEOUT_META,
      }
    );
  } catch (e) {
    log.error("[WSP] enviarBotones:", e.response?.data?.error?.message || e.message);
  }
}

async function enviarImagen(to, imageUrl, caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } },
      {
        headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
        timeout: CONFIG.TIMEOUT_META,
      }
    );
  } catch (e) {
    log.error("[WSP] enviarImagen:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarImagenPorId(to, imageId, caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { id: imageId, caption } },
      {
        headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
        timeout: CONFIG.TIMEOUT_META,
      }
    );
  } catch (e) {
    log.error("[WSP] reenviarImagen:", e.response?.data?.error?.message || e.message);
  }
}

async function descargarImagenMeta(mediaId) {
  const urlRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  const binRes = await axios.get(urlRes.data.url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  return Buffer.from(binRes.data);
}

async function obtenerUrlMedia(mediaId) {
  const res = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    timeout: CONFIG.TIMEOUT_META,
  });
  return res.data.url;
}

// ═══════════════════════════════════════════════════════════════════════════
// FIRMA META
// ═══════════════════════════════════════════════════════════════════════════

function verificarFirmaMeta(req) {
  if (!CONFIG.META_APP_SECRET) return true;
  const sigHeader = req.headers["x-hub-signature-256"];
  if (!sigHeader) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", CONFIG.META_APP_SECRET)
      .update(req.rawBody)
      .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORIAL DEL PASAJERO
// ═══════════════════════════════════════════════════════════════════════════

async function obtenerUltimoViaje(phone) {
  return await Viaje.findOne({
    usuarioPhone: phone,
    estado: "completado",
  })
    .sort({ fechaFin: -1 })
    .lean();
}

// Obtiene top N destinos más frecuentes (rutas únicas por destino)
async function obtenerDestinosFrecuentes(phone, limit = 2) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario?.rutasFrecuentes?.length) return [];

  // Agrupar por destino (puede venir con varios orígenes hacia el mismo destino)
  const mapa = new Map();
  for (const ruta of usuario.rutasFrecuentes) {
    const key =
      `${(ruta.destino?.lat || 0).toFixed(3)}_${(ruta.destino?.lng || 0).toFixed(3)}`;
    const actual = mapa.get(key);
    if (actual) {
      actual.contador += ruta.contador || 1;
      // Preferimos el nombre más descriptivo (más largo)
      if ((ruta.destino?.nombre || "").length > (actual.destino.nombre || "").length) {
        actual.destino = ruta.destino;
      }
    } else {
      mapa.set(key, {
        destino: ruta.destino,
        contador: ruta.contador || 1,
      });
    }
  }

  const top = Array.from(mapa.values())
    .filter((r) => r.destino && r.destino.lat && r.destino.lng)
    .sort((a, b) => b.contador - a.contador)
    .slice(0, limit);
  return top;
}

async function guardarRutaFrecuente(phone, origen, destino) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario) return;
  const existente = usuario.rutasFrecuentes.find(
    (r) =>
      Math.abs(r.origen.lat - origen.lat) < 0.001 &&
      Math.abs(r.destino.lat - destino.lat) < 0.001
  );
  if (existente) existente.contador += 1;
  else usuario.rutasFrecuentes.push({ origen, destino, contador: 1 });
  await usuario.save();
}

// Construye los botones de historial para el saludo inicial
async function construirBotonesHistorial(phone) {
  const [ultimo, frecuentes] = await Promise.all([
    obtenerUltimoViaje(phone),
    obtenerDestinosFrecuentes(phone, 3),
  ]);

  const botones = [];
  const idsParaSession = { rutas: [] };

  if (ultimo) {
    botones.push({
      id: "hist_ultimo",
      title: "🔄 Último viaje",
    });
    idsParaSession.ultimo = {
      origen: ultimo.origen,
      destino: ultimo.destino,
    };
  }

  // Agregar frecuentes que no sean el mismo destino del último
  let agregados = 0;
  for (let i = 0; i < frecuentes.length && botones.length < 3; i++) {
    const f = frecuentes[i];
    if (
      ultimo?.destino &&
      Math.abs(ultimo.destino.lat - f.destino.lat) < 0.001 &&
      Math.abs(ultimo.destino.lng - f.destino.lng) < 0.001
    ) {
      continue;
    }
    const nombre = acortarParaBoton(f.destino.nombre || "Destino", 17);
    botones.push({
      id: `hist_freq_${agregados}`,
      title: `⭐ ${nombre}`,
    });
    idsParaSession.rutas.push({ destino: f.destino });
    agregados++;
  }

  // Si aún hay espacio, agregar "nueva ruta" como escape
  // (solo si hay al menos un botón de historial, para no mostrarlo solo)
  if (botones.length > 0 && botones.length < 3) {
    botones.push({ id: "hist_nueva", title: "📍 Nueva ruta" });
  }

  return { botones, idsParaSession };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGO DIARIO
// ═══════════════════════════════════════════════════════════════════════════

function choferPagoAlDia(chofer) {
  if (!chofer?.pagoDiario?.aprobado) return false;
  const hoyStr = fechaStrBolivia();
  return chofer.pagoDiario.fechaStr === hoyStr;
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTA DE ESPERA (interval) — v3: búsqueda activa desde el segundo 0
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const ahora = new Date();
    const pendientes = await ListaEspera.find({});

    for (const espera of pendientes) {
      try {
        const segundos = (ahora.getTime() - new Date(espera.timestamp).getTime()) / 1000;

        // Si hay oferta activa vigente → esperar respuesta
        if (espera.ofertaActivaWialonId && espera.ofertaActivaHasta) {
          const expirada = new Date(espera.ofertaActivaHasta) < ahora;
          if (!expirada) {
            continue; // todavía esperando respuesta del pasajero
          }
          // Oferta expiró sin respuesta → agregar a rechazadas y seguir buscando
          log.info(
            `[ESPERA] Oferta expirada para ${espera.userPhone} (chofer ${espera.ofertaActivaWialonId})`
          );
          espera.ofertasRechazadas = [
            ...(espera.ofertasRechazadas || []),
            espera.ofertaActivaWialonId,
          ];
          espera.ofertaActivaWialonId = null;
          espera.ofertaActivaHasta = null;
          await espera.save();
        }

        // Tiempo total excedido → cerrar
        if (segundos > CONFIG.ESPERA_TIMEOUT_TOTAL) {
          log.info(`[ESPERA] Timeout total para ${espera.userPhone}`);
          await removeListaEspera(espera.userPhone);
          await updateSession(espera.userPhone, { step: "inicio" });
          await enviarMensaje(
            espera.userPhone,
            `😔 No encontramos chofer disponible en los últimos ${Math.round(
              CONFIG.ESPERA_TIMEOUT_TOTAL / 60
            )} minutos.\n\nPor favor intenta de nuevo en un ratito. 🚖`
          );
          continue;
        }

        // Buscar chofer (desde el segundo 0, excluyendo rechazados, filtrando por tipo si fue solicitado)
        const chofer = await buscarChoferDisponible(
          { lat: espera.origen.lat, lng: espera.origen.lng },
          espera.ofertasRechazadas || [],
          espera.tipoVehiculoSolicitado || null
        );

        if (chofer) {
          // ¡Chofer disponible! Hacer oferta al pasajero
          espera.ofertaActivaWialonId = chofer.wialonId;
          espera.ofertaActivaHasta = new Date(
            Date.now() + CONFIG.ESPERA_OFERTA_VIGENCIA * 1000
          );
          await espera.save();

          await updateSession(espera.userPhone, { step: "sin_chofer" });

          await enviarBotones(
            espera.userPhone,
            `🚖 *¡Se acaba de liberar un chofer cerca tuyo!*\n\n` +
              `👤 ${chofer.nombre}\n` +
              `📌 A ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km de ti\n` +
              `📏 ${espera.distancia} km de viaje\n` +
              `💰 Bs ${espera.precio}\n\n` +
              `¿Lo asignamos? _(tienes ${CONFIG.ESPERA_OFERTA_VIGENCIA}s para decidir)_`,
            [
              { id: "confirmar_viaje_recordatorio", title: "✅ Sí, taxi" },
              { id: "cancelar_viaje", title: "❌ Ya no" },
            ]
          );
        } else {
          // Sin chofer todavía
          if (segundos > CONFIG.ESPERA_NOTIFICAR_SIN_CHOFER && !espera.notificado) {
            espera.notificado = true;
            await espera.save();
            await updateSession(espera.userPhone, { step: "sin_chofer" });
            await enviarMensaje(
              espera.userPhone,
              `😔 Por ahora no hay móviles disponibles cerca tuyo.\n\nSeguimos buscando — te avisaremos apenas aparezca uno. 🚖\n\n_Escribe CANCELAR para dejar de buscar._`
            );
          }
        }
      } catch (eInner) {
        log.error("[ESPERA_ITEM]", eInner.message);
      }
    }
  } catch (e) {
    log.error("[ESPERA_LOOP]", e.message);
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// TIMEOUT DE ACEPTACIÓN DEL CHOFER (30s)
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const limite = new Date(Date.now() - CONFIG.TIMEOUT_ACEPTACION_CHOFER * 1000);
    const pendientes = await Viaje.find({
      estado: "pendiente",
      fechaAsignacion: { $lt: limite },
    });

    for (const viaje of pendientes) {
      try {
        log.warn(`[TIMEOUT] Viaje ${viaje._id} sin respuesta del chofer ${viaje.choferPhone}`);
        await liberarReservaChofer(viaje.choferWialonId);
        await Viaje.findByIdAndUpdate(viaje._id, {
          estado: "buscando_otro_chofer",
          cancelacionMotivo: "timeout_chofer",
        });
        await enviarMensaje(
          viaje.choferPhone,
          "⏰ Se te pasó el tiempo para aceptar el viaje. Pasamos al siguiente chofer."
        );
        const session = await getSession(viaje.usuarioPhone);
        if (session && session.step === "esperando_chofer") {
          await enviarMensaje(
            viaje.usuarioPhone,
            "⏳ El chofer no respondió a tiempo. Buscando otro..."
          );
          await asignarChofer(viaje.usuarioPhone, session, [viaje.choferWialonId]);
        }
      } catch (eInner) {
        log.error("[TIMEOUT_ITEM]", eInner.message);
      }
    }
  } catch (e) {
    log.error("[TIMEOUT_LOOP]", e.message);
  }
}, 15000);

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR CHOFER
// ═══════════════════════════════════════════════════════════════════════════

async function asignarChofer(userPhone, session, excludeWialonIds = []) {
  // Filtrar por tipo de vehículo si el pasajero eligió uno
  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
  const chofer = await buscarChoferDisponible(session.origen, excludeWialonIds, tipoSolicitado);

  if (!chofer) {
    await addListaEspera(userPhone, session);
    const tipoTexto = tipoSolicitado === "moto" ? "moto" : tipoSolicitado === "auto" ? "auto" : "móvil";
    await enviarMensaje(
      userPhone,
      `⏳ Buscando un ${tipoTexto} cercano para ti...\n\n_Escribe CANCELAR si quieres dejar de buscar._`
    );
    return;
  }

  const viaje = await Viaje.create({
    usuarioPhone: userPhone,
    choferPhone: chofer.phone,
    choferWialonId: chofer.wialonId,
    choferNombre: chofer.nombre,
    choferPlaca: chofer.placa,
    origen: session.origen,
    destino: session.destino,
    distanciaKm: session.distancia,
    precioTotal: session.precio,
    precioPorKm: session.precioPorKm,
    tipoVehiculo: chofer.tipoVehiculo || tipoSolicitado || "auto",
    estado: "pendiente",
    fechaAsignacion: new Date(),
  });

  const reservado = await reservarChofer(chofer.wialonId, viaje._id);
  if (!reservado) {
    log.warn(`[ASIGNAR] Chofer ${chofer.nombre} ya fue reservado. Reintentando...`);
    await Viaje.findByIdAndDelete(viaje._id);
    await asignarChofer(userPhone, session, [...excludeWialonIds, chofer.wialonId]);
    return;
  }

  await updateSession(userPhone, {
    ...session,
    step: "esperando_chofer",
    choferId: chofer.wialonId,
    choferPhone: chofer.phone,
    viajeId: viaje._id.toString(),
  });

  const linkViaje = `https://www.google.com/maps/dir/?api=1&origin=${session.origen.lat},${session.origen.lng}&destination=${session.destino.lat},${session.destino.lng}&travelmode=driving`;

  await enviarBotones(
    chofer.phone,
    `🚖 *NUEVO VIAJE*\n\n` +
      `📏 Distancia viaje: ${session.distancia} km\n` +
      `💰 Precio: Bs ${session.precio}\n` +
      `📌 Estás a ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km del pasajero\n\n` +
      `📍 Origen: ${session.origen.nombre || "Ver mapa"}\n` +
      `🏁 Destino: ${session.destino.nombre || "Ver mapa"}\n\n` +
      `🗺️ Ruta del viaje:\n${linkViaje}\n\n` +
      `⏱️ Tienes *${CONFIG.TIMEOUT_ACEPTACION_CHOFER}s* para aceptar`,
    [
      { id: "aceptar_viaje", title: "✅ Aceptar" },
      { id: "rechazar_viaje", title: "❌ Rechazar" },
    ]
  );
  await enviarMensaje(
    userPhone,
    `🔍 Encontramos un chofer cerca.\n_Esperando confirmación (máx ${CONFIG.TIMEOUT_ACEPTACION_CHOFER}s)..._\n\n_Escribe CANCELAR si quieres cancelar._`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE LLEGADA AL DESTINO
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    // ─────────────────────────────────────────────────────────────────
    // A) DETECTAR LLEGADA AL ORIGEN DEL PASAJERO (≤50m)
    //    Estados: en_camino → notifica al pasajero "tu chofer llegó"
    //             y al chofer "ya estás cerca, espera al pasajero"
    // ─────────────────────────────────────────────────────────────────
    const enCamino = await Viaje.find({
      estado: "en_camino",
      llegadaOrigenNotificada: false,
    });
    for (const viaje of enCamino) {
      try {
        const posChofer = await obtenerUbicacionChofer(viaje.choferWialonId);
        if (posChofer.minutos > 5) continue; // GPS demasiado viejo, no confiar

        const distOrigen = distanciaEntrePuntos(
          posChofer.lat,
          posChofer.lng,
          viaje.origen.lat,
          viaje.origen.lng
        );

        // 50 metros = 0.05 km
        if (distOrigen <= 0.05) {
          // Marcamos atómicamente para evitar doble notificación si hay race
          const updated = await Viaje.findOneAndUpdate(
            { _id: viaje._id, llegadaOrigenNotificada: false },
            { $set: { llegadaOrigenNotificada: true, estado: "esperando_pasajero" } },
            { new: true }
          );
          if (!updated) continue; // ya fue notificado por otro tick

          // Actualizar session del usuario
          const session = await getSession(viaje.usuarioPhone);
          if (session) {
            await updateSession(viaje.usuarioPhone, {
              ...session,
              step: "chofer_esperando_pasajero",
            });
          }

          // Notificar al pasajero
          const tipoVehLlegada = updated.tipoVehiculo || "auto";
          const emojiLleg = tipoVehLlegada === "moto" ? "🏍️" : "🚗";
          const labelLleg = tipoVehLlegada === "moto" ? "moto" : "auto";
          await enviarMensaje(
            viaje.usuarioPhone,
            `🚕 *¡Tu chofer llegó!*\n\n` +
              `👤 ${viaje.choferNombre}\n` +
              `${emojiLleg} ${labelLleg} placa: ${viaje.choferPlaca}\n\n` +
              `Por favor dirígete al vehículo. 🚖`
          );

          // Notificar al chofer con botones para iniciar/cancelar
          await enviarBotones(
            viaje.choferPhone,
            `📍 *Estás a 50m del pasajero*\n\n` +
              `Ya le avisamos al pasajero que llegaste.\nCuando el pasajero suba presiona:`,
            [
              { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
              { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
            ]
          );

          log.info(`[LLEGADA_ORIGEN] Notificado viaje ${viaje._id} a ${distOrigen.toFixed(3)}km del origen`);
        }
      } catch {
        // ignorar fallo individual
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // B) DETECTAR LLEGADA AL DESTINO (≤150m)
    //    Estado: en_curso → notifica al pasajero y muestra botón terminar al chofer
    // ─────────────────────────────────────────────────────────────────
    const enCurso = await Viaje.find({ estado: "en_curso", llegadaNotificada: false });
    for (const viaje of enCurso) {
      try {
        const posChofer = await obtenerUbicacionChofer(viaje.choferWialonId);
        const distDestino = distanciaEntrePuntos(
          posChofer.lat,
          posChofer.lng,
          viaje.destino.lat,
          viaje.destino.lng
        );
        if (distDestino < 0.15) {
          await Viaje.findByIdAndUpdate(viaje._id, { llegadaNotificada: true });
          await enviarBotones(
            viaje.choferPhone,
            "📍 Parece que llegaste al destino. ¿Finalizas el viaje?",
            [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
          );
          await enviarMensaje(viaje.usuarioPhone, "📍 ¡Tu chofer llegó al destino!");
        }
      } catch {
        // ignorar fallo individual
      }
    }
  } catch (e) {
    log.error("[LLEGADA_LOOP]", e.message);
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// CANCELACIÓN INICIADA POR PASAJERO
// ═══════════════════════════════════════════════════════════════════════════

async function procesarCancelacionPasajero(phone, session) {
  // Si el viaje está activo con chofer, liberar chofer y notificarle
  const viaje = await Viaje.findOne({
    usuarioPhone: phone,
    estado: { $in: ["pendiente", "en_camino", "esperando_pasajero"] },
  });

  if (viaje) {
    await Viaje.findByIdAndUpdate(viaje._id, {
      estado: "cancelado_pasajero",
      cancelacionMotivo: "cancelado_por_pasajero",
      fechaFin: new Date(),
    });
    // Liberar al chofer
    if (viaje.choferWialonId) {
      await Chofer.findOneAndUpdate(
        { wialonId: viaje.choferWialonId },
        { estado: "libre", viajeReservado: null, reservadoHasta: null }
      );
      await enviarMensaje(
        viaje.choferPhone,
        `❌ El pasajero canceló el viaje. Ya estás LIBRE para recibir otros viajes.`
      );
    }
    await enviarMensaje(phone, `✅ Viaje cancelado. Escribe cuando necesites otro taxi. 🚖`);
  } else {
    // Caso: estaba en esperando_confirmacion o sin_chofer
    await enviarMensaje(phone, `✅ Búsqueda cancelada. Escribe cuando necesites otro taxi. 🚖`);
  }

  // Limpiar lista de espera y sesión
  await removeListaEspera(phone);
  await deleteSession(phone);
}

// ═══════════════════════════════════════════════════════════════════════════
// SOPORTE / AYUDA
// ═══════════════════════════════════════════════════════════════════════════

async function procesarPedidoAyuda(phone, esChofer = false) {
  const viaje = esChofer
    ? await Viaje.findOne({
        choferPhone: phone,
        estado: { $in: ["en_camino", "esperando_pasajero", "en_curso"] },
      })
    : await Viaje.findOne({
        usuarioPhone: phone,
        estado: { $in: ["pendiente", "en_camino", "esperando_pasajero", "en_curso"] },
      });

  await enviarMensaje(
    phone,
    `🆘 *Soporte ChatGo*\n\nHemos notificado al administrador. Te contactarán pronto desde +591 62741818.`
  );

  const contexto = viaje
    ? `\n\n📋 *Contexto del viaje:*\n` +
      `👤 Pasajero: +${viaje.usuarioPhone}\n` +
      `🚖 Chofer: ${viaje.choferNombre} (+${viaje.choferPhone}) - ${viaje.choferPlaca}\n` +
      `📏 ${viaje.distanciaKm} km | 💰 Bs ${viaje.precioTotal}\n` +
      `📍 Estado: ${viaje.estado}`
    : "";

  await enviarMensaje(
    CONFIG.ADMIN_PHONE,
    `🆘 *Pedido de AYUDA*\n\n` +
      `De ${esChofer ? "CHOFER" : "PASAJERO"}: +${phone}${contexto}\n\n` +
      `Contáctalo cuanto antes.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RATING DEL VIAJE
// ═══════════════════════════════════════════════════════════════════════════

async function solicitarRating(userPhone, viajeId) {
  await Viaje.findByIdAndUpdate(viajeId, { ratingSolicitado: true });
  await updateSession(userPhone, { step: "esperando_rating", viajeIdRating: String(viajeId) });
  await enviarBotones(
    userPhone,
    `¿Cómo estuvo tu viaje? ⭐\n\nTu opinión nos ayuda a mejorar.`,
    [
      { id: "rating_5", title: "⭐⭐⭐⭐⭐ Excelente" },
      { id: "rating_3", title: "⭐⭐⭐ Regular" },
      { id: "rating_1", title: "⭐ Malo" },
    ]
  );
}

async function registrarRating(userPhone, rating, viajeId) {
  const viaje = await Viaje.findByIdAndUpdate(viajeId, { ratingPasajero: rating });
  if (!viaje) return;

  // Actualizar promedio del chofer
  if (viaje.choferPhone) {
    const chofer = await Chofer.findOne({ phone: viaje.choferPhone });
    if (chofer) {
      const totalAnterior = (chofer.ratingPromedio || 0) * (chofer.ratingCantidad || 0);
      const nuevaCantidad = (chofer.ratingCantidad || 0) + 1;
      const nuevoPromedio = (totalAnterior + rating) / nuevaCantidad;
      await Chofer.findByIdAndUpdate(chofer._id, {
        ratingPromedio: Math.round(nuevoPromedio * 10) / 10,
        ratingCantidad: nuevaCantidad,
      });
    }
  }

  await deleteSession(userPhone);

  if (rating >= 4) {
    await enviarMensaje(
      userPhone,
      `🙏 ¡Gracias por tu calificación!\n\nNos vemos en tu próximo viaje con ChatGo. 🚖`
    );
  } else {
    await enviarMensaje(
      userPhone,
      `🙏 Gracias por tu calificación.\n\nSentimos que no haya sido una buena experiencia. Si quieres contarnos qué pasó, escribe AYUDA y un humano te contactará.`
    );
    // Notificar al admin si rating bajo
    await enviarMensaje(
      CONFIG.ADMIN_PHONE,
      `⚠️ *Rating bajo*\n\nPasajero: +${userPhone}\nChofer: ${viaje.choferNombre} (+${viaje.choferPhone})\nRating: ${rating}/5\nViaje: ${viaje._id}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL CHOFER
// ═══════════════════════════════════════════════════════════════════════════

async function procesarMensajeChofer(phone, mensajeTexto, buttonId, mediaId) {
  let chofer = await Chofer.findOne({ phone });

  // Chofer no registrado — redirigir al bot de registro
  if (!chofer) {
    const NUMERO_REGISTRO = process.env.NUMERO_REGISTRO || "59164637067";
    await enviarMensaje(
      phone,
      `👋 Hola! Para ser conductor de ChatGo primero tienes que registrarte con nosotros.\n\n` +
        `El registro es rápido (unos 5 minutos) y lo haces con otro número:\n\n` +
        `📱 https://wa.me/${NUMERO_REGISTRO}?text=Vengo+a+registrarme\n\n` +
        `Te vamos a pedir:\n` +
        `1️⃣ Foto de licencia de conducir\n` +
        `2️⃣ Selfie tuya\n` +
        `3️⃣ Foto del vehículo con placa visible\n` +
        `4️⃣ RUAT\n` +
        `5️⃣ SOAT\n\n` +
        `Una vez aprobado tu registro, te enviaremos las credenciales y podrás volver aquí para iniciar tu jornada 🚖`
    );
    return;
  }

  // Detectar pedido de ayuda (texto)
  if (!buttonId && mensajeTexto && esPedidoAyuda(mensajeTexto)) {
    await procesarPedidoAyuda(phone, true);
    return;
  }

  // Botones del chofer
  if (buttonId) {
    if (buttonId === "aceptar_viaje") {
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: "pendiente",
      });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes pendientes (quizás expiró).");

      const userPhone = viaje.usuarioPhone;
      await Chofer.findByIdAndUpdate(chofer._id, {
        estado: "ocupado",
        viajeReservado: null,
        reservadoHasta: null,
      });
      await Viaje.findByIdAndUpdate(viaje._id, {
        estado: "en_camino",
        fechaAceptacion: new Date(),
      });

      const session = await getSession(userPhone);
      if (session) {
        await updateSession(userPhone, { ...session, step: "chofer_en_camino" });
      }

      const linkRastreo = await generarLinkLocator(chofer.wialonId);

      const tipoVehChofer = chofer.tipoVehiculo || "auto";
      const emojiVeh = tipoVehChofer === "moto" ? "🏍️" : "🚗";
      const labelVeh = tipoVehChofer === "moto" ? "Moto" : "Auto";

      await enviarMensaje(
        userPhone,
        `🎉 *¡Viaje aceptado!*\n\n` +
          `👤 Chofer: ${chofer.nombre}\n${emojiVeh} ${labelVeh} placa: ${chofer.placa}\n\n` +
          `📍 Rastrea tu chofer:\n${linkRastreo}\n\n` +
          `💬 Escribe cualquier mensaje para chatear con él.\n` +
          `_Escribe CANCELAR si necesitas cancelar, o AYUDA para soporte._`
      );
      await enviarBotones(
        phone,
        `✅ Viaje aceptado!\n\nCuando llegues al punto de recojo presiona el botón.`,
        [
          { id: "llegue_al_punto", title: "🚕 Llegué" },
          { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
        ]
      );
      return;
    }

    if (buttonId === "rechazar_viaje") {
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: "pendiente",
      });
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, {
          estado: "rechazado_chofer",
          cancelacionMotivo: "rechazo_chofer",
        });
        await liberarReservaChofer(chofer.wialonId);
        await enviarMensaje(phone, "Ok, buscaremos otro chofer para ese pasajero.");
        const session = await getSession(viaje.usuarioPhone);
        if (session) {
          await enviarMensaje(viaje.usuarioPhone, "⏳ Buscando otro chofer...");
          await asignarChofer(viaje.usuarioPhone, session, [chofer.wialonId]);
        }
      }
      return;
    }

    if (buttonId === "llegue_al_punto") {
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: "en_camino",
      });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes activos.");
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "esperando_pasajero" });
      const session = await getSession(viaje.usuarioPhone);
      if (session) {
        await updateSession(viaje.usuarioPhone, {
          ...session,
          step: "chofer_esperando_pasajero",
        });
      }
      const tipoVehM = chofer.tipoVehiculo || "auto";
      const emojiM = tipoVehM === "moto" ? "🏍️" : "🚗";
      const labelM = tipoVehM === "moto" ? "moto" : "auto";
      await enviarMensaje(
        viaje.usuarioPhone,
        `🚕 *¡Tu chofer llegó!*\n\n👤 ${chofer.nombre}\n${emojiM} ${labelM} placa: ${chofer.placa}\n\nDirígete al vehículo.`
      );
      await enviarBotones(
        phone,
        `✅ Pasajero notificado.\n\nCuando el pasajero suba presiona:`,
        [
          { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
          { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
        ]
      );
      return;
    }

    if (buttonId === "iniciar_viaje") {
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: "esperando_pasajero",
      });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes activos.");
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "en_curso" });
      const session = await getSession(viaje.usuarioPhone);
      if (session) {
        await updateSession(viaje.usuarioPhone, { ...session, step: "en_curso" });
      }
      await enviarMensaje(viaje.usuarioPhone, `🚖 *Viaje iniciado*\n\n¡Disfruta tu viaje con ChatGo!`);
      const linkAlDestino = `https://www.google.com/maps/dir/?api=1&origin=${viaje.origen.lat},${viaje.origen.lng}&destination=${viaje.destino.lat},${viaje.destino.lng}&travelmode=driving`;
      await enviarBotones(
        phone,
        `▶️ *Viaje iniciado*\n\n` +
          `🏁 Destino: ${viaje.destino.nombre || "destino del pasajero"}\n` +
          `📏 ${viaje.distanciaKm} km\n\n` +
          `🗺️ Ir al destino:\n${linkAlDestino}\n\nConduce con cuidado! 🚖`,
        [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
      );
      return;
    }

    if (buttonId === "cancelar_viaje_chofer") {
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: { $in: ["en_camino", "esperando_pasajero"] },
      });
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, {
          estado: "cancelado_chofer",
          cancelacionMotivo: "cancelado_por_chofer",
          fechaFin: new Date(),
        });
        await Chofer.findByIdAndUpdate(chofer._id, { estado: "libre" });
        await enviarMensaje(
          viaje.usuarioPhone,
          `❌ Tu chofer canceló el viaje. Puedes pedir otro cuando quieras.`
        );
        await enviarMensaje(phone, `❌ Viaje cancelado. Ya estás LIBRE.`);
        await deleteSession(viaje.usuarioPhone);
      }
      return;
    }

    if (buttonId === "terminar_viaje") {
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: { $in: ["en_curso", "esperando_pasajero"] },
      });
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, {
          estado: "completado",
          fechaFin: new Date(),
        });
        await Usuario.findOneAndUpdate(
          { phone: viaje.usuarioPhone },
          { $inc: { viajesTotal: 1 } }
        );
        const choferActual = await Chofer.findById(chofer._id);
        const sigueAlDia = choferPagoAlDia(choferActual);
        const nuevoEstado = sigueAlDia ? "libre" : "offline";
        await Chofer.findByIdAndUpdate(chofer._id, {
          estado: nuevoEstado,
          $inc: { viajesTotal: 1 },
        });
        await guardarRutaFrecuente(viaje.usuarioPhone, viaje.origen, viaje.destino);

        await enviarMensaje(
          viaje.usuarioPhone,
          `✅ *Viaje completado*\n\n📏 ${viaje.distanciaKm} km\n💰 Bs ${viaje.precioTotal}\n\n¡Gracias por usar ChatGo! 🚖`
        );

        // Pedir rating
        await solicitarRating(viaje.usuarioPhone, viaje._id);

        if (sigueAlDia) {
          await enviarBotones(
            phone,
            `✅ Viaje finalizado!\n🟢 Ya estás LIBRE para el siguiente viaje.`,
            [
              { id: "chofer_ocupado", title: "🔴 Ocupado" },
              { id: "chofer_ayuda", title: "❓ Ayuda" },
            ]
          );
        } else {
          await enviarMensaje(
            phone,
            `✅ Viaje finalizado!\n\n⚠️ Tu pago diario no está al día. Debes pagar Bs 10 para seguir recibiendo viajes.`
          );
          if (CONFIG.QR_IMAGE_URL) {
            await enviarImagen(
              phone,
              CONFIG.QR_IMAGE_URL,
              `📲 Escanea el QR y envíame la *foto del comprobante*.`
            );
          }
          await setSession(phone, { step: "chofer_esperando_comprobante" });
        }
      }
      return;
    }

    if (buttonId === "chofer_libre") {
      if (!choferPagoAlDia(chofer)) {
        await Chofer.findByIdAndUpdate(chofer._id, { estado: "offline" });
        await enviarMensaje(phone, `Para estar LIBRE primero paga tu cuota diaria de *Bs 10*.`);
        if (CONFIG.QR_IMAGE_URL) {
          await enviarImagen(
            phone,
            CONFIG.QR_IMAGE_URL,
            `📲 Escanea el QR y envíame la *foto del comprobante* para activarte.`
          );
        }
        await setSession(phone, { step: "chofer_esperando_comprobante" });
        return;
      }
      // Verificar que WiaTag esté publicando GPS reciente
      try {
        const pos = await obtenerUbicacionChofer(chofer.wialonId);
        if (pos.minutos > 5) {
          await enviarMensaje(
            phone,
            `⚠️ Tu GPS no está enviando señal en este momento (última señal hace ${pos.minutos} min).\n\n` +
              `Para recibir viajes necesitas tener *WiaTag abierto y conectado*.\n\n` +
              `Revisa:\n` +
              `✅ WiaTag esté abierto (puede estar en segundo plano)\n` +
              `✅ Permiso de ubicación *"Permitir todo el tiempo"*\n` +
              `✅ Internet/datos activos\n` +
              `✅ Optimización de batería DESACTIVADA para WiaTag\n\n` +
              `Reintenta en 1 minuto presionando 🟢 Libre otra vez.`
          );
          return;
        }
      } catch (e) {
        await enviarMensaje(
          phone,
          `⚠️ No pude detectar tu GPS (${e.message}).\n\n` +
            `Asegúrate que *WiaTag esté abierto y logueado* con tus credenciales. Si recién instalaste la app, dale unos minutos para conectar.\n\n` +
            `Si el problema persiste, contacta al admin: +591 62741818`
        );
        return;
      }
      await Chofer.findByIdAndUpdate(chofer._id, { estado: "libre" });
      await enviarBotones(phone, `✅ Ya estás *LIBRE* y listo para viajes! 🚖\n\n📡 GPS: conectado ✅`, [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]);
      return;
    }

    if (buttonId === "chofer_ocupado") {
      await Chofer.findByIdAndUpdate(chofer._id, { estado: "ocupado" });
      await enviarBotones(phone, `🔴 Estado: *OCUPADO*`, [
        { id: "chofer_libre", title: "🟢 Libre" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]);
      return;
    }

    if (buttonId === "chofer_ayuda") {
      await enviarMensaje(
        phone,
        `❓ *Ayuda ChatGo*\n\n` +
          `🟢 Libre → Recibes viajes\n` +
          `🔴 Ocupado → No recibes viajes\n` +
          `💬 Antes de iniciar el viaje puedes chatear con el pasajero escribiendo cualquier mensaje\n` +
          `🆘 Escribe AYUDA en cualquier momento para contactar a soporte\n\n` +
          `Admin: +591 62741818`
      );
      return;
    }
  }

  // Comprobante de pago
  const session = await getSession(phone);
  if (session?.step === "chofer_esperando_comprobante" && mediaId) {
    await enviarMensaje(phone, "🔍 Analizando tu comprobante...");
    let comprobanteValido = false;
    try {
      const buffer = await descargarImagenMeta(mediaId);
      const base64 = buffer.toString("base64");
      const resultado = await validarComprobantePago(base64);
      comprobanteValido = !!resultado.es_comprobante;
      if (resultado._error) comprobanteValido = true; // fail-open
    } catch (e) {
      log.error("[COMPROBANTE]", e.message);
      comprobanteValido = true;
    }

    if (!comprobanteValido) {
      await enviarMensaje(
        phone,
        `❌ No pude identificar un comprobante de pago válido en esa imagen.\n\nMándame una captura clara del pago realizado (QR, transferencia, Tigo Money, etc).`
      );
      return;
    }

    await Chofer.findByIdAndUpdate(chofer._id, {
      "pagoDiario.fecha": new Date(),
      "pagoDiario.fechaStr": fechaStrBolivia(),
      "pagoDiario.pagado": true,
      "pagoDiario.aprobado": false,
      "pagoDiario.comprobanteValidado": true,
    });
    await deleteSession(phone);

    await reenviarImagenPorId(
      `${CONFIG.ADMIN_PHONE}`,
      mediaId,
      `💰 Comprobante recibido de ${chofer.nombre}\n📞 +${phone}\n🚗 ${chofer.placa}`
    );
    await enviarBotones(
      CONFIG.ADMIN_PHONE,
      `¿Apruebas el pago de ${chofer.nombre}?`,
      [
        { id: `aprobar_pago_${phone}`, title: "✅ Aprobar" },
        { id: `rechazar_pago_${phone}`, title: "❌ Rechazar" },
      ]
    );
    await enviarMensaje(
      phone,
      "⏳ Comprobante recibido. Esperando aprobación del administrador..."
    );
    return;
  }

  // Chat con pasajero durante viaje
  const viajeActivo = await Viaje.findOne({
    choferWialonId: chofer.wialonId,
    estado: { $in: ["en_camino", "esperando_pasajero", "en_curso"] },
  });
  if (viajeActivo && mensajeTexto && mensajeTexto.trim()) {
    await enviarMensaje(
      viajeActivo.usuarioPhone,
      `💬 *Mensaje de tu chofer:*\n${mensajeTexto.trim()}`
    );
    await enviarMensaje(phone, "✅ Enviado al pasajero");
    return;
  }

  // Menú del chofer
  if (!choferPagoAlDia(chofer)) {
    await Chofer.findByIdAndUpdate(chofer._id, { estado: "offline" });
    await enviarMensaje(
      phone,
      `👋 Hola ${chofer.nombre}!\n\nPara iniciar tu jornada necesitas pagar *Bs 10*.`
    );
    if (CONFIG.QR_IMAGE_URL) {
      await enviarImagen(
        phone,
        CONFIG.QR_IMAGE_URL,
        `📲 Escanea el QR y envíame la *foto del comprobante*.`
      );
    }
    await setSession(phone, { step: "chofer_esperando_comprobante" });
    return;
  }

  if (chofer.estado === "libre") {
    await enviarBotones(
      phone,
      `👋 Hola ${chofer.nombre}!\n\n🟢 Estás *LIBRE* y recibiendo viajes.`,
      [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );
  } else {
    await enviarBotones(
      phone,
      `👋 Hola ${chofer.nombre}!\n\n${
        chofer.estado === "ocupado" ? "🔴 Estás *OCUPADO*" : "⚪ Estás desconectado"
      }`,
      [
        { id: "chofer_libre", title: "🟢 Libre" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL USUARIO
// ═══════════════════════════════════════════════════════════════════════════

async function procesarCalculoViaje(phone, session) {
  await updateSession(phone, { ...session, step: "calculando" });
  await enviarMensaje(phone, "⏳ Calculando ruta y precio...");

  try {
    const { km, duracion, esAproximado } = await calcularDistancia(session.origen, session.destino);

    // Calcular precio para AMBOS tipos
    const auto = calcularPrecio(km, "auto");
    const moto = calcularPrecio(km, "moto");

    const nuevaSession = {
      ...session,
      distancia: km,
      precioAuto: auto.total,
      precioMoto: moto.total,
      precioPorKmAuto: auto.precioPorKm,
      precioPorKmMoto: moto.precioPorKm,
      step: "eligiendo_tipo_vehiculo",
    };
    await setSession(phone, nuevaSession);

    const avisoAprox = esAproximado ? "\n_(distancia aproximada)_" : "";
    await enviarBotones(
      phone,
      `🗺️ *Resumen del viaje*\n\n` +
        `📍 Origen: ${session.origen.nombre || "Tu ubicación"}\n` +
        `🏁 Destino: ${session.destino.nombre || "Tu destino"}\n\n` +
        `📏 Distancia: ${km} km${avisoAprox}\n` +
        `⏱️ Tiempo: ${duracion}\n\n` +
        `*Elige tu tipo de viaje:*\n\n` +
        `🚗 *Auto* — Bs ${auto.total}\n` +
        `🏍️ *Moto* — Bs ${moto.total}\n\n` +
        `_(Si eliges Moto te llegará una motocicleta. Recuerda llevar casco si tienes uno.)_`,
      [
        { id: "elegir_auto", title: "🚗 Pedir Auto" },
        { id: "elegir_moto", title: "🏍️ Pedir Moto" },
        { id: "cancelar_viaje", title: "❌ Cancelar" },
      ]
    );
  } catch (e) {
    log.error("[CALCULO]", e.message);
    await enviarMensaje(phone, "❌ Error calculando. Intenta de nuevo.");
    await updateSession(phone, { ...session, step: "esperando_origen" });
  }
}

async function procesarMensajeUsuario(phone, mensaje, buttonId) {
  let usuario = await Usuario.findOne({ phone });

  // Términos y condiciones
  if (!usuario || !usuario.aceptoTerminos) {
    let session = (await getSession(phone)) || { step: "usuario_terminos" };

    if (session.step === "usuario_terminos" && !buttonId) {
      await enviarBotones(
        phone,
        `👋 ¡Bienvenido a *ChatGo*!\n\n¿Cómo quieres usar la plataforma?`,
        [
          { id: "soy_pasajero", title: "🧍 Pasajero" },
          { id: "soy_chofer", title: "🚖 Chofer" },
        ]
      );
      await setSession(phone, { ...session, step: "eligiendo_rol" });
      return;
    }

    if (session.step === "eligiendo_rol") {
      if (buttonId === "soy_chofer") {
        await deleteSession(phone);
        await procesarMensajeChofer(phone, "", null);
        return;
      }
      session = { ...session, step: "usuario_terminos" };
    }

    if (session.step === "usuario_terminos" || buttonId === "soy_pasajero") {
      await enviarBotones(
        phone,
        `👋 Bienvenido a *ChatGo* de RastreoPlus.\n\n` +
          `Términos y Condiciones:\n\n` +
          `• ChatGo es intermediación tecnológica\n` +
          `• Tu ubicación GPS se usa solo para el viaje\n` +
          `• No compartimos tu info con terceros\n` +
          `• Pago directo al conductor\n` +
          `• Jurisdicción: Cochabamba, Bolivia\n\n` +
          `¿Aceptas?`,
        [
          { id: "usuario_acepta_tc", title: "✅ Acepto" },
          { id: "usuario_rechaza_tc", title: "❌ No acepto" },
        ]
      );
      await setSession(phone, { ...session, step: "usuario_esperando_tc" });
      return;
    }

    if (session.step === "usuario_esperando_tc") {
      if (buttonId === "usuario_acepta_tc") {
        await Usuario.findOneAndUpdate(
          { phone },
          { phone, aceptoTerminos: true },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await deleteSession(phone);
        await enviarMensaje(
          phone,
          "✅ ¡Bienvenido a ChatGo!\n\nEscribe cualquier mensaje o envía un audio para pedir tu taxi. 🚖"
        );
      } else {
        await enviarMensaje(phone, "Para usar ChatGo debes aceptar los términos.");
        await deleteSession(phone);
      }
      return;
    }
  }

  let session = await ensureSession(phone, { step: "inicio" });

  const texto = mensaje.text?.body?.trim() || "";

  // ─── CANCELACIÓN por palabra clave (alta prioridad) ─────────────────
  if (
    texto &&
    !buttonId &&
    esIntentoCancelar(texto) &&
    [
      "esperando_chofer",
      "chofer_en_camino",
      "chofer_esperando_pasajero",
      "sin_chofer",
      "confirmado",
      "esperando_confirmacion",
    ].includes(session.step)
  ) {
    // Confirmar antes de cancelar (seguridad)
    await updateSession(phone, { ...session, step: "confirmando_cancelacion" });
    await enviarBotones(
      phone,
      `⚠️ ¿Estás seguro de cancelar tu viaje?`,
      [
        { id: "confirmar_cancelacion", title: "✅ Sí, cancelar" },
        { id: "no_cancelar", title: "❌ No, seguir" },
      ]
    );
    return;
  }

  // ─── AYUDA por palabra clave ───────────────────────────────────────
  if (texto && !buttonId && esPedidoAyuda(texto)) {
    await procesarPedidoAyuda(phone, false);
    return;
  }

  // ─── Botones historial (inicio) ────────────────────────────────────
  if (buttonId === "hist_ultimo") {
    const histData = session.historial;
    if (histData?.ultimo?.destino) {
      // 🔧 FIX: solo reusamos el DESTINO. El origen lo pedimos siempre,
      // porque el pasajero raramente está en el mismo lugar de donde salió la última vez.
      const destino = histData.ultimo.destino;
      await updateSession(phone, {
        ...session,
        destino,
        step: "esperando_origen_con_destino",
      });
      await enviarMensaje(
        phone,
        `✅ Repetimos el viaje a: *${destino.nombre || "tu último destino"}*\n\n📍 Ahora envíame tu *ubicación actual* (con el pin de WhatsApp) para que sepamos desde dónde recogerte.`
      );
    } else {
      await updateSession(phone, { ...session, step: "esperando_origen" });
      await enviarMensaje(phone, "📍 Envía tu ubicación de origen con el pin.");
    }
    return;
  }

  if (buttonId?.startsWith("hist_freq_")) {
    const idx = parseInt(buttonId.replace("hist_freq_", ""));
    const histData = session.historial;
    if (histData?.rutas?.[idx]?.destino) {
      const destino = histData.rutas[idx].destino;
      await updateSession(phone, {
        ...session,
        destino,
        step: "esperando_origen_con_destino",
      });
      await enviarMensaje(
        phone,
        `✅ Vamos a: *${destino.nombre || "tu destino guardado"}*\n\n📍 Ahora envíame tu *ubicación actual* (con el pin de WhatsApp) para que sepamos desde dónde recogerte.`
      );
    } else {
      await updateSession(phone, { ...session, step: "esperando_origen" });
      await enviarMensaje(phone, "📍 Envía tu ubicación de origen con el pin.");
    }
    return;
  }

  if (buttonId === "hist_nueva") {
    await updateSession(phone, { ...session, step: "esperando_origen" });
    await enviarMensaje(phone, "📍 Envía tu *ubicación de origen* con el pin de WhatsApp.");
    return;
  }

  // ─── Confirmación/cancelación de cancelación ───────────────────────
  if (session.step === "confirmando_cancelacion") {
    if (buttonId === "confirmar_cancelacion") {
      await procesarCancelacionPasajero(phone, session);
      return;
    }
    if (buttonId === "no_cancelar") {
      // Restaurar al paso anterior (en_camino/esperando/etc)
      const viaje = await Viaje.findOne({
        usuarioPhone: phone,
        estado: { $in: ["pendiente", "en_camino", "esperando_pasajero", "en_curso"] },
      });
      const pasoRestaurar = viaje
        ? viaje.estado === "pendiente"
          ? "esperando_chofer"
          : viaje.estado === "en_camino"
          ? "chofer_en_camino"
          : viaje.estado === "esperando_pasajero"
          ? "chofer_esperando_pasajero"
          : "en_curso"
        : "inicio";
      await updateSession(phone, { ...session, step: pasoRestaurar });
      await enviarMensaje(phone, "✅ Seguimos con tu viaje.");
      return;
    }
  }

  // ─── Rating ─────────────────────────────────────────────────────────
  if (session.step === "esperando_rating" && buttonId?.startsWith("rating_")) {
    const rating = parseInt(buttonId.replace("rating_", ""));
    if (rating && session.viajeIdRating) {
      await registrarRating(phone, rating, session.viajeIdRating);
    }
    return;
  }

  // ─── Extraer coordenadas ───────────────────────────────────────────
  let coords = null;
  if (mensaje.location) {
    const lat = parseFloat(mensaje.location.latitude ?? mensaje.location.lat);
    const lng = parseFloat(
      mensaje.location.longitude ?? mensaje.location.lng ?? mensaje.location.lon
    );
    if (!isNaN(lat) && !isNaN(lng)) {
      coords = { lat, lng };
    }
  }

  // ─── Chat con chofer durante viaje ─────────────────────────────────
  if (
    texto &&
    !buttonId &&
    ["esperando_chofer", "chofer_en_camino", "chofer_esperando_pasajero", "en_curso"].includes(
      session.step
    )
  ) {
    if (session.choferPhone) {
      await enviarMensaje(session.choferPhone, `💬 *Mensaje del pasajero:*\n${texto}`);
      await enviarMensaje(phone, "✅ Enviado al chofer");
      return;
    }
  }

  // ─── Audio ─────────────────────────────────────────────────────────
  if (mensaje.type === "audio" || mensaje.type === "voice") {
    await enviarMensaje(phone, "🎤 Procesando tu mensaje de voz...");
    try {
      const audioUrl = await obtenerUrlMedia(mensaje.audio?.id || mensaje.voice?.id);
      const transcripcion = await transcribirAudio(audioUrl);
      await enviarMensaje(phone, `🎤 Escuché: _"${transcripcion}"_`);
      const ubicaciones = await extraerUbicaciones(transcripcion);

      if (ubicaciones.origen && !ubicaciones.destino) {
        const origenCoords = await geocodificarDireccion(ubicaciones.origen);
        if (origenCoords) {
          origenCoords.nombre = ubicaciones.origen;
          session.origen = origenCoords;
        }
        await updateSession(phone, { ...session, step: "esperando_destino" });
        await enviarMensaje(
          phone,
          `✅ Origen: *${ubicaciones.origen}*\n\n🏁 Ahora dime tu *destino*.`
        );
        return;
      }

      if (!ubicaciones.origen && ubicaciones.destino) {
        const destinoCoords = await geocodificarDireccion(ubicaciones.destino);
        if (destinoCoords) {
          destinoCoords.nombre = ubicaciones.destino;
          session.destino = destinoCoords;
        }
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(
          phone,
          `✅ Destino: *${ubicaciones.destino}*\n\n📍 Ahora dime tu *origen*.`
        );
        return;
      }

      if (!ubicaciones.origen && !ubicaciones.destino) {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(
          phone,
          "No pude identificar ubicaciones.\n📍 Envía tu origen con el pin de WhatsApp."
        );
        return;
      }

      const origenCoords = await geocodificarDireccion(ubicaciones.origen);
      const destinoCoords = await geocodificarDireccion(ubicaciones.destino);
      if (!origenCoords || !destinoCoords) {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(phone, "No encontré las ubicaciones.\n📍 Envía tu origen con el pin.");
        return;
      }
      origenCoords.nombre = ubicaciones.origen;
      destinoCoords.nombre = ubicaciones.destino;
      await updateSession(phone, {
        ...session,
        origenPendiente: origenCoords,
        destinoPendiente: destinoCoords,
        step: "confirmando_ubicaciones_voz",
      });
      await enviarBotones(
        phone,
        `📍 *¿Confirmas estas ubicaciones?*\n\n` +
          `🚀 Origen: ${ubicaciones.origen}\n` +
          `🏁 Destino: ${ubicaciones.destino}`,
        [
          { id: "confirmar_ubicaciones", title: "✅ Sí" },
          { id: "corregir_origen", title: "Cambiar origen" },
          { id: "corregir_destino", title: "Cambiar destino" },
        ]
      );
    } catch (e) {
      log.error("[AUDIO]", e.message);
      await enviarMensaje(phone, "❌ Error procesando audio. Envía el pin de ubicación.");
      await updateSession(phone, { ...session, step: "esperando_origen" });
    }
    return;
  }

  // ─── Switch de steps ───────────────────────────────────────────────
  switch (session.step) {
    case "inicio": {
      // Construir botones con historial
      const { botones, idsParaSession } = await construirBotonesHistorial(phone);

      if (botones.length > 0) {
        await updateSession(phone, {
          ...session,
          step: "eligiendo_historial",
          historial: idsParaSession,
        });
        await enviarBotones(
          phone,
          `👋 ¡Hola de nuevo!\n\n¿A dónde vas hoy?`,
          botones
        );
      } else {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(
          phone,
          "👋 ¡Hola! Bienvenido a *ChatGo*.\n\n" +
            "📍 Envía tu ubicación de origen usando el pin de WhatsApp.\n\n" +
            "También puedes enviar un 🎤 mensaje de voz diciendo a dónde quieres ir."
        );
      }
      break;
    }

    case "eligiendo_historial": {
      // Si llegó algo sin ser un botón de historial, caer al flujo normal
      if (coords) {
        // Si mandó pin, tratar como origen
        const origen = { ...coords };
        try {
          const dir = await obtenerDireccion(coords.lat, coords.lng);
          if (dir) origen.nombre = dir;
        } catch {}
        await updateSession(phone, { ...session, origen, step: "esperando_destino" });
        await enviarMensaje(
          phone,
          "✅ Origen recibido.\n\n🏁 Ahora envía tu *ubicación de destino*."
        );
      } else {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(phone, "📍 Envía tu ubicación de origen con el pin de WhatsApp.");
      }
      break;
    }

    case "esperando_origen":
      if (!coords) {
        await enviarMensaje(
          phone,
          "📍 Estoy esperando tu ubicación de origen.\nUsa el 📎 adjunto → Ubicación, o envía un 🎤 audio."
        );
        break;
      }
      {
        const origen = { ...coords };
        try {
          const dir = await obtenerDireccion(coords.lat, coords.lng);
          if (dir) origen.nombre = dir;
        } catch {}
        await updateSession(phone, { ...session, origen, step: "esperando_destino" });
        await enviarMensaje(phone, "✅ Origen recibido.\n\n🏁 Ahora envía tu *ubicación de destino*.");
      }
      break;

    case "esperando_origen_con_destino":
      // Caso especial: ya tenemos destino (del historial), solo falta origen
      if (!coords) {
        await enviarMensaje(
          phone,
          "📍 Estoy esperando tu ubicación de origen.\nUsa el 📎 adjunto → Ubicación."
        );
        break;
      }
      {
        const origen = { ...coords };
        try {
          const dir = await obtenerDireccion(coords.lat, coords.lng);
          if (dir) origen.nombre = dir;
        } catch {}
        const nuevaSession = { ...session, origen };
        await setSession(phone, nuevaSession);
        await procesarCalculoViaje(phone, nuevaSession);
      }
      break;

    case "esperando_destino":
      if (!coords) {
        await enviarMensaje(
          phone,
          "🏁 Estoy esperando tu ubicación de destino.\nUsa el 📎 adjunto → Ubicación."
        );
        break;
      }
      {
        const destino = { ...coords };
        try {
          const dir = await obtenerDireccion(coords.lat, coords.lng);
          if (dir) destino.nombre = dir;
        } catch {}
        const nuevaSession = { ...session, destino };
        await setSession(phone, nuevaSession);
        await procesarCalculoViaje(phone, nuevaSession);
      }
      break;

    case "confirmando_ubicaciones_voz":
      if (buttonId === "confirmar_ubicaciones") {
        const nuevaSession = {
          ...session,
          origen: session.origenPendiente,
          destino: session.destinoPendiente,
        };
        delete nuevaSession.origenPendiente;
        delete nuevaSession.destinoPendiente;
        await procesarCalculoViaje(phone, nuevaSession);
      } else if (buttonId === "corregir_origen") {
        const nuevaSession = { ...session, destino: session.destinoPendiente };
        delete nuevaSession.origenPendiente;
        delete nuevaSession.destinoPendiente;
        nuevaSession.step = "esperando_origen";
        await setSession(phone, nuevaSession);
        await enviarMensaje(phone, "📍 Envía tu *ubicación de origen* con el pin.");
      } else if (buttonId === "corregir_destino") {
        const nuevaSession = { ...session, origen: session.origenPendiente };
        delete nuevaSession.origenPendiente;
        delete nuevaSession.destinoPendiente;
        nuevaSession.step = "esperando_destino";
        await setSession(phone, nuevaSession);
        await enviarMensaje(phone, "🏁 Envía tu *ubicación de destino* con el pin.");
      }
      break;

    case "eligiendo_tipo_vehiculo": {
      const textoConf = texto.toUpperCase();

      // Detectar tipo elegido por botón o texto
      let tipoElegido = null;
      if (buttonId === "elegir_auto" || /\b(AUTO|CARRO|COCHE|TAXI)\b/i.test(textoConf)) {
        tipoElegido = "auto";
      } else if (buttonId === "elegir_moto" || /\b(MOTO|MOTOCICLETA)\b/i.test(textoConf)) {
        tipoElegido = "moto";
      }

      if (
        buttonId === "cancelar_viaje" ||
        textoConf === "NO" ||
        textoConf === "CANCELAR"
      ) {
        await deleteSession(phone);
        await enviarMensaje(phone, "❌ Viaje cancelado.");
        break;
      }

      if (!tipoElegido) {
        // No entendió, repetir opciones
        await enviarBotones(
          phone,
          `¿Qué tipo de viaje prefieres?\n\n🚗 *Auto* — Bs ${session.precioAuto}\n🏍️ *Moto* — Bs ${session.precioMoto}`,
          [
            { id: "elegir_auto", title: "🚗 Pedir Auto" },
            { id: "elegir_moto", title: "🏍️ Pedir Moto" },
            { id: "cancelar_viaje", title: "❌ Cancelar" },
          ]
        );
        break;
      }

      // Tipo elegido: guardar precio y tipo definitivos
      const precioFinal = tipoElegido === "moto" ? session.precioMoto : session.precioAuto;
      const precioPorKmFinal =
        tipoElegido === "moto" ? session.precioPorKmMoto : session.precioPorKmAuto;

      const sessionConTipo = {
        ...session,
        tipoVehiculoSolicitado: tipoElegido,
        precio: precioFinal,
        precioPorKm: precioPorKmFinal,
        step: "confirmado",
      };
      await setSession(phone, sessionConTipo);

      const emoji = tipoElegido === "moto" ? "🏍️" : "🚗";
      const labelTipo = tipoElegido === "moto" ? "moto" : "auto";
      await enviarMensaje(
        phone,
        `${emoji} Buscando ${labelTipo} disponible...\n💰 Precio: Bs ${precioFinal}`
      );
      await asignarChofer(phone, sessionConTipo);
      break;
    }

    case "esperando_confirmacion": {
      // Compatibilidad con sesiones viejas (en caso de redeploy mientras hay alguien acá)
      // Las redirige al nuevo flujo
      await procesarCalculoViaje(phone, session);
      break;
    }

    case "sin_chofer":
      if (buttonId === "confirmar_viaje_recordatorio") {
        // El pasajero aceptó la oferta, limpiar lista de espera y asignar
        const espera = await ListaEspera.findOne({ userPhone: phone });
        const chofer_preferido = espera?.ofertaActivaWialonId;
        await removeListaEspera(phone);
        await enviarMensaje(phone, "✅ Perfecto! Asignando tu chofer...");
        // Preservar datos del viaje en session
        const sessionConDatos = {
          ...session,
          origen: espera?.origen || session.origen,
          destino: espera?.destino || session.destino,
          distancia: espera?.distancia || session.distancia,
          precio: espera?.precio || session.precio,
          precioPorKm: espera?.precioPorKm || session.precioPorKm,
        };
        await setSession(phone, sessionConDatos);
        // Intentar asignar al que ofrecimos primero; si falló, buscar otro
        await asignarChofer(phone, sessionConDatos);
      } else if (buttonId === "cancelar_viaje") {
        await deleteSession(phone);
        await removeListaEspera(phone);
        await enviarMensaje(phone, "❌ Entendido. Escribe cuando necesites taxi. 🚖");
      } else {
        await enviarMensaje(phone, "⏳ Seguimos buscando un móvil para ti...");
      }
      break;

    case "esperando_chofer":
      if (!buttonId) {
        await enviarMensaje(phone, "⏳ Ya estamos buscando tu chofer...");
      }
      break;

    case "chofer_en_camino":
    case "chofer_esperando_pasajero":
    case "en_curso": {
      // Relay del pasajero hacia el chofer (chat durante el viaje)
      const viajeActivo = await Viaje.findOne({
        usuarioPhone: phone,
        estado: { $in: ["en_camino", "esperando_pasajero", "en_curso"] },
      });

      if (!viajeActivo) {
        // No hay viaje real, sesión inconsistente — reiniciamos
        await deleteSession(phone);
        await setSession(phone, { step: "inicio" });
        await enviarMensaje(phone, "🤔 No encontré tu viaje activo. Escribe *HOLA* para empezar de nuevo.");
        break;
      }

      // Si el pasajero presionó botón especial (cancelar, etc.)
      if (buttonId === "cancelar_viaje_pasajero") {
        await Viaje.findByIdAndUpdate(viajeActivo._id, {
          estado: "cancelado",
          fechaFin: new Date(),
          cancelacionMotivo: "cancelado_por_pasajero",
        });
        await Chofer.findOneAndUpdate(
          { wialonId: viajeActivo.choferWialonId },
          { $set: { estado: "libre", viajeReservado: null, reservadoHasta: null } }
        );
        await enviarMensaje(viajeActivo.choferPhone, `❌ El pasajero canceló el viaje.`);
        await deleteSession(phone);
        await enviarMensaje(phone, "❌ Viaje cancelado. Escribe cuando necesites otro taxi 🚖");
        break;
      }

      // Si escribió texto, lo relayeamos al chofer
      if (mensajeTexto && mensajeTexto.trim()) {
        await enviarMensaje(
          viajeActivo.choferPhone,
          `💬 *Mensaje de tu pasajero:*\n${mensajeTexto.trim()}`
        );
        await enviarMensaje(phone, "✅ Enviado al chofer");
        break;
      }

      // Si no es texto ni botón conocido, mensaje guía según step
      const guiasPorStep = {
        chofer_en_camino: `🚖 Tu chofer va en camino.\n\nPuedes escribirle por aquí — yo le envío tus mensajes 💬`,
        chofer_esperando_pasajero: `🚕 Tu chofer ya llegó. Dirígete al vehículo.\n\nSi quieres mandarle un mensaje, escríbelo aquí 💬`,
        en_curso: `🚖 Tu viaje está en curso. ¡Disfrútalo!\n\nSi necesitas decirle algo al chofer, escríbelo aquí 💬`,
      };
      await enviarMensaje(phone, guiasPorStep[session.step] || "Tu viaje está activo.");
      break;
    }

    default:
      await deleteSession(phone);
      await setSession(phone, { step: "inicio" });
      await procesarMensajeUsuario(phone, mensaje, buttonId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK META
// ═══════════════════════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === CONFIG.VERIFY_TOKEN
  ) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  if (!verificarFirmaMeta(req)) {
    log.warn("[WEBHOOK] Firma inválida, rechazado");
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      try {
        const phone = msg.from;
        const buttonId = msg.interactive?.button_reply?.id || null;
        const textoUpper = msg.text?.body?.trim().toUpperCase() || "";
        const mediaId = msg.image?.id || null;

        log.info(
          `[WEBHOOK] From: ${phone}, Type: ${msg.type}, Text: "${msg.text?.body || ""}", Button: ${buttonId || "-"}`
        );

        const dentroLimite = await checkRateLimit(phone);
        if (!dentroLimite) {
          log.warn(`[WEBHOOK] Rate limit excedido para ${phone}`);
          continue;
        }

        // Admin approvals
        if (
          buttonId &&
          (buttonId.startsWith("aprobar_pago_") || buttonId.startsWith("rechazar_pago_"))
        ) {
          if (phone !== CONFIG.ADMIN_PHONE) {
            log.warn(`[SECURITY] ${phone} intentó aprobar pago sin ser admin`);
            await enviarMensaje(phone, "❌ No tienes permiso para esa acción.");
            continue;
          }
          const esAprobar = buttonId.startsWith("aprobar_pago_");
          const choferPhone = buttonId.replace(/^(aprobar|rechazar)_pago_/, "");
          if (esAprobar) {
            await Chofer.findOneAndUpdate(
              { phone: choferPhone },
              {
                "pagoDiario.aprobado": true,
                "pagoDiario.fecha": new Date(),
                "pagoDiario.fechaStr": fechaStrBolivia(),
                estado: "libre",
              }
            );
            await enviarBotones(
              choferPhone,
              `✅ *Pago confirmado!*\n🚖 Ya estás LIBRE para recibir viajes.`,
              [
                { id: "chofer_ocupado", title: "🔴 Ocupado" },
                { id: "chofer_ayuda", title: "❓ Ayuda" },
              ]
            );
            await enviarMensaje(phone, `✅ Pago aprobado para +${choferPhone}`);
          } else {
            await Chofer.findOneAndUpdate(
              { phone: choferPhone },
              {
                "pagoDiario.pagado": false,
                "pagoDiario.aprobado": false,
                estado: "offline",
              }
            );
            await enviarMensaje(
              choferPhone,
              `❌ Tu comprobante de pago fue rechazado. Contacta al admin: +591 62741818`
            );
            await enviarMensaje(phone, `❌ Pago rechazado para +${choferPhone}`);
          }
          continue;
        }

        const esChofer = await Chofer.exists({ phone });
        const session = await getSession(phone);
        const esRegistroChofer =
          textoUpper === "CHOFER" ||
          textoUpper === "SOY CHOFER" ||
          textoUpper === "CONDUCTOR" ||
          (session && session.step?.startsWith("chofer_"));

        if (esChofer || esRegistroChofer) {
          await procesarMensajeChofer(phone, msg.text?.body || "", buttonId, mediaId);
        } else {
          await procesarMensajeUsuario(phone, msg, buttonId);
        }
      } catch (eInner) {
        log.error("[WEBHOOK_MSG]", eInner.message, eInner.stack);
      }
    }
  } catch (e) {
    log.error("[WEBHOOK]", e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINTS AUXILIARES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/unidades", async (req, res) => {
  try {
    const eid = await wialonLogin();
    const resp = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
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
          flags: 4294967295,
          from: 0,
          to: 0,
        }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (!resp.data.items) return res.json({ error: "No se encontraron unidades", raw: resp.data });
    const unidades = resp.data.items.map((u) => ({
      id: u.id,
      nombre: u.nm,
      uid: u.uid || u.uid2 || "",
      ultimaPos: u.pos
        ? {
            lat: u.pos.y,
            lng: u.pos.x,
            hace_min: Math.round((Date.now() / 1000 - (u.pos.t || 0)) / 60),
          }
        : null,
    }));
    res.json({ total: unidades.length, unidades });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const [
      usuarios,
      choferes,
      choferesLibres,
      choferesPagados,
      viajesHoy,
      viajesActivos,
      ratingPromedio,
    ] = await Promise.all([
      Usuario.countDocuments(),
      Chofer.countDocuments(),
      Chofer.countDocuments({ estado: "libre" }),
      Chofer.countDocuments({ "pagoDiario.aprobado": true, "pagoDiario.fechaStr": hoyStr }),
      Viaje.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }),
      Viaje.countDocuments({
        estado: { $in: ["pendiente", "en_camino", "esperando_pasajero", "en_curso"] },
      }),
      Viaje.aggregate([
        { $match: { ratingPasajero: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: "$ratingPasajero" }, count: { $sum: 1 } } },
      ]),
    ]);
    res.json({
      hoy: hoyStr,
      usuarios,
      choferes,
      choferesLibres,
      choferesPagadosHoy: choferesPagados,
      viajesUltimas24h: viajesHoy,
      viajesActivos,
      rating: ratingPromedio[0]
        ? { promedio: Math.round(ratingPromedio[0].avg * 10) / 10, cantidad: ratingPromedio[0].count }
        : null,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/", (req, res) => {
  res.send("ChatGo v3 HARDENED - RastreoPlus - Operativo ✅");
});

// ═══════════════════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log.info(`🚖 ChatGo v3 corriendo en puerto ${PORT}`));

process.on("unhandledRejection", (reason) => {
  log.error("[UNHANDLED_REJECTION]", reason);
});

process.on("uncaughtException", (err) => {
  log.error("[UNCAUGHT_EXCEPTION]", err.message, err.stack);
});
