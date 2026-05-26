// ChatGo — Config, Logger, Ciudades

// ─── CONFIGURACIÓN ─────────────────────────────────────────────────────────
const crypto = require("crypto");

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

  PROMO_GRATIS_HASTA: process.env.PROMO_GRATIS_HASTA || "2026-06-01",
  PROMO_CODIGOS_HASTA: process.env.PROMO_CODIGOS_HASTA || "2026-06-01",
  CODIGO_DESCUENTO_PORCENTAJE: 40,
  CODIGO_VIGENCIA_DIAS: 15,

  MAX_PARADAS: 3,
  // Tiempo máximo inactividad en flujo de pedido antes de limpiar sesión (30 minutos)
  SESSION_PEDIDO_TIMEOUT_MS: 30 * 60 * 1000,
  // URL pública de la app (Railway o dominio propio)
  APP_URL: process.env.APP_URL || "",
  // Máximo de reintentos en asignarChofer para evitar recursión infinita
  MAX_REINTENTOS_ASIGNAR: 5,
  // TTL para deduplicación de mensajes WA (ms)
  MSG_DEDUP_TTL: 5 * 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════════════
// CIUDADES SOPORTADAS — bounding boxes y contexto para geocoding
// ═══════════════════════════════════════════════════════════════════════════
const CIUDADES = {
  "Cochabamba": {
    bounds: { latMin: -17.55, latMax: -17.20, lngMin: -66.35, lngMax: -66.05 },
    centro: { lat: -17.3935, lng: -66.157 },
    contextoGeocode: "Cochabamba, Bolivia",
    refs: ["cochabamba","cbba","quillacollo","sacaba","tiquipaya","colcapirhua","vinto"],
  },
  "Santa Cruz": {
    bounds: { latMin: -18.05, latMax: -17.55, lngMin: -63.35, lngMax: -62.95 },
    centro: { lat: -17.7833, lng: -63.1822 },
    contextoGeocode: "Santa Cruz de la Sierra, Bolivia",
    refs: ["santa cruz","cruceño","la ramada","equipetrol","urubo","montero"],
  },
  "La Paz": {
    bounds: { latMin: -16.65, latMax: -16.30, lngMin: -68.25, lngMax: -68.00 },
    centro: { lat: -16.5000, lng: -68.1500 },
    contextoGeocode: "La Paz, Bolivia",
    refs: ["la paz","miraflores","sopocachi","obrajes","calacoto","paceño"],
  },
  "El Alto": {
    bounds: { latMin: -16.55, latMax: -16.45, lngMin: -68.25, lngMax: -68.05 },
    centro: { lat: -16.5000, lng: -68.1833 },
    contextoGeocode: "El Alto, Bolivia",
    refs: ["el alto","ciudad satelite","16 de julio"],
  },
  "Oruro": {
    bounds: { latMin: -18.05, latMax: -17.85, lngMin: -67.20, lngMax: -66.95 },
    centro: { lat: -17.9833, lng: -67.1167 },
    contextoGeocode: "Oruro, Bolivia",
    refs: ["oruro"],
  },
  "Potosí": {
    bounds: { latMin: -19.65, latMax: -19.50, lngMin: -65.85, lngMax: -65.65 },
    centro: { lat: -19.5836, lng: -65.7531 },
    contextoGeocode: "Potosí, Bolivia",
    refs: ["potosi","potosi"],
  },
  "Sucre": {
    bounds: { latMin: -19.15, latMax: -18.95, lngMin: -65.35, lngMax: -65.15 },
    centro: { lat: -19.0431, lng: -65.2592 },
    contextoGeocode: "Sucre, Bolivia",
    refs: ["sucre","chuquisaca"],
  },
  "Tarija": {
    bounds: { latMin: -21.65, latMax: -21.45, lngMin: -64.85, lngMax: -64.65 },
    centro: { lat: -21.5355, lng: -64.7296 },
    contextoGeocode: "Tarija, Bolivia",
    refs: ["tarija"],
  },
  "Trinidad": {
    bounds: { latMin: -14.95, latMax: -14.75, lngMin: -64.95, lngMax: -64.75 },
    centro: { lat: -14.8333, lng: -64.9000 },
    contextoGeocode: "Trinidad, Bolivia",
    refs: ["trinidad","beni"],
  },
  "Cobija": {
    bounds: { latMin: -11.10, latMax: -10.95, lngMin: -68.85, lngMax: -68.65 },
    centro: { lat: -11.0333, lng: -68.7833 },
    contextoGeocode: "Cobija, Bolivia",
    refs: ["cobija","pando"],
  },
};

function detectarCiudadPorCoords(lat, lng) {
  for (const [nombre, ciudad] of Object.entries(CIUDADES)) {
    const b = ciudad.bounds;
    if (lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax) return nombre;
  }
  return null;
}

function detectarCiudadPorTexto(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [nombre, ciudad] of Object.entries(CIUDADES)) {
    if (ciudad.refs.some(ref => t.includes(ref))) return nombre;
  }
  return null;
}

function getContextoGeocode(ciudadUsuario) {
  return (CIUDADES[ciudadUsuario] || CIUDADES["Cochabamba"]).contextoGeocode;
}

function getBoundsUsuario(ciudadUsuario) {
  return (CIUDADES[ciudadUsuario] || CIUDADES["Cochabamba"]).bounds;
}

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



// ─── VALIDACIÓN DE VARIABLES DE ENTORNO ─────────────────────────────────────
function validateConfig() {
  const required = [
    "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "VERIFY_TOKEN", 
    "GOOGLE_MAPS_KEY", "WIALON_TOKEN", "OPENAI_KEY", "MONGODB_URI"
  ];
  const warned = [
    "META_APP_SECRET", "JWT_SECRET", "ADMIN_PASSWORD"
  ];
  const missing = required.filter(k => !process.env[k]);
  const warnings = warned.filter(k => !process.env[k]);
  
  if (missing.length > 0) {
    console.error("❌ Faltan variables de entorno requeridas:", missing.join(", "));
    console.error("   El bot NO puede arrancar sin estas variables.");
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.warn("⚠️ Variables recomendadas no definidas:", warnings.join(", "));
    console.warn("   El bot funcionará pero con menos seguridad.");
  }
  return true;
}

module.exports = { CONFIG, CIUDADES, log, detectarCiudadPorCoords, detectarCiudadPorTexto, getContextoGeocode, getBoundsUsuario, validateConfig };
