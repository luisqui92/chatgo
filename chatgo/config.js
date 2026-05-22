// ═══════════════════════════════════════════════════════════════════════════
// ChatGo — Configuración central
// ═══════════════════════════════════════════════════════════════════════════

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
  APP_URL: process.env.APP_URL || "",

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

  PROMO_GRATIS_HASTA: process.env.PROMO_GRATIS_HASTA || "2026-05-25",
  PROMO_CODIGOS_HASTA: process.env.PROMO_CODIGOS_HASTA || "2026-05-25",
  CODIGO_DESCUENTO_PORCENTAJE: 40,
  CODIGO_VIGENCIA_DIAS: 15,

  MAX_PARADAS: 3,
  SESSION_PEDIDO_TIMEOUT_MS: 30 * 60 * 1000,
  MAX_REINTENTOS_ASIGNAR: 5,
  MSG_DEDUP_TTL: 5 * 60 * 1000,

  // Bounding box Cochabamba (ciudad + área metropolitana)
  CBBA_BOUNDS: { latMin: -17.55, latMax: -17.20, lngMin: -66.35, lngMax: -66.05 },

  // Restricción vehicular
  RESTRICCION_POLIGONO: [
    { lat: -17.3720, lng: -66.1640 },
    { lat: -17.3718, lng: -66.1485 },
    { lat: -17.3900, lng: -66.1468 },
    { lat: -17.4020, lng: -66.1490 },
    { lat: -17.4035, lng: -66.1555 },
    { lat: -17.4010, lng: -66.1630 },
    { lat: -17.3850, lng: -66.1648 },
    { lat: -17.3720, lng: -66.1640 },
  ],
  RESTRICCION_HORA_INICIO: 7.5,
  RESTRICCION_HORA_FIN: 19.0,
  RESTRICCION_CALENDARIO: {
    1: [0, 1], // Lunes
    2: [2, 3], // Martes
    3: [4, 5], // Miércoles
    4: [6, 7], // Jueves
    5: [8, 9], // Viernes
    6: [],     // Sábado
    0: [],     // Domingo
  },
};

const log = {
  info:  (...a) => console.log(new Date().toISOString(), "[INFO]",  ...a),
  warn:  (...a) => console.warn(new Date().toISOString(), "[WARN]",  ...a),
  error: (...a) => console.error(new Date().toISOString(), "[ERROR]", ...a),
  debug: (...a) => console.log(new Date().toISOString(), "[DEBUG]", ...a),
};

if (!process.env.META_APP_SECRET) {
  log.warn("⚠️  META_APP_SECRET no configurado — webhook acepta sin validar firma.");
}

module.exports = { CONFIG, log };
