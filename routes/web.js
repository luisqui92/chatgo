// ChatGo — Canal WEB Premium (Etapa 1)
//
// La web es una boca de entrada al MISMO motor del taxi: el pedido web crea el
// viaje con el motor real (asignarChofer), el chofer recibe la orden por
// WhatsApp como siempre, y el cliente ve el estado en la web Y recibe las
// notificaciones por WhatsApp (su número se verifica con un código enviado por
// el propio bot — sin SMS, sin costo extra, y anti-pedidos-falsos).
//
// Endpoints (todos JSON, CORS ya cubierto por el middleware global):
//   POST /api/web/enviar-codigo    { phone }                → OTP por WhatsApp
//   POST /api/web/verificar-codigo { phone, codigo }        → { token } (24h)
//   POST /api/web/geocodificar     { token, direccion }     → { lat, lng, nombre }
//   GET  /api/web/direccion        ?token&lat&lng           → { nombre } (reverso)
//   POST /api/web/cotizar          { token, origen, destino } → precios auto/van
//   POST /api/web/pedir            { token, origen, destino, tipoVehiculo }
//   GET  /api/web/estado           ?token                   → estado del viaje activo
//   GET  /pedir                    → la página web (con la key de Maps inyectada)

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { Viaje, Chofer, ListaEspera } = require("../db/models");
const { enviarMensaje, enviarPlantillaCodigo } = require("../services/whatsapp");

// Número del bot en formato wa.me, para el botón "Abrir WhatsApp" cuando todo
// lo demás falla (usuario sin ventana de 24h y plantilla no disponible aún)
const WA_NUMERO_BOT = process.env.WA_NUMERO_BOT || "59177908529";
const { rateLimit } = require("../services/ratelimit");
const { calcularDistancia, calcularRutasConTrafico, geocodificarDireccion, geocodificarConMemoria, obtenerDireccion } = require("../services/google");
const { calcularPrecio, buscarEsquinaMapeada, obtenerLugarPersonal, obtenerLugarOtros } = require("../services/utils");
const { transcribirAudioWeb, extraerUbicaciones } = require("../services/openai");
const { calcularMultiplierSurge, aplicarSurge } = require("../ai");
const { asignarChofer, procesarCancelacionPasajero } = require("../flows/viaje");
const { getSession, updateSession } = require("../services/session");
const { pushActivo, clavePublica, guardarSuscripcion } = require("../services/push");

// ─── Límites (por IP) ────────────────────────────────────────────────────────
const limitWeb = rateLimit("web", 60, 60 * 1000, "Demasiadas peticiones. Esperá un momento.");
const limitCodigo = rateLimit("webCodigo", 5, 10 * 60 * 1000, "Demasiados códigos pedidos. Esperá 10 minutos.");

// ─── OTP en memoria ──────────────────────────────────────────────────────────
// phone → { codigo, exp, intentos }. TTL 10 min, máx 5 intentos por código.
const codigosPendientes = new Map();
// phone → { count, resetAt } — máx 3 códigos por número por hora (además del límite por IP)
const codigosPorTelefono = new Map();
// ─── Verificación INVERSA (1 toque) ─────────────────────────────────────────
// La web genera un código, abre wa.me con el mensaje pre-escrito, el usuario
// solo toca ENVIAR, el webhook detecta el mensaje y la sesión queda verificada
// sola (el número se toma de msg.from — ni siquiera hay que escribirlo).
// codigo → { phone: null | "591...", exp }
const verificacionesInversas = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codigosPendientes) if (v.exp < now) codigosPendientes.delete(k);
  for (const [k, v] of codigosPorTelefono) if (v.resetAt < now) codigosPorTelefono.delete(k);
  for (const [k, v] of verificacionesInversas) if (v.exp < now) verificacionesInversas.delete(k);
}, 5 * 60 * 1000);

// Genera código corto sin caracteres ambiguos (sin 0/O/1/I/L)
function codigoInverso() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += abc[crypto.randomInt(abc.length)];
  return c;
}

// Llamada desde el WEBHOOK con cada texto entrante: si es un mensaje de
// verificación web ("ChatGo-XXXXXX"), completa la verificación y responde.
// Devuelve true si el mensaje era de verificación (el webhook corta ahí).
async function procesarVerificacionWeb(phone, texto) {
  const m = String(texto || "").match(/chatgo[-\s]?([A-HJ-NP-Z2-9]{6})/i);
  if (!m) return false;
  const codigo = m[1].toUpperCase();
  const pendiente = verificacionesInversas.get(codigo);
  if (!pendiente || pendiente.exp < Date.now()) {
    await enviarMensaje(phone, "⏱️ Ese código de la web ya venció. Volvé a la página y tocá el botón de nuevo.");
    return true;
  }
  pendiente.phone = phone;
  log.info(`[WEB] Verificación inversa completada: ${codigo} → ${phone}`);
  await enviarMensaje(phone, "✅ *¡Listo!* Tu número quedó verificado.\n\nVolvé a la página para pedir tu ChatGo 🚖");
  return true;
}

// ─── Token web (HMAC, 24h) ───────────────────────────────────────────────────
const WEB_SECRET = process.env.JWT_SECRET || process.env.META_APP_SECRET || "chatgo-web-cambiar-en-produccion";

function generarTokenWeb(phone) {
  const payload = Buffer.from(JSON.stringify({ phone, exp: Date.now() + 24 * 60 * 60 * 1000 })).toString("base64url");
  const firma = crypto.createHmac("sha256", WEB_SECRET).update(payload).digest("base64url");
  return `${payload}.${firma}`;
}

function verificarTokenWeb(token) {
  try {
    const [payload, firma] = String(token || "").split(".");
    if (!payload || !firma) return null;
    const esperada = crypto.createHmac("sha256", WEB_SECRET).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
    const datos = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!datos.phone || datos.exp < Date.now()) return null;
    return datos;
  } catch { return null; }
}

// Middleware: exige token web válido; deja req.webPhone
function requireTokenWeb(req, res, next) {
  const token = req.body?.token || req.query?.token;
  const datos = verificarTokenWeb(token);
  if (!datos) return res.status(401).json({ error: "Sesión inválida o vencida. Verificá tu número de nuevo." });
  req.webPhone = datos.phone;
  next();
}

// Normaliza un número boliviano a formato internacional sin "+" (591XXXXXXXX)
function normalizarPhoneBo(input) {
  const num = String(input || "").replace(/\D/g, "");
  if (/^591\d{8}$/.test(num)) return num;
  if (/^[67]\d{7}$/.test(num)) return `591${num}`;
  return null;
}

function coordsValidas(p) {
  return p && typeof p.lat === "number" && typeof p.lng === "number" &&
    p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

module.exports = function (app) {

  // ── 0a. Verificación en 1 toque: iniciar ──────────────────────────────────
  // La web pide un código, abre wa.me con el mensaje pre-escrito, y hace
  // polling a 0b hasta que el webhook detecte el mensaje del usuario.
  app.post("/api/web/iniciar-verificacion", limitCodigo, (req, res) => {
    try {
      const codigo = codigoInverso();
      verificacionesInversas.set(codigo, { phone: null, exp: Date.now() + 10 * 60 * 1000 });
      const texto = encodeURIComponent(`ChatGo-${codigo}`);
      res.json({
        codigo,
        waLink: `https://wa.me/${WA_NUMERO_BOT}?text=${texto}`,
      });
    } catch (e) {
      log.error("[WEB_VERIF_INV]", e.message);
      res.status(500).json({ error: "Error iniciando la verificación." });
    }
  });

  // ── 0b. Verificación en 1 toque: polling ──────────────────────────────────
  app.get("/api/web/estado-verificacion", limitWeb, (req, res) => {
    const codigo = String(req.query.codigo || "").toUpperCase();
    const pendiente = verificacionesInversas.get(codigo);
    if (!pendiente || pendiente.exp < Date.now()) {
      return res.status(410).json({ error: "Código vencido. Tocá el botón de nuevo." });
    }
    if (!pendiente.phone) return res.json({ pendiente: true });
    verificacionesInversas.delete(codigo);
    res.json({ token: generarTokenWeb(pendiente.phone), phone: pendiente.phone });
  });

  // ── 1. Enviar código de verificación por WhatsApp ─────────────────────────
  app.post("/api/web/enviar-codigo", limitCodigo, async (req, res) => {
    try {
      const phone = normalizarPhoneBo(req.body?.phone);
      if (!phone) return res.status(400).json({ error: "Número inválido. Usá tu celular boliviano (ej: 71234567)." });

      // Anti-spam por número (independiente del límite por IP)
      const now = Date.now();
      const porTel = codigosPorTelefono.get(phone);
      if (porTel && porTel.resetAt > now && porTel.count >= 3) {
        return res.status(429).json({ error: "Ya pediste varios códigos. Esperá una hora o escribinos directo al WhatsApp." });
      }
      codigosPorTelefono.set(phone, porTel && porTel.resetAt > now
        ? { count: porTel.count + 1, resetAt: porTel.resetAt }
        : { count: 1, resetAt: now + 60 * 60 * 1000 });

      const codigo = String(crypto.randomInt(1000, 10000)); // 4 dígitos
      codigosPendientes.set(phone, { codigo, exp: now + 10 * 60 * 1000, intentos: 0 });

      // Cascada de envío — LA PLANTILLA VA PRIMERO:
      // Meta ACEPTA mensajes directos fuera de la ventana de 24h (devuelve
      // "éxito") y después los descarta en silencio — el fallback nunca se
      // disparaba y los números nuevos jamás recibían el código (caso real).
      // Las plantillas de autenticación entregan SIEMPRE; el mensaje directo
      // queda como respaldo si la plantilla falla (mal nombre/idioma/pausada).
      let ok = await enviarPlantillaCodigo(phone, codigo);
      let via = "plantilla";
      if (!ok) {
        log.warn(`[WEB] Plantilla de código falló para ${phone} — respaldo con mensaje directo (solo entrega con ventana 24h abierta)`);
        ok = await enviarMensaje(phone,
          `🐒 *ChatGo Web*\n\nTu código de verificación es: *${codigo}*\n\n_Vence en 10 minutos. Si no fuiste vos, ignorá este mensaje._`);
        via = "directo";
      }
      if (!ok) {
        return res.status(422).json({
          error: "No pudimos enviarte el código. Tocá el botón para abrir nuestro WhatsApp, mandá \"hola\" y volvé acá a reintentar.",
          waLink: `https://wa.me/${WA_NUMERO_BOT}?text=hola`,
        });
      }
      log.info(`[WEB] Código enviado a ${phone} (vía ${via})`);
      res.json({ ok: true });
    } catch (e) {
      log.error("[WEB_CODIGO]", e.message);
      res.status(500).json({ error: "Error enviando el código. Intentá de nuevo." });
    }
  });

  // ── 2. Verificar código → token ───────────────────────────────────────────
  app.post("/api/web/verificar-codigo", limitWeb, async (req, res) => {
    try {
      const phone = normalizarPhoneBo(req.body?.phone);
      const codigo = String(req.body?.codigo || "").trim();
      if (!phone || !/^\d{4}$/.test(codigo)) return res.status(400).json({ error: "Código inválido." });

      const pendiente = codigosPendientes.get(phone);
      if (!pendiente || pendiente.exp < Date.now()) {
        return res.status(400).json({ error: "El código venció. Pedí uno nuevo." });
      }
      pendiente.intentos++;
      if (pendiente.intentos > 5) {
        codigosPendientes.delete(phone);
        return res.status(429).json({ error: "Demasiados intentos. Pedí un código nuevo." });
      }
      if (pendiente.codigo !== codigo) {
        return res.status(400).json({ error: "Código incorrecto." });
      }
      codigosPendientes.delete(phone);
      log.info(`[WEB] Número verificado: ${phone}`);
      res.json({ token: generarTokenWeb(phone), phone });
    } catch (e) {
      log.error("[WEB_VERIFICAR]", e.message);
      res.status(500).json({ error: "Error verificando el código." });
    }
  });

  // ── 3. Geocodificar dirección escrita (reusa el geocoder validado del bot) ─
  app.post("/api/web/geocodificar", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const direccion = String(req.body?.direccion || "").trim().substring(0, 120);
      if (direccion.length < 3) return res.status(400).json({ error: "Escribí una dirección o lugar." });
      const geo = await geocodificarDireccion(direccion, true, "Cochabamba");
      if (!geo || !geo.lat) return res.status(404).json({ error: "No encontré ese lugar. Probá con calle y esquina, o mové el pin en el mapa." });
      res.json({ lat: geo.lat, lng: geo.lng, nombre: geo.nombre || direccion });
    } catch (e) {
      log.error("[WEB_GEOCOD]", e.message);
      res.status(500).json({ error: "Error buscando la dirección." });
    }
  });

  // ── 4. Dirección legible de un punto (para el pin del mapa) ───────────────
  app.get("/api/web/direccion", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
      if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "Coordenadas inválidas." });
      const nombre = await obtenerDireccion(lat, lng).catch(() => null);
      res.json({ nombre: nombre || "Punto en el mapa" });
    } catch (e) {
      res.json({ nombre: "Punto en el mapa" });
    }
  });

  // ── 4b. VOZ: el usuario habla y el pin va solo al lugar ───────────────────
  // Reusa TODA la inteligencia del bot: transcripción con diccionario de
  // Cochabamba, extracción de lugares con IA, lugares personales del usuario
  // (casa/trabajo/alias), esquinas crowdsourced con match difuso, y la memoria
  // de referencias por voz (LocationReference). La confirmación es visual: el
  // pin queda en el lugar entendido y el usuario lo ajusta si hace falta.
  app.post("/api/web/interpretar-voz", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const { audio, mime } = req.body || {};
      if (!audio || typeof audio !== "string") return res.status(400).json({ error: "No llegó el audio." });
      const buffer = Buffer.from(audio, "base64");
      if (buffer.length < 500) return res.status(400).json({ error: "Audio muy corto. Mantené presionado y hablá." });
      if (buffer.length > 3 * 1024 * 1024) return res.status(400).json({ error: "Audio muy largo. Máximo ~15 segundos." });

      // 1) Transcribir
      const transcripcion = await transcribirAudioWeb(buffer, mime || "audio/webm");
      if (!transcripcion?.trim()) return res.status(422).json({ error: "No escuché nada claro. Probá de nuevo." });
      log.info(`[WEB_VOZ] ${req.webPhone}: "${transcripcion.trim().substring(0, 80)}"`);

      // 2) Interpretar el lugar con IA (mismo extractor del bot)
      const ubi = await extraerUbicaciones(transcripcion);
      const detalle = ubi?.destinoDetalle || ubi?.origenDetalle || null;
      const textoLugar = (detalle?.texto || ubi?.destino || ubi?.origen || "").trim();
      if (!textoLugar) {
        return res.status(422).json({ error: "No entendí el lugar. Decí por ejemplo: \"al Correo Central\" o \"Ayacucho y Heroínas\".", transcripcion });
      }

      // 3) Resolver con la memoria del sistema (en orden de confianza)
      const phone = req.webPhone;
      let punto = null;

      // 3a. Lugar personal del usuario: "mi casa", "mi trabajo", alias guardados
      if (detalle?.tipo === "personal" && detalle.lugar_personal) {
        const g = await obtenerLugarPersonal(phone, detalle.lugar_personal).catch(() => null);
        if (g?.lat) punto = { lat: g.lat, lng: g.lng, nombre: g.nombre || detalle.lugar_personal };
      }
      if (!punto && textoLugar) {
        const alias = await obtenerLugarOtros(phone, textoLugar).catch(() => null);
        if (alias?.lat) punto = { lat: alias.lat, lng: alias.lng, nombre: alias.nombre || alias.alias };
      }

      // 3b. Esquina crowdsourced (con match difuso anti errores de dicción)
      if (!punto && detalle?.tipo === "esquina" && detalle.calle1 && detalle.calle2) {
        const r = await buscarEsquinaMapeada(detalle.calle1, detalle.calle2, detalle.zona || null).catch(() => null);
        if (r?.esquina?.lat) punto = { lat: r.esquina.lat, lng: r.esquina.lng, nombre: `${detalle.calle1} y ${detalle.calle2}` };
      }

      // 3c. Memoria de referencias por voz + geocoding validado de Google
      if (!punto) {
        const g = await geocodificarConMemoria(textoLugar, "Cochabamba").catch(() => null);
        // _incierto está OK acá: la confirmación de la web es visual (el pin)
        if (g?.lat) punto = { lat: g.lat, lng: g.lng, nombre: g.nombre || textoLugar };
      }

      if (!punto) {
        return res.status(422).json({
          error: `Entendí "${textoLugar}" pero no pude ubicarlo. Movė el pin al lugar o probá con calle y esquina.`,
          transcripcion,
          textoLugar,
        });
      }

      res.json({ ...punto, transcripcion: transcripcion.trim(), textoLugar });
    } catch (e) {
      log.error("[WEB_VOZ]", e.response?.data?.error?.message || e.message);
      res.status(500).json({ error: "Error procesando el audio. Probá de nuevo." });
    }
  });

  // ── 5. Cotizar (precio real del backend, con surge — el front no calcula nada)
  app.post("/api/web/cotizar", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const { origen, destino } = req.body || {};
      if (!coordsValidas(origen) || !coordsValidas(destino)) {
        return res.status(400).json({ error: "Faltan las ubicaciones." });
      }
      if (!detectarCiudadPorCoords(origen.lat, origen.lng)) {
        return res.status(400).json({ error: "El punto de recogida está fuera de nuestra zona de cobertura." });
      }
      if (Math.abs(origen.lat - destino.lat) < 0.0005 && Math.abs(origen.lng - destino.lng) < 0.0005) {
        return res.status(400).json({ error: "El origen y el destino son el mismo punto." });
      }

      // Ruta real por calles (Routes API) — km para el precio Y puntos para
      // dibujar la ruta en el mapa de cotización (no una línea recta)
      let km, duracion, esAproximado = false, puntos = [];
      const rutas = await calcularRutasConTrafico(origen, destino).catch(() => []);
      if (rutas.length) {
        km = Math.round((rutas[0].distanciaM / 1000) * 10) / 10;
        duracion = `${Math.round(rutas[0].duracionSeg / 60)} min`;
        puntos = rutas[0].puntos;
      } else {
        const d = await calcularDistancia(origen, destino);
        km = d.km; duracion = d.duracion; esAproximado = !!d.esAproximado;
      }
      const { multiplier } = await calcularMultiplierSurge(origen.lat, origen.lng);
      const auto = aplicarSurge(calcularPrecio(km, "auto").total, multiplier);
      const van = aplicarSurge(calcularPrecio(km, "van").total, multiplier);

      res.json({
        km,
        duracion,
        esAproximado,
        surge: multiplier > 1 ? multiplier : null,
        precios: { auto, van },
        puntos,
      });
    } catch (e) {
      log.error("[WEB_COTIZAR]", e.message);
      res.status(500).json({ error: "No pudimos calcular el precio. Intentá de nuevo." });
    }
  });

  // ── 6. Pedir el viaje — usa el motor REAL del taxi ────────────────────────
  app.post("/api/web/pedir", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const phone = req.webPhone;
      const { origen, destino, tipoVehiculo } = req.body || {};
      if (!coordsValidas(origen) || !coordsValidas(destino)) {
        return res.status(400).json({ error: "Faltan las ubicaciones." });
      }
      const tipo = ["auto", "van"].includes(tipoVehiculo) ? tipoVehiculo : "auto";

      // Un solo viaje activo por número
      const viajeActivo = await Viaje.findFirst({
        where: { usuarioPhone: phone, estado: { in: ["pendiente", "en_camino", "esperando_pasajero", "en_curso"] } },
      });
      if (viajeActivo) {
        return res.status(409).json({ error: "Ya tenés un viaje en curso.", viajeId: viajeActivo.id });
      }

      // Recalcular SIEMPRE en el servidor (el precio del front es solo informativo)
      const { km } = await calcularDistancia(origen, destino);
      const { multiplier } = await calcularMultiplierSurge(origen.lat, origen.lng);
      const base = calcularPrecio(km, tipo);
      const precio = aplicarSurge(base.total, multiplier);

      const nombreOrigen = origen.nombre || (await obtenerDireccion(origen.lat, origen.lng).catch(() => null)) || "Punto en el mapa";
      const nombreDestino = destino.nombre || (await obtenerDireccion(destino.lat, destino.lng).catch(() => null)) || "Punto en el mapa";

      // Sesión con el formato del motor del taxi y despacho real.
      // Desde acá todo es el pipeline de siempre: reserva atómica, orden al
      // chofer por WhatsApp, lista de espera si no hay móviles, chat, tracking.
      const sesionViaje = {
        step: "calculando",
        origen: { lat: origen.lat, lng: origen.lng, nombre: nombreOrigen },
        destino: { lat: destino.lat, lng: destino.lng, nombre: nombreDestino },
        ubicaciones: {
          origen: { lat: origen.lat, lng: origen.lng },
          destino: { lat: destino.lat, lng: destino.lng },
        },
        distancia: km,
        precio,
        precioBase: precio,
        precioPorKm: base.precioPorKm,
        observaciones: "🌐 Pedido desde la web",
        tipoVehiculoSolicitado: tipo,
        origenWeb: true,
      };
      await updateSession(phone, sesionViaje);
      await asignarChofer(phone, sesionViaje);

      const s = await getSession(phone);
      log.info(`[WEB] Pedido de ${phone}: ${nombreOrigen} → ${nombreDestino} (${tipo}, Bs ${precio}) — step=${s?.step}`);
      res.json({
        ok: true,
        estado: s?.step === "sin_chofer" ? "buscando" : "asignando",
        viajeId: s?.viajeId || null,
        precio,
        km,
      });
    } catch (e) {
      log.error("[WEB_PEDIR]", e.message);
      res.status(500).json({ error: "No pudimos crear el pedido. Intentá de nuevo." });
    }
  });

  // ── 6b. Cancelar desde la web ──────────────────────────────────────────────
  // Reusa la cancelación real del bot: marca atómico anti-race con el interval
  // de lista de espera, libera al chofer y le avisa, limpia todo.
  app.post("/api/web/cancelar", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const phone = req.webPhone;
      const session = await getSession(phone);
      await procesarCancelacionPasajero(phone, session || {});
      log.info(`[WEB] Viaje cancelado desde la web por ${phone}`);
      res.json({ ok: true });
    } catch (e) {
      log.error("[WEB_CANCELAR]", e.message);
      res.status(500).json({ error: "No pudimos cancelar. Escribí CANCELAR a nuestro WhatsApp." });
    }
  });

  // ── 7. Estado del viaje activo (polling del front, cada ~4s) ──────────────
  app.get("/api/web/estado", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const phone = req.webPhone;
      const viaje = await Viaje.findFirst({
        where: { usuarioPhone: phone, estado: { in: ["pendiente", "en_camino", "esperando_pasajero", "en_curso"] } },
        orderBy: { createdAt: "desc" },
      });

      if (!viaje) {
        // ¿Sigue en lista de espera buscando móvil?
        const enEspera = await ListaEspera.findUnique({ where: { userPhone: phone } }).catch(() => null);
        if (enEspera) return res.json({ estado: "buscando" });
        // ¿El último viaje terminó/canceló hace poco? — para que el front cierre el ciclo
        const ultimo = await Viaje.findFirst({ where: { usuarioPhone: phone }, orderBy: { createdAt: "desc" } });
        if (ultimo && ["completado", "cancelado_chofer", "cancelado_pasajero", "cancelado"].includes(ultimo.estado)) {
          return res.json({ estado: ultimo.estado === "completado" ? "completado" : "cancelado" });
        }
        return res.json({ estado: "ninguno" });
      }

      let chofer = null;
      if (viaje.choferPhone && viaje.estado !== "pendiente") {
        const c = await Chofer.findUnique({ where: { phone: viaje.choferPhone } }).catch(() => null);
        if (c) {
          chofer = {
            nombre: c.nombre,
            placa: c.placa,
            tipoVehiculo: c.tipoVehiculo,
            colorVehiculo: c.colorVehiculo || null,
            fotoChofer: c.fotoChofer || null,
            fotoVehiculo: c.fotoVehiculo || null,
            rating: c.ratingCantidad > 0 ? Math.round(c.ratingPromedio * 10) / 10 : null,
          };
        }
      }

      res.json({
        estado: viaje.estado, // pendiente | en_camino | esperando_pasajero | en_curso
        viajeId: viaje.id,
        precio: viaje.precioTotal,
        km: viaje.distanciaKm,
        origenNombre: viaje.origenNombre,
        destinoNombre: viaje.destinoNombre,
        chofer,
        tracking: viaje.estado !== "pendiente" ? `${CONFIG.APP_URL || ""}/track/${viaje.id}` : null,
      });
    } catch (e) {
      log.error("[WEB_ESTADO]", e.message);
      res.status(500).json({ error: "Error consultando el estado." });
    }
  });

  // ── 8. Web Push: la web pide la clave pública VAPID ───────────────────────
  app.get("/api/web/vapid", limitWeb, (req, res) => {
    if (!pushActivo()) return res.json({ activo: false });
    res.json({ activo: true, key: clavePublica() });
  });

  // ── 9. Web Push: guardar la suscripción del navegador ─────────────────────
  // El navegador registra el Service Worker y manda su PushSubscription; la
  // guardamos ligada al teléfono para poder avisarle aunque cierre la web.
  app.post("/api/web/push-sub", limitWeb, requireTokenWeb, async (req, res) => {
    try {
      const sub = req.body?.subscription;
      if (!sub || !sub.endpoint) return res.status(400).json({ error: "Suscripción inválida." });
      const ok = await guardarSuscripcion(req.webPhone, sub);
      log.info(`[WEB_PUSHSUB] ${req.webPhone}: suscripción ${ok ? "guardada ✅" : "NO guardada ❌"}`);
      res.json({ ok });
    } catch (e) {
      log.error("[WEB_PUSHSUB]", e.message);
      res.status(500).json({ error: "No se pudo activar la notificación." });
    }
  });

  // ── La página web (key de Maps inyectada al servir) ───────────────────────
  app.get("/pedir", (_req, res) => {
    try {
      const file = path.join(__dirname, "..", "public", "web", "index.html");
      let html = fs.readFileSync(file, "utf8");
      html = html.replace("__GMAPS_KEY__", CONFIG.GOOGLE_MAPS_KEY || "");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.send(html);
    } catch (e) {
      res.status(500).send("Web no disponible.");
    }
  });
};

// Para el webhook: detectar mensajes de verificación web ("ChatGo-XXXXXX")
module.exports.procesarVerificacionWeb = procesarVerificacionWeb;
