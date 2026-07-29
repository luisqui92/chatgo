// ═══════════════════════════════════════════════════════════════════════════
// ChatGo - Bot de Taxi por WhatsApp (v6.0 - Modular) - Build 20260525055707
// ═══════════════════════════════════════════════════════════════════════════

// ─── CARGAR .env ─────────────────────────────────────────────────────────────
// PM2 NO lee el .env (solo conserva las variables de cuando se arrancó el
// proceso por primera vez). Caso real: MODULOS_ACTIVOS agregado al .env nunca
// llegaba a la app. La app lo carga acá misma; las variables ya definidas por
// el entorno/PM2 tienen prioridad (no se pisan).
(function cargarEnv() {
  try {
    const fs = require("fs");
    const path = require("path");
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const linea of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (e) {
    console.error("No se pudo cargar .env:", e.message);
  }
})();

const express = require("express");
const app = express();

// ─── MÓDULOS ─────────────────────────────────────────────────────────────────
const { CONFIG, log, validateConfig } = require("./config");
validateConfig();
log.info(`🧩 Módulos activos: ${CONFIG.MODULOS_ACTIVOS.length ? CONFIG.MODULOS_ACTIVOS.join(", ") : "(solo taxi)"}`);
const models = require("./db/models");
const { Usuario, Chofer, Viaje, SessionState, ListaEspera, RateLimit, CodigoPromo, LocationReference, NotificacionPago } = models;

// Services
const { getSession, setSession, updateSession, deleteSession, ensureSession, addListaEspera, removeListaEspera, checkRateLimit, sessionCache, processedMsgIds, yaProcesoMensaje } = require("./services/session");
const { enviarMensaje, enviarBotones, enviarImagen, reenviarImagenPorId, reenviarAudioPorId, reenviarVideoPorId, reenviarUbicacion, reenviarDocumentoPorId, relayMensajeChat, descargarImagenMeta, obtenerUrlMedia, verificarFirmaMeta } = require("./services/whatsapp");
// Wialon reemplazado por Traccar
const { calcularPrecio, distanciaEntrePuntos, evaluarPrecisionReferencia, extraerCoordsDeUrlGmaps, resolverUrlCorta, detectarYExtrarCoordsMaps, normalizarReferencia, generarTrigramas, similitudTexto, buscarReferenciaEnMemoria, guardarReferenciaVoz, dentroDeCocha, geocodificarConMemoria, calcularDistancia, calcularDistanciaConParadas, generarLinkRutaConParadas, geocodificarDireccion, obtenerDireccion } = require("./services/google");
const { transcribirAudio, extraerUbicaciones, validarComprobantePago } = require("./services/openai");
const { fechaStrBolivia, horaStrBolivia, formatearFechaPromo, promoCodigosActiva, enPromoGratis, generarCodigoUnico, crearCodigoPromo, validarCodigoPromo, consumirCodigoPromo, mensajeCodigoEntregado, enviarCodigoDescuento, validarPlaca, normalizarPlaca, acortarParaBoton, esIntentoCancelar, esPedidoAyuda, esPlusCode, detectarIncompatibilidadMoto, obtenerUltimoViaje, obtenerDestinosFrecuentes, guardarRutaFrecuente, construirBotonesHistorial, choferPagoAlDia } = require("./services/utils");

// AI
const { seleccionarMejorChofer, registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge, registrarViajeEnDemanda, enviarAlertasChoferes, monitorearViajeEnCurso, monitorearSeguridad, procesarReactivaciones, actualizarUltimoViaje } = require("./ai");

// Flows
const { asignarChofer, procesarCancelacionPasajero, procesarPedidoAyuda, solicitarRating, registrarRating } = require("./flows/viaje");
const { procesarMensajeChofer } = require("./flows/chofer");
const { procesarMensajeUsuario, preguntarOpcionesViaje, procesarCalculoViaje } = require("./flows/pasajero");

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

// ─── CORS ───────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = ["https://chatgo.ia.bo", "https://www.chatgo.ia.bo", "http://localhost:3000", "http://localhost:5173"];
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const allowed = ["https://chatgo.ia.bo", "http://chatgo.ia.bo", "http://localhost:3000"];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── RUTAS ────────────────────────────────────────────────────────────────────
const allDeps = {
  CONFIG, log,
  // Models
  Usuario, Chofer, Viaje, SessionState, ListaEspera, RateLimit, CodigoPromo, LocationReference, NotificacionPago,
  // Services
  getSession, setSession, updateSession, deleteSession, ensureSession,
  addListaEspera, removeListaEspera, checkRateLimit, sessionCache, processedMsgIds, yaProcesoMensaje,
  enviarMensaje, enviarBotones, enviarImagen, reenviarImagenPorId, reenviarAudioPorId,
  reenviarVideoPorId, reenviarUbicacion, reenviarDocumentoPorId, relayMensajeChat,
  descargarImagenMeta, obtenerUrlMedia, verificarFirmaMeta,
  calcularPrecio, distanciaEntrePuntos, evaluarPrecisionReferencia, extraerCoordsDeUrlGmaps,
  resolverUrlCorta, detectarYExtrarCoordsMaps, normalizarReferencia, generarTrigramas, similitudTexto,
  buscarReferenciaEnMemoria, guardarReferenciaVoz, dentroDeCocha, geocodificarConMemoria,
  calcularDistancia, calcularDistanciaConParadas, generarLinkRutaConParadas, geocodificarDireccion, obtenerDireccion,
  transcribirAudio, extraerUbicaciones, validarComprobantePago,
  fechaStrBolivia, horaStrBolivia, formatearFechaPromo, promoCodigosActiva, enPromoGratis,
  generarCodigoUnico, crearCodigoPromo, validarCodigoPromo, consumirCodigoPromo,
  mensajeCodigoEntregado, enviarCodigoDescuento, validarPlaca, normalizarPlaca,
  acortarParaBoton, esIntentoCancelar, esPedidoAyuda, esPlusCode, detectarIncompatibilidadMoto,
  obtenerUltimoViaje, obtenerDestinosFrecuentes, guardarRutaFrecuente, construirBotonesHistorial, choferPagoAlDia,
  // AI
  seleccionarMejorChofer, registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge,
  registrarViajeEnDemanda, enviarAlertasChoferes, monitorearViajeEnCurso, monitorearSeguridad,
  procesarReactivaciones, actualizarUltimoViaje,
  // Flows
  asignarChofer, procesarCancelacionPasajero, procesarPedidoAyuda, solicitarRating, registrarRating,
  procesarMensajeChofer, procesarMensajeUsuario, preguntarOpcionesViaje, procesarCalculoViaje,
};

require("./routes/webhook")(app, allDeps);
require("./routes/admin")(app, allDeps);
require("./routes/pagoNotificacion")(app, allDeps);
require("./routes/mapa")(app);
require("./routes/web")(app); // Canal web premium (Etapa 1) — GET /pedir
require("./routes/bus")(app); // ChatGo Bus demo — GET /bus/:lineaId
require("./routes/flota")(app); // Mapa de flota en vivo — GET /flota
require("./routes/trufis")(app); // ChatGo Bus — simulación de trufis — GET /trufis
require("./routes/panel")(app); // Panel de operaciones por ciudad — GET /panel
require("./routes/links")(app); // Índice de enlaces — GET /links
require("./routes/auxilio")(app); // Auxilio Mecánico (Etapa 1) — GET /admin/auxilio
require("./routes/agua")(app); // ChatGo Agua — despacho y rutas — GET /admin/agua

// ─── INTERVALS ────────────────────────────────────────────────────────────────
const { iniciarIntervals } = require("./intervals");
iniciarIntervals(allDeps);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("ChatGo v6.0 Modular - RastreoPlus - Operativo ✅"));

// ChatGo Ambulancias — página comunitaria (servicio gratuito)
app.get("/ambulancias", (_req, res) => {
  const path = require("path");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "ambulancias.html"));
});

// Demo de ChatGo Bus (5 líneas simuladas, vista operador/pasajero)
app.get("/bus-demo", (_req, res) => {
  const path = require("path");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "bus-demo.html"));
});

// Service Worker de Web Push (debe servirse desde la raíz para tener scope global)
app.get("/sw.js", (req, res) => {
  const path = require("path");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Service-Worker-Allowed", "/");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

// Servir logo público
app.get("/logo.png", (req, res) => {
  const path = require("path");
  const file = path.join(__dirname, "public", "logo.png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(file);
});

// Servir fotos de choferes
app.get("/fotos/:filename", (req, res) => {
  const path = require("path");
  const fs = require("fs");
  const file = path.join(__dirname, "public", "fotos", req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(file);
});

// Servir el QR de cobro (cuota diaria de choferes)
app.get("/qr/:filename", (req, res) => {
  const path = require("path");
  const fs = require("fs");
  const file = path.join(__dirname, "public", "qr", req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(file);
});

// ─── SERVER ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log.info(`🚀 ChatGo v6.0 corriendo en puerto ${PORT}`));
