// ChatGo — Config, Logger, Ciudades

// ─── CONFIGURACIÓN ─────────────────────────────────────────────────────────
const crypto = require("crypto");

// Normaliza un número a formato boliviano de WhatsApp: solo dígitos, y si viene
// el celular de 8 dígitos sin código de país, le antepone 591. Así el mismo
// número calza escríbase "79159396", "591 79159396" o "+59179159396".
function normalizarPhoneBolivia(n) {
  const d = String(n || "").replace(/\D/g, "");
  if (d.length === 8) return "591" + d;
  return d;
}

const CONFIG = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  META_APP_SECRET: process.env.META_APP_SECRET,
  GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY,
  GOOGLE_MAP_ID: process.env.GOOGLE_MAP_ID || "", // Map ID vectorial → navegación 3D (inclinación + rotación)
  OPENAI_KEY: process.env.OPENAI_KEY,
  ADMIN_PHONE: process.env.ADMIN_PHONE || "59162741818",
  QR_IMAGE_URL: process.env.QR_IMAGE_URL || (process.env.APP_URL ? `${process.env.APP_URL}/qr/pago.jpg` : null),

  TIMEOUT_OPENAI: 20000,
  TIMEOUT_GOOGLE: 10000,
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

  // Ciudad asumida cuando todavía no se conoce la del usuario (usuario nuevo que
  // pide por audio/texto/link antes de mandar un pin). Antes estaba clavado en
  // "Cochabamba" en varios archivos → una dirección de La Paz resolvía a la calle
  // homónima de Cochabamba. Para el piloto de La Paz: CIUDAD_DEFAULT=La Paz
  CIUDAD_DEFAULT: process.env.CIUDAD_DEFAULT || "Cochabamba",
  MAX_PARADAS: 3,
  // Tiempo máximo inactividad en flujo de pedido antes de limpiar sesión (30 minutos)
  SESSION_PEDIDO_TIMEOUT_MS: 30 * 60 * 1000,
  // Inactividad tras la cual, al volver a escribir, la sesión se resetea al
  // inicio EN SILENCIO (sin importar el paso: pedir viaje, vinculación, etc.).
  // No aplica a viajes activos. Configurable con TIMEOUT_INACTIVIDAD_MIN.
  TIMEOUT_INACTIVIDAD_MIN: Number(process.env.TIMEOUT_INACTIVIDAD_MIN || 10),
  // URL pública de la app (Railway o dominio propio)
  APP_URL: process.env.APP_URL || "",
  // Máximo de reintentos en asignarChofer para evitar recursión infinita
  MAX_REINTENTOS_ASIGNAR: 12,
  // TTL para deduplicación de mensajes WA (ms)
  MSG_DEDUP_TTL: 5 * 60 * 1000,
  // Choferes de prueba (SUPERCHOFERES forzados): siempre se les asigna el
  // viaje sin filtros de estado/pago/ciudad/distancia (mientras tengan GPS en
  // vivo y no hayan sido excluidos en este mismo intento). Acepta VARIOS
  // números separados por coma para ver la secuencia de llegada de trabajos:
  // el más cercano recibe primero, y si rechaza/vence pasa al siguiente.
  // CHOFER_PRUEBA_PHONE queda por retrocompatibilidad (primer número).
  // Se normalizan a formato boliviano (591 + 8 dígitos) para que calcen con el
  // phone guardado en la tabla Chofer AUNQUE en el .env se carguen sin el 591
  // (ej. "79159396" → "59179159396"). Sin esto, el forzado nunca se activaba.
  CHOFER_PRUEBA_PHONE: normalizarPhoneBolivia((process.env.CHOFER_PRUEBA_PHONE || "59176496075").split(",")[0]),
  CHOFER_PRUEBA_PHONES: (process.env.CHOFER_PRUEBA_PHONE || "59176496075")
    .split(",")
    .map(normalizarPhoneBolivia)
    .filter(Boolean),
  // Cuota diaria que debe pagar cada chofer (en Bs)
  CUOTA_DIARIA_BS: Number(process.env.CUOTA_DIARIA_BS || 10),
  // ─── RECARGO POR SUBIDA (La Paz es una olla entre cerros) ─────────────────
  // Cobra un extra cuando el viaje SUBE (destino más alto que el origen), medido
  // con la API de Elevación de Google. En bajada o plano no se cobra extra.
  // Encendido por defecto (antes exigía exactamente "=1" y quedaba muerto en
  // silencio si se olvidaban). Se apaga solo con RECARGO_SUBIDA_ENABLED=0/false.
  // El estado activo se loguea al arrancar (ver más abajo).
  RECARGO_SUBIDA_ENABLED: !["0", "false", "no", "off"].includes(String(process.env.RECARGO_SUBIDA_ENABLED || "").trim().toLowerCase()),
  RECARGO_SUBIDA_BS_POR_100M: Number(process.env.RECARGO_SUBIDA_BS_POR_100M || 2), // Bs por cada 100 m de subida neta
  RECARGO_SUBIDA_UMBRAL_M: Number(process.env.RECARGO_SUBIDA_UMBRAL_M || 60),       // no cobrar si sube menos que esto (viaje casi plano)
  RECARGO_SUBIDA_MAX_BS: Number(process.env.RECARGO_SUBIDA_MAX_BS || 15),           // tope del recargo
  // Secreto compartido para validar notificaciones de pago bancario (MacroDroid → webhook).
  // Si no está configurado, el endpoint rechaza todas las llamadas.
  PAGO_WEBHOOK_SECRET: process.env.PAGO_WEBHOOK_SECRET || null,
  AUXILIO_ADMIN_TOKEN: process.env.AUXILIO_ADMIN_TOKEN || null, // panel de auxilio mecánico
  AGUA_REPARTIDOR_PHONE: process.env.AGUA_REPARTIDOR_PHONE || "59164637067", // admin/repartidor: Luis (chofer) por defecto
  AGUA_FABRICA_NOMBRE: process.env.AGUA_FABRICA_NOMBRE || "Agua de Mesa", // nombre de la fábrica (demo)
  AGUA_ADMIN_TOKEN: process.env.AGUA_ADMIN_TOKEN || process.env.AUXILIO_ADMIN_TOKEN || null, // panel de despacho
  AGUA_FABRICA_LAT: Number(process.env.AGUA_FABRICA_LAT || -17.3895), // base de la fábrica (para las rutas)
  AGUA_FABRICA_LNG: Number(process.env.AGUA_FABRICA_LNG || -66.1568),
  // ─── Evaluación de Ventas (sistema separado) ───
  VENTAS_ADMIN_TOKEN: process.env.VENTAS_ADMIN_TOKEN || null,
  VENTAS_MODEL: process.env.VENTAS_MODEL || "gpt-4o", // scoring con OpenAI (reusa OPENAI_KEY)
  VENTAS_MAIL_USER: process.env.VENTAS_MAIL_USER || "rastreoplus@gmail.com", // correo padre (remitente)
  VENTAS_MAIL_PASS: process.env.VENTAS_MAIL_PASS || null, // contraseña de aplicación de Gmail
  VENTAS_WA_ENABLED: process.env.VENTAS_WA_ENABLED === "1", // enlace de líneas por Baileys (separado de ChatGo)
  VENTAS_WA_DIR: process.env.VENTAS_WA_DIR || "data/wa-ventas", // credenciales de sesión Baileys
  VENTAS_WA_DEBOUNCE_MS: Number(process.env.VENTAS_WA_DEBOUNCE_MS || 180000), // espera de inactividad antes de auto-evaluar (3 min)
  // Token del panel de aluminio: si no se define uno propio, usa el de VENTAS
  // con una letra extra al final ("a") — así es distinto pero fácil de recordar.
  CARP_ADMIN_TOKEN: process.env.CARP_ADMIN_TOKEN || (process.env.VENTAS_ADMIN_TOKEN ? process.env.VENTAS_ADMIN_TOKEN + "a" : null), // panel de corte de aluminio (separado)
  CARP_VISION_MODEL: process.env.CARP_VISION_MODEL || "gpt-4o", // lectura de medidas por foto (reusa OPENAI_KEY)

  // ─── PLATAFORMA MODULAR ────────────────────────────────────────────────
  // Módulos activos además del taxi, separados por coma.
  // Ej: MODULOS_ACTIVOS="favor,delivery,school,empresas,rastreo"
  // Vacío (default) = solo taxi; el comportamiento actual no cambia en nada.
  MODULOS_ACTIVOS: (process.env.MODULOS_ACTIVOS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  // Tarifa base que se suma al costo por km en mandados (módulo favor)
  FAVOR_TARIFA_BASE_BS: Number(process.env.FAVOR_TARIFA_BASE_BS || 5),
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
  // La Paz "hoyada" (la ciudad en el valle) + Zona Sur. Recortada al ESTE de la
  // ceja (lng > -68.16) para NO solaparse con El Alto (que está en la planicie al
  // oeste). Antes la caja llegaba a -68.25 y contenía por completo a El Alto.
  "La Paz": {
    bounds: { latMin: -16.58, latMax: -16.46, lngMin: -68.16, lngMax: -68.03 },
    centro: { lat: -16.4957, lng: -68.1336 }, // Plaza Murillo (antes estaba mal, caía en El Alto)
    contextoGeocode: "La Paz, Bolivia",
    refs: ["la paz","miraflores","sopocachi","obrajes","calacoto","san miguel","cota cota","irpavi","paceño"],
  },
  // El Alto: planicie al OESTE de la ceja (lng < -68.16). Disjunta de La Paz.
  "El Alto": {
    bounds: { latMin: -16.56, latMax: -16.46, lngMin: -68.25, lngMax: -68.16 },
    centro: { lat: -16.5047, lng: -68.1633 }, // La Ceja
    contextoGeocode: "El Alto, Bolivia",
    refs: ["el alto","ciudad satelite","16 de julio","villa adela","rio seco"],
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
  // Si dos cajas llegaran a solaparse, gana la MÁS ESPECÍFICA (menor área), para
  // que un punto de El Alto nunca se clasifique como La Paz por orden de lista.
  let mejor = null;
  let mejorArea = Infinity;
  for (const [nombre, ciudad] of Object.entries(CIUDADES)) {
    const b = ciudad.bounds;
    if (lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax) {
      const area = (b.latMax - b.latMin) * (b.lngMax - b.lngMin);
      if (area < mejorArea) { mejorArea = area; mejor = nombre; }
    }
  }
  return mejor;
}

function detectarCiudadPorTexto(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [nombre, ciudad] of Object.entries(CIUDADES)) {
    if (ciudad.refs.some(ref => t.includes(ref))) return nombre;
  }
  return null;
}

function ciudadPorDefecto() {
  return CIUDADES[CONFIG.CIUDAD_DEFAULT] ? CONFIG.CIUDAD_DEFAULT : "Cochabamba";
}

function getContextoGeocode(ciudadUsuario) {
  return (CIUDADES[ciudadUsuario] || CIUDADES[ciudadPorDefecto()]).contextoGeocode;
}

function getBoundsUsuario(ciudadUsuario) {
  return (CIUDADES[ciudadUsuario] || CIUDADES[ciudadPorDefecto()]).bounds;
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
  // OJO: este proyecto usa Prisma + MySQL. La base se configura por DATABASE_URL,
  // NO por MONGODB_URI (residuo de la versión vieja en Mongo). Validar la variable
  // equivocada fue lo que permitió que convivieran dos versiones/stacks distintos.
  const required = [
    "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "VERIFY_TOKEN",
    "GOOGLE_MAPS_KEY", "OPENAI_KEY", "DATABASE_URL"
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
  // Estado de flags sensibles del piloto — visibles de un vistazo al arrancar,
  // para no descubrir en producción que una feature quedó apagada en silencio.
  log.info(`🌆 Ciudad por defecto: ${ciudadPorDefecto()}${CIUDADES[CONFIG.CIUDAD_DEFAULT] ? "" : " (CIUDAD_DEFAULT inválida, usando Cochabamba)"}`);
  log.info(`⛰️ Recargo por subida: ${CONFIG.RECARGO_SUBIDA_ENABLED ? "ENCENDIDO" : "apagado"} (Bs ${CONFIG.RECARGO_SUBIDA_BS_POR_100M}/100m, umbral ${CONFIG.RECARGO_SUBIDA_UMBRAL_M}m, tope Bs ${CONFIG.RECARGO_SUBIDA_MAX_BS})`);
  log.info(`🚕 Superchoferes de prueba: ${CONFIG.CHOFER_PRUEBA_PHONES.join(", ") || "(ninguno)"}`);
  return true;
}

module.exports = { CONFIG, CIUDADES, log, detectarCiudadPorCoords, detectarCiudadPorTexto, getContextoGeocode, getBoundsUsuario, ciudadPorDefecto, validateConfig };
