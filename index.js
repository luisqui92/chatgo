// ═══════════════════════════════════════════════════════════════════════════
// ChatGo - Bot de Taxi por WhatsApp (v6.0 - Modular) - Build 20260525055707
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const app = express();

// ─── MÓDULOS ─────────────────────────────────────────────────────────────────
const { CONFIG, log } = require("./config");
const models = require("./db/models");
const { Usuario, Chofer, Viaje, SessionState, ListaEspera, RateLimit, CodigoPromo, LocationReference } = models;

// Services
const { getSession, setSession, updateSession, deleteSession, ensureSession, addListaEspera, removeListaEspera, checkRateLimit, sessionCache, processedMsgIds, yaProcesoMensaje } = require("./services/session");
const { enviarMensaje, enviarBotones, enviarImagen, reenviarImagenPorId, reenviarAudioPorId, reenviarVideoPorId, reenviarUbicacion, reenviarDocumentoPorId, relayMensajeChat, descargarImagenMeta, obtenerUrlMedia, verificarFirmaMeta } = require("./services/whatsapp");
const { wialonLogin, wialonInvalidateCache, obtenerUbicacionChofer, getAppUrl, generarLinkRastreoPropio, generarLinkLocator, buscarChoferDisponible, reservarChofer, liberarReservaChofer } = require("./services/wialon");
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
  Usuario, Chofer, Viaje, SessionState, ListaEspera, RateLimit, CodigoPromo, LocationReference,
  // Services
  getSession, setSession, updateSession, deleteSession, ensureSession,
  addListaEspera, removeListaEspera, checkRateLimit, sessionCache, processedMsgIds, yaProcesoMensaje,
  enviarMensaje, enviarBotones, enviarImagen, reenviarImagenPorId, reenviarAudioPorId,
  reenviarVideoPorId, reenviarUbicacion, reenviarDocumentoPorId, relayMensajeChat,
  descargarImagenMeta, obtenerUrlMedia, verificarFirmaMeta,
  wialonLogin, wialonInvalidateCache, obtenerUbicacionChofer, getAppUrl,
  generarLinkRastreoPropio, generarLinkLocator, buscarChoferDisponible, reservarChofer, liberarReservaChofer,
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

// ─── INTERVALS ────────────────────────────────────────────────────────────────
const { iniciarIntervals } = require("./intervals");
iniciarIntervals(allDeps);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("ChatGo v6.0 Modular - RastreoPlus - Operativo ✅"));

// ─── SERVER ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log.info(`🚀 ChatGo v6.0 corriendo en puerto ${PORT}`));
