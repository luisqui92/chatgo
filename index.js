// ═══════════════════════════════════════════════════════════════════════════
// ChatGo - Bot de Taxi por WhatsApp (v4 - FIXED + FEATURES)
// RastreoPlus - Cochabamba, Bolivia
// Cambios v4:
//   FIXES: race condition promo, cancelación en_curso, llegada GPS doble notif,
//          viajes zombie, Wialon bulk search, chat multimedia esperando_chofer,
//          recursión asignarChofer, routing CONDUCTOR, dedup mensajes WA,
//          Plus Code como nombre, origen=destino guard
//   FEATURES: parseo Google Maps URLs, memoria de referencias de voz,
//             audio → geocode → fallback a memoria
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

  TIMEOUT_ACEPTACION_CHOFER: 30,
  ESPERA_NOTIFICAR_SIN_CHOFER: 120,
  ESPERA_TIMEOUT_TOTAL: 300,
  ESPERA_OFERTA_VIGENCIA: 45,

  LOCATOR_DURACION: 21600,
  OFFSET_HORAS: -4,
  MAX_MENSAJES_POR_HORA: 80,

  PROMO_GRATIS_HASTA: process.env.PROMO_GRATIS_HASTA || "2026-05-16",
  PROMO_CODIGOS_HASTA: process.env.PROMO_CODIGOS_HASTA || "2026-05-16",
  CODIGO_DESCUENTO_PORCENTAJE: 40,
  CODIGO_VIGENCIA_DIAS: 15,

  MAX_PARADAS: 3,
  // Máximo de reintentos en asignarChofer para evitar recursión infinita
  MAX_REINTENTOS_ASIGNAR: 5,
  // TTL para deduplicación de mensajes WA (ms)
  MSG_DEDUP_TTL: 5 * 60 * 1000,
};

// ─── LOGGER ────────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log(new Date().toISOString(), "[INFO]",  ...a),
  warn:  (...a) => console.warn(new Date().toISOString(), "[WARN]",  ...a),
  error: (...a) => console.error(new Date().toISOString(), "[ERROR]", ...a),
  debug: (...a) => console.log(new Date().toISOString(), "[DEBUG]", ...a),
};

// FIX BUG#10 — advertir si META_APP_SECRET no está seteado
if (!process.env.META_APP_SECRET) {
  log.warn("⚠️  META_APP_SECRET no configurado — el webhook acepta requests sin validar firma. Configúralo en producción.");
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => { req.rawBody = buf; },
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
    paradas: [{ lat: Number, lng: Number, nombre: String }],
    observaciones: String,
    distanciaKm: Number,
    precioBase: Number,
    descuentoBs: { type: Number, default: 0 },
    codigoPromoUsado: String,
    precioTotal: Number,
    precioPorKm: Number,
    tipoVehiculo: { type: String, enum: ["auto", "moto"], default: "auto" },
    estado: { type: String, default: "pendiente", index: true },
    fechaInicio: { type: Date, default: Date.now },
    fechaAsignacion: Date,
    fechaAceptacion: Date,
    fechaFin: Date,
    llegadaNotificada: { type: Boolean, default: false },
    llegadaOrigenNotificada: { type: Boolean, default: false },
    cancelacionMotivo: String,
    ratingPasajero: Number,
    comentarioPasajero: String,
    ratingSolicitado: { type: Boolean, default: false },
    codigoPromoGenerado: String,
  },
  { timestamps: true }
);

const codigoPromoSchema = new mongoose.Schema(
  {
    codigo: { type: String, unique: true, index: true, uppercase: true },
    descuentoPorcentaje: { type: Number, default: 40 },
    generadoPor: { type: String, index: true },
    tipoOrigen: { type: String, default: "post_viaje" },
    fechaCreacion: { type: Date, default: Date.now },
    fechaVencimiento: { type: Date, index: true },
    usado: { type: Boolean, default: false, index: true },
    usadoPor: String,
    fechaUso: Date,
    viajeIdAsociado: String,
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
    notificado: { type: Boolean, default: false },
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

// FEATURE: Schema para memoria de referencias de voz
const locationReferenceSchema = new mongoose.Schema(
  {
    referencia: { type: String, unique: true, index: true }, // normalizada
    referenciaOriginal: String,
    lat: Number,
    lng: Number,
    nombreResuelto: String,
    contador: { type: Number, default: 1 },
    ciudad: { type: String, default: "Cochabamba" },
  },
  { timestamps: true }
);

const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);
const SessionState = mongoose.model("SessionState", sessionSchema, "sessionstates");
const ListaEspera = mongoose.model("ListaEspera", listaEsperaSchema, "listaesperas");
const RateLimit = mongoose.model("RateLimit", rateLimitSchema, "ratelimits");
const CodigoPromo = mongoose.model("CodigoPromo", codigoPromoSchema, "codigospromo");
const LocationReference = mongoose.model("LocationReference", locationReferenceSchema, "locationreferences");

// ═══════════════════════════════════════════════════════════════════════════
// FIX BUG#9 — DEDUPLICACIÓN DE MENSAJES WHATSAPP
// Map: msgId → timestamp. Se limpia automáticamente cada 5 min.
// ═══════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════
// FECHA Y ZONA HORARIA (Bolivia UTC-4)
// ═══════════════════════════════════════════════════════════════════════════

function fechaStrBolivia(date = new Date()) {
  const t = new Date(date.getTime() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

function horaStrBolivia(date = new Date()) {
  const t = new Date(date.getTime() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
  return t.toISOString().slice(0, 13);
}

function formatearFechaPromo(fechaStr) {
  if (!fechaStr) return "fin de la promo";
  const [, mm, dd] = fechaStr.split("-");
  const meses = ["enero","febrero","marzo","abril","mayo","junio",
                 "julio","agosto","septiembre","octubre","noviembre","diciembre"];
  return `${parseInt(dd, 10)} de ${meses[parseInt(mm, 10) - 1] || mm}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// CÓDIGOS DE DESCUENTO
// ═══════════════════════════════════════════════════════════════════════════

function promoCodigosActiva() {
  return fechaStrBolivia() <= CONFIG.PROMO_CODIGOS_HASTA;
}

async function generarCodigoUnico(maxIntentos = 10) {
  for (let i = 0; i < maxIntentos; i++) {
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    const codigo = `CHATGO-${random}`;
    if (!(await CodigoPromo.findOne({ codigo }))) return codigo;
  }
  return `CHATGO-${Date.now().toString(36).toUpperCase()}`;
}

async function crearCodigoPromo(generadoPorPhone, tipoOrigen = "post_viaje") {
  if (!promoCodigosActiva()) return null;
  const codigo = await generarCodigoUnico();
  const fechaVenc = new Date(Date.now() + CONFIG.CODIGO_VIGENCIA_DIAS * 24 * 60 * 60 * 1000);
  const doc = await CodigoPromo.create({
    codigo,
    descuentoPorcentaje: CONFIG.CODIGO_DESCUENTO_PORCENTAJE,
    generadoPor: generadoPorPhone,
    tipoOrigen,
    fechaVencimiento: fechaVenc,
  });
  log.info(`[PROMO] Código creado: ${codigo} (${tipoOrigen}) para ${generadoPorPhone}`);
  return doc;
}

async function validarCodigoPromo(codigoTexto, precioBase) {
  if (!codigoTexto) return { valido: false, motivo: "Código vacío" };
  const codigo = String(codigoTexto).trim().toUpperCase();
  const doc = await CodigoPromo.findOne({ codigo });
  if (!doc) return { valido: false, motivo: "Ese código no existe" };
  if (doc.usado) return { valido: false, motivo: "Ese código ya fue usado" };
  if (doc.fechaVencimiento < new Date()) return { valido: false, motivo: "El código está vencido" };
  const descuento = Math.round((precioBase * doc.descuentoPorcentaje) / 100);
  return {
    valido: true,
    descuento,
    porcentaje: doc.descuentoPorcentaje,
    codigoDoc: doc,
    nuevoPrecio: Math.max(precioBase - descuento, 1),
  };
}

async function consumirCodigoPromo(codigoDocId, usadoPorPhone, viajeId) {
  await CodigoPromo.findByIdAndUpdate(codigoDocId, {
    usado: true,
    usadoPor: usadoPorPhone,
    fechaUso: new Date(),
    viajeIdAsociado: String(viajeId || ""),
  });
}

function mensajeCodigoEntregado(codigo, motivoTexto = "tu próximo viaje") {
  return (
    `🎁 *¡Tienes un código de descuento!*\n\n` +
    `Código: *${codigo.codigo}*\n` +
    `Descuento: *${codigo.descuentoPorcentaje}% OFF*\n` +
    `Válido por *${CONFIG.CODIGO_VIGENCIA_DIAS} días*\n\n` +
    `📲 Úsalo en ${motivoTexto}.\n` +
    `🤝 También puedes compartirlo con amigos — solo se puede usar 1 vez.\n\n` +
    `Para canjearlo, al confirmar tu próximo viaje toca *🎁 Tengo código*.`
  );
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
  if (!s) { s = defaults; await setSession(phone, s); }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTA DE ESPERA
// ═══════════════════════════════════════════════════════════════════════════

async function addListaEspera(userPhone, session) {
  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
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
    precioPorKm = km < 4 ? 2.5 : km < 10 ? 2.0 : 1.5;
    minimo = 5;
  } else {
    precioPorKm = km < 4 ? 3.5 : km < 10 ? 2.5 : 2.0;
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

function acortarParaBoton(texto, maxLen = 17) {
  if (!texto) return "";
  const limpio = String(texto).split(",")[0].trim();
  if (limpio.length <= maxLen) return limpio;
  return limpio.substring(0, maxLen - 1) + "…";
}

function esIntentoCancelar(texto) {
  if (!texto) return false;
  const t = texto.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const patrones = ["cancelar","cancela","cancelalo","cancelado","ya no quiero","ya no","anular","anula"];
  return patrones.some((p) => t === p || t.startsWith(p + " ") || t.endsWith(" " + p));
}

function esPedidoAyuda(texto) {
  if (!texto) return false;
  const t = texto.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const patrones = ["ayuda","soporte","urgencia","emergencia","hablar con alguien","admin"];
  return patrones.some((p) => t === p || t.startsWith(p + " ") || t.includes(" " + p));
}

// FIX BUG#12 — detectar Plus Code de Google (formato XXXX+XX o XXXX+XXXX)
function esPlusCode(texto) {
  if (!texto) return false;
  return /^[A-Z0-9]{4,8}\+[A-Z0-9]{2,}/.test(texto.trim().toUpperCase());
}

// ─── FEATURE: Parsear URLs de Google Maps ──────────────────────────────────
// Extrae coordenadas de links compartidos de Google Maps:
// - https://www.google.com/maps/@-17.39,-66.15,15z
// - https://www.google.com/maps/place/.../@-17.39,-66.15,...
// - https://maps.google.com/maps?q=-17.39,-66.15
// - https://maps.app.goo.gl/... (URL corta, requiere resolver redirect)
function extraerCoordsDeUrlGmaps(texto) {
  if (!texto) return null;

  // Patrón 1: @lat,lng en la URL
  const atMatch = texto.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  // Patrón 2: ?q=lat,lng o &q=lat,lng
  const qMatch = texto.match(/[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (qMatch) {
    const lat = parseFloat(qMatch[1]);
    const lng = parseFloat(qMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  // Patrón 3: /maps/place/.../lat,lng (último par de números flotantes)
  const placeMatch = texto.match(/maps\/place\/[^@]*@?(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (placeMatch) {
    const lat = parseFloat(placeMatch[1]);
    const lng = parseFloat(placeMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  // Patrón 4: ll=lat,lng (URL clásica de Google Maps)
  const llMatch = texto.match(/ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (llMatch) {
    const lat = parseFloat(llMatch[1]);
    const lng = parseFloat(llMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  return null;
}

// Resuelve una URL corta (maps.app.goo.gl) siguiendo redirects
async function resolverUrlCorta(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 5000,
      validateStatus: () => true,
    });
    // En axios la URL final después de redirects
    return res.request?.res?.responseUrl || res.config?.url || url;
  } catch {
    return url;
  }
}

// Detecta si un texto contiene un link de Google Maps y extrae coords
async function detectarYExtrarCoordsMaps(texto) {
  if (!texto) return null;

  // URL corta de Google Maps
  const urlCortaMatch = texto.match(/https?:\/\/maps\.app\.goo\.gl\/\S+/);
  if (urlCortaMatch) {
    try {
      const urlFinal = await resolverUrlCorta(urlCortaMatch[0]);
      const coords = extraerCoordsDeUrlGmaps(urlFinal);
      if (coords) return coords;
    } catch { /* ignorar */ }
  }

  // URL larga de Google Maps
  if (texto.includes("google.com/maps") || texto.includes("maps.google.com")) {
    return extraerCoordsDeUrlGmaps(texto);
  }

  return null;
}

// ─── FEATURE: Memoria de referencias de voz ────────────────────────────────
function normalizarReferencia(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(al|el|la|los|las|un|una|de|del|en|por|y|o|a|por favor|porfavor)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function buscarReferenciaEnMemoria(referencia) {
  if (!referencia || referencia.length < 4) return null;
  const norm = normalizarReferencia(referencia);
  const doc = await LocationReference.findOne({ referencia: norm });
  if (doc) {
    log.info(`[VOICE_MEM] Cache hit: "${referencia}" → (${doc.lat}, ${doc.lng})`);
    return { lat: doc.lat, lng: doc.lng, nombre: doc.nombreResuelto };
  }
  return null;
}

async function guardarReferenciaVoz(referenciaOriginal, lat, lng, nombre) {
  if (!referenciaOriginal || referenciaOriginal.length < 4) return;
  try {
    const norm = normalizarReferencia(referenciaOriginal);
    await LocationReference.findOneAndUpdate(
      { referencia: norm },
      {
        $set: { referenciaOriginal, lat, lng, nombreResuelto: nombre },
        $inc: { contador: 1 },
      },
      { upsert: true }
    );
    log.info(`[VOICE_MEM] Guardado: "${referenciaOriginal}" → ${nombre}`);
  } catch (e) {
    log.error("[VOICE_MEM] Error guardando:", e.message);
  }
}

// Wrapper: busca en memoria primero, si no geocodifica y guarda
async function geocodificarConMemoria(referencia) {
  if (!referencia) return null;

  // 1. Buscar en memoria de referencias
  const enMemoria = await buscarReferenciaEnMemoria(referencia);
  if (enMemoria) return enMemoria;

  // 2. Geocodificar con Google
  const coords = await geocodificarDireccion(referencia);
  if (coords) {
    // 3. Guardar en memoria para futuros usos
    await guardarReferenciaVoz(referencia, coords.lat, coords.lng, coords.nombre);
  }
  return coords;
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
    if (res.data.status !== "OK") throw new Error("fallback");
    const element = res.data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") throw new Error("fallback");
    return {
      km: Math.round((element.distance.value / 1000) * 10) / 10,
      duracion: element.duration.text,
      esAproximado: false,
    };
  } catch {
    const km = Math.round(distanciaEntrePuntos(origen.lat, origen.lng, destino.lat, destino.lng) * 1.3 * 10) / 10;
    return { km, duracion: `~${Math.round(km * 3)} min`, esAproximado: true };
  }
}

async function calcularDistanciaConParadas(origen, paradas, destino) {
  const puntos = [origen, ...(paradas || []), destino];
  let kmTotal = 0, minTotal = 0, huboFallback = false;

  for (let i = 0; i < puntos.length - 1; i++) {
    try {
      const res = await axios.get(
        "https://maps.googleapis.com/maps/api/distancematrix/json",
        {
          params: {
            origins: `${puntos[i].lat},${puntos[i].lng}`,
            destinations: `${puntos[i + 1].lat},${puntos[i + 1].lng}`,
            key: CONFIG.GOOGLE_MAPS_KEY,
            mode: "driving",
          },
          timeout: CONFIG.TIMEOUT_GOOGLE,
        }
      );
      const elem = res.data.rows?.[0]?.elements?.[0];
      if (res.data.status === "OK" && elem?.status === "OK") {
        kmTotal += elem.distance.value / 1000;
        minTotal += elem.duration.value / 60;
      } else throw new Error("fallback");
    } catch {
      const km = distanciaEntrePuntos(puntos[i].lat, puntos[i].lng, puntos[i+1].lat, puntos[i+1].lng);
      kmTotal += km * 1.3;
      minTotal += km * 3;
      huboFallback = true;
    }
  }

  return {
    km: Math.round(kmTotal * 10) / 10,
    duracion: `${Math.round(minTotal)} min`,
    esAproximado: huboFallback,
  };
}

function generarLinkRutaConParadas(origen, paradas, destino) {
  let url = `https://www.google.com/maps/dir/?api=1`;
  url += `&origin=${origen.lat},${origen.lng}`;
  url += `&destination=${destino.lat},${destino.lng}`;
  if (paradas && paradas.length > 0) {
    url += `&waypoints=${encodeURIComponent(paradas.map(p => `${p.lat},${p.lng}`).join("|"))}`;
  }
  url += `&travelmode=driving`;
  return url;
}

function detectarIncompatibilidadMoto(observaciones) {
  if (!observaciones) return null;
  const t = observaciones.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const reglas = [
    { palabras: ["mascota grande","perro grande","perrazo"], razon: "mascota grande" },
    { palabras: ["maleta grande","maletas","valijas","equipaje grande","muchas maletas"], razon: "equipaje grande" },
    { palabras: ["mueble","muebles","sofa","tv grande","televisor","refrigerador","heladera","lavadora"], razon: "muebles/electrodomésticos" },
    { palabras: ["bebe","bebé","embarazada","embarazo","guagua"], razon: "bebé/embarazada" },
    { palabras: ["muletas","silla de ruedas","discapacidad fisica","yeso"], razon: "movilidad reducida" },
    { palabras: ["3 personas","tres personas","4 personas","cuatro personas","varios pasajeros","somos varios"], razon: "más de 1 pasajero" },
    { palabras: ["fragil","vidrio","garrafa","frágil"], razon: "carga frágil" },
    { palabras: ["mucha compra","muchas compras","compras grandes","carga pesada"], razon: "carga grande" },
  ];
  for (const r of reglas) {
    if (r.palabras.some(p => t.includes(p))) return { incompatible: true, razon: r.razon };
  }
  return null;
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

// FIX BUG#12 — obtenerDireccion evita devolver Plus Codes como nombre
async function obtenerDireccion(lat, lng) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { latlng: `${lat},${lng}`, key: CONFIG.GOOGLE_MAPS_KEY, language: "es" },
      timeout: CONFIG.TIMEOUT_GOOGLE,
    });
    if (!res.data.results?.length) return null;

    const result = res.data.results[0];
    const comps = result.address_components;

    const calle = comps.find(c => c.types.includes("route"))?.long_name || "";
    const numero = comps.find(c => c.types.includes("street_number"))?.long_name || "";
    const barrio = comps.find(c => c.types.includes("neighborhood") || c.types.includes("sublocality"))?.long_name || "";

    let nombre = null;
    if (calle && !esPlusCode(calle)) {
      nombre = numero ? `${calle} ${numero}` : barrio ? `${calle}, ${barrio}` : calle;
    }

    // Si no tenemos nombre legible o es un Plus Code, usar formatted_address limpio
    if (!nombre || esPlusCode(nombre)) {
      const formatted = result.formatted_address;
      // Eliminar el Plus Code al inicio si está
      nombre = formatted.replace(/^[A-Z0-9]{4,8}\+[A-Z0-9]+,?\s*/i, "").split(",")[0].trim();
    }

    return nombre || null;
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
  if (tipoVehiculo) filtro.tipoVehiculo = tipoVehiculo;

  const choferes = await Chofer.find(filtro);
  if (!choferes.length) {
    log.info(`[BUSCAR] No hay choferes ${tipoVehiculo || ""} libres`);
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
          flags: 1 | 256, // básico + posición (flags mínimos para rendimiento)
          from: 0,
          to: 0,
        }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (res.data?.error === 1) { wialonInvalidateCache(); throw new Error("Sesión Wialon expirada"); }
    // Filtrar solo los IDs que nos interesan
    const idSet = new Set(wialonIds);
    itemsWialon = (res.data.items || []).filter(i => idSet.has(i.id));
  } catch (e) {
    log.error("[BUSCAR_BULK]", e.message);
    return null;
  }

  let mejorChofer = null, menorDist = Infinity;
  const ahoraSeg = Math.floor(Date.now() / 1000);

  for (const chofer of choferes) {
    const itemW = itemsWialon.find(i => i.id === parseInt(chofer.wialonId));
    if (!itemW || !itemW.pos) continue;
    const pos = itemW.pos;
    const minutosGps = Math.round((ahoraSeg - (pos.t || 0)) / 60);
    if (minutosGps > 10) continue;
    const dist = distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.y, pos.x);
    if (dist > 10) continue;
    if (dist < menorDist) {
      menorDist = dist;
      mejorChofer = { ...chofer.toObject(), ubicacion: { lat: pos.y, lng: pos.x, minutos: minutosGps }, distanciaAlUsuario: dist };
    }
  }

  if (mejorChofer) log.info(`[BUSCAR] Asignado ${mejorChofer.nombre} a ${menorDist.toFixed(2)}km`);
  else log.info(`[BUSCAR] ${choferes.length} libres pero ninguno cerca o con GPS activo`);

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
  formData.append("file", Buffer.from(audioRes.data), { filename: "audio.ogg", contentType: "audio/ogg" });
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
La gente dice cosas como: "recógeme en X esquina Y", "llévame al Z", "del mercado al hospital". Extrae referencias completas con barrio o referencia local si se menciona.
IMPORTANTE: origen y destino NUNCA pueden ser el mismo lugar a menos que el usuario lo diga explícitamente.`,
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
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
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
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
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
            buttons: botones.slice(0, 3).map(b => ({
              type: "reply",
              reply: { id: b.id, title: b.title.substring(0, 20) },
            })),
          },
        },
      },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
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
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
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
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarImagen:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarAudioPorId(to, audioId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "audio", audio: { id: audioId } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarAudio:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarVideoPorId(to, videoId, caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "video", video: { id: videoId, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarVideo:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarUbicacion(to, lat, lng, name = "", address = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "location", location: { latitude: lat, longitude: lng, name, address } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarUbicacion:", e.response?.data?.error?.message || e.message);
  }
}

async function reenviarDocumentoPorId(to, docId, filename = "", caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "document", document: { id: docId, filename, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: CONFIG.TIMEOUT_META }
    );
  } catch (e) {
    log.error("[WSP] reenviarDocumento:", e.response?.data?.error?.message || e.message);
  }
}

async function relayMensajeChat(de, hacia, mensaje, etiquetaQuien) {
  if (mensaje.type === "text" && mensaje.text?.body?.trim()) {
    await enviarMensaje(hacia, `💬 *Mensaje de ${etiquetaQuien}:*\n${mensaje.text.body.trim()}`);
    return true;
  }
  if ((mensaje.type === "audio" || mensaje.type === "voice") && (mensaje.audio?.id || mensaje.voice?.id)) {
    await enviarMensaje(hacia, `🎤 _Audio de ${etiquetaQuien}:_`);
    await reenviarAudioPorId(hacia, mensaje.audio?.id || mensaje.voice?.id);
    return true;
  }
  if (mensaje.type === "image" && mensaje.image?.id) {
    const cap = mensaje.image.caption ? `📸 De ${etiquetaQuien}:\n${mensaje.image.caption}` : `📸 Foto de ${etiquetaQuien}`;
    await reenviarImagenPorId(hacia, mensaje.image.id, cap);
    return true;
  }
  if (mensaje.type === "video" && mensaje.video?.id) {
    const cap = mensaje.video.caption ? `🎥 De ${etiquetaQuien}:\n${mensaje.video.caption}` : `🎥 Video de ${etiquetaQuien}`;
    await reenviarVideoPorId(hacia, mensaje.video.id, cap);
    return true;
  }
  if (mensaje.type === "location" && mensaje.location) {
    const lat = parseFloat(mensaje.location.latitude ?? mensaje.location.lat);
    const lng = parseFloat(mensaje.location.longitude ?? mensaje.location.lng ?? mensaje.location.lon);
    if (!isNaN(lat) && !isNaN(lng)) {
      await enviarMensaje(hacia, `📍 _${etiquetaQuien.charAt(0).toUpperCase() + etiquetaQuien.slice(1)} comparte ubicación:_`);
      await reenviarUbicacion(hacia, lat, lng, mensaje.location.name || "", mensaje.location.address || "");
      return true;
    }
  }
  if (mensaje.type === "document" && mensaje.document?.id) {
    await reenviarDocumentoPorId(
      hacia,
      mensaje.document.id,
      mensaje.document.filename || "documento",
      mensaje.document.caption ? `📎 De ${etiquetaQuien}: ${mensaje.document.caption}` : `📎 Documento de ${etiquetaQuien}`
    );
    return true;
  }
  if (mensaje.type === "sticker") {
    await enviarMensaje(hacia, `🎨 ${etiquetaQuien.charAt(0).toUpperCase() + etiquetaQuien.slice(1)} te envió un sticker.`);
    return true;
  }
  return false;
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
  if (!CONFIG.META_APP_SECRET) return true; // advertencia ya logueada al inicio
  const sigHeader = req.headers["x-hub-signature-256"];
  if (!sigHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", CONFIG.META_APP_SECRET).update(req.rawBody).digest("hex");
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
  return await Viaje.findOne({ usuarioPhone: phone, estado: "completado" }).sort({ fechaFin: -1 }).lean();
}

async function obtenerDestinosFrecuentes(phone, limit = 2) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario?.rutasFrecuentes?.length) return [];
  const mapa = new Map();
  for (const ruta of usuario.rutasFrecuentes) {
    const key = `${(ruta.destino?.lat || 0).toFixed(3)}_${(ruta.destino?.lng || 0).toFixed(3)}`;
    const actual = mapa.get(key);
    if (actual) {
      actual.contador += ruta.contador || 1;
      if ((ruta.destino?.nombre || "").length > (actual.destino.nombre || "").length) actual.destino = ruta.destino;
    } else {
      mapa.set(key, { destino: ruta.destino, contador: ruta.contador || 1 });
    }
  }
  return Array.from(mapa.values())
    .filter(r => r.destino && r.destino.lat && r.destino.lng)
    .sort((a, b) => b.contador - a.contador)
    .slice(0, limit);
}

async function guardarRutaFrecuente(phone, origen, destino) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario) return;
  const existente = usuario.rutasFrecuentes.find(
    r => Math.abs(r.origen.lat - origen.lat) < 0.001 && Math.abs(r.destino.lat - destino.lat) < 0.001
  );
  if (existente) existente.contador += 1;
  else usuario.rutasFrecuentes.push({ origen, destino, contador: 1 });
  await usuario.save();
}

async function construirBotonesHistorial(phone) {
  const [ultimo, frecuentes] = await Promise.all([obtenerUltimoViaje(phone), obtenerDestinosFrecuentes(phone, 3)]);
  const botones = [];
  const idsParaSession = { rutas: [] };

  if (ultimo) {
    botones.push({ id: "hist_ultimo", title: "🔄 Último viaje" });
    idsParaSession.ultimo = { origen: ultimo.origen, destino: ultimo.destino };
  }

  let agregados = 0;
  for (let i = 0; i < frecuentes.length && botones.length < 3; i++) {
    const f = frecuentes[i];
    if (
      ultimo?.destino &&
      Math.abs(ultimo.destino.lat - f.destino.lat) < 0.001 &&
      Math.abs(ultimo.destino.lng - f.destino.lng) < 0.001
    ) continue;
    botones.push({ id: `hist_freq_${agregados}`, title: `⭐ ${acortarParaBoton(f.destino.nombre || "Destino", 17)}` });
    idsParaSession.rutas.push({ destino: f.destino });
    agregados++;
  }

  if (botones.length > 0 && botones.length < 3) {
    botones.push({ id: "hist_nueva", title: "📍 Nueva ruta" });
  }

  return { botones, idsParaSession };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGO DIARIO Y PROMO DE LANZAMIENTO
// ═══════════════════════════════════════════════════════════════════════════

function enPromoGratis() {
  if (!CONFIG.PROMO_GRATIS_HASTA) return false;
  return fechaStrBolivia() <= CONFIG.PROMO_GRATIS_HASTA;
}

function choferPagoAlDia(chofer) {
  if (enPromoGratis()) return true;
  if (!chofer?.pagoDiario?.aprobado) return false;
  return chofer.pagoDiario.fechaStr === fechaStrBolivia();
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTA DE ESPERA (interval) — búsqueda activa desde el segundo 0
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const ahora = new Date();
    const pendientes = await ListaEspera.find({});

    for (const espera of pendientes) {
      try {
        const segundos = (ahora.getTime() - new Date(espera.timestamp).getTime()) / 1000;

        if (espera.ofertaActivaWialonId && espera.ofertaActivaHasta) {
          const expirada = new Date(espera.ofertaActivaHasta) < ahora;
          if (!expirada) continue;
          log.info(`[ESPERA] Oferta expirada para ${espera.userPhone}`);
          espera.ofertasRechazadas = [...(espera.ofertasRechazadas || []), espera.ofertaActivaWialonId];
          espera.ofertaActivaWialonId = null;
          espera.ofertaActivaHasta = null;
          await espera.save();
        }

        if (segundos > CONFIG.ESPERA_TIMEOUT_TOTAL) {
          log.info(`[ESPERA] Timeout total para ${espera.userPhone}`);
          await removeListaEspera(espera.userPhone);
          await updateSession(espera.userPhone, { step: "inicio" });
          await enviarMensaje(
            espera.userPhone,
            `😔 No encontramos chofer disponible en los últimos ${Math.round(CONFIG.ESPERA_TIMEOUT_TOTAL / 60)} minutos.\n\nPor favor intenta de nuevo en un ratito. 🚖`
          );
          continue;
        }

        const chofer = await buscarChoferDisponible(
          { lat: espera.origen.lat, lng: espera.origen.lng },
          espera.ofertasRechazadas || [],
          espera.tipoVehiculoSolicitado || null
        );

        if (chofer) {
          espera.ofertaActivaWialonId = chofer.wialonId;
          espera.ofertaActivaHasta = new Date(Date.now() + CONFIG.ESPERA_OFERTA_VIGENCIA * 1000);
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
    const pendientes = await Viaje.find({ estado: "pendiente", fechaAsignacion: { $lt: limite } });

    for (const viaje of pendientes) {
      try {
        log.warn(`[TIMEOUT] Viaje ${viaje._id} sin respuesta del chofer ${viaje.choferPhone}`);
        await liberarReservaChofer(viaje.choferWialonId);
        await Viaje.findByIdAndUpdate(viaje._id, { estado: "buscando_otro_chofer", cancelacionMotivo: "timeout_chofer" });
        await enviarMensaje(viaje.choferPhone, "⏰ Se te pasó el tiempo para aceptar el viaje. Pasamos al siguiente chofer.");
        const session = await getSession(viaje.usuarioPhone);
        if (session && session.step === "esperando_chofer") {
          await enviarMensaje(viaje.usuarioPhone, "⏳ El chofer no respondió a tiempo. Buscando otro...");
          await asignarChofer(viaje.usuarioPhone, session, [viaje.choferWialonId]);
        }
      } catch (eInner) {
        log.error("[TIMEOUT_ITEM]", eInner.message);
      }
    }

    // FIX BUG#4 — limpiar viajes zombie en estado buscando_otro_chofer más de 10 min
    const limiteZombie = new Date(Date.now() - 10 * 60 * 1000);
    await Viaje.updateMany(
      { estado: "buscando_otro_chofer", updatedAt: { $lt: limiteZombie } },
      { estado: "cancelado_timeout", cancelacionMotivo: "zombie_cleanup", fechaFin: new Date() }
    );
  } catch (e) {
    log.error("[TIMEOUT_LOOP]", e.message);
  }
}, 15000);

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR CHOFER — FIX BUG#1 (race condition promo) + FIX BUG#7 (recursión)
// ═══════════════════════════════════════════════════════════════════════════

async function asignarChofer(userPhone, session, excludeWialonIds = [], intento = 0) {
  // FIX BUG#7 — límite de reintentos para evitar recursión infinita
  if (intento >= CONFIG.MAX_REINTENTOS_ASIGNAR) {
    log.warn(`[ASIGNAR] Máximo de reintentos alcanzado para ${userPhone}`);
    await addListaEspera(userPhone, session);
    const tipoTexto = session.tipoVehiculoSolicitado === "moto" ? "moto" : session.tipoVehiculoSolicitado === "auto" ? "auto" : "móvil";
    await enviarMensaje(userPhone, `⏳ Buscando un ${tipoTexto} cercano para ti...\n\n_Escribe CANCELAR si quieres dejar de buscar._`);
    return;
  }

  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
  const chofer = await buscarChoferDisponible(session.origen, excludeWialonIds, tipoSolicitado);

  if (!chofer) {
    await addListaEspera(userPhone, session);
    const tipoTexto = tipoSolicitado === "moto" ? "moto" : tipoSolicitado === "auto" ? "auto" : "móvil";
    await enviarMensaje(userPhone, `⏳ Buscando un ${tipoTexto} cercano para ti...\n\n_Escribe CANCELAR si quieres dejar de buscar._`);
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
    paradas: session.paradas || [],
    observaciones: session.observaciones || "",
    distanciaKm: session.distancia,
    precioBase: session.precioBase || session.precio,
    descuentoBs: session.descuentoBs || 0,
    codigoPromoUsado: session.codigoPromoUsado || null,
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
    // FIX BUG#7: pasar intento + 1 en lugar de recursión sin límite
    await asignarChofer(userPhone, session, [...excludeWialonIds, chofer.wialonId], intento + 1);
    return;
  }

  // FIX BUG#1 — consumir código DESPUÉS de confirmar reserva exitosa
  if (session.codigoPromoDocId) {
    try {
      await consumirCodigoPromo(session.codigoPromoDocId, userPhone, viaje._id);
    } catch (e) {
      log.error("[PROMO] Error consumiendo código:", e.message);
    }
  }

  await updateSession(userPhone, {
    ...session,
    step: "esperando_chofer",
    choferId: chofer.wialonId,
    choferPhone: chofer.phone,
    viajeId: viaje._id.toString(),
  });

  const linkViaje = generarLinkRutaConParadas(session.origen, session.paradas || [], session.destino);

  let textoParadas = "";
  if (session.paradas && session.paradas.length > 0) {
    textoParadas = session.paradas.map((p, i) => `🚏 Parada ${i + 1}: ${p.nombre || "Ver mapa"}`).join("\n") + "\n";
  }

  const textoObs = session.observaciones ? `\n📝 *Notas del pasajero:*\n_${session.observaciones}_\n` : "";
  const textoDesc = session.descuentoBs > 0 ? `\n🎁 _Pasajero usó código de descuento (Bs ${session.descuentoBs} off)_\n` : "";

  await enviarBotones(
    chofer.phone,
    `🚖 *NUEVO VIAJE*\n\n` +
      `📏 Distancia viaje: ${session.distancia} km\n` +
      `💰 Precio a cobrar: Bs ${session.precio}\n` +
      textoDesc +
      `📌 Estás a ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km del pasajero\n\n` +
      `📍 Origen: ${session.origen.nombre || "Ver mapa"}\n` +
      textoParadas +
      `🏁 Destino: ${session.destino.nombre || "Ver mapa"}\n` +
      textoObs +
      `\n🗺️ Ruta del viaje:\n${linkViaje}\n\n` +
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
    // A) LLEGADA AL ORIGEN DEL PASAJERO (≤50m)
    const enCamino = await Viaje.find({ estado: "en_camino", llegadaOrigenNotificada: false });
    for (const viaje of enCamino) {
      try {
        const posChofer = await obtenerUbicacionChofer(viaje.choferWialonId);
        if (posChofer.minutos > 5) continue;
        const distOrigen = distanciaEntrePuntos(posChofer.lat, posChofer.lng, viaje.origen.lat, viaje.origen.lng);
        if (distOrigen <= 0.05) {
          const updated = await Viaje.findOneAndUpdate(
            { _id: viaje._id, llegadaOrigenNotificada: false },
            { $set: { llegadaOrigenNotificada: true, estado: "esperando_pasajero" } },
            { new: true }
          );
          if (!updated) continue;

          const session = await getSession(viaje.usuarioPhone);
          if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "chofer_esperando_pasajero" });

          const tipoVeh = updated.tipoVehiculo || "auto";
          const emoji = tipoVeh === "moto" ? "🏍️" : "🚗";
          const label = tipoVeh === "moto" ? "moto" : "auto";

          await enviarMensaje(
            viaje.usuarioPhone,
            `🚕 *¡Tu chofer llegó!*\n\n👤 ${viaje.choferNombre}\n${emoji} ${label} placa: ${viaje.choferPlaca}\n\nPor favor dirígete al vehículo. 🚖`
          );

          // FIX BUG#3 — el GPS detectó llegada, le enviamos botones nuevos al chofer
          // y NO esperamos que presione el botón "Llegué" que ya está obsoleto
          await enviarBotones(
            viaje.choferPhone,
            `📍 *Estás a 50m del pasajero*\n\nYa le avisamos que llegaste.\nCuando el pasajero suba presiona:`,
            [
              { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
              { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
            ]
          );
          log.info(`[LLEGADA_ORIGEN] Notificado viaje ${viaje._id}`);
        }
      } catch { /* ignorar fallo individual */ }
    }

    // B) LLEGADA AL DESTINO (≤150m)
    const enCurso = await Viaje.find({ estado: "en_curso", llegadaNotificada: false });
    for (const viaje of enCurso) {
      try {
        const posChofer = await obtenerUbicacionChofer(viaje.choferWialonId);
        const distDestino = distanciaEntrePuntos(posChofer.lat, posChofer.lng, viaje.destino.lat, viaje.destino.lng);
        if (distDestino < 0.15) {
          await Viaje.findByIdAndUpdate(viaje._id, { llegadaNotificada: true });
          await enviarBotones(viaje.choferPhone, "📍 Parece que llegaste al destino. ¿Finalizas el viaje?",
            [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]);
          await enviarMensaje(viaje.usuarioPhone, "📍 ¡Tu chofer llegó al destino!");
        }
      } catch { /* ignorar fallo individual */ }
    }
  } catch (e) {
    log.error("[LLEGADA_LOOP]", e.message);
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// CANCELACIÓN INICIADA POR PASAJERO — FIX BUG#2 (en_curso incluido)
// ═══════════════════════════════════════════════════════════════════════════

async function procesarCancelacionPasajero(phone, session) {
  // FIX BUG#2 — incluir "en_curso" y "buscando_otro_chofer" en el filtro
  const viaje = await Viaje.findOne({
    usuarioPhone: phone,
    estado: { $in: ["pendiente", "en_camino", "esperando_pasajero", "en_curso", "buscando_otro_chofer"] },
  });

  if (viaje) {
    await Viaje.findByIdAndUpdate(viaje._id, {
      estado: "cancelado_pasajero",
      cancelacionMotivo: "cancelado_por_pasajero",
      fechaFin: new Date(),
    });
    if (viaje.choferWialonId) {
      await Chofer.findOneAndUpdate(
        { wialonId: viaje.choferWialonId },
        { estado: "libre", viajeReservado: null, reservadoHasta: null }
      );
      await enviarMensaje(viaje.choferPhone, `❌ El pasajero canceló el viaje. Ya estás LIBRE para recibir otros viajes.`);
    }
    await enviarMensaje(phone, `✅ Viaje cancelado. Escribe cuando necesites otro taxi. 🚖`);
  } else {
    await enviarMensaje(phone, `✅ Búsqueda cancelada. Escribe cuando necesites otro taxi. 🚖`);
  }

  await removeListaEspera(phone);
  await deleteSession(phone);
}

// ═══════════════════════════════════════════════════════════════════════════
// SOPORTE / AYUDA
// ═══════════════════════════════════════════════════════════════════════════

async function procesarPedidoAyuda(phone, esChofer = false) {
  const viaje = esChofer
    ? await Viaje.findOne({ choferPhone: phone, estado: { $in: ["en_camino","esperando_pasajero","en_curso"] } })
    : await Viaje.findOne({ usuarioPhone: phone, estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } });

  await enviarMensaje(phone, `🆘 *Soporte ChatGo*\n\nHemos notificado al administrador. Te contactarán pronto desde +591 62741818.`);

  const contexto = viaje
    ? `\n\n📋 *Contexto del viaje:*\n` +
      `👤 Pasajero: +${viaje.usuarioPhone}\n` +
      `🚖 Chofer: ${viaje.choferNombre} (+${viaje.choferPhone}) - ${viaje.choferPlaca}\n` +
      `📏 ${viaje.distanciaKm} km | 💰 Bs ${viaje.precioTotal}\n` +
      `📍 Estado: ${viaje.estado}`
    : "";

  await enviarMensaje(
    CONFIG.ADMIN_PHONE,
    `🆘 *Pedido de AYUDA*\n\nDe ${esChofer ? "CHOFER" : "PASAJERO"}: +${phone}${contexto}\n\nContáctalo cuanto antes.`
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
    await enviarMensaje(userPhone, `🙏 ¡Gracias por tu calificación!\n\nNos vemos en tu próximo viaje con ChatGo. 🚖`);
  } else {
    await enviarMensaje(userPhone, `🙏 Gracias por tu calificación.\n\nSentimos que no haya sido una buena experiencia. Si quieres contarnos qué pasó, escribe AYUDA y un humano te contactará.`);
    await enviarMensaje(
      CONFIG.ADMIN_PHONE,
      `⚠️ *Rating bajo*\n\nPasajero: +${userPhone}\nChofer: ${viaje.choferNombre} (+${viaje.choferPhone})\nRating: ${rating}/5\nViaje: ${viaje._id}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL CHOFER
// ═══════════════════════════════════════════════════════════════════════════

async function procesarMensajeChofer(phone, mensajeTexto, buttonId, mediaId, mensaje) {
  let chofer = await Chofer.findOne({ phone });

  if (!chofer) {
    const NUMERO_REGISTRO = process.env.NUMERO_REGISTRO || "59164637067";
    await enviarMensaje(
      phone,
      `👋 Hola! Para ser conductor de ChatGo primero tienes que registrarte con nosotros.\n\n` +
        `El registro es rápido (unos 5 minutos) y lo haces con otro número:\n\n` +
        `📱 https://wa.me/${NUMERO_REGISTRO}?text=Vengo+a+registrarme\n\n` +
        `Te vamos a pedir:\n` +
        `1️⃣ Foto de licencia de conducir\n2️⃣ Selfie tuya\n3️⃣ Foto del vehículo con placa visible\n4️⃣ RUAT\n5️⃣ SOAT\n\n` +
        `Una vez aprobado tu registro, te enviaremos las credenciales y podrás volver aquí para iniciar tu jornada 🚖`
    );
    return;
  }

  if (!buttonId && mensajeTexto && esPedidoAyuda(mensajeTexto)) {
    await procesarPedidoAyuda(phone, true);
    return;
  }

  if (buttonId) {
    if (buttonId === "aceptar_viaje") {
      const viaje = await Viaje.findOne({ choferWialonId: chofer.wialonId, estado: "pendiente" });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes pendientes (quizás expiró).");

      const userPhone = viaje.usuarioPhone;
      await Chofer.findByIdAndUpdate(chofer._id, { estado: "ocupado", viajeReservado: null, reservadoHasta: null });
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "en_camino", fechaAceptacion: new Date() });

      const session = await getSession(userPhone);
      if (session) await updateSession(userPhone, { ...session, step: "chofer_en_camino" });

      const linkRastreo = await generarLinkLocator(chofer.wialonId);
      const tipoVeh = chofer.tipoVehiculo || "auto";
      const emojiV = tipoVeh === "moto" ? "🏍️" : "🚗";
      const labelV = tipoVeh === "moto" ? "Moto" : "Auto";

      await enviarMensaje(
        userPhone,
        `🎉 *¡Viaje aceptado!*\n\n` +
          `👤 Chofer: ${chofer.nombre}\n${emojiV} ${labelV} placa: ${chofer.placa}\n\n` +
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
      const viaje = await Viaje.findOne({ choferWialonId: chofer.wialonId, estado: "pendiente" });
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, { estado: "rechazado_chofer", cancelacionMotivo: "rechazo_chofer" });
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

    // FIX BUG#3 — llegue_al_punto busca en en_camino Y en esperando_pasajero
    // para evitar conflicto con la detección GPS automática
    if (buttonId === "llegue_al_punto") {
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: { $in: ["en_camino", "esperando_pasajero"] },
      });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes activos.");

      // Si ya está en esperando_pasajero (GPS ya lo detectó), simplemente mostrar botones
      if (viaje.estado === "esperando_pasajero") {
        await enviarBotones(
          phone,
          `✅ El pasajero ya fue notificado de tu llegada.\nCuando el pasajero suba presiona:`,
          [
            { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
            { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
          ]
        );
        return;
      }

      // Estado en_camino — transición manual
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "esperando_pasajero", llegadaOrigenNotificada: true });
      const session = await getSession(viaje.usuarioPhone);
      if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "chofer_esperando_pasajero" });

      const tipoVeh = chofer.tipoVehiculo || "auto";
      const emoji = tipoVeh === "moto" ? "🏍️" : "🚗";
      const label = tipoVeh === "moto" ? "moto" : "auto";

      await enviarMensaje(viaje.usuarioPhone, `🚕 *¡Tu chofer llegó!*\n\n👤 ${chofer.nombre}\n${emoji} ${label} placa: ${chofer.placa}\n\nDirígete al vehículo.`);
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
      const viaje = await Viaje.findOne({ choferWialonId: chofer.wialonId, estado: "esperando_pasajero" });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes activos.");
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "en_curso" });
      const session = await getSession(viaje.usuarioPhone);
      if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "en_curso" });
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
        await enviarMensaje(viaje.usuarioPhone, `❌ Tu chofer canceló el viaje. Puedes pedir otro cuando quieras.`);
        await enviarMensaje(phone, `❌ Viaje cancelado. Ya estás LIBRE.`);
        await deleteSession(viaje.usuarioPhone);
      }
      return;
    }

    if (buttonId === "terminar_viaje") {
      // Acepta en_curso o esperando_pasajero (edge case: pasajero no subió pero chofer quiere terminar)
      const viaje = await Viaje.findOne({
        choferWialonId: chofer.wialonId,
        estado: { $in: ["en_curso", "esperando_pasajero"] },
      });
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, { estado: "completado", fechaFin: new Date() });
        await Usuario.findOneAndUpdate({ phone: viaje.usuarioPhone }, { $inc: { viajesTotal: 1 } });

        const choferActual = await Chofer.findById(chofer._id);
        const sigueAlDia = choferPagoAlDia(choferActual);
        await Chofer.findByIdAndUpdate(chofer._id, {
          estado: sigueAlDia ? "libre" : "offline",
          $inc: { viajesTotal: 1 },
        });
        await guardarRutaFrecuente(viaje.usuarioPhone, viaje.origen, viaje.destino);

        await enviarMensaje(
          viaje.usuarioPhone,
          `✅ *Viaje completado*\n\n📏 ${viaje.distanciaKm} km\n💰 Bs ${viaje.precioTotal}\n\n¡Gracias por usar ChatGo! 🚖`
        );

        if (promoCodigosActiva()) {
          try {
            const nuevoCodigo = await crearCodigoPromo(viaje.usuarioPhone, "post_viaje");
            if (nuevoCodigo) {
              await Viaje.findByIdAndUpdate(viaje._id, { codigoPromoGenerado: nuevoCodigo.codigo });
              await enviarMensaje(viaje.usuarioPhone, mensajeCodigoEntregado(nuevoCodigo, "tu próximo viaje"));
            }
          } catch (e) {
            log.error("[PROMO] Error generando código post-viaje:", e.message);
          }
        }

        await solicitarRating(viaje.usuarioPhone, viaje._id);

        if (sigueAlDia) {
          await enviarBotones(phone, `✅ Viaje finalizado!\n🟢 Ya estás LIBRE para el siguiente viaje.`, [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]);
        } else {
          await enviarMensaje(phone, `✅ Viaje finalizado!\n\n⚠️ Tu pago diario no está al día. Debes pagar Bs 10 para seguir recibiendo viajes.`);
          if (CONFIG.QR_IMAGE_URL) await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante*.`);
          await setSession(phone, { step: "chofer_esperando_comprobante" });
        }
      }
      return;
    }

    if (buttonId === "chofer_libre") {
      if (!choferPagoAlDia(chofer)) {
        await Chofer.findByIdAndUpdate(chofer._id, { estado: "offline" });
        await enviarMensaje(phone, `Para estar LIBRE primero paga tu cuota diaria de *Bs 10*.`);
        if (CONFIG.QR_IMAGE_URL) await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante* para activarte.`);
        await setSession(phone, { step: "chofer_esperando_comprobante" });
        return;
      }
      try {
        const pos = await obtenerUbicacionChofer(chofer.wialonId);
        if (pos.minutos > 5) {
          await enviarMensaje(
            phone,
            `⚠️ Tu GPS no está enviando señal en este momento (última señal hace ${pos.minutos} min).\n\n` +
              `Para recibir viajes necesitas tener *WiaTag abierto y conectado*.\n\n` +
              `Revisa:\n✅ WiaTag esté abierto (puede estar en segundo plano)\n✅ Permiso de ubicación *"Permitir todo el tiempo"*\n✅ Internet/datos activos\n✅ Optimización de batería DESACTIVADA para WiaTag\n\n` +
              `Reintenta en 1 minuto presionando 🟢 Libre otra vez.`
          );
          return;
        }
      } catch (e) {
        await enviarMensaje(
          phone,
          `⚠️ No pude detectar tu GPS (${e.message}).\n\nAsegúrate que *WiaTag esté abierto y logueado* con tus credenciales.\n\nSi el problema persiste, contacta al admin: +591 62741818`
        );
        return;
      }
      await Chofer.findByIdAndUpdate(chofer._id, { estado: "libre" });
      if (enPromoGratis()) {
        await enviarBotones(
          phone,
          `🎉 *¡Ya estás LIBRE y listo para viajes!* 🚖\n\n📡 GPS: conectado ✅\n\n━━━━━━━━━━━━━━━━━\n🎁 *PROMO DE LANZAMIENTO*\nHasta el ${formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA)} estás operando *GRATIS*.\nNo tienes que pagar la cuota diaria de Bs 10 ni mandar comprobantes.\nA partir del día siguiente: cuota normal Bs 10/día.\n━━━━━━━━━━━━━━━━━\n\n¡Gracias por confiar en ChatGo desde el día 1! 🙌`,
          [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]
        );
      } else {
        await enviarBotones(phone, `✅ Ya estás *LIBRE* y listo para viajes! 🚖\n\n📡 GPS: conectado ✅`, [
          { id: "chofer_ocupado", title: "🔴 Ocupado" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]);
      }
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
      const resultado = await validarComprobantePago(buffer.toString("base64"));
      comprobanteValido = !!resultado.es_comprobante;
      if (resultado._error) comprobanteValido = true;
    } catch (e) {
      log.error("[COMPROBANTE]", e.message);
      comprobanteValido = true;
    }

    if (!comprobanteValido) {
      await enviarMensaje(phone, `❌ No pude identificar un comprobante de pago válido en esa imagen.\n\nMándame una captura clara del pago realizado (QR, transferencia, Tigo Money, etc).`);
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
    await reenviarImagenPorId(`${CONFIG.ADMIN_PHONE}`, mediaId, `💰 Comprobante recibido de ${chofer.nombre}\n📞 +${phone}\n🚗 ${chofer.placa}`);
    await enviarBotones(CONFIG.ADMIN_PHONE, `¿Apruebas el pago de ${chofer.nombre}?`, [
      { id: `aprobar_pago_${phone}`, title: "✅ Aprobar" },
      { id: `rechazar_pago_${phone}`, title: "❌ Rechazar" },
    ]);
    await enviarMensaje(phone, "⏳ Comprobante recibido. Esperando aprobación del administrador...");
    return;
  }

  // Chat con pasajero durante viaje
  const viajeActivo = await Viaje.findOne({
    choferWialonId: chofer.wialonId,
    estado: { $in: ["en_camino","esperando_pasajero","en_curso"] },
  });
  if (viajeActivo && mensaje && mensaje.type) {
    const reenviado = await relayMensajeChat(phone, viajeActivo.usuarioPhone, mensaje, "tu chofer");
    if (reenviado) { await enviarMensaje(phone, "✅ Enviado al pasajero"); return; }
  }

  // Menú del chofer
  if (!choferPagoAlDia(chofer)) {
    await Chofer.findByIdAndUpdate(chofer._id, { estado: "offline" });
    await enviarMensaje(phone, `👋 Hola ${chofer.nombre}!\n\nPara iniciar tu jornada necesitas pagar *Bs 10*.`);
    if (CONFIG.QR_IMAGE_URL) await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante*.`);
    await setSession(phone, { step: "chofer_esperando_comprobante" });
    return;
  }

  if (chofer.estado === "libre") {
    await enviarBotones(phone, `👋 Hola ${chofer.nombre}!\n\n🟢 Estás *LIBRE* y recibiendo viajes.`, [
      { id: "chofer_ocupado", title: "🔴 Ocupado" },
      { id: "chofer_ayuda", title: "❓ Ayuda" },
    ]);
  } else {
    await enviarBotones(phone, `👋 Hola ${chofer.nombre}!\n\n${chofer.estado === "ocupado" ? "🔴 Estás *OCUPADO*" : "⚪ Estás desconectado"}`, [
      { id: "chofer_libre", title: "🟢 Libre" },
      { id: "chofer_ayuda", title: "❓ Ayuda" },
    ]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL USUARIO
// ═══════════════════════════════════════════════════════════════════════════

async function preguntarOpcionesViaje(phone, session) {
  await updateSession(phone, { ...session, step: "preguntando_opciones" });
  const numParadas = (session.paradas || []).length;
  const yaTieneObs = !!session.observaciones;

  let resumen = `🗺️ *Resumen del viaje*\n\n`;
  resumen += `📍 Origen: ${session.origen.nombre || "Tu ubicación"}\n`;
  if (numParadas > 0) session.paradas.forEach((p, i) => { resumen += `🚏 Parada ${i + 1}: ${p.nombre || "ubicación"}\n`; });
  resumen += `🏁 Destino: ${session.destino.nombre || "Tu destino"}\n`;
  if (yaTieneObs) resumen += `\n📝 Notas: _${session.observaciones}_\n`;
  resumen += `\n¿Quieres agregar algo más antes de calcular el precio?`;

  const botones = [];
  if (numParadas < CONFIG.MAX_PARADAS) botones.push({ id: "agregar_parada", title: "🚏 Agregar parada" });
  if (!yaTieneObs) botones.push({ id: "agregar_observacion", title: "📝 Notas" });
  botones.push({ id: "ver_precio", title: "💰 Ver precio" });

  await enviarBotones(phone, resumen, botones);
}

async function procesarCalculoViaje(phone, session) {
  await updateSession(phone, { ...session, step: "calculando" });
  await enviarMensaje(phone, "⏳ Calculando ruta y precio...");

  try {
    const paradas = session.paradas || [];
    const { km, duracion, esAproximado } = paradas.length > 0
      ? await calcularDistanciaConParadas(session.origen, paradas, session.destino)
      : await calcularDistancia(session.origen, session.destino);

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
    let extras = "";
    if (paradas.length > 0) extras += `🚏 ${paradas.length} parada(s)\n`;
    if (session.observaciones) extras += `📝 _${session.observaciones}_\n`;

    await enviarBotones(
      phone,
      `🗺️ *Resumen del viaje*\n\n` +
        `📍 Origen: ${session.origen.nombre || "Tu ubicación"}\n` +
        `🏁 Destino: ${session.destino.nombre || "Tu destino"}\n` +
        (extras ? `\n${extras}` : "") +
        `\n📏 Distancia: ${km} km${avisoAprox}\n` +
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
      if (buttonId === "soy_chofer") { await deleteSession(phone); await procesarMensajeChofer(phone, "", null); return; }
      session = { ...session, step: "usuario_terminos" };
    }

    if (session.step === "usuario_terminos" || buttonId === "soy_pasajero") {
      await enviarBotones(
        phone,
        `👋 Bienvenido a *ChatGo* de RastreoPlus.\n\nTérminos y Condiciones:\n\n• ChatGo es intermediación tecnológica\n• Tu ubicación GPS se usa solo para el viaje\n• No compartimos tu info con terceros\n• Pago directo al conductor\n• Jurisdicción: Cochabamba, Bolivia\n\n¿Aceptas?`,
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
        await Usuario.findOneAndUpdate({ phone }, { phone, aceptoTerminos: true }, { upsert: true, new: true, setDefaultsOnInsert: true });
        await deleteSession(phone);
        await enviarMensaje(phone, "✅ ¡Bienvenido a ChatGo!\n\nEscribe cualquier mensaje o envía un audio para pedir tu taxi. 🚖");
        if (promoCodigosActiva()) {
          try {
            const codigo = await crearCodigoPromo(phone, "bienvenida");
            if (codigo) await enviarMensaje(phone, mensajeCodigoEntregado(codigo, "tu primer viaje"));
          } catch (e) { log.error("[PROMO] Error código bienvenida:", e.message); }
        }
      } else {
        await enviarMensaje(phone, "Para usar ChatGo debes aceptar los términos.");
        await deleteSession(phone);
      }
      return;
    }
  }

  let session = await ensureSession(phone, { step: "inicio" });
  const texto = mensaje.text?.body?.trim() || "";
  const textoUpper = texto.toUpperCase();

  // ─── CANCELACIÓN por palabra clave ──────────────────────────────────────
  if (
    texto && !buttonId && esIntentoCancelar(texto) &&
    ["esperando_chofer","chofer_en_camino","chofer_esperando_pasajero","sin_chofer","confirmado","esperando_confirmacion","en_curso"].includes(session.step)
  ) {
    await updateSession(phone, { ...session, step: "confirmando_cancelacion" });
    await enviarBotones(phone, `⚠️ ¿Estás seguro de cancelar tu viaje?`, [
      { id: "confirmar_cancelacion", title: "✅ Sí, cancelar" },
      { id: "no_cancelar", title: "❌ No, seguir" },
    ]);
    return;
  }

  // ─── AYUDA por palabra clave ─────────────────────────────────────────────
  if (texto && !buttonId && esPedidoAyuda(texto)) {
    await procesarPedidoAyuda(phone, false);
    return;
  }

  // ─── Botones historial ───────────────────────────────────────────────────
  if (buttonId === "hist_ultimo") {
    const histData = session.historial;
    if (histData?.ultimo?.destino) {
      const destino = histData.ultimo.destino;
      await updateSession(phone, { ...session, destino, step: "esperando_origen_con_destino" });
      await enviarMensaje(phone, `✅ Repetimos el viaje a: *${destino.nombre || "tu último destino"}*\n\n📍 Ahora envíame tu *ubicación actual* (con el pin de WhatsApp) para que sepamos desde dónde recogerte.`);
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
      await updateSession(phone, { ...session, destino, step: "esperando_origen_con_destino" });
      await enviarMensaje(phone, `✅ Vamos a: *${destino.nombre || "tu destino guardado"}*\n\n📍 Ahora envíame tu *ubicación actual* (con el pin de WhatsApp) para que sepamos desde dónde recogerte.`);
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

  // ─── Confirmación/cancelación ────────────────────────────────────────────
  if (session.step === "confirmando_cancelacion") {
    if (buttonId === "confirmar_cancelacion") { await procesarCancelacionPasajero(phone, session); return; }
    if (buttonId === "no_cancelar") {
      const viaje = await Viaje.findOne({ usuarioPhone: phone, estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } });
      const pasoRestaurar = viaje
        ? viaje.estado === "pendiente" ? "esperando_chofer"
          : viaje.estado === "en_camino" ? "chofer_en_camino"
          : viaje.estado === "esperando_pasajero" ? "chofer_esperando_pasajero"
          : "en_curso"
        : "inicio";
      await updateSession(phone, { ...session, step: pasoRestaurar });
      await enviarMensaje(phone, "✅ Seguimos con tu viaje.");
      return;
    }
  }

  // ─── Rating ──────────────────────────────────────────────────────────────
  if (session.step === "esperando_rating" && buttonId?.startsWith("rating_")) {
    const rating = parseInt(buttonId.replace("rating_", ""));
    if (rating && session.viajeIdRating) await registrarRating(phone, rating, session.viajeIdRating);
    return;
  }

  // ─── Extraer coordenadas de pin de WhatsApp ──────────────────────────────
  let coords = null;
  if (mensaje.location) {
    const lat = parseFloat(mensaje.location.latitude ?? mensaje.location.lat);
    const lng = parseFloat(mensaje.location.longitude ?? mensaje.location.lng ?? mensaje.location.lon);
    if (!isNaN(lat) && !isNaN(lng)) coords = { lat, lng };
  }

  // FEATURE: Detectar link de Google Maps en texto ──────────────────────────
  if (!coords && texto && (texto.includes("google.com/maps") || texto.includes("maps.app.goo.gl") || texto.includes("maps.google.com"))) {
    try {
      const coordsMaps = await detectarYExtrarCoordsMaps(texto);
      if (coordsMaps) {
        coords = coordsMaps;
        log.info(`[GMAPS_URL] Coordenadas extraídas de URL: (${coords.lat}, ${coords.lng})`);
        await enviarMensaje(phone, "📍 Detecté un link de Google Maps. Procesando ubicación...");
      }
    } catch (e) {
      log.error("[GMAPS_URL]", e.message);
    }
  }

  // ─── FIX BUG#6: Chat multimedia en TODOS los estados activos ────────────
  // Incluye "esperando_chofer" que antes solo hacía relay de texto
  if (
    !buttonId &&
    ["esperando_chofer","chofer_en_camino","chofer_esperando_pasajero","en_curso"].includes(session.step)
  ) {
    if (session.choferPhone) {
      const reenviado = await relayMensajeChat(phone, session.choferPhone, mensaje, "tu pasajero");
      if (reenviado) {
        await enviarMensaje(phone, "✅ Enviado al chofer");
        return;
      }
    }
  }

  // ─── Audio / voz ─────────────────────────────────────────────────────────
  if (mensaje.type === "audio" || mensaje.type === "voice") {
    await enviarMensaje(phone, "🎤 Procesando tu mensaje de voz...");
    try {
      const audioUrl = await obtenerUrlMedia(mensaje.audio?.id || mensaje.voice?.id);
      const transcripcion = await transcribirAudio(audioUrl);
      await enviarMensaje(phone, `🎤 Escuché: _"${transcripcion}"_`);
      const ubicaciones = await extraerUbicaciones(transcripcion);

      // FEATURE: Usar memoria de referencias antes de geocodificar

      if (ubicaciones.origen && !ubicaciones.destino) {
        const origenCoords = await geocodificarConMemoria(ubicaciones.origen);
        if (origenCoords) {
          session.origen = { ...origenCoords, nombre: origenCoords.nombre || ubicaciones.origen };
        }
        await updateSession(phone, { ...session, step: "esperando_destino" });
        await enviarMensaje(phone, `✅ Origen: *${ubicaciones.origen}*\n\n🏁 Ahora dime tu *destino* (envía el pin o dime el lugar).`);
        return;
      }

      if (!ubicaciones.origen && ubicaciones.destino) {
        const destinoCoords = await geocodificarConMemoria(ubicaciones.destino);
        if (destinoCoords) {
          session.destino = { ...destinoCoords, nombre: destinoCoords.nombre || ubicaciones.destino };
        }
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(phone, `✅ Destino: *${ubicaciones.destino}*\n\n📍 Ahora dime tu *origen* (de dónde te recogemos).`);
        return;
      }

      if (!ubicaciones.origen && !ubicaciones.destino) {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(phone, "No pude identificar ubicaciones en tu audio.\n📍 Envía tu origen con el pin de WhatsApp o dime la dirección.");
        return;
      }

      // Tiene ambos — geocodificar con memoria
      const origenCoords = await geocodificarConMemoria(ubicaciones.origen);
      const destinoCoords = await geocodificarConMemoria(ubicaciones.destino);

      if (!origenCoords || !destinoCoords) {
        // Al menos uno no se pudo geocodificar — guardar lo que pudimos y pedir el faltante
        let mensajeFaltante = "";
        if (origenCoords) {
          session.origen = { ...origenCoords, nombre: origenCoords.nombre || ubicaciones.origen };
          mensajeFaltante = `✅ Origen: *${ubicaciones.origen}*\n\n🏁 No pude encontrar el destino en el mapa. Envía el pin del destino.`;
          await updateSession(phone, { ...session, step: "esperando_destino" });
        } else if (destinoCoords) {
          session.destino = { ...destinoCoords, nombre: destinoCoords.nombre || ubicaciones.destino };
          mensajeFaltante = `✅ Destino: *${ubicaciones.destino}*\n\n📍 No pude encontrar el origen en el mapa. Envía el pin de tu origen.`;
          await updateSession(phone, { ...session, step: "esperando_origen" });
        } else {
          await updateSession(phone, { ...session, step: "esperando_origen" });
          mensajeFaltante = "No encontré las ubicaciones en el mapa.\n📍 Envía tu origen con el pin de WhatsApp.";
        }
        await enviarMensaje(phone, mensajeFaltante);
        return;
      }

      origenCoords.nombre = origenCoords.nombre || ubicaciones.origen;
      destinoCoords.nombre = destinoCoords.nombre || ubicaciones.destino;

      await updateSession(phone, {
        ...session,
        origenPendiente: origenCoords,
        destinoPendiente: destinoCoords,
        step: "confirmando_ubicaciones_voz",
      });
      await enviarBotones(
        phone,
        `📍 *¿Confirmas estas ubicaciones?*\n\n🚀 Origen: ${ubicaciones.origen}\n🏁 Destino: ${ubicaciones.destino}`,
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

  // ─── Switch de steps ──────────────────────────────────────────────────────
  switch (session.step) {
    case "inicio": {
      const { botones, idsParaSession } = await construirBotonesHistorial(phone);
      if (botones.length > 0) {
        await updateSession(phone, { ...session, step: "eligiendo_historial", historial: idsParaSession });
        await enviarBotones(phone, `👋 ¡Hola de nuevo!\n\nElige una opción o envíame tu *ubicación de origen* 📍`, botones);
      } else {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(
          phone,
          "👋 ¡Hola! Bienvenido a *ChatGo*.\n\n" +
            "📍 Envía tu ubicación de origen usando el pin de WhatsApp.\n\n" +
            "También puedes:\n• Enviar un 🎤 audio de voz diciendo a dónde quieres ir\n• Compartir un link de 🗺️ Google Maps"
        );
      }
      break;
    }

    case "eligiendo_historial": {
      if (coords) {
        const origen = { ...coords };
        try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) origen.nombre = dir; } catch {}
        await updateSession(phone, { ...session, origen, step: "esperando_destino" });
        await enviarMensaje(phone, `✅ *Origen recibido:* ${origen.nombre || "tu ubicación actual"}\n\n🏁 Ahora envía tu *ubicación de destino* (a dónde quieres ir).`);
      } else {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(phone, "📍 Envía tu ubicación de origen con el pin de WhatsApp.");
      }
      break;
    }

    case "esperando_origen":
      if (!coords) {
        await enviarMensaje(phone, "📍 Estoy esperando tu *ubicación de origen* (de dónde te recogemos).\n\nUsa el 📎 adjunto → Ubicación, envía un 🎤 audio, o comparte un link de Google Maps.");
        break;
      }
      {
        const origen = { ...coords };
        try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) origen.nombre = dir; } catch {}
        await updateSession(phone, { ...session, origen, step: "esperando_destino" });
        await enviarMensaje(phone, `✅ *Origen recibido:* ${origen.nombre || "tu ubicación"}\n\n🏁 Ahora envía tu *ubicación de destino* (a dónde quieres ir).`);
      }
      break;

    case "esperando_origen_con_destino":
      if (!coords) {
        await enviarMensaje(phone, "📍 Estoy esperando tu ubicación de origen.\nUsa el 📎 adjunto → Ubicación.");
        break;
      }
      {
        const origen = { ...coords };
        try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) origen.nombre = dir; } catch {}
        const nuevaSession = { ...session, origen };
        await setSession(phone, nuevaSession);
        await preguntarOpcionesViaje(phone, nuevaSession);
      }
      break;

    case "esperando_destino":
      if (!coords) {
        await enviarMensaje(phone, "🏁 Estoy esperando tu *ubicación de destino* (a dónde quieres ir).\n\nUsa el 📎 adjunto → Ubicación, envía un 🎤 audio, o comparte un link de Google Maps.");
        break;
      }
      {
        // FIX BUG: guard contra origen = destino (causaba HVGC+HXJ = HVGC+HXJ)
        if (
          session.origen &&
          Math.abs(coords.lat - session.origen.lat) < 0.0001 &&
          Math.abs(coords.lng - session.origen.lng) < 0.0001
        ) {
          await enviarMensaje(phone, "⚠️ El destino que enviaste parece ser el mismo que el origen.\n\n🏁 Por favor envía el pin del lugar *al que quieres llegar*.");
          break;
        }

        const destino = { ...coords };
        try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) destino.nombre = dir; } catch {}
        const nuevaSession = { ...session, destino };
        await setSession(phone, nuevaSession);
        await preguntarOpcionesViaje(phone, nuevaSession);
      }
      break;

    case "confirmando_ubicaciones_voz":
      if (buttonId === "confirmar_ubicaciones") {
        const nuevaSession = { ...session, origen: session.origenPendiente, destino: session.destinoPendiente };
        delete nuevaSession.origenPendiente;
        delete nuevaSession.destinoPendiente;
        await preguntarOpcionesViaje(phone, nuevaSession);
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

    case "preguntando_opciones": {
      if (buttonId === "agregar_parada") {
        const numParadas = (session.paradas || []).length;
        if (numParadas >= CONFIG.MAX_PARADAS) {
          await enviarMensaje(phone, `⚠️ Ya tienes el máximo de ${CONFIG.MAX_PARADAS} paradas.`);
          await preguntarOpcionesViaje(phone, session);
          break;
        }
        await updateSession(phone, { ...session, step: "esperando_parada" });
        await enviarMensaje(phone, `🚏 Envía la *ubicación de tu parada* (con el pin de WhatsApp).\n\n_Parada ${numParadas + 1} de ${CONFIG.MAX_PARADAS}_`);
        break;
      }
      if (buttonId === "agregar_observacion") {
        await updateSession(phone, { ...session, step: "esperando_observacion" });
        await enviarMensaje(phone, `📝 *Cuéntame qué llevas o cualquier detalle.*\n\nEjemplos:\n• "Llevo mi perrito"\n• "Tengo equipaje grande"\n• "Voy con bebé"\n• "Soy persona mayor"\n\nEscribe en una sola respuesta.`);
        break;
      }
      if (buttonId === "ver_precio") { await procesarCalculoViaje(phone, session); break; }
      await preguntarOpcionesViaje(phone, session);
      break;
    }

    case "esperando_parada": {
      if (!coords) { await enviarMensaje(phone, "🚏 Envía la *ubicación de la parada* con el 📎 adjunto → Ubicación."); break; }
      const parada = { ...coords };
      try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) parada.nombre = dir; } catch {}
      const paradas = [...(session.paradas || []), parada];
      const nuevaSession = { ...session, paradas };
      await setSession(phone, nuevaSession);
      await enviarMensaje(phone, `✅ Parada ${paradas.length} guardada: ${parada.nombre || "ubicación"}`);
      await preguntarOpcionesViaje(phone, nuevaSession);
      break;
    }

    case "esperando_observacion": {
      if (!texto || texto.length < 2) { await enviarMensaje(phone, "📝 Escribe brevemente qué llevas o cualquier detalle del viaje."); break; }
      const obs = texto.slice(0, 200);
      const nuevaSession = { ...session, observaciones: obs };
      await setSession(phone, nuevaSession);
      await enviarMensaje(phone, `✅ Notas guardadas: _"${obs}"_`);
      await preguntarOpcionesViaje(phone, nuevaSession);
      break;
    }

    case "eligiendo_tipo_vehiculo": {
      let tipoElegido = null;
      if (buttonId === "elegir_auto" || /\b(AUTO|CARRO|COCHE|TAXI)\b/i.test(textoUpper)) tipoElegido = "auto";
      else if (buttonId === "elegir_moto" || /\b(MOTO|MOTOCICLETA)\b/i.test(textoUpper)) tipoElegido = "moto";

      if (buttonId === "cancelar_viaje" || textoUpper === "NO" || textoUpper === "CANCELAR") {
        await deleteSession(phone);
        await enviarMensaje(phone, "❌ Viaje cancelado.");
        break;
      }

      if (!tipoElegido) {
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

      if (tipoElegido === "moto" && session.observaciones) {
        const incomp = detectarIncompatibilidadMoto(session.observaciones);
        if (incomp && incomp.incompatible) {
          await updateSession(phone, { ...session, step: "confirmando_moto_incompatible", tipoTentativo: "moto" });
          await enviarBotones(
            phone,
            `⚠️ *Atención*\n\nMencionaste *${incomp.razon}* en tus notas. La moto puede no ser ideal para esto.\n\n¿Qué prefieres?`,
            [
              { id: "cambiar_a_auto", title: "🚗 Cambiar a auto" },
              { id: "moto_de_todas_formas", title: "🏍️ Moto igual" },
              { id: "cancelar_viaje", title: "❌ Cancelar" },
            ]
          );
          break;
        }
      }

      const precioFinal = tipoElegido === "moto" ? session.precioMoto : session.precioAuto;
      const precioPorKmFinal = tipoElegido === "moto" ? session.precioPorKmMoto : session.precioPorKmAuto;
      const sessionConTipo = { ...session, tipoVehiculoSolicitado: tipoElegido, precioBase: precioFinal, precio: precioFinal, precioPorKm: precioPorKmFinal, step: "ofreciendo_codigo" };
      await setSession(phone, sessionConTipo);

      const emojiT = tipoElegido === "moto" ? "🏍️" : "🚗";
      await enviarBotones(
        phone,
        `${emojiT} Elegiste *${tipoElegido.toUpperCase()}*\n💰 Precio: Bs ${precioFinal}\n\n¿Tienes un código de descuento?`,
        [
          { id: "tengo_codigo", title: "🎁 Tengo código" },
          { id: "sin_codigo", title: "💰 Confirmar sin código" },
          { id: "cancelar_viaje", title: "❌ Cancelar" },
        ]
      );
      break;
    }

    case "confirmando_moto_incompatible": {
      if (buttonId === "cambiar_a_auto") {
        const s = { ...session, tipoVehiculoSolicitado: "auto", precioBase: session.precioAuto, precio: session.precioAuto, precioPorKm: session.precioPorKmAuto, step: "ofreciendo_codigo" };
        delete s.tipoTentativo;
        await setSession(phone, s);
        await enviarBotones(phone, `🚗 Cambiamos a auto.\n💰 Precio: Bs ${session.precioAuto}\n\n¿Tienes un código de descuento?`, [
          { id: "tengo_codigo", title: "🎁 Tengo código" },
          { id: "sin_codigo", title: "💰 Confirmar sin código" },
          { id: "cancelar_viaje", title: "❌ Cancelar" },
        ]);
        break;
      }
      if (buttonId === "moto_de_todas_formas") {
        const s = { ...session, tipoVehiculoSolicitado: "moto", precioBase: session.precioMoto, precio: session.precioMoto, precioPorKm: session.precioPorKmMoto, step: "ofreciendo_codigo" };
        delete s.tipoTentativo;
        await setSession(phone, s);
        await enviarBotones(phone, `🏍️ Continuamos con moto.\n💰 Precio: Bs ${session.precioMoto}\n\n¿Tienes un código de descuento?`, [
          { id: "tengo_codigo", title: "🎁 Tengo código" },
          { id: "sin_codigo", title: "💰 Confirmar sin código" },
          { id: "cancelar_viaje", title: "❌ Cancelar" },
        ]);
        break;
      }
      if (buttonId === "cancelar_viaje") { await deleteSession(phone); await enviarMensaje(phone, "❌ Viaje cancelado."); break; }
      await enviarBotones(phone, "¿Qué prefieres?", [
        { id: "cambiar_a_auto", title: "🚗 Cambiar a auto" },
        { id: "moto_de_todas_formas", title: "🏍️ Moto igual" },
        { id: "cancelar_viaje", title: "❌ Cancelar" },
      ]);
      break;
    }

    case "ofreciendo_codigo": {
      if (buttonId === "tengo_codigo") {
        await updateSession(phone, { ...session, step: "esperando_codigo" });
        await enviarMensaje(phone, `🎁 Escribe tu código (ej: CHATGO-AB12CD).\n\n_Recuerda: 40% de descuento, válido 15 días, uso único._`);
        break;
      }
      if (buttonId === "sin_codigo") {
        const tipoBuscar = session.tipoVehiculoSolicitado;
        const emoji = tipoBuscar === "moto" ? "🏍️" : "🚗";
        const labelTipo = tipoBuscar === "moto" ? "moto" : "auto";
        await updateSession(phone, { ...session, step: "confirmado" });
        await enviarMensaje(phone, `${emoji} Buscando ${labelTipo} disponible...\n💰 Precio: Bs ${session.precio}`);
        await asignarChofer(phone, session);
        break;
      }
      if (buttonId === "cancelar_viaje") { await deleteSession(phone); await enviarMensaje(phone, "❌ Viaje cancelado."); break; }
      await enviarBotones(phone, "¿Tienes un código de descuento?", [
        { id: "tengo_codigo", title: "🎁 Tengo código" },
        { id: "sin_codigo", title: "💰 Confirmar sin código" },
        { id: "cancelar_viaje", title: "❌ Cancelar" },
      ]);
      break;
    }

    case "esperando_codigo": {
      if (buttonId === "cancelar_viaje") { await deleteSession(phone); await enviarMensaje(phone, "❌ Viaje cancelado."); break; }
      if (!texto || texto.length < 4) { await enviarMensaje(phone, "🎁 Escribe el código completo (ej: CHATGO-AB12CD)"); break; }
      const validacion = await validarCodigoPromo(texto, session.precioBase || session.precio);
      if (!validacion.valido) {
        await enviarBotones(phone, `❌ ${validacion.motivo}\n\n¿Quieres intentar con otro código o continuar sin código?`, [
          { id: "tengo_codigo", title: "🎁 Otro código" },
          { id: "sin_codigo", title: "💰 Sin código" },
          { id: "cancelar_viaje", title: "❌ Cancelar" },
        ]);
        await updateSession(phone, { ...session, step: "ofreciendo_codigo" });
        break;
      }
      const sessionConDesc = {
        ...session,
        codigoPromoUsado: validacion.codigoDoc.codigo,
        codigoPromoDocId: String(validacion.codigoDoc._id),
        descuentoBs: validacion.descuento,
        precio: validacion.nuevoPrecio,
        step: "confirmado",
      };
      await setSession(phone, sessionConDesc);
      const emojiT2 = session.tipoVehiculoSolicitado === "moto" ? "🏍️" : "🚗";
      const labelTipo2 = session.tipoVehiculoSolicitado === "moto" ? "moto" : "auto";
      await enviarMensaje(
        phone,
        `🎁 *Código aplicado!*\n\nPrecio original: Bs ${session.precioBase}\nDescuento (${validacion.porcentaje}%): -Bs ${validacion.descuento}\n*Total a pagar: Bs ${validacion.nuevoPrecio}*\n\n${emojiT2} Buscando ${labelTipo2} disponible...`
      );
      await asignarChofer(phone, sessionConDesc);
      break;
    }

    case "esperando_confirmacion":
      await procesarCalculoViaje(phone, session);
      break;

    case "sin_chofer":
      if (buttonId === "confirmar_viaje_recordatorio") {
        const espera = await ListaEspera.findOne({ userPhone: phone });
        await removeListaEspera(phone);
        await enviarMensaje(phone, "✅ Perfecto! Asignando tu chofer...");
        const sessionConDatos = {
          ...session,
          origen: espera?.origen || session.origen,
          destino: espera?.destino || session.destino,
          distancia: espera?.distancia || session.distancia,
          precio: espera?.precio || session.precio,
          precioPorKm: espera?.precioPorKm || session.precioPorKm,
        };
        await setSession(phone, sessionConDatos);
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
      if (!buttonId) await enviarMensaje(phone, "⏳ Ya estamos buscando tu chofer...");
      break;

    case "chofer_en_camino":
    case "chofer_esperando_pasajero":
    case "en_curso": {
      const viajeActivo = await Viaje.findOne({
        usuarioPhone: phone,
        estado: { $in: ["en_camino","esperando_pasajero","en_curso"] },
      });

      if (!viajeActivo) {
        await deleteSession(phone);
        await setSession(phone, { step: "inicio" });
        await enviarMensaje(phone, "🤔 No encontré tu viaje activo. Escribe *HOLA* para empezar de nuevo.");
        break;
      }

      if (buttonId === "cancelar_viaje_pasajero") {
        await Viaje.findByIdAndUpdate(viajeActivo._id, { estado: "cancelado", fechaFin: new Date(), cancelacionMotivo: "cancelado_por_pasajero" });
        await Chofer.findOneAndUpdate({ wialonId: viajeActivo.choferWialonId }, { $set: { estado: "libre", viajeReservado: null, reservadoHasta: null } });
        await enviarMensaje(viajeActivo.choferPhone, `❌ El pasajero canceló el viaje.`);
        await deleteSession(phone);
        await enviarMensaje(phone, "❌ Viaje cancelado. Escribe cuando necesites otro taxi 🚖");
        break;
      }

      // Chat multimedia hacia el chofer
      const reenviado = await relayMensajeChat(phone, viajeActivo.choferPhone, mensaje, "tu pasajero");
      if (reenviado) { await enviarMensaje(phone, "✅ Enviado al chofer"); break; }

      const guias = {
        chofer_en_camino: `🚖 Tu chofer va en camino.\n\nPuedes escribirle, mandarle audio, foto o ubicación por aquí 💬`,
        chofer_esperando_pasajero: `🚕 Tu chofer ya llegó. Dirígete al vehículo.\n\nSi quieres mandarle algo, escríbelo aquí 💬`,
        en_curso: `🚖 Tu viaje está en curso. ¡Disfrútalo!\n\nSi necesitas decirle algo al chofer, envíalo aquí 💬`,
      };
      await enviarMensaje(phone, guias[session.step] || "Tu viaje está activo.");
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
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === CONFIG.VERIFY_TOKEN) {
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
        // FIX BUG#9 — deduplicar por msg.id (WhatsApp puede entregar el mismo mensaje dos veces)
        if (msg.id && yaProcesoMensaje(msg.id)) {
          log.warn(`[WEBHOOK] Mensaje duplicado ignorado: ${msg.id}`);
          continue;
        }

        const phone = msg.from;
        const buttonId = msg.interactive?.button_reply?.id || null;
        const textoUpper = msg.text?.body?.trim().toUpperCase() || "";
        const mediaId = msg.image?.id || null;

        log.info(`[WEBHOOK] From: ${phone}, Type: ${msg.type}, Text: "${msg.text?.body || ""}", Button: ${buttonId || "-"}`);

        const dentroLimite = await checkRateLimit(phone);
        if (!dentroLimite) { log.warn(`[WEBHOOK] Rate limit excedido para ${phone}`); continue; }

        // Admin approvals
        if (buttonId && (buttonId.startsWith("aprobar_pago_") || buttonId.startsWith("rechazar_pago_"))) {
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
              { "pagoDiario.aprobado": true, "pagoDiario.fecha": new Date(), "pagoDiario.fechaStr": fechaStrBolivia(), estado: "libre" }
            );
            await enviarBotones(choferPhone, `✅ *Pago confirmado!*\n🚖 Ya estás LIBRE para recibir viajes.`, [
              { id: "chofer_ocupado", title: "🔴 Ocupado" },
              { id: "chofer_ayuda", title: "❓ Ayuda" },
            ]);
            await enviarMensaje(phone, `✅ Pago aprobado para +${choferPhone}`);
          } else {
            await Chofer.findOneAndUpdate({ phone: choferPhone }, { "pagoDiario.pagado": false, "pagoDiario.aprobado": false, estado: "offline" });
            await enviarMensaje(choferPhone, `❌ Tu comprobante de pago fue rechazado. Contacta al admin: +591 62741818`);
            await enviarMensaje(phone, `❌ Pago rechazado para +${choferPhone}`);
          }
          continue;
        }

        // FIX BUG#8 — routing chofer/pasajero mejorado
        // Solo redirigir a flujo chofer si está registrado como chofer en BD,
        // o si su sesión activa es de chofer, o si escribió la palabra clave ESTANDO sin sesión activa.
        const esChofer = await Chofer.exists({ phone });
        const session = await getSession(phone);

        // Un pasajero con sesión activa NO debe ser re-ruteado por palabras clave de chofer
        const sesionEsPasajero = session && session.step && !session.step.startsWith("chofer_") && session.step !== "eligiendo_rol";
        const esRegistroChofer =
          !sesionEsPasajero && (
            textoUpper === "CHOFER" ||
            textoUpper === "SOY CHOFER" ||
            textoUpper === "CONDUCTOR" ||
            (session && session.step?.startsWith("chofer_"))
          );

        if (esChofer || esRegistroChofer) {
          await procesarMensajeChofer(phone, msg.text?.body || "", buttonId, mediaId, msg);
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
          spec: { itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
          force: 1, flags: 4294967295, from: 0, to: 0,
        }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (!resp.data.items) return res.json({ error: "No se encontraron unidades", raw: resp.data });
    const unidades = resp.data.items.map(u => ({
      id: u.id,
      nombre: u.nm,
      uid: u.uid || u.uid2 || "",
      ultimaPos: u.pos ? { lat: u.pos.y, lng: u.pos.x, hace_min: Math.round((Date.now() / 1000 - (u.pos.t || 0)) / 60) } : null,
    }));
    res.json({ total: unidades.length, unidades });
  } catch (e) { res.json({ error: e.message }); }
});

app.get("/stats", async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const [usuarios, choferes, choferesLibres, choferesPagados, viajesHoy, viajesActivos, ratingPromedio] = await Promise.all([
      Usuario.countDocuments(),
      Chofer.countDocuments(),
      Chofer.countDocuments({ estado: "libre" }),
      Chofer.countDocuments({ "pagoDiario.aprobado": true, "pagoDiario.fechaStr": hoyStr }),
      Viaje.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }),
      Viaje.countDocuments({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }),
      Viaje.aggregate([{ $match: { ratingPasajero: { $exists: true } } }, { $group: { _id: null, avg: { $avg: "$ratingPasajero" }, count: { $sum: 1 } } }]),
    ]);
    res.json({ hoy: hoyStr, usuarios, choferes, choferesLibres, choferesPagadosHoy: choferesPagados, viajesUltimas24h: viajesHoy, viajesActivos, rating: ratingPromedio[0] ? { promedio: Math.round(ratingPromedio[0].avg * 10) / 10, cantidad: ratingPromedio[0].count } : null });
  } catch (e) { res.json({ error: e.message }); }
});

// Endpoint para ver referencias de voz (debug/admin)
app.get("/admin/referencias-voz", async (req, res) => {
  try {
    const refs = await LocationReference.find().sort({ contador: -1 }).limit(100).lean();
    res.json({ total: refs.length, referencias: refs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Endpoint público para verificar estado de la promo
app.get("/promo", (req, res) => {
  const activa = enPromoGratis();
  const hoy = fechaStrBolivia();
  res.json({
    promoActiva: activa,
    fechaHoy: hoy,
    fechaFin: CONFIG.PROMO_GRATIS_HASTA,
    fechaFinLegible: formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA),
    mensaje: activa
      ? `🎉 Promo gratis activa hasta el ${formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA)}.`
      : `💰 Promo terminada. Cobro normal de Bs 10/día activado.`,
  });
});

app.get("/admin/viaje/:id", async (req, res) => {
  try {
    const viaje = await Viaje.findById(req.params.id).lean();
    if (!viaje) { res.status(404).send("<h1>Viaje no encontrado</h1>"); return; }

    let posChofer = null, posError = null;
    if (viaje.choferWialonId) {
      try { const p = await obtenerUbicacionChofer(viaje.choferWialonId); posChofer = { lat: p.lat, lng: p.lng, hace_min: p.minutos }; }
      catch (e) { posError = e.message; }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viaje · ChatGo</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,sans-serif;background:#0f1419;color:#e6e6e6;}.header{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;}.header h1{font-size:16px;color:#00d97e;}.back{color:#58a6ff;text-decoration:none;font-size:13px;}.info{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;}.info-label{color:#8b949e;font-size:10px;text-transform:uppercase;}.info-value{font-size:14px;margin-top:2px;}.estado{padding:2px 8px;border-radius:10px;font-size:11px;display:inline-block;}.estado-en_curso{background:#0d3d20;color:#3fb950;}.estado-completado{background:#0d3d20;color:#3fb950;}.estado-pendiente,.estado-esperando_pasajero{background:#3d2c0d;color:#d29922;}.estado-en_camino{background:#0d2c3d;color:#58a6ff;}.estado-cancelado,.estado-cancelado_pasajero,.estado-cancelado_chofer{background:#3d0d0d;color:#f85149;}#map{height:calc(100vh - 200px);width:100%;}.leyenda{position:absolute;bottom:10px;left:10px;background:rgba(22,27,34,.95);padding:10px;border-radius:8px;border:1px solid #30363d;font-size:12px;z-index:1000;}.leyenda div{margin:3px 0;}.mi{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:6px;vertical-align:middle;}</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/></head>
<body>
<div class="header"><a href="/admin" class="back">← Volver al panel</a><h1>🚖 Viaje #${String(viaje._id).slice(-6).toUpperCase()}</h1><button onclick="location.reload()" style="background:#1f6feb;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🔄 Actualizar</button></div>
<div class="info">
  <div><div class="info-label">Estado</div><div class="info-value"><span class="estado estado-${viaje.estado}">${viaje.estado.toUpperCase()}</span></div></div>
  <div><div class="info-label">Pasajero</div><div class="info-value">+${viaje.usuarioPhone||"—"}</div></div>
  <div><div class="info-label">Chofer</div><div class="info-value">${viaje.choferNombre||"—"}<br><small style="color:#8b949e">${viaje.choferPlaca||""} · ${viaje.tipoVehiculo==="moto"?"🏍️ Moto":"🚗 Auto"}</small></div></div>
  <div><div class="info-label">Distancia</div><div class="info-value">${viaje.distanciaKm||"—"} km</div></div>
  <div><div class="info-label">Precio</div><div class="info-value">Bs ${viaje.precioTotal||"—"}${viaje.descuentoBs>0?' <small style="color:#3fb950">(-Bs '+viaje.descuentoBs+')</small>':""}</div></div>
  ${posChofer?`<div><div class="info-label">GPS Chofer</div><div class="info-value" style="color:${posChofer.hace_min<=5?"#3fb950":posChofer.hace_min<=15?"#d29922":"#f85149"}">📡 ${posChofer.hace_min} min</div></div>`:""}
  ${viaje.observaciones?`<div style="grid-column:span 2"><div class="info-label">📝 Observaciones</div><div class="info-value">${viaje.observaciones}</div></div>`:""}
</div>
<div id="map"></div>
<div class="leyenda">
  <div><span class="mi" style="background:#3fb950"></span>Origen</div>
  ${(viaje.paradas||[]).length>0?'<div><span class="mi" style="background:#d29922"></span>Paradas</div>':""}
  <div><span class="mi" style="background:#f85149"></span>Destino</div>
  ${posChofer?'<div><span class="mi" style="background:#58a6ff"></span>Chofer ahora</div>':""}
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const viaje=${JSON.stringify({origen:viaje.origen,paradas:viaje.paradas||[],destino:viaje.destino,posChofer,estado:viaje.estado})};
const puntos=[viaje.origen,...viaje.paradas,viaje.destino].filter(p=>p&&p.lat);
if(viaje.posChofer)puntos.push(viaje.posChofer);
const cLat=puntos.reduce((s,p)=>s+p.lat,0)/puntos.length;
const cLng=puntos.reduce((s,p)=>s+p.lng,0)/puntos.length;
const map=L.map('map').setView([cLat,cLng],14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
function mkIcon(color,label){return L.divIcon({html:'<div style="background:'+color+';width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;"><span style="transform:rotate(45deg)">'+label+'</span></div>',iconSize:[30,30],iconAnchor:[15,30],className:''});}
if(viaje.origen?.lat)L.marker([viaje.origen.lat,viaje.origen.lng],{icon:mkIcon('#3fb950','A')}).addTo(map).bindPopup('<b>📍 Origen</b><br>'+(viaje.origen.nombre||''));
viaje.paradas.forEach((p,i)=>L.marker([p.lat,p.lng],{icon:mkIcon('#d29922',String(i+1))}).addTo(map).bindPopup('<b>🚏 Parada '+(i+1)+'</b><br>'+(p.nombre||'')));
if(viaje.destino?.lat)L.marker([viaje.destino.lat,viaje.destino.lng],{icon:mkIcon('#f85149','B')}).addTo(map).bindPopup('<b>🏁 Destino</b><br>'+(viaje.destino.nombre||''));
if(viaje.posChofer){const ci=L.divIcon({html:'<div style="background:#58a6ff;width:36px;height:36px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:18px;">🚖</div>',iconSize:[36,36],iconAnchor:[18,18],className:''});L.marker([viaje.posChofer.lat,viaje.posChofer.lng],{icon:ci}).addTo(map).bindPopup('<b>🚖 Chofer ahora</b><br>Hace '+viaje.posChofer.hace_min+' min');}
const ruta=[];if(viaje.origen?.lat)ruta.push([viaje.origen.lat,viaje.origen.lng]);viaje.paradas.forEach(p=>ruta.push([p.lat,p.lng]));if(viaje.destino?.lat)ruta.push([viaje.destino.lat,viaje.destino.lng]);
if(ruta.length>=2)L.polyline(ruta,{color:'#58a6ff',weight:4,opacity:.7,dashArray:'8,8'}).addTo(map);
if(viaje.posChofer){const np=viaje.estado==='en_curso'&&viaje.destino?.lat?[viaje.destino.lat,viaje.destino.lng]:viaje.origen?.lat?[viaje.origen.lat,viaje.origen.lng]:null;if(np)L.polyline([[viaje.posChofer.lat,viaje.posChofer.lng],np],{color:'#3fb950',weight:3,opacity:.8}).addTo(map);}
const g=L.featureGroup();puntos.forEach(p=>g.addLayer(L.marker([p.lat,p.lng])));if(puntos.length>1)map.fitBounds(g.getBounds(),{padding:[50,50]});
if(['pendiente','en_camino','esperando_pasajero','en_curso'].includes(viaje.estado))setTimeout(()=>location.reload(),30000);
</script></body></html>`);
  } catch (e) { log.error("[ADMIN_VIAJE]", e.message); res.status(500).send("Error: " + e.message); }
});

app.get("/admin/mapa", async (req, res) => {
  try {
    const choferes = await Chofer.find().lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      if (!c.wialonId) return null;
      try { const p = await obtenerUbicacionChofer(c.wialonId); return { phone: c.phone, nombre: c.nombre, placa: c.placa, tipoVehiculo: c.tipoVehiculo||"auto", estado: c.estado, wialonId: c.wialonId, lat: p.lat, lng: p.lng, hace_min: p.minutos }; }
      catch { return null; }
    }));
    const validos = choferesConPos.filter(Boolean);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mapa Choferes · ChatGo</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,sans-serif;background:#0f1419;color:#e6e6e6;}.header{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;}.header h1{font-size:16px;color:#00d97e;}.header a{color:#58a6ff;text-decoration:none;font-size:13px;}.stats{display:flex;gap:14px;font-size:12px;}.stats span{color:#8b949e;}#map{height:calc(100vh - 60px);width:100%;}.leyenda{position:absolute;bottom:10px;left:10px;background:rgba(22,27,34,.95);padding:10px;border-radius:8px;border:1px solid #30363d;font-size:12px;z-index:1000;}</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/></head>
<body><div class="header"><a href="/admin">← Panel</a><h1>🗺️ Mapa de choferes en vivo</h1><div class="stats"><span>🟢 Libres: ${validos.filter(c=>c.estado==="libre").length}</span><span>🟡 Ocupados: ${validos.filter(c=>c.estado==="ocupado").length}</span><span>🔴 Offline: ${validos.filter(c=>c.estado==="offline").length}</span></div></div>
<div id="map"></div>
<div class="leyenda"><div>🟢 Libre</div><div>🟡 Ocupado</div><div>🔴 Offline</div><div style="margin-top:6px;color:#8b949e;font-size:11px">Auto-refresh: 30s</div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const choferes=${JSON.stringify(validos)};
let cLat=-17.39,cLng=-66.157;
if(choferes.length>0){cLat=choferes.reduce((s,c)=>s+c.lat,0)/choferes.length;cLng=choferes.reduce((s,c)=>s+c.lng,0)/choferes.length;}
const map=L.map('map').setView([cLat,cLng],13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
function colorE(e){return e==='libre'?'#3fb950':e==='ocupado'?'#d29922':'#f85149';}
function iconC(c){const color=colorE(c.estado);const em=c.tipoVehiculo==='moto'?'🏍️':'🚗';return L.divIcon({html:'<div style="background:'+color+';width:36px;height:36px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:16px;">'+em+'</div>',iconSize:[36,36],iconAnchor:[18,18],className:''});}
choferes.forEach(c=>L.marker([c.lat,c.lng],{icon:iconC(c)}).addTo(map).bindPopup('<b>'+(c.nombre||'Sin nombre')+'</b><br>Placa: '+(c.placa||'—')+'<br>'+(c.tipoVehiculo==='moto'?'🏍️ Moto':'🚗 Auto')+'<br>Estado: '+c.estado.toUpperCase()+'<br>GPS: hace '+c.hace_min+' min<br>Tel: +'+c.phone));
if(choferes.length>1){const g=L.featureGroup(choferes.map(c=>L.marker([c.lat,c.lng])));map.fitBounds(g.getBounds(),{padding:[50,50]});}
setTimeout(()=>location.reload(),30000);
</script></body></html>`);
  } catch (e) { log.error("[ADMIN_MAPA]", e.message); res.status(500).send("Error: " + e.message); }
});

app.get("/admin/mapa-data", async (req, res) => {
  try {
    const choferes = await Chofer.find().lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      if (!c.wialonId) return null;
      try { const pos = await obtenerUbicacionChofer(c.wialonId); if (pos.minutos > 30) return null; return { phone: c.phone, nombre: c.nombre||"—", placa: c.placa||"—", tipoVehiculo: c.tipoVehiculo||"auto", estado: c.estado||"offline", wialonId: c.wialonId, lat: pos.lat, lng: pos.lng, hace_min: pos.minutos, ratingPromedio: c.ratingPromedio||0, viajesTotal: c.viajesTotal||0 }; }
      catch { return null; }
    }));
    const viajesActivos = await Viaje.find({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }).lean();
    res.json({ timestamp: new Date().toISOString(), choferes: choferesConPos.filter(Boolean), viajesActivos });
  } catch (e) { log.error("[MAPA_DATA]", e.message); res.status(500).json({ error: e.message }); }
});

app.get("/admin/data", async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const ahora = Date.now();
    const choferes = await Chofer.find().sort({ updatedAt: -1 }).lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      let pos = null, posError = null;
      if (c.wialonId) { try { const p = await obtenerUbicacionChofer(c.wialonId); pos = { lat: p.lat, lng: p.lng, hace_min: p.minutos, wialonOk: true }; } catch (e) { posError = e.message; } }
      const pagoAlDia = !!(c.pagoDiario?.aprobado && c.pagoDiario?.fechaStr === hoyStr);
      return { _id: c._id, phone: c.phone, nombre: c.nombre||"", placa: c.placa||"", tipoVehiculo: c.tipoVehiculo||"auto", wialonId: c.wialonId||"", estado: c.estado||"offline", viajesTotal: c.viajesTotal||0, ratingPromedio: c.ratingPromedio||0, ratingCantidad: c.ratingCantidad||0, pagoDiario: c.pagoDiario||{}, pagoAlDia, viajeReservado: c.viajeReservado, ultimaPos: pos, posError };
    }));
    const viajesActivos = await Viaje.find({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }).sort({ createdAt: -1 }).lean();
    const viajesRecientes = await Viaje.find().sort({ createdAt: -1 }).limit(20).lean();
    const listaEspera = await ListaEspera.find().lean();
    const [totalUsuarios, usuariosNuevosHoy, viajes24h, viajesCompletados24h, ratingAgg, codigosActivos, codigosUsados] = await Promise.all([
      Usuario.countDocuments(),
      Usuario.countDocuments({ createdAt: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.countDocuments({ createdAt: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.countDocuments({ estado: "completado", fechaFin: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.aggregate([{ $match: { ratingPasajero: { $exists: true } } }, { $group: { _id: null, avg: { $avg: "$ratingPasajero" }, count: { $sum: 1 } } }]),
      CodigoPromo.countDocuments({ usado: false, fechaVencimiento: { $gt: new Date() } }),
      CodigoPromo.countDocuments({ usado: true }),
    ]);
    res.json({
      timestamp: new Date().toISOString(),
      hoy: hoyStr,
      stats: { totalUsuarios, usuariosNuevosHoy, viajes24h, viajesCompletados24h, rating: ratingAgg[0] ? { promedio: Math.round(ratingAgg[0].avg * 10) / 10, cantidad: ratingAgg[0].count } : null, codigosActivos, codigosUsados, choferesTotal: choferes.length, choferesLibres: choferesConPos.filter(c=>c.estado==="libre").length, choferesOcupados: choferesConPos.filter(c=>c.estado==="ocupado").length, choferesOffline: choferesConPos.filter(c=>c.estado==="offline").length, choferesPagadosHoy: choferesConPos.filter(c=>c.pagoAlDia).length, choferesConGPSReciente: choferesConPos.filter(c=>c.ultimaPos&&c.ultimaPos.hace_min<=15).length, viajesActivos: viajesActivos.length, enListaEspera: listaEspera.length },
      choferes: choferesConPos, viajesActivos, viajesRecientes, listaEspera,
      promo: { viajesActiva: enPromoGratis(), viajesFin: CONFIG.PROMO_GRATIS_HASTA, codigosActiva: promoCodigosActiva(), codigosFin: CONFIG.PROMO_CODIGOS_HASTA },
    });
  } catch (e) { log.error("[ADMIN_DATA]", e.message); res.status(500).json({ error: e.message }); }
});

app.get("/admin", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGo Admin · RastreoPlus</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1419;color:#e6e6e6;padding:14px;font-size:14px;}h1{color:#00d97e;font-size:22px;margin-bottom:4px;}.subtitle{color:#8b949e;margin-bottom:16px;font-size:12px;}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px;}.btn{padding:6px 12px;background:#1f6feb;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;}.btn:hover{background:#388bfd;}.btn.muted{background:#30363d;}.updated{color:#8b949e;font-size:11px;}.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:18px;}.stat{background:#161b22;padding:10px 12px;border-radius:8px;border:1px solid #30363d;}.stat-label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}.stat-value{font-size:22px;font-weight:bold;margin-top:4px;}.stat-value.green{color:#3fb950;}.stat-value.yellow{color:#d29922;}.stat-value.red{color:#f85149;}.stat-value.blue{color:#58a6ff;}.section{background:#161b22;padding:14px;border-radius:8px;border:1px solid #30363d;margin-bottom:14px;}.section h2{font-size:15px;color:#58a6ff;margin-bottom:10px;display:flex;align-items:center;gap:8px;}.badge{padding:2px 8px;background:#30363d;border-radius:10px;font-size:11px;color:#8b949e;}table{width:100%;border-collapse:collapse;font-size:12px;}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #21262d;}th{color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.5px;}tr:hover{background:#0d1117;}.estado{padding:2px 8px;border-radius:10px;font-size:11px;display:inline-block;}.estado-libre{background:#0d3d20;color:#3fb950;}.estado-ocupado{background:#3d2c0d;color:#d29922;}.estado-offline{background:#3d0d0d;color:#f85149;}.gps-ok{color:#3fb950;}.gps-old{color:#d29922;}.gps-no{color:#f85149;}.pago-ok{color:#3fb950;}.pago-no{color:#f85149;}.vehiculo-auto{color:#58a6ff;}.vehiculo-moto{color:#d29922;}a.maplink{color:#58a6ff;text-decoration:none;}a.maplink:hover{text-decoration:underline;}.empty{color:#8b949e;font-style:italic;text-align:center;padding:18px;}.loading{text-align:center;color:#8b949e;padding:40px;}.filter{padding:4px 8px;background:#0d1117;border:1px solid #30363d;color:#e6e6e6;border-radius:4px;font-size:12px;}.truncate{max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}@media (max-width:768px){body{padding:8px;font-size:13px;}.stats-grid{grid-template-columns:repeat(2,1fr);}table{font-size:11px;}th,td{padding:6px 4px;}}</style>
</head><body>
<h1>🚖 ChatGo Admin</h1>
<div class="subtitle">RastreoPlus · Cochabamba · v4 FIXED</div>
<div class="toolbar">
  <button class="btn" onclick="cargar()">🔄 Actualizar</button>
  <button class="btn muted" id="btnAuto">▶️ Auto-refresh OFF</button>
  <a href="/admin/mapa" class="btn" style="text-decoration:none;background:#0d3d20;">🗺️ Mapa choferes</a>
  <span class="updated" id="updated">Cargando...</span>
</div>
<div id="content"><div class="loading">⏳ Cargando datos...</div></div>
<script>
let autoRefresh=false,intervaloRefresh=null;
document.getElementById("btnAuto").onclick=()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("btnAuto");if(autoRefresh){btn.textContent="⏸️ Auto-refresh ON (15s)";btn.style.background="#0d3d20";intervaloRefresh=setInterval(cargar,15000);}else{btn.textContent="▶️ Auto-refresh OFF";btn.style.background="#30363d";if(intervaloRefresh)clearInterval(intervaloRefresh);}};
function fmtHora(d){if(!d)return"—";return new Date(d).toLocaleString("es-BO",{timeZone:"America/La_Paz",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});}
function fmtTel(p){return p?"+"+p:"—";}
function gpsBadge(pos){if(!pos)return'<span class="gps-no">❌ Sin GPS</span>';if(pos.hace_min<=5)return'<span class="gps-ok">📡 '+pos.hace_min+'min</span>';if(pos.hace_min<=15)return'<span class="gps-old">⚠️ '+pos.hace_min+'min</span>';return'<span class="gps-no">🔴 '+pos.hace_min+'min</span>';}
function estadoBadge(estado){return'<span class="estado estado-'+estado+'">'+estado.toUpperCase()+'</span>';}
function tipoVehBadge(t){const e=t==="moto"?"🏍️":"🚗";return'<span class="vehiculo-'+t+'">'+e+' '+t.toUpperCase()+'</span>';}
function pagoBadge(c){if(c.pagoAlDia)return'<span class="pago-ok">✅ Pagado hoy</span>';if(c.pagoDiario?.pagado&&!c.pagoDiario?.aprobado)return'<span class="gps-old">⏳ Pendiente</span>';return'<span class="pago-no">❌ Sin pago</span>';}
async function cargar(){try{const r=await fetch("/admin/data");const d=await r.json();if(d.error){document.getElementById("content").innerHTML='<div class="section">❌ Error: '+d.error+'</div>';return;}renderizar(d);document.getElementById("updated").textContent="Actualizado: "+new Date().toLocaleTimeString("es-BO");}catch(e){document.getElementById("content").innerHTML='<div class="section">❌ Error de red: '+e.message+'</div>';}}
function renderizar(d){const s=d.stats;let html='';
html+='<div class="stats-grid">';
html+='<div class="stat"><div class="stat-label">Choferes</div><div class="stat-value blue">'+s.choferesTotal+'</div></div>';
html+='<div class="stat"><div class="stat-label">🟢 Libres</div><div class="stat-value green">'+s.choferesLibres+'</div></div>';
html+='<div class="stat"><div class="stat-label">🟡 Ocupados</div><div class="stat-value yellow">'+s.choferesOcupados+'</div></div>';
html+='<div class="stat"><div class="stat-label">🔴 Offline</div><div class="stat-value red">'+s.choferesOffline+'</div></div>';
html+='<div class="stat"><div class="stat-label">📡 GPS reciente</div><div class="stat-value blue">'+s.choferesConGPSReciente+'</div></div>';
html+='<div class="stat"><div class="stat-label">💰 Pagados hoy</div><div class="stat-value green">'+s.choferesPagadosHoy+'</div></div>';
html+='<div class="stat"><div class="stat-label">🚖 Activos</div><div class="stat-value yellow">'+s.viajesActivos+'</div></div>';
html+='<div class="stat"><div class="stat-label">⏳ En espera</div><div class="stat-value yellow">'+s.enListaEspera+'</div></div>';
html+='<div class="stat"><div class="stat-label">Usuarios</div><div class="stat-value blue">'+s.totalUsuarios+'</div></div>';
html+='<div class="stat"><div class="stat-label">+ Hoy</div><div class="stat-value green">'+s.usuariosNuevosHoy+'</div></div>';
html+='<div class="stat"><div class="stat-label">Viajes 24h</div><div class="stat-value blue">'+s.viajes24h+'</div></div>';
html+='<div class="stat"><div class="stat-label">✅ Completados</div><div class="stat-value green">'+s.viajesCompletados24h+'</div></div>';
if(s.rating)html+='<div class="stat"><div class="stat-label">⭐ Rating</div><div class="stat-value yellow">'+s.rating.promedio+' <span style="font-size:11px;color:#8b949e">('+s.rating.cantidad+')</span></div></div>';
html+='<div class="stat"><div class="stat-label">🎁 Códigos</div><div class="stat-value green">'+s.codigosActivos+'</div></div>';
html+='</div>';
html+='<div class="section"><h2>👥 Choferes <span class="badge">'+d.choferes.length+'</span> <select class="filter" id="filtroChofer" onchange="filtrarChoferes()"><option value="todos">Todos</option><option value="libre">Libres</option><option value="ocupado">Ocupados</option><option value="offline">Offline</option><option value="con-gps">Con GPS</option><option value="sin-gps">Sin GPS</option><option value="pagado">Pagados</option><option value="impago">Sin pagar</option></select></h2>';
if(d.choferes.length===0){html+='<div class="empty">No hay choferes registrados.</div>';}else{html+='<div style="overflow-x:auto"><table id="tablaChoferes"><thead><tr><th>Estado</th><th>Nombre</th><th>Placa</th><th>Tipo</th><th>Teléfono</th><th>Wialon ID</th><th>GPS</th><th>Pago</th><th>Viajes</th><th>⭐</th><th>Mapa</th></tr></thead><tbody>';
d.choferes.forEach(c=>{let mapaLink="—";if(c.ultimaPos)mapaLink='<a class="maplink" href="https://www.google.com/maps?q='+c.ultimaPos.lat+','+c.ultimaPos.lng+'" target="_blank">🗺️ Ver</a>';const rating=c.ratingCantidad>0?c.ratingPromedio.toFixed(1)+' ('+c.ratingCantidad+')':'—';let clase="chofer";clase+=" estado-"+c.estado;clase+=c.ultimaPos&&c.ultimaPos.hace_min<=15?" con-gps":" sin-gps";clase+=c.pagoAlDia?" pagado":" impago";html+='<tr class="'+clase+'"><td>'+estadoBadge(c.estado)+'</td><td class="truncate" title="'+(c.nombre||"")+'">'+(c.nombre||"—")+'</td><td>'+(c.placa||"—")+'</td><td>'+tipoVehBadge(c.tipoVehiculo)+'</td><td>'+fmtTel(c.phone)+'</td><td>'+(c.wialonId||"—")+'</td><td>'+gpsBadge(c.ultimaPos)+'</td><td>'+pagoBadge(c)+'</td><td>'+c.viajesTotal+'</td><td>'+rating+'</td><td>'+mapaLink+'</td></tr>';});
html+='</tbody></table></div>';}html+='</div>';
html+='<div class="section"><h2>🚖 Viajes activos <span class="badge">'+d.viajesActivos.length+'</span></h2>';
if(d.viajesActivos.length===0){html+='<div class="empty">No hay viajes activos.</div>';}else{html+='<div style="overflow-x:auto"><table><thead><tr><th>Estado</th><th>Tipo</th><th>Pasajero</th><th>Chofer</th><th>Origen</th><th>Destino</th><th>Km</th><th>Precio</th><th>Inicio</th><th>Mapa</th></tr></thead><tbody>';d.viajesActivos.forEach(v=>{html+='<tr><td><span class="estado estado-'+(v.estado==="en_curso"?"libre":"ocupado")+'">'+v.estado+'</span></td><td>'+tipoVehBadge(v.tipoVehiculo||"auto")+'</td><td>'+fmtTel(v.usuarioPhone)+'</td><td>'+(v.choferNombre||"—")+'<br><small>'+(v.choferPlaca||"")+'</small></td><td class="truncate">'+(v.origen?.nombre||"📍")+'</td><td class="truncate">'+(v.destino?.nombre||"🏁")+'</td><td>'+(v.distanciaKm||"—")+' km</td><td>Bs '+(v.precioTotal||"—")+'</td><td>'+fmtHora(v.fechaInicio)+'</td><td><a class="maplink" href="/admin/viaje/'+v._id+'" target="_blank">🗺️</a></td></tr>';});html+='</tbody></table></div>';}html+='</div>';
if(d.listaEspera.length>0){html+='<div class="section"><h2>⏳ Lista de espera <span class="badge">'+d.listaEspera.length+'</span></h2><div style="overflow-x:auto"><table><thead><tr><th>Pasajero</th><th>Tipo</th><th>Origen</th><th>Destino</th><th>Precio</th><th>Esperando desde</th><th>Notificado</th></tr></thead><tbody>';d.listaEspera.forEach(e=>{html+='<tr><td>'+fmtTel(e.userPhone)+'</td><td>'+(e.tipoVehiculoSolicitado?tipoVehBadge(e.tipoVehiculoSolicitado):"—")+'</td><td class="truncate">'+(e.origen?.nombre||"—")+'</td><td class="truncate">'+(e.destino?.nombre||"—")+'</td><td>Bs '+(e.precio||"—")+'</td><td>'+fmtHora(e.timestamp)+'</td><td>'+(e.notificado?"✅":"⏳")+'</td></tr>';});html+='</tbody></table></div></div>';}
html+='<div class="section"><h2>📜 Últimos 20 viajes</h2><div style="overflow-x:auto"><table><thead><tr><th>Fecha</th><th>Estado</th><th>Tipo</th><th>Pasajero</th><th>Chofer</th><th>Km</th><th>Precio</th><th>⭐</th><th>Mapa</th></tr></thead><tbody>';
d.viajesRecientes.forEach(v=>{const rTxt=v.ratingPasajero?"⭐"+v.ratingPasajero:"—";let clE="offline";if(v.estado==="completado")clE="libre";else if(["en_curso","en_camino","esperando_pasajero","pendiente"].includes(v.estado))clE="ocupado";html+='<tr><td>'+fmtHora(v.createdAt||v.fechaInicio)+'</td><td><span class="estado estado-'+clE+'">'+v.estado+'</span></td><td>'+tipoVehBadge(v.tipoVehiculo||"auto")+'</td><td>'+fmtTel(v.usuarioPhone)+'</td><td>'+(v.choferNombre||"—")+'</td><td>'+(v.distanciaKm||"—")+' km</td><td>Bs '+(v.precioTotal||"—")+'</td><td>'+rTxt+'</td><td><a class="maplink" href="/admin/viaje/'+v._id+'" target="_blank">🗺️</a></td></tr>';});
html+='</tbody></table></div></div>';
document.getElementById("content").innerHTML=html;}
function filtrarChoferes(){const filtro=document.getElementById("filtroChofer").value;const filas=document.querySelectorAll("#tablaChoferes tbody tr");filas.forEach(f=>{let m=true;if(filtro==="libre")m=f.classList.contains("estado-libre");else if(filtro==="ocupado")m=f.classList.contains("estado-ocupado");else if(filtro==="offline")m=f.classList.contains("estado-offline");else if(filtro==="con-gps")m=f.classList.contains("con-gps");else if(filtro==="sin-gps")m=f.classList.contains("sin-gps");else if(filtro==="pagado")m=f.classList.contains("pagado");else if(filtro==="impago")m=f.classList.contains("impago");f.style.display=m?"":"none";});}
cargar();
</script></body></html>`);
});

app.get("/", (_req, res) => { res.send("ChatGo v4 FIXED + FEATURES - RastreoPlus - Operativo ✅"); });

// ═══════════════════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log.info(`🚖 ChatGo v4 corriendo en puerto ${PORT}`));

process.on("unhandledRejection", (reason) => { log.error("[UNHANDLED_REJECTION]", reason); });
process.on("uncaughtException", (err) => { log.error("[UNCAUGHT_EXCEPTION]", err.message, err.stack); });
