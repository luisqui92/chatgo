// ═══════════════════════════════════════════════════════════════════════════
// ChatGo - Bot de Taxi por WhatsApp (v6.0 - Modular) - Build 20260525055707
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const app = express();

// ─── MÓDULOS ─────────────────────────────────────────────────────────────────
const { CONFIG, log, validateConfig } = require("./config");
validateConfig();
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
require("./routes/medicoAuth")(app, allDeps);
require("./routes/consultaMedica")(app, allDeps);
require("./routes/pacientes")(app, allDeps);
require("./routes/medicamentos")(app, allDeps);
require("./routes/vacunas")(app, allDeps);
require("./routes/mediciones")(app, allDeps);
require("./routes/estudios")(app, allDeps);
require("./routes/memoriaClinica")(app, allDeps);
require("./routes/recetas")(app, allDeps);
require("./routes/vinculacion")(app, allDeps);

// ─── INTERVALS ────────────────────────────────────────────────────────────────
const { iniciarIntervals } = require("./intervals");
iniciarIntervals(allDeps);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("ChatGo v6.0 Modular - RastreoPlus - Operativo ✅"));

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

// Estáticos de Vitalis (logo, css, los módulos JS de salud.html) — todo lo
// que se agregue a public/salud/ queda servido solo, sin tocar este archivo.
// maxAge corto a propósito: mientras el producto cambia seguido, que el
// celular del médico siempre pida la versión nueva vale más que ahorrar
// esas requests (son archivos chicos).
app.use("/salud", require("express").static(require("path").join(__dirname, "public", "salud"), {
  maxAge: "5m",
}));

// Web de consultas médicas (mismo dominio/certificado que la API, sin subdominio aparte)
app.get("/salud", (_req, res) => {
  const path = require("path");
  res.sendFile(path.join(__dirname, "salud.html"));
});

// ─── SERVER ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log.info(`🚀 ChatGo v6.0 corriendo en puerto ${PORT}`));
