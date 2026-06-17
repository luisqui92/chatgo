// ChatGo — Flow pasajero
const mongoose = require("mongoose");
const https = require("https");
const http = require("http");
const os = require("os");
const { CONFIG, log, CIUDADES, detectarCiudadPorCoords, detectarCiudadPorTexto } = require("../config");
const { Usuario, Chofer, Viaje, ListaEspera, CodigoPromo, LocationReference } = require("../db/models");
const { getSession, setSession, updateSession, deleteSession, ensureSession, removeListaEspera } = require("../services/session");
const { enviarMensaje: enviarMensajeRaw, enviarBotones: enviarBotonesRaw, relayMensajeChat, obtenerUrlMedia } = require("../services/whatsapp");
const { evaluarPrecisionReferencia, detectarYExtrarCoordsMaps, normalizarReferencia, guardarReferenciaVoz, geocodificarConMemoria, calcularDistancia, calcularDistanciaConParadas, obtenerDireccion, buscarReferenciaEnMemoria } = require("../services/google");
const { transcribirAudio, extraerUbicaciones } = require("../services/openai");
const { promoCodigosActiva, crearCodigoPromo, validarCodigoPromo, enviarCodigoDescuento, esIntentoCancelar, esPedidoAyuda, detectarIncompatibilidadMoto, construirBotonesHistorial, sugerenciaPorHora, buscarEsquinaMapeada, guardarEsquina, obtenerLugarPersonal, guardarLugarPersonal, evaluarReferencia, mensajePidiendoReferencia, calcularPrecio } = require("../services/utils");
const { calcularMultiplierSurge, aplicarSurge, textoSurge } = require("../ai");
const { generarAudioDesdeTexto } = require("../services/openai");
const { enviarVoz } = require("../services/whatsapp");
const { asignarChofer, procesarCancelacionPasajero, procesarPedidoAyuda, registrarRating } = require("../flows/viaje");
const { buscarChoferDisponibleTraccar } = require("../services/traccar");
const { procesarMensajeChofer } = require("../flows/chofer");

// ─── SISTEMA DE VOZ GLOBAL (Opción C: espejo + forzado) ──────────────────────
// enviarMensaje() es un wrapper inteligente: si el usuario está en modo voz
// (mandó audio, o tiene respuestasPorVoz/modoAdultoMayor), responde HABLANDO.
// Si no, manda texto normal. Así TODO el flujo responde por voz automáticamente
// sin tener que tocar cada uno de los ~97 mensajes.
//
// Cache corto en memoria para no consultar la DB en cada mensaje (mismo phone).
const _vozCache = new Map(); // phone -> { usaVoz: bool, ts: number }

async function _usuarioUsaVoz(phone) {
  const cached = _vozCache.get(phone);
  if (cached && Date.now() - cached.ts < 60000) return cached.usaVoz;
  try {
    const usuario = await Usuario.findOne({ phone }).lean();
    const session = await getSession(phone);
    const usaVoz = !!(usuario?.respuestasPorVoz || usuario?.modoAdultoMayor || session?.ultimaInteraccionVoz);
    _vozCache.set(phone, { usaVoz, ts: Date.now() });
    return usaVoz;
  } catch {
    return false;
  }
}

// Marca/desmarca el modo voz para un phone (actualiza cache al instante)
function _setVozCache(phone, usaVoz) {
  _vozCache.set(phone, { usaVoz, ts: Date.now() });
}

// Wrapper de enviarMensaje: decide voz o texto automáticamente
async function enviarMensaje(phone, texto) {
  if (await _usuarioUsaVoz(phone)) {
    const audio = await generarAudioDesdeTexto(limpiarParaVoz(texto));
    if (audio) {
      const ok = await enviarVoz(phone, audio);
      if (ok) return; // voz enviada con éxito, no mandar texto
    }
    // Si falló la voz, cae a texto (no dejar al usuario sin respuesta)
  }
  await enviarMensajeRaw(phone, texto);
}

// Wrapper de enviarBotones: los botones SIEMPRE van como texto (el usuario los necesita ver
// para tocarlos), pero si está en modo voz, primero le mandamos un audio leyendo el mensaje.
// textoVoz opcional: versión corta/natural para el audio (si no, usa el texto visual).
async function enviarBotones(phone, texto, botones, textoVoz) {
  if (await _usuarioUsaVoz(phone)) {
    const audio = await generarAudioDesdeTexto(limpiarParaVoz(textoVoz || texto));
    if (audio) await enviarVoz(phone, audio);
  }
  await enviarBotonesRaw(phone, texto, botones);
}

// Limpia texto para que el TTS no lea emojis, markdown ni URLs en voz alta
function limpiarParaVoz(texto) {
  let t = texto
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ". ")
    .replace(/\.\s*\.+/g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();

  // Acortar para voz: los audios largos tardan demasiado en generarse (timeout)
  // y nadie quiere escuchar un audio de un minuto. Si es muy largo, cortar al
  // primer tramo con sentido (hasta ~280 caracteres, terminando en una oración).
  const MAX_VOZ = 280;
  if (t.length > MAX_VOZ) {
    const corte = t.slice(0, MAX_VOZ);
    const ultimoPunto = corte.lastIndexOf(". ");
    t = ultimoPunto > 100 ? corte.slice(0, ultimoPunto + 1) : corte + "...";
  }
  return t;
}


async function preguntarOpcionesViaje(phone, session) {
  // Guard: si falta origen o destino, pedir lo que falta en lugar de crashear
  if (!session.origen?.lat) {
    await updateSession(phone, { ...session, step: "esperando_origen" });
    await enviarMensaje(phone, "📍 Necesito tu *ubicación de origen* para continuar.\n\nUsa el 📎 adjunto → Ubicación.");
    return;
  }
  if (!session.destino?.lat) {
    await updateSession(phone, { ...session, step: "esperando_destino" });
    await enviarMensaje(phone, "🏁 Necesito tu *ubicación de destino* para continuar.\n\nUsa el 📎 adjunto → Ubicación.");
    return;
  }

  await updateSession(phone, { ...session, step: "preguntando_opciones" });
  const numParadas = (session.paradas || []).length;
  const yaTieneObs = !!session.observaciones;

  let resumen = `🗺️ *Resumen del viaje*\n\n`;
  resumen += `📍 Origen: ${session.origen?.nombre || "Tu ubicación"}\n`;
  if (numParadas > 0) session.paradas.forEach((p, i) => { resumen += `🚏 Parada ${i + 1}: ${p.nombre || "ubicación"}\n`; });
  resumen += `🏁 Destino: ${session.destino?.nombre || "Tu destino"}\n`;
  if (yaTieneObs) resumen += `\n📝 Notas: _${session.observaciones}_\n`;
  resumen += `\n¿Quieres agregar algo más antes de calcular el precio?`;

  const botones = [];
  if (numParadas < CONFIG.MAX_PARADAS) botones.push({ id: "agregar_parada", title: "🚏 Agregar parada" });
  if (!yaTieneObs) botones.push({ id: "agregar_observacion", title: "📝 Notas" });
  botones.push({ id: "ver_precio", title: "💰 Ver precio" });

  await enviarBotones(phone, resumen, botones);
}

// ─── FLUJO RÁPIDO POR VOZ (adultos mayores / audio claro) ────────────────────
// Cuando origen y destino ya están resueltos y el usuario va por voz, salta la
// cadena de botones: calcula precio, ve si hay auto cerca, y pregunta por voz
// "tengo un móvil a X min, cuesta Y Bs, ¿confirmo?". El usuario responde "sí"
// por audio (o toca un botón de respaldo). Devuelve true si manejó el flujo.
async function flujoRapidoVoz(phone, session) {
  try {
    if (!session.origen?.lat || !session.destino?.lat) return false;

    const { km, duracion } = await calcularDistancia(session.origen, session.destino);
    const auto = calcularPrecio(km, "auto");
    const { multiplier } = await calcularMultiplierSurge(session.origen?.lat, session.origen?.lng);
    const precioAuto = aplicarSurge(auto.total, multiplier);

    // Ver si hay un chofer cerca
    let infoChofer;
    try {
      const chofer = await buscarChoferDisponibleTraccar(session.origen, [], "auto");
      if (chofer?.ubicacion?.minutos != null) {
        const min = Math.max(chofer.ubicacion.minutos, 2);
        infoChofer = `Tengo un móvil cerca, a unos ${min} minutos. `;
      } else {
        infoChofer = "Voy a buscar un móvil para usted. ";
      }
    } catch {
      infoChofer = "Voy a buscar un móvil para usted. ";
    }

    await updateSession(phone, {
      ...session,
      distancia: km,
      duracionEstimada: duracion,
      precioAuto,
      tipoVehiculo: "auto",
      multiplier,
      step: "confirmando_viaje_voz",
    });

    // Texto de tiempo limpio (duracion puede venir como número o con "min")
    const minNum = typeof duracion === "number" ? duracion : parseInt(String(duracion)) || null;
    const tiempoTxt = minNum ? `unos ${minNum} minutos` : "pocos minutos";

    // Mensaje de VOZ: el audio dice todo y pide confirmar hablando
    const mensajeVoz =
      `${infoChofer}El viaje a ${session.destino?.nombre || "su destino"} ` +
      `dura ${tiempoTxt} y le cuesta ${precioAuto} bolivianos. ` +
      `Si está de acuerdo, respóndame con un sí.`;

    // Texto VISUAL mínimo de referencia (el audio ya dice todo, incluyendo "responda sí")
    const mensajeTexto = `🚗 ${session.destino?.nombre || "Tu viaje"} — *Bs ${precioAuto}*`;

    // Como la IA entendió todo con claridad, vamos por VOZ PURA (sin botones).
    // El usuario confirma diciendo "sí" por audio. El step confirmando_viaje_voz
    // intercepta su próximo audio y lo interpreta.
    if (await _usuarioUsaVoz(phone)) {
      const audio = await generarAudioDesdeTexto(limpiarParaVoz(mensajeVoz));
      if (audio) await enviarVoz(phone, audio);
      await enviarMensajeRaw(phone, mensajeTexto); // referencia visual corta
    } else {
      // Respaldo (no debería pasar en flujo voz, pero por seguridad): botones
      await enviarBotonesRaw(phone, `🚗 ${session.destino?.nombre || "Tu viaje"} — Bs ${precioAuto}\n\n¿Confirmo el viaje?`, [
        { id: "confirmar_viaje_voz_si", title: "✅ Sí, confirmar" },
        { id: "confirmar_viaje_voz_no", title: "❌ No" },
      ]);
    }
    return true;
  } catch (e) {
    log.error("[FLUJO_VOZ]", e.message);
    return false;
  }
}

// Detecta si una transcripción de audio corto significa "sí" o "no"
function interpretarSiNo(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase().trim().replace(/[.,!¡¿?]/g, "");

  // Frases de duda que NO son rechazo (no cancelar el viaje por estas)
  const dudas = ["no se", "no sé", "no entiendo", "no escucho", "no oigo", "no sé qué", "no estoy seguro"];
  for (const d of dudas) if (t.includes(d)) return null;

  const siPalabras = ["si", "sí", "sa", "ya", "yap", "claro", "dale", "bueno", "esta bien", "está bien", "confirmo", "confirma", "acepto", "ok", "okay", "okey", "correcto", "afirmativo", "de acuerdo"];
  const noPalabras = ["no", "nop", "para nada", "mejor no", "cancela", "cancelar", "negativo", "no quiero", "no gracias"];

  // "sí" tiene prioridad si aparece claramente
  for (const s of siPalabras) if (t === s || t.includes(s)) return "si";
  // "no" solo como palabra sola, al inicio claro, o frases de rechazo explícito
  for (const n of noPalabras) if (t === n || t.startsWith(n + " ") || t.startsWith(n + ",")) return "no";
  return null;
}

async function procesarCalculoViaje(phone, session) {
  await updateSession(phone, { ...session, step: "calculando" });
  await enviarMensajeRaw(phone, "⏳ Calculando ruta y precio...");

  try {
    const paradas = session.paradas || [];
    const { km, duracion, esAproximado } = paradas.length > 0
      ? await calcularDistanciaConParadas(session.origen, paradas, session.destino)
      : await calcularDistancia(session.origen, session.destino);

    const auto = calcularPrecio(km, "auto");
    const moto = calcularPrecio(km, "moto");

    // IA PRICING: calcular surge según demanda y hora
    const { multiplier, motivos } = await calcularMultiplierSurge(session.origen?.lat, session.origen?.lng);
    const precioAutoFinal = aplicarSurge(auto.total, multiplier);
    const precioMotoFinal = aplicarSurge(moto.total, multiplier);
    const textoSurgeMsg = textoSurge(multiplier, motivos);

    const nuevaSession = {
      ...session,
      distancia: km,
      precioAuto: precioAutoFinal,
      precioMoto: precioMotoFinal,
      precioPorKmAuto: auto.precioPorKm,
      precioPorKmMoto: moto.precioPorKm,
      surgeMultiplier: multiplier,
      step: "eligiendo_tipo_vehiculo",
    };
    await setSession(phone, nuevaSession);

    const avisoAprox = esAproximado ? "\n_(distancia aproximada)_" : "";
    let extras = "";
    if (paradas.length > 0) extras += `🚏 ${paradas.length} parada(s)\n`;
    if (session.observaciones) extras += `📝 _${session.observaciones}_\n`;
    const avisoSurge = textoSurgeMsg ? `\n${textoSurgeMsg}\n` : "";

    await enviarBotones(
      phone,
      `🗺️ *Resumen del viaje*\n\n` +
        `📍 Origen: ${session.origen.nombre || "Tu ubicación"}\n` +
        `🏁 Destino: ${session.destino.nombre || "Tu destino"}\n` +
        (extras ? `\n${extras}` : "") +
        `\n📏 Distancia: ${km} km${avisoAprox}\n` +
        `⏱️ Tiempo: ${duracion}\n` +
        avisoSurge +
        `\n*Elige tu tipo de viaje:*\n\n` +
        `🚗 *Auto* — Bs ${precioAutoFinal}\n` +
        `🏍️ *Moto* — Bs ${precioMotoFinal}\n\n` +
        `_(Si eliges Moto te llegará una motocicleta. Recuerda llevar casco si tienes uno.)_`,
      [
        { id: "elegir_auto", title: "🚗 Pedir Auto" },
        { id: "elegir_moto", title: "🏍️ Pedir Moto" },
        { id: "cancelar_viaje", title: "❌ Cancelar" },
      ]
    );
  } catch (e) {
    log.error("[CALCULO_PRECIO]", e.message, e.stack);
    // Notificar al admin para investigar
    try {
      await enviarMensaje(
        CONFIG.ADMIN_PHONE,
        `🐛 *Error calculando precio*\n\nPasajero: +${phone}\nOrigen: ${session.origen?.nombre || "?"}\nDestino: ${session.destino?.nombre || "?"}\nError: ${e.message}`
      );
    } catch {}
    await enviarMensaje(phone, "❌ Hubo un problema calculando el precio. Ya estamos viendo qué pasó — intenta de nuevo en un momento.");
    await updateSession(phone, { ...session, step: "esperando_origen" });
  }
}

// ─── COMANDO "MIS LUGARES" ──────────────────────────────────────────────────
// Detecta si el usuario escribió un comando relacionado con gestionar sus lugares
function esComandoLugares(txt) {
  if (!txt) return false;
  const t = String(txt).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  // Comandos exactos
  const exactos = ["mis lugares", "lugares", "mis sitios", "lugares guardados", "guardar casa", "guardar trabajo", "mi casa", "mi trabajo"];
  if (exactos.includes(t)) return true;
  // O empieza con "guardar mi" / "borrar mi" / etc.
  if (/^(guardar|borrar|eliminar|cambiar|editar)\s+(mi\s+)?(casa|trabajo|hogar|oficina)/.test(t)) return true;
  return false;
}

async function mostrarMenuLugares(phone) {
  const u = await Usuario.findOne({ phone }).lean();
  const lf = u?.lugaresFrecuentes || {};
  
  let texto = "📌 *Mis lugares guardados*\n\n";
  texto += `🏠 *Casa:* ${lf.casa?.nombre || "_no guardada_"}\n`;
  texto += `💼 *Trabajo:* ${lf.trabajo?.nombre || "_no guardado_"}\n\n`;
  texto += "Cuando los tengas guardados, podés decir por audio:\n";
  texto += '• 🎤 _"llévame a casa"_\n';
  texto += '• 🎤 _"salgo del trabajo"_\n\n';
  texto += "¿Qué querés hacer?";
  
  const botones = [];
  botones.push({ id: lf.casa?.lat ? "lugares_cambiar_casa" : "lugares_guardar_casa", title: lf.casa?.lat ? "🏠 Cambiar casa" : "🏠 Guardar casa" });
  botones.push({ id: lf.trabajo?.lat ? "lugares_cambiar_trabajo" : "lugares_guardar_trabajo", title: lf.trabajo?.lat ? "💼 Cambiar trabajo" : "💼 Guardar trabajo" });
  botones.push({ id: "lugares_volver", title: "↩️ Volver" });
  
  await deleteSession(phone); // limpiar cualquier flujo previo
  await setSession(phone, { step: "gestionando_lugares" });
  await enviarBotones(phone, texto, botones);
}

async function procesarMensajeUsuario(phone, mensaje, buttonId) {
  let usuario = await Usuario.findOne({ phone });

  // Términos y condiciones
  // Bloque de onboarding (términos + nombre): entrar si NO terminó el setup
  const sesionPrevia = await getSession(phone);

  // Expirar sesiones de confirmación viejas: si quedó un viaje a medio confirmar
  // (el pasajero no respondió "sí/no" y se fue), no debe mezclarse con un pedido
  // nuevo. Si pasaron más de 5 minutos en un step de confirmación, se descarta.
  if (sesionPrevia?.updatedAt && sesionPrevia.step) {
    const stepsConfirmacion = ["confirmando_viaje_voz", "confirmando_ubicaciones_voz", "preguntando_opciones", "eligiendo_tipo_vehiculo", "ofreciendo_codigo"];
    if (stepsConfirmacion.includes(sesionPrevia.step)) {
      const edadMin = (Date.now() - new Date(sesionPrevia.updatedAt).getTime()) / 60000;
      if (edadMin > 5) {
        log.info(`[SESSION] Confirmación vieja (${Math.round(edadMin)}min) en ${sesionPrevia.step} — descartada`);
        await deleteSession(phone);
        sesionPrevia.step = null; // tratar como sesión fresca de acá en adelante
      }
    }
  }

  const enFlujoNombre = sesionPrevia && sesionPrevia.step === "esperando_nombre_usuario";
  if (!usuario || !usuario.aceptoTerminos || enFlujoNombre) {
    let session = sesionPrevia || { step: "usuario_terminos" };

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
        await setSession(phone, { step: "esperando_nombre_usuario" });
        await enviarMensaje(phone, `✅ ¡Bienvenido a ChatGo!\n\n¿Cuál es tu nombre? Así el chofer sabrá a quién buscar cuando llegue. 😊`);
      } else {
        await enviarMensaje(phone, "Para usar ChatGo debes aceptar los términos.");
        await deleteSession(phone);
      }
      return;
    }

    if (session.step === "esperando_nombre_usuario") {
      const nombreIngresado = mensaje.text?.body?.trim() || "";
      if (!nombreIngresado || nombreIngresado.length < 2) {
        await enviarMensaje(phone, "Por favor escribe tu nombre para continuar.");
        return;
      }
      const nombreLimpio = nombreIngresado.slice(0, 40);
      await Usuario.findOneAndUpdate({ phone }, { nombre: nombreLimpio });
      await deleteSession(phone);
      await enviarMensaje(
        phone,
        `👋 ¡Hola, ${nombreLimpio}! Ya estás listo para pedir tu taxi.\n\n` +
        `📍 Envía tu ubicación de origen usando el pin de WhatsApp.\n\n` +
        `También puedes:\n• Enviar un 🎤 audio de voz diciendo a dónde quieres ir\n• Compartir un link de 🗺️ Google Maps\n\n` +
        `_⚠️ La función de audio está en desarrollo — puede cometer errores. Si algo falla usa el pin._`
      );
      if (promoCodigosActiva()) {
        try {
          const codigo = await crearCodigoPromo(phone, "bienvenida");
          if (codigo) await enviarCodigoDescuento(phone, codigo, "tu primer viaje");
        } catch (e) { log.error("[PROMO] Error código bienvenida:", e.message); }
      }
      return;
    }
  }

  // ⚡ MEJORA: usuarios ANTIGUOS que aceptaron términos en el bot viejo pero
  // nunca dieron su nombre. Se lo pedimos antes de dejarlos pedir viaje, así
  // el chofer siempre sabe a quién busca.
  if (usuario && usuario.aceptoTerminos && (!usuario.nombre || usuario.nombre.trim().length < 2)) {
    let sName = await getSession(phone);
    // Evitar pedir nombre si ya está en el flujo nuevo de nombre
    if (sName && (sName.step === "esperando_nombre_usuario" || sName.step === "usuario_esperando_tc")) {
      // Ya está en el flujo correcto — no interrumpir
    } else if (sName && sName.step === "esperando_nombre_usuario_legacy") {
      const nombreIngresado = mensaje.text?.body?.trim() || "";
      if (!nombreIngresado || nombreIngresado.length < 2) {
        await enviarMensaje(phone, "Por favor escribe tu nombre para continuar. 😊");
        return;
      }
      const nombreLimpio = nombreIngresado.slice(0, 40);
      await Usuario.findOneAndUpdate({ phone }, { nombre: nombreLimpio });
      await deleteSession(phone);
      await enviarMensaje(
        phone,
        `👋 ¡Gracias, ${nombreLimpio}! Ya podemos continuar.\n\n` +
        `📍 Envía tu ubicación de origen usando el pin de WhatsApp.\n\n` +
        `También puedes:\n• Enviar un 🎤 audio diciendo a dónde quieres ir\n• Compartir un link de 🗺️ Google Maps`
      );
      return;
    } else {
      // Primera vez que lo detectamos sin nombre: se lo pedimos
      await setSession(phone, { step: "esperando_nombre_usuario_legacy" });
    await enviarMensaje(
      phone,
      `👋 ¡Hola de nuevo! Antes de continuar necesitamos un dato:\n\n` +
      `¿Cuál es tu nombre? Así el chofer sabe a quién buscar cuando llegue. 😊`
    );
    return;
    } // cierre else
  }

  let session = await ensureSession(phone, { step: "inicio" });
  const texto = mensaje.text?.body?.trim() || "";
  const textoUpper = texto.toUpperCase();

  // ESPEJO bidireccional: si el usuario escribe texto real (no botón), volver a modo texto.
  // Si manda audio, el bloque de audio reactiva el modo voz.
  if (texto && !buttonId && mensaje.type !== "audio" && mensaje.type !== "voice") {
    _setVozCache(phone, false);
    try {
      const s = await getSession(phone);
      if (s?.ultimaInteraccionVoz) await updateSession(phone, { ...s, ultimaInteraccionVoz: false });
    } catch {}
  }

  // ─── COMANDO DE PRUEBA TTS (temporal, para diagnóstico) ─────────────────
  // Escribir "/voz algo" hace que el bot responda eso en audio. Para verificar TTS.
  if (texto && texto.toLowerCase().startsWith("/voz")) {
    const textoAProbar = texto.slice(4).trim() || "Hola, esta es una prueba de voz de ChatGo. Si escuchas este mensaje, el sistema funciona correctamente.";
    await enviarMensajeRaw(phone, "🔊 Generando audio de prueba...");
    const audio = await generarAudioDesdeTexto(textoAProbar);
    if (!audio) {
      await enviarMensaje(phone, "❌ Falló la generación del audio (TTS). Revisa los logs [TTS].");
      return;
    }
    const ok = await enviarVoz(phone, audio);
    if (!ok) {
      await enviarMensaje(phone, "⚠️ El audio se generó pero falló el envío a WhatsApp. Revisa los logs [WSP] enviarVoz.");
    }
    return;
  }

  // ─── COMANDO ADMIN: cargar lugares de una ciudad desde WhatsApp ──────────
  // "cargar santa cruz" → pre-carga cientos de lugares con Google Places.
  // Solo el admin puede usarlo. Evita tener que correr scripts en terminal.
  if (texto && /^cargar\s+/i.test(texto) && phone === CONFIG.ADMIN_PHONE) {
    const nombreCiudad = texto.replace(/^cargar\s+/i, "").trim();
    const ciudadCargar = detectarCiudadPorTexto(nombreCiudad);
    if (!ciudadCargar) {
      await enviarMensajeRaw(phone, `❌ No reconocí esa ciudad. Ejemplo: *cargar santa cruz*`);
      return;
    }
    await enviarMensajeRaw(phone, `⏳ Cargando lugares de *${ciudadCargar}* desde Google Places...\n\nEsto puede tardar 1-2 minutos. Te aviso cuando termine.`);
    try {
      const { precargarCiudad } = require("../services/precarga");
      const resultado = await precargarCiudad(ciudadCargar, async (msg) => {
        await enviarMensajeRaw(phone, `📍 ${msg}`);
      });
      if (resultado.error === "REQUEST_DENIED") {
        await enviarMensajeRaw(phone, `❌ Places API no está habilitada en Google Cloud.\n\nActívala en:\nhttps://console.cloud.google.com/apis/library/places-backend.googleapis.com\n\nDetalle: ${resultado.mensaje || "REQUEST_DENIED"}`);
      } else if (resultado.error) {
        await enviarMensajeRaw(phone, `❌ Error: ${resultado.error}`);
      } else {
        await enviarMensajeRaw(phone, `✅ *${ciudadCargar} cargada.*\n\n📍 ${resultado.guardados} lugares reales guardados\n🗑️ ${resultado.descartados} descartados (fuera de zona)\n\nAhora ChatGo conoce estos lugares. Probá pidiendo un viaje por voz.`);
      }
    } catch (e) {
      log.error("[CMD_CARGAR]", e.message);
      await enviarMensajeRaw(phone, `❌ Falló la carga: ${e.message}`);
    }
    return;
  }

  // ─── COMANDO: fijar ciudad del usuario ──────────────────────────────────
  // Escribir "ciudad santa cruz" (o "/ciudad ...") fija la ciudad del perfil.
  // Esto hace que TODO lo que el usuario pida se busque en esa ciudad.
  // Clave para demos en otra ciudad: el pasajero "está" donde diga su perfil.
  if (texto && /^\/?ciudad\s+/i.test(texto)) {
    const nombreCiudad = texto.replace(/^\/?ciudad\s+/i, "").trim();
    const ciudadDetectada = detectarCiudadPorTexto(nombreCiudad);
    if (ciudadDetectada) {
      await Usuario.findOneAndUpdate({ phone }, { ciudad: ciudadDetectada }, { upsert: true });
      await updateSession(phone, { ...session, ciudadUsuario: ciudadDetectada });
      await enviarMensaje(phone, `✅ Ciudad fijada en *${ciudadDetectada}*.\n\nAhora todos tus viajes se buscarán en ${ciudadDetectada}. Para cambiarla, escribe "ciudad" y el nombre de otra.`);
    } else {
      const disponibles = Object.keys(CIUDADES).join(", ");
      await enviarMensaje(phone, `❌ No reconocí esa ciudad.\n\nCiudades disponibles: ${disponibles}.\n\nEjemplo: escribe *ciudad santa cruz*`);
    }
    return;
  }

  // ─── CANCELACIÓN por palabra clave ──────────────────────────────────────
  // ─── Comando: "mis lugares" / "casa" / "trabajo" ───────────────────────
  // Detección por texto libre — el usuario quiere gestionar sus lugares guardados
  if (texto && !buttonId && esComandoLugares(texto)) {
    await mostrarMenuLugares(phone);
    return;
  }
  
  if (texto && !buttonId && esIntentoCancelar(texto)) {
    // Estados con viaje activo → confirmar antes de cancelar
    const stepsViaje = ["esperando_chofer","chofer_en_camino","chofer_esperando_pasajero","sin_chofer","confirmado","esperando_confirmacion","en_curso"];
    // Estados de flujo de pedido → cancelar directo sin confirmar
    const stepsPedido = ["esperando_origen","esperando_origen_con_destino","esperando_destino","eligiendo_historial","preguntando_opciones","calculando","eligiendo_tipo_vehiculo","confirmando_moto_incompatible","ofreciendo_codigo","esperando_codigo","esperando_parada","esperando_observacion","confirmando_ubicaciones_voz","confirmando_viaje_voz","aprendiendo_origen_voz","aprendiendo_destino_voz"];

    if (stepsViaje.includes(session.step)) {
      await updateSession(phone, { ...session, step: "confirmando_cancelacion" });
      await enviarBotones(phone, `⚠️ ¿Estás seguro de cancelar tu viaje?`, [
        { id: "confirmar_cancelacion", title: "✅ Sí, cancelar" },
        { id: "no_cancelar", title: "❌ No, seguir" },
      ]);
      return;
    }
    if (stepsPedido.includes(session.step)) {
      await deleteSession(phone);
      await enviarMensaje(phone, "❌ Pedido cancelado. Escribe cuando quieras pedir un taxi. 🚖");
      return;
    }
  }

  // ─── COPILOTO IA: respuesta del pasajero a alerta de seguridad ───────────
  if (buttonId === "seg_todo_bien" || buttonId === "seg_necesito_ayuda") {
    const { manejarRespuestaPasajero } = require("../ai/copiloto");
    const viajeSeg = await Viaje.findOne({
      usuarioPhone: phone,
      estado: { $in: ["en_curso", "esperando_pasajero", "en_camino"] },
    }).sort({ createdAt: -1 });
    if (viajeSeg) {
      await manejarRespuestaPasajero(viajeSeg, buttonId);
    } else {
      await enviarMensaje(phone, "No encontramos un viaje activo. Si es una emergencia, llama al 110.");
    }
    return;
  }

  // ─── COPILOTO IA: botón de pánico manual del pasajero ────────────────────
  if (buttonId === "seg_panico" || (texto && !buttonId && /\b(emergencia|auxilio|ayuda urgente|me est[aá]n|s[aá]quenme|secuestr)\b/i.test(texto))) {
    const { activarPanico } = require("../ai/copiloto");
    const viajePanico = await Viaje.findOne({
      usuarioPhone: phone,
      estado: { $in: ["en_curso", "esperando_pasajero", "en_camino"] },
    }).sort({ createdAt: -1 });
    if (viajePanico) {
      await activarPanico(viajePanico, "pasajero");
      await enviarMensaje(phone, "🆘 Alerta enviada. Nuestro equipo fue notificado y seguimos tu ubicación. Si es grave, llama al 110.");
    }
    return;
  }

  // ─── AYUDA por palabra clave ─────────────────────────────────────────────
  if (texto && !buttonId && esPedidoAyuda(texto)) {
    await procesarPedidoAyuda(phone, false);
    return;
  }

  // ─── Botones post-rating ─────────────────────────────────────────────────
  // ─── Handlers de TIP post-viaje ─────────────────────────────────────────
  if (buttonId === "tip_guardar_casa") {
    await setSession(phone, { step: "guardando_lugar_personal_origen", lugarPersonalPendiente: "casa", desdeMenu: true });
    await enviarMensaje(phone,
      `🏠 Genial, vamos a guardar tu casa.\n\n` +
      `Mandame el 📍 *pin de tu casa* ahora.\n` +
      `(Si estás ahí ahora, mejor — más preciso)\n\n` +
      `Usá el 📎 adjunto → Ubicación.`
    );
    return;
  }
  if (buttonId === "tip_guardar_trabajo") {
    await setSession(phone, { step: "guardando_lugar_personal_origen", lugarPersonalPendiente: "trabajo", desdeMenu: true });
    await enviarMensaje(phone,
      `💼 Genial, vamos a guardar tu trabajo.\n\n` +
      `Mandame el 📍 *pin de tu trabajo* ahora.\n\n` +
      `Usá el 📎 adjunto → Ubicación.`
    );
    return;
  }
  if (buttonId === "tip_mas_tarde") {
    await deleteSession(phone);
    await enviarMensaje(phone,
      `👍 Sin problema. Cuando quieras guardarlo, escribí _"mis lugares"_ 📌`
    );
    return;
  }
  
  // Respuesta del pasajero a finalización sospechosa
  if (buttonId?.startsWith("viaje_ok_")) {
    await enviarMensaje(phone, "✅ Gracias por confirmar. ¡Nos alegra que hayas llegado bien!");
    return;
  }

  if (buttonId?.startsWith("viaje_problema_")) {
    const viajeId = buttonId.replace("viaje_problema_", "");
    // Registrar incidente en MongoDB
    await Viaje.findByIdAndUpdate(viajeId, {
      incidenteReportado: true,
      incidenteDescripcion: "Pasajero reportó que no llegó al destino",
      incidenteFecha: new Date(),
    }).catch(() => {});
    // Notificar al admin
    await enviarMensaje(
      CONFIG.ADMIN_PHONE,
      `🚨 *Incidente confirmado por pasajero*\n\n📞 Pasajero: +${phone}\n🆔 Viaje: ${viajeId}\n\nEl pasajero indicó que NO llegó a su destino.`
    );
    await enviarMensaje(phone, "⚠️ Gracias por reportarlo. Hemos notificado al equipo de ChatGo para revisar este caso. Lamentamos los inconvenientes.");
    return;
  }

  if (buttonId === "pedir_otro_taxi") {
    await deleteSession(phone);
    // Redirigir al flujo normal de inicio
    await procesarMensajeUsuario(phone, mensaje, null);
    return;
  }
  if (buttonId === "no_por_ahora") {
    await enviarMensaje(phone, `👍 ¡Hasta la próxima! Escribe cuando necesites taxi. 🚖`);
    return;
  }
  if (buttonId === "contactar_soporte") {
    await procesarPedidoAyuda(phone, false);
    return;
  }

  // ─── Botones historial ───────────────────────────────────────────────────
  // ─── COPILOTO DE HÁBITOS: el usuario aceptó la sugerencia por hora ────────
  if (buttonId === "sug_aceptar") {
    const sug = session.sugerencia;
    if (sug?.destino && sug?.origen) {
      // Tenemos origen Y destino habituales → vamos directo a calcular precio
      await updateSession(phone, {
        ...session,
        origen: sug.origen,
        destino: sug.destino,
        tipoVehiculoSugerido: sug.tipoVehiculo,
        step: "preguntando_opciones",
      });
      await enviarMensaje(phone, `🎯 ¡Perfecto! Vamos desde *${sug.origen.nombre || "tu origen habitual"}* hasta *${sug.destino.nombre || "tu destino habitual"}*.`);
      await preguntarOpcionesViaje(phone, await ensureSession(phone, {}));
    } else if (sug?.destino) {
      await updateSession(phone, { ...session, destino: sug.destino, step: "esperando_origen_con_destino" });
      await enviarMensaje(phone, `🎯 ¡Perfecto! Vamos a *${sug.destino.nombre || "tu destino habitual"}*.\n\n📍 Envíame tu *ubicación actual* para recogerte.`);
    } else {
      await updateSession(phone, { ...session, step: "esperando_origen" });
      await enviarMensaje(phone, "📍 Envía tu ubicación de origen con el pin.");
    }
    return;
  }

  if (buttonId === "sug_rechazar") {
    await updateSession(phone, { ...session, step: "esperando_origen" });
    await enviarMensaje(phone, "👍 Sin problema. 📍 Envíame tu *ubicación de origen* con el pin de WhatsApp, o mándame un 🎤 audio diciendo a dónde quieres ir.");
    return;
  }

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
    // OPCIÓN C - ESPEJO: el usuario mandó audio → el bot le responde por voz
    await updateSession(phone, { ...session, ultimaInteraccionVoz: true });
    session = { ...session, ultimaInteraccionVoz: true };
    _setVozCache(phone, true); // activar voz al instante (sin esperar la DB)

    // INTERCEPCIÓN: si estamos esperando que confirme el viaje por voz (sí/no),
    // transcribir el audio corto e interpretarlo como sí o no.
    if (session.step === "confirmando_viaje_voz") {
      try {
        const audioUrl = await obtenerUrlMedia(mensaje.audio?.id || mensaje.voice?.id);
        const transcripcion = await transcribirAudio(audioUrl);
        const decision = interpretarSiNo(transcripcion);

        // Distinguir: ¿es una confirmación corta ("sí"/"no") o un PEDIDO NUEVO?
        // Si el audio es largo (varias palabras) y menciona ir/llevar/calles, es un
        // viaje nuevo, NO una confirmación del viaje anterior. Evita asignar al chofer
        // un viaje viejo cuando el pasajero en realidad pidió otro.
        const palabras = (transcripcion || "").trim().split(/\s+/).length;
        const pareceePedidoNuevo = palabras > 5 && /\b(ir|vamos|ll[eé]vame|llevar|desde|hasta|hacia|quiero|necesito|av\.|avenida|calle|plaza)\b/i.test(transcripcion || "");

        if (decision && !pareceePedidoNuevo) {
          // Es una confirmación clara (sí/no) y NO parece un pedido nuevo
          if (decision === "si") {
            const sessionViaje = { ...session, tipoVehiculo: session.tipoVehiculo || "auto", precioFinal: session.precioAuto };
            await asignarChofer(phone, sessionViaje);
          } else {
            await deleteSession(phone);
            await setSession(phone, { step: "inicio" });
            await enviarMensaje(phone, "Está bien, cancelé el viaje. Cuando quiera otro, solo dígame a dónde quiere ir. 🚖");
          }
          return;
        }

        if (pareceePedidoNuevo) {
          // El pasajero pidió un viaje NUEVO mientras había uno sin confirmar.
          // Descartamos el anterior y procesamos este como pedido fresco.
          log.info(`[VOZ] Pedido nuevo durante confirmación pendiente — reiniciando viaje`);
          await deleteSession(phone);
          session = { step: null, ultimaInteraccionVoz: true };
          await setSession(phone, session);
          // (cae al procesamiento normal de audio más abajo)
        } else {
          // No se entendió y no parece pedido nuevo — volver a preguntar
          await enviarMensaje(phone, "No le entendí bien. ¿Confirmo el viaje? Por favor dígame *sí* o *no*.");
          return;
        }
      } catch (e) {
        log.error("[VOZ_CONFIRM]", e.message);
        await enviarMensaje(phone, "Tuve un problema escuchando. ¿Confirmo el viaje? Dígame *sí* o *no*.");
        return;
      }
    }

    // Onboarding de audio: explicar UNA SOLA VEZ cómo funciona y que ayudan a construir el mapa
    const usuarioParaAudio = await Usuario.findOne({ phone }).lean();
    if (!usuarioParaAudio?.audioOnboardingHecho) {
      await enviarMensaje(phone,
        `🎤 *¡Podés pedir tu taxi por voz!*\n\n` +
        `🗺️ Estamos construyendo el mapa de Cochabamba con la ayuda de usuarios como vos.\n\n` +
        `*Para que funcione bien, danos referencias exactas:*\n\n` +
        `✅ *Bien:*\n` +
        `_"Recógeme de la Cancha, esquina Punata y San Martín, y llevame al Stadium en Juan de la Rosa y Libertador"_\n\n` +
        `⚠️ *Menos preciso:*\n` +
        `_"De la Cancha al Stadium"_ ← no sabemos de qué parte exacta\n\n` +
        `*Cómo funciona:*\n` +
        `• Lugar conocido → lo proceso directo ✅\n` +
        `• Lugar desconocido → te pido el pin para mapearlo 📍\n` +
        `• Próxima vez → ya lo sé sin pedir pin 🙌\n\n` +
        `_Gracias por tu paciencia. Cada pin ayuda a todos los usuarios futuros._\n\n` +
        `⏳ Procesando tu audio...`
      );
      // Marcar que ya se explicó — no volver a mostrar este mensaje
      await Usuario.findOneAndUpdate({ phone }, { audioOnboardingHecho: true });
    } else if (!(await _usuarioUsaVoz(phone))) {
      // Solo mostrar "Procesando" si NO está en modo voz (en voz, el audio de respuesta basta)
      await enviarMensajeRaw(phone, "🎤 _Procesando tu audio..._");
    }
    try {
      const audioUrl = await obtenerUrlMedia(mensaje.audio?.id || mensaje.voice?.id);
      const transcripcion = await transcribirAudio(audioUrl);
      // "Escuché" solo en modo texto (en voz sería redundante con el audio de respuesta)
      if (!(await _usuarioUsaVoz(phone))) {
        await enviarMensajeRaw(phone, `🎤 Escuché: _"${transcripcion}"_`);
      }
      const ubicaciones = await extraerUbicaciones(transcripcion);
      // Detalle estructurado (nuevo formato: tipo, calle1, calle2, etc.)
      const detOrigen = ubicaciones.origenDetalle;
      const detDestino = ubicaciones.destinoDetalle;
      
      // ─── CASO 1: Lugar personal (mi casa, mi trabajo) ───────────────────
      // Si el usuario dijo "casa" o "trabajo", buscar en sus lugares guardados
      async function resolverPersonal(det, esOrigen) {
        if (!det || det.tipo !== "personal" || !det.lugar_personal) return null;
        const guardado = await obtenerLugarPersonal(phone, det.lugar_personal);
        if (guardado && guardado.lat && guardado.lng) {
          return { coords: { lat: guardado.lat, lng: guardado.lng, nombre: guardado.nombre || det.lugar_personal } };
        }
        // No tiene guardado — pedirle que mande el pin para guardarlo
        return { necesitaGuardar: true, tipo: det.lugar_personal };
      }
      
      const personalOrigen = await resolverPersonal(detOrigen, true);
      const personalDestino = await resolverPersonal(detDestino, false);
      
      // Si tiene personal NO guardado, pedirle el pin
      if (personalOrigen?.necesitaGuardar || personalDestino?.necesitaGuardar) {
        const tipoLugar = personalOrigen?.necesitaGuardar ? personalOrigen.tipo : personalDestino.tipo;
        const esOrigenPersonal = !!personalOrigen?.necesitaGuardar;
        await updateSession(phone, {
          ...session,
          step: esOrigenPersonal ? "guardando_lugar_personal_origen" : "guardando_lugar_personal_destino",
          lugarPersonalPendiente: tipoLugar,
        });
        await enviarMensaje(phone,
          `📌 No tengo guardado todavía dónde está tu *${tipoLugar}*.\n\n` +
          `Mandame el 📍 pin de tu ${tipoLugar} ahora y lo guardo para que la próxima vez digas "${tipoLugar === "casa" ? "llévame a casa" : "voy al trabajo"}" y lo sepa al toque. 😊\n\n` +
          `Usá el 📎 adjunto → Ubicación.`
        );
        return;
      }
      
      // Si tiene personal SÍ guardado, ya tenemos las coordenadas directamente
      if (personalOrigen?.coords) {
        ubicaciones.origen = personalOrigen.coords.nombre;
        // Inyectar las coords como si fuera un lugar mapeado
        session._personalOrigen = personalOrigen.coords;
      }
      if (personalDestino?.coords) {
        ubicaciones.destino = personalDestino.coords.nombre;
        session._personalDestino = personalDestino.coords;
      }
      
      // ─── CASO 2: Referencia vaga (zona amplia o lugar grande) ────────────
      // Si la IA detecta algo vago, pedir referencia adicional antes de seguir
      const evalOrigenVoz = detOrigen ? evaluarReferencia(detOrigen) : { vaga: false };
      const evalDestinoVoz = detDestino ? evaluarReferencia(detDestino) : { vaga: false };

      // Ciudad del usuario para geocoding correcto (definida acá porque la usamos abajo)
      const usuarioParaGeocode = await Usuario.findOne({ phone }).lean();
      const ciudadParaAudio = session.ciudadUsuario || usuarioParaGeocode?.ciudad || "Cochabamba";

      // Si el lugar YA está en la memoria (pre-cargado o aprendido antes), tiene
      // coordenadas exactas → NO es vago, no hay que pedir más referencias.
      const memOrigen = ubicaciones.origen ? await buscarReferenciaEnMemoria(ubicaciones.origen, ciudadParaAudio) : null;
      const memDestino = ubicaciones.destino ? await buscarReferenciaEnMemoria(ubicaciones.destino, ciudadParaAudio) : null;

      // Solo intervenir si AL MENOS UNO es vago Y no está resuelto por memoria ni coords personales
      const origenVago = evalOrigenVoz.vaga && !personalOrigen?.coords && !memOrigen;
      const destinoVago = evalDestinoVoz.vaga && !personalDestino?.coords && !memDestino;
      
      if (origenVago || destinoVago) {
        // Construir mensaje pidiendo referencias
        let msg = `Te entendí:\n`;
        if (detOrigen) msg += `📍 Origen: *${detOrigen.texto}* ${origenVago ? "⚠️" : "✅"}\n`;
        if (detDestino) msg += `🏁 Destino: *${detDestino.texto}* ${destinoVago ? "⚠️" : "✅"}\n`;
        msg += `\n`;
        
        if (origenVago && destinoVago) {
          msg += `⚠️ Ambos lugares son muy amplios — necesito *esquinas o referencias exactas*.\n\n`;
        } else if (origenVago) {
          msg += `⚠️ El *origen* es muy amplio — necesito una *esquina o referencia*.\n\n`;
        } else {
          msg += `⚠️ El *destino* es muy amplio — necesito una *esquina o referencia*.\n\n`;
        }
        
        const vago = origenVago ? detOrigen : detDestino;
        msg += `🎤 Mandame otro audio diciendo la *esquina* o una referencia clara:\n` +
          `   • "${vago.texto} y [otra calle]"\n` +
          `   • "${vago.texto} esquina [calle]"\n` +
          `   • "${vago.texto} al lado de [referencia conocida]"\n\n` +
          `_O mandame el 📍 pin de ${origenVago && destinoVago ? "las ubicaciones" : (origenVago ? "tu origen" : "tu destino")}._`;

        // FIX: el step debe coincidir con QUÉ ubicación falta, para que el pin se guarde bien.
        // Si solo el destino es vago, esperamos el pin del DESTINO (no del origen).
        if (destinoVago && !origenVago) {
          // Guardar el origen que sí entendimos, y esperar pin del destino
          const sessActualizada = { ...session, step: "aprendiendo_destino_voz", referenciaVozDestino: detDestino.texto };
          // Si el origen del audio se puede resolver, guardarlo
          if (detOrigen) {
            const origenCoords = await geocodificarConMemoria(detOrigen.texto);
            if (origenCoords && !origenCoords._incierto) {
              sessActualizada.origen = { ...origenCoords, nombre: origenCoords.nombre || detOrigen.texto };
            }
          }
          await updateSession(phone, sessActualizada);
        } else if (origenVago && !destinoVago) {
          // Solo el origen es vago: esperar pin del origen, guardar destino si se puede
          const sessActualizada = { ...session, step: "aprendiendo_origen_voz", referenciaVozOrigen: detOrigen.texto };
          if (detDestino) {
            const destinoCoords = await geocodificarConMemoria(detDestino.texto);
            if (destinoCoords && !destinoCoords._incierto) {
              sessActualizada.destino = { ...destinoCoords, nombre: destinoCoords.nombre || detDestino.texto };
            }
          }
          await updateSession(phone, sessActualizada);
        } else {
          // Ambos vagos: pedir origen primero (flujo de dos pasos)
          await updateSession(phone, { ...session, step: "aprendiendo_origen_voz", referenciaVozOrigen: detOrigen.texto, referenciaVozDestino: detDestino?.texto });
        }
        await enviarMensaje(phone, msg);
        return;
      }
      
      // ─── CASO 3: Esquina conocida en memoria compartida ──────────────────
      // Si la IA extrajo esquina con calle1+calle2, buscar en EsquinaMapeada antes de Google
      async function resolverEsquinaCompartida(det) {
        if (!det || det.tipo !== "esquina" || !det.calle1 || !det.calle2) return null;
        const resultado = await buscarEsquinaMapeada(det.calle1, det.calle2, det.zona);
        if (!resultado || !resultado.esquina) return null;
        const esquina = resultado.esquina;
        
        // PROTECCIÓN 3: Si la esquina necesita confirmación (pocos usos o múltiples zonas),
        // no usar coords directo — devolver con bandera para que el bot pregunte
        if (resultado.requiereConfirmacion) {
          log.info(`[CROWDSOURCE] Esquina ${det.calle1} y ${det.calle2} encontrada pero requiere confirmación (usos: ${esquina.usos})`);
          return { 
            lat: esquina.lat, lng: esquina.lng, 
            nombre: `${esquina.calle1} y ${esquina.calle2}${esquina.zona ? " ("+esquina.zona+")" : ""}`,
            requiereConfirmacion: true,
            alternativas: resultado.alternativas || null,
          };
        }
        
        // Esquina confiable: incrementar uso y devolver
        log.info(`[CROWDSOURCE] Esquina conocida confiable: ${det.calle1} y ${det.calle2} → ${esquina.zona || "?"} (usos: ${esquina.usos})`);
        esquina.usos = (esquina.usos || 0) + 1;
        esquina.ultimoUso = new Date();
        esquina.save().catch(()=>{});
        return { lat: esquina.lat, lng: esquina.lng, nombre: `${esquina.calle1} y ${esquina.calle2}${esquina.zona ? " ("+esquina.zona+")" : ""}` };
      }
      
      const esquinaOrigen = await resolverEsquinaCompartida(detOrigen);
      const esquinaDestino = await resolverEsquinaCompartida(detDestino);
      if (esquinaOrigen) session._esquinaOrigen = esquinaOrigen;
      if (esquinaDestino) session._esquinaDestino = esquinaDestino;
      // (El flujo viejo seguirá usando ubicaciones.origen/destino como texto, geocodificará si no las teníamos)

      // Evaluar precisión de las referencias extraídas
      // Si son imprecisas advertimos pero NO bloqueamos — el viaje puede continuar
      // Las advertencias de precisión son largas: útiles en TEXTO, pero en VOZ
      // se vuelven un audio largo que se cuelga y molesta. En modo voz las omitimos
      // (el flujo rápido continúa; el precio puede variar pero el viaje funciona).
      if ((ubicaciones.origen || ubicaciones.destino) && !(await _usuarioUsaVoz(phone))) {
        const evalOrigen = ubicaciones.origen ? evaluarPrecisionReferencia(ubicaciones.origen) : null;
        const evalDestino = ubicaciones.destino ? evaluarPrecisionReferencia(ubicaciones.destino) : null;
        const advertencias = [];

        if (evalOrigen && !evalOrigen.precisa) {
          advertencias.push(
            `⚠️ *Origen poco preciso:* _"${ubicaciones.origen}"_\n` +
            `${evalOrigen.sugerencia || "Intentá dar una esquina o referencia exacta."}`
          );
        }
        if (evalDestino && !evalDestino.precisa) {
          advertencias.push(
            `⚠️ *Destino poco preciso:* _"${ubicaciones.destino}"_\n` +
            `${evalDestino.sugerencia || "Intentá dar una esquina o referencia exacta."}`
          );
        }

        if (advertencias.length > 0) {
          await enviarMensaje(phone,
            advertencias.join("\n\n") +
            `\n\n💰 _Si el lugar no es exacto, el precio calculado podría variar con el real._\n` +
            `_Podés cancelar y mandar el audio de nuevo con más referencias, o continuar._`
          );
        }
      }

      if (!ubicaciones.origen && !ubicaciones.destino) {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(phone,
          "No pude identificar ninguna ubicación en tu audio.\n\n" +
          "📍 Envía el pin de tu origen con el 📎 adjunto → Ubicación."
        );
        return;
      }

      // Función interna: intenta geocodificar, si falla activa aprendizaje colaborativo
      async function resolverUbicacionVoz(referencia, tipoUbic) {
        if (!referencia) return { coords: null, aprender: false };
        const coords = await geocodificarConMemoria(referencia, ciudadParaAudio);
        if (!coords) {
          // No se pudo mapear — pedir pin al usuario para aprenderlo
          log.info(`[APRENDIZAJE] "${referencia}" no mapeado en ${ciudadParaAudio} — solicitando pin al usuario`);
          return { coords: null, aprender: true, referencia, tipoUbic };
        }
        if (coords._incierto) {
          // Google encontró algo pero es una calle genérica — pedir pin para confirmar
          log.info(`[APRENDIZAJE] "${referencia}" incierto — solicitando pin para confirmar`);
          return { coords: null, aprender: true, referencia, tipoUbic, inciertoLink: `https://www.google.com/maps?q=${coords.lat},${coords.lng}` };
        }
        return { coords, aprender: false };
      }

      // Caso: solo origen en el audio
      if (ubicaciones.origen && !ubicaciones.destino) {
        const resultOrigen = await resolverUbicacionVoz(ubicaciones.origen, "origen");
        const { coords, aprender, referencia } = resultOrigen;
        const nombreOrigen = referencia || ubicaciones.origen;
        if (coords) {
          await updateSession(phone, { ...session, origen: { ...coords, nombre: coords.nombre || nombreOrigen }, step: "esperando_destino" });
          await enviarMensaje(phone, `✅ *Origen:* ${nombreOrigen}\n\n🏁 Ahora envía el pin de tu *destino*.`);
        } else if (aprender) {
          const linkVerif = resultOrigen.inciertoLink ? `\n\n🗺️ Google lo encontró aquí: ${resultOrigen.inciertoLink}\nSi no es correcto, mandame el pin exacto.` : "";
          await updateSession(phone, { 
            ...session, 
            step: "aprendiendo_origen_voz", 
            referenciaVozOrigen: nombreOrigen,
            _detOrigenCalle1: detOrigen?.calle1 || null,
            _detOrigenCalle2: detOrigen?.calle2 || null,
            _detOrigenZona: detOrigen?.zona || null,
          });
          await enviarMensaje(phone,
            `🎤 Entendí: *"${nombreOrigen}"*${linkVerif}\n\n` +
            `📍 *ORIGEN — de dónde te recogemos*\n` +
            `Mandame el pin exacto de *${nombreOrigen}*\n` +
            `Usa el 📎 adjunto → Ubicación y mueve el pin al lugar exacto.`
          );
        }
        return;
      }

      // Caso: solo destino en el audio
      if (!ubicaciones.origen && ubicaciones.destino) {
        const { coords, aprender, referencia } = await resolverUbicacionVoz(ubicaciones.destino, "destino");
        const nombreDestino = referencia || ubicaciones.destino; // fallback a lo que dijo el usuario
        if (coords) {
          await updateSession(phone, { ...session, destino: { ...coords, nombre: coords.nombre || nombreDestino }, step: "esperando_origen" });
          await enviarMensaje(phone, `✅ *Destino:* ${nombreDestino}\n\n📍 Ahora envía el pin de tu *origen* (de dónde te recogemos).`);
        } else if (aprender) {
          await updateSession(phone, { ...session, step: "aprendiendo_destino_voz", referenciaVozDestino: referencia });
          await enviarMensaje(phone,
            `🎤 Entendí: *"${referencia}"*\n\n` +
            `🗺️ Todavía no tengo ese lugar mapeado.\n` +
            `¿Me mandas el pin de *${referencia}*? Así lo aprendo y la próxima vez ya lo sé. 📍`
          );
        }
        return;
      }

      // Caso: tiene ambos
      const result1 = await resolverUbicacionVoz(ubicaciones.origen, "origen");
      const result2 = await resolverUbicacionVoz(ubicaciones.destino, "destino");
      const { coords: origenCoords, aprender: aprenderOrigen, referencia: refOrigen } = result1;
      const { coords: destinoCoords, aprender: aprenderDestino, referencia: refDestino } = result2;

      if (origenCoords && destinoCoords) {
        // Ambos resueltos
        origenCoords.nombre = origenCoords.nombre || ubicaciones.origen;
        destinoCoords.nombre = destinoCoords.nombre || ubicaciones.destino;

        // FLUJO RÁPIDO POR VOZ: si el usuario habló (audio claro y completo),
        // saltamos la confirmación de ubicaciones y la cadena de botones.
        // Vamos directo a "tengo un móvil a X min, cuesta Y, ¿confirmo?".
        if (await _usuarioUsaVoz(phone)) {
          const sesionConViaje = { ...session, origen: origenCoords, destino: destinoCoords };
          const manejado = await flujoRapidoVoz(phone, sesionConViaje);
          if (manejado) return;
          // Si el flujo rápido falló por algo, caemos a la confirmación normal
        }

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
          ],
          `Vas desde ${ubicaciones.origen}, hasta ${ubicaciones.destino}. Si está bien, toca el botón verde que dice Sí.`
        );
      } else if (origenCoords && !destinoCoords) {
        // Origen OK, destino no mapeado — pedir pin del destino para aprender
        const refD2 = refDestino || ubicaciones.destino;
        const linkD2 = result2?.inciertoLink ? `\n🗺️ Google lo puso aquí: ${result2.inciertoLink} — si no es correcto, mandame el pin exacto.` : "";
        await updateSession(phone, {
          ...session,
          origen: { ...origenCoords, nombre: origenCoords.nombre || ubicaciones.origen },
          step: "aprendiendo_destino_voz",
          referenciaVozDestino: refD2,
        });
        await enviarMensaje(phone,
          `✅ *Origen:* ${ubicaciones.origen}\n\n` +
          `🏁 *DESTINO — a dónde vas*\n` +
          `Mandame el pin de: *${refD2}*${linkD2}\n` +
          `Usa el 📎 adjunto → Ubicación y mueve el pin al lugar exacto.`
        );
      } else if (!origenCoords && destinoCoords) {
        // Destino OK, origen no mapeado — pedir pin del origen para aprender
        const refO2 = refOrigen || ubicaciones.origen;
        const linkO2 = result1?.inciertoLink ? `\n🗺️ Google lo puso aquí: ${result1.inciertoLink} — si no es correcto, mandame el pin exacto.` : "";
        await updateSession(phone, {
          ...session,
          destino: { ...destinoCoords, nombre: destinoCoords.nombre || ubicaciones.destino },
          step: "aprendiendo_origen_voz",
          referenciaVozOrigen: refO2,
        });
        await enviarMensaje(phone,
          `✅ *Destino:* ${ubicaciones.destino}\n\n` +
          `📍 *ORIGEN — de dónde te recogemos*\n` +
          `Mandame el pin de: *${refO2}*${linkO2}\n` +
          `Usa el 📎 adjunto → Ubicación y mueve el pin al lugar exacto.`
        );
      } else {
        // Ninguno mapeado — pedir ambos pins en secuencia (paso 1 de 2, paso 2 de 2)
        const refO = refOrigen || ubicaciones.origen;
        const refD = refDestino || ubicaciones.destino;
        await updateSession(phone, {
          ...session,
          step: "aprendiendo_origen_voz",
          referenciaVozOrigen: refO,
          referenciaVozDestino: refD,
        });
        await enviarMensaje(phone,
          `🎤 Entendí:\n` +
          `📍 *Origen:* ${ubicaciones.origen}\n` +
          `🏁 *Destino:* ${ubicaciones.destino}\n\n` +
          `🗺️ Esos dos lugares no los tengo mapeados todavía.\n` +
          `¡Ayudame a aprenderlos! Necesito 2 pins.\n\n` +
          `📍 *ORIGEN — de dónde te recogemos* _(paso 1 de 2)_\n` +
          `Mandame el pin de: *${refO}*\n` +
          `Usa el 📎 adjunto → Ubicación y mueve el pin al lugar exacto.`
        );
      }

    } catch (e) {
      log.error("[AUDIO]", e.message);
      await enviarMensaje(phone, "❌ Error procesando audio. Envía el pin de ubicación.");
      await updateSession(phone, { ...session, step: "esperando_origen" });
    }
    return;
  }

  // ─── Detección de nuevo pedido por texto libre ────────────────────────────
  // Si el usuario escribe algo que claramente indica querer un nuevo viaje
  // y tiene una sesión de pedido abandonada, la reseteamos
  const stepsPedidoAbandonable = [
    "esperando_origen","esperando_destino","esperando_origen_con_destino",
    "eligiendo_historial","preguntando_opciones","calculando",
    "eligiendo_tipo_vehiculo","confirmando_moto_incompatible",
    "ofreciendo_codigo","esperando_codigo","esperando_parada","esperando_observacion",
    "confirmando_ubicaciones_voz","aprendiendo_origen_voz","aprendiendo_destino_voz",
    "confirmando_ciudad"
  ];

  if (texto && !buttonId && !coords && stepsPedidoAbandonable.includes(session.step)) {
    // Verificar si la sesión está vencida (más de 2 horas sin actividad)
    const sesionVencida = session.updatedAt &&
      (Date.now() - new Date(session.updatedAt).getTime()) > CONFIG.SESSION_PEDIDO_TIMEOUT_MS;

    // Detectar frases que indican nuevo pedido
    const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const esNuevoPedido = /\b(nueva|nuevo|otra|otro|quiero|necesito|pedir|pedido|carrera|taxi|viaje)\b/.test(t);

    if (sesionVencida || (esNuevoPedido && stepsPedidoAbandonable.includes(session.step))) {
      log.info(`[SESSION] Reset por ${sesionVencida ? "timeout" : "nuevo pedido"} — phone: ${phone}, step: ${session.step}`);
      await deleteSession(phone);
      await procesarMensajeUsuario(phone, mensaje, buttonId);
      return;
    }
  }

  // ─── Switch de steps ──────────────────────────────────────────────────────
  switch (session.step) {
    case "gestionando_lugares": {
      if (buttonId === "lugares_guardar_casa" || buttonId === "lugares_cambiar_casa") {
        await setSession(phone, { step: "guardando_lugar_personal_origen", lugarPersonalPendiente: "casa", desdeMenu: true });
        await enviarMensaje(phone, `🏠 Mandame el 📍 *pin de tu casa*.\n\nUsá el 📎 adjunto → Ubicación.\n\nUna vez guardada, podrás decir _"llévame a casa"_ por audio 🎤`);
        return;
      }
      if (buttonId === "lugares_guardar_trabajo" || buttonId === "lugares_cambiar_trabajo") {
        await setSession(phone, { step: "guardando_lugar_personal_origen", lugarPersonalPendiente: "trabajo", desdeMenu: true });
        await enviarMensaje(phone, `💼 Mandame el 📍 *pin de tu trabajo*.\n\nUsá el 📎 adjunto → Ubicación.\n\nUna vez guardado, podrás decir _"voy al trabajo"_ por audio 🎤`);
        return;
      }
      if (buttonId === "lugares_volver") {
        await deleteSession(phone);
        await enviarMensaje(phone, "✅ Listo. Mandame tu 📍 ubicación de origen para pedir un taxi.");
        return;
      }
      // Si manda texto u otra cosa, repetir menú
      await mostrarMenuLugares(phone);
      return;
    }

    case "inicio": {
      // Entregar código a usuarios existentes que no tengan uno activo
      if (promoCodigosActiva()) {
        const tieneCodigoActivo = await CodigoPromo.exists({
          generadoPor: phone, usado: false, fechaVencimiento: { $gt: new Date() }
        });
        if (!tieneCodigoActivo) {
          try {
            const codigoExistente = await crearCodigoPromo(phone, "promo_masiva");
            if (codigoExistente) await enviarCodigoDescuento(phone, codigoExistente, "tu próximo viaje");
          } catch (e) { log.error("[PROMO_MASIVA]", e.message); }
        }
      }

      // FIX: si el usuario mandó un pin junto con el primer mensaje,
      // procesarlo directo sin pedirlo de nuevo
      if (coords) {
        const origen = { ...coords };
        try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) origen.nombre = dir; } catch {}
        await updateSession(phone, { ...session, origen, step: "esperando_destino" });
        await enviarMensaje(phone, `✅ *Origen recibido:* ${origen.nombre || "tu ubicación"}\n\n🏁 Ahora envía tu *ubicación de destino* (a dónde quieres ir).`);
        break;
      }

      // ─── COPILOTO DE HÁBITOS: ¿hay un patrón de viaje a esta hora? ─────────
      const sugerencia = await sugerenciaPorHora(phone);
      if (sugerencia) {
        const emojiVeh = sugerencia.tipoVehiculo === "moto" ? "🏍️" : "🚗";
        await updateSession(phone, { ...session, step: "eligiendo_historial", sugerencia });
        await enviarBotones(
          phone,
          `👋 ¡Hola de nuevo!\n\n🎯 Noté que a esta hora sueles ir a *${sugerencia.destinoNombre}* en ${emojiVeh} ${sugerencia.tipoVehiculo}.\n\n¿Vamos para allá?`,
          [
            { id: "sug_aceptar", title: `✅ Sí, vamos` },
            { id: "sug_rechazar", title: "📍 Otro viaje" },
          ]
        );
        break;
      }

      const { botones, idsParaSession } = await construirBotonesHistorial(phone);
      if (botones.length > 0) {
        await updateSession(phone, { ...session, step: "eligiendo_historial", historial: idsParaSession });
        await enviarBotones(phone, `👋 ¡Hola de nuevo!\n\nElige una opción o envíame tu *ubicación de origen* 📍\n\n💡 _Tip: escribí "mis lugares" para guardar tu casa o trabajo y pedir viajes más rápido._`, botones);
      } else {
        await updateSession(phone, { ...session, step: "esperando_origen" });
        await enviarMensaje(
          phone,
          "👋 ¡Hola! Bienvenido a *ChatGo*.\n\n" +
            "📍 Envía tu ubicación de origen usando el pin de WhatsApp.\n\n" +
            "También puedes:\n" +
            "• Enviar un 🎤 audio de voz diciendo a dónde quieres ir\n" +
            "• Compartir un link de 🗺️ Google Maps\n" +
            "• Escribir _\"mis lugares\"_ para guardar tu casa o trabajo 📌"
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

    // ─── APRENDIZAJE COLABORATIVO ────────────────────────────────────────────
    // El usuario manda un audio con lugar desconocido.
    // El bot pide el pin para aprenderlo y continúa el flujo normal.
    // Si ambos (origen y destino) son desconocidos, los pide en secuencia.
    // ─────────────────────────────────────────────────────────────────────────

      case "guardando_lugar_personal_origen":
      case "guardando_lugar_personal_destino": {
        // El usuario está mandando el pin de su casa o trabajo para guardarlo
        const tipoLugar = session.lugarPersonalPendiente; // "casa" o "trabajo"
        const esOrigen = session.step === "guardando_lugar_personal_origen";
        
        // Resolver dirección amigable
        let nombreLugar = tipoLugar;
        try { 
          const dir = await obtenerDireccion(coords.lat, coords.lng); 
          if (dir) nombreLugar = `${tipoLugar} (${dir})`;
        } catch {}
        
        // Guardar en el perfil del usuario
        await guardarLugarPersonal(phone, tipoLugar, coords.lat, coords.lng, nombreLugar);
        log.info(`[LUGAR_PERSONAL] ${phone} guardó ${tipoLugar}: (${coords.lat}, ${coords.lng})`);
        
        // Asignar al viaje
        if (esOrigen) {
          await updateSession(phone, {
            ...session,
            origen: { lat: coords.lat, lng: coords.lng, nombre: nombreLugar },
            step: session.destino?.lat ? "preguntando_opciones" : "esperando_destino",
            lugarPersonalPendiente: null,
          });
          await enviarMensaje(phone, 
            `✅ Guardé tu *${tipoLugar}* 🎉\n` +
            `Ahora cuando digas "${tipoLugar === "casa" ? "salgo de casa" : "estoy en el trabajo"}" lo voy a saber al toque. 🚀\n\n` +
            (session.destino?.lat 
              ? `¡Listo! Calculando tu viaje...` 
              : `🏁 Ahora envía el pin del destino o decime a dónde vas.`)
          );
        } else {
          await updateSession(phone, {
            ...session,
            destino: { lat: coords.lat, lng: coords.lng, nombre: nombreLugar },
            step: session.origen?.lat ? "preguntando_opciones" : "esperando_origen",
            lugarPersonalPendiente: null,
          });
          await enviarMensaje(phone,
            `✅ Guardé tu *${tipoLugar}* 🎉\n` +
            `Ahora cuando digas "${tipoLugar === "casa" ? "llévame a casa" : "voy al trabajo"}" lo voy a saber al toque. 🚀\n\n` +
            (session.origen?.lat
              ? `¡Listo! Calculando tu viaje...`
              : `📍 Ahora envía el pin de tu origen o decime de dónde te recogemos.`)
          );
        }
        
        // Si ya tenemos ambos puntos, continuar
        const sFinal = await getSession(phone);
        if (sFinal.origen?.lat && sFinal.destino?.lat) {
          await preguntarOpcionesViaje(phone, sFinal);
        }
        return;
      }
      
    case "aprendiendo_origen_voz": {
      const refOrigen = session.referenciaVozOrigen || "tu origen";
      const tambienAprendeDestino = !!session.referenciaVozDestino && !session.destino?.lat;
      const pasoLabel = tambienAprendeDestino ? " _(paso 1 de 2)_" : "";

      if (!coords) {
        await enviarMensaje(phone,
          `📍 *ORIGEN — de dónde te recogemos*${pasoLabel}\n\n` +
          `Mandame el pin de: *${refOrigen}*\n\n` +
          `Usa el 📎 adjunto → Ubicación y mueve el pin al lugar exacto.\n` +
          `_Con tu ayuda ChatGo aprende las calles de Cochabamba. 🗺️_`
        );
        break;
      }
      {
        const origen = { ...coords };
        try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) origen.nombre = dir; } catch {}

        // Guardar en memoria para futuros usuarios
        if (session.referenciaVozOrigen) {
          await guardarReferenciaVoz(session.referenciaVozOrigen, origen.lat, origen.lng, origen.nombre || session.referenciaVozOrigen, session.ciudadUsuario || "Cochabamba");
          log.info(`[APRENDIZAJE] Origen guardado: "${session.referenciaVozOrigen}" → (${origen.lat}, ${origen.lng})`);
          // Si era una esquina (calle1+calle2 del detalle GPT), también guardarla en memoria compartida
          if (session._detOrigenCalle1 && session._detOrigenCalle2) {
            await guardarEsquina(session._detOrigenCalle1, session._detOrigenCalle2, origen.lat, origen.lng, { phone, zona: session._detOrigenZona });
            log.info(`[CROWDSOURCE] Esquina compartida guardada: ${session._detOrigenCalle1} y ${session._detOrigenCalle2}`);
          }
        }

        if (tambienAprendeDestino) {
          // Destino también es desconocido — pedirlo ahora (paso 2 de 2)
          const refDestino = session.referenciaVozDestino;
          const sessionActualizada = { ...session, origen, step: "aprendiendo_destino_voz" };
          await setSession(phone, sessionActualizada);
          await enviarMensaje(phone,
            `✅ ¡Gracias! Origen mapeado. 🙌\n\n` +
            `🏁 *DESTINO — a dónde vas* _(paso 2 de 2)_\n\n` +
            `Mandame el pin de: *${refDestino}*\n\n` +
            `Usa el 📎 adjunto → Ubicación y mueve el pin al lugar exacto.`
          );
        } else if (session.destino?.lat) {
          // Ya tiene destino mapeado — ir directo al resumen
          const nuevaSession = { ...session, origen };
          delete nuevaSession.referenciaVozOrigen;
          delete nuevaSession.referenciaVozDestino;
          nuevaSession.step = "preguntando_opciones";
          await setSession(phone, nuevaSession);
          if (session.referenciaVozOrigen) {
            await enviarMensaje(phone, `✅ ¡Gracias! Aprendí *${session.referenciaVozOrigen}*. 🙌`);
          }
          await preguntarOpcionesViaje(phone, nuevaSession);
        } else {
          // Solo faltaba el origen — pedir destino normalmente
          const nuevaSession = { ...session, origen, step: "esperando_destino" };
          delete nuevaSession.referenciaVozOrigen;
          delete nuevaSession.referenciaVozDestino;
          await setSession(phone, nuevaSession);
          if (session.referenciaVozOrigen) {
            await enviarMensaje(phone, `✅ ¡Gracias! Aprendí *${session.referenciaVozOrigen}*. 🙌\n\n🏁 Ahora envía el pin de tu *destino*.`);
          } else {
            await enviarMensaje(phone, `✅ *Origen guardado.*\n\n🏁 Ahora envía el pin de tu *destino*.`);
          }
        }
      }
      break;
    }

    case "aprendiendo_destino_voz": {
      const refDestino = session.referenciaVozDestino || "tu destino";
      const teníaOrigenDesconocido = !!session.referenciaVozOrigen;
      const pasoLabelD = teníaOrigenDesconocido ? " _(paso 2 de 2)_" : "";

      if (!coords) {
        await enviarMensaje(phone,
          `🏁 *DESTINO — a dónde vas*${pasoLabelD}\n\n` +
          `Mandame el pin de: *${refDestino}*\n\n` +
          `Usa el 📎 adjunto → Ubicación y mueve el pin al lugar exacto.\n` +
          `_Con tu ayuda ChatGo aprende las calles de Cochabamba. 🗺️_`
        );
        break;
      }
      {
        const destino = { ...coords };
        try { const dir = await obtenerDireccion(coords.lat, coords.lng); if (dir) destino.nombre = dir; } catch {}

        // Guardar en memoria para futuros usuarios
        if (session.referenciaVozDestino) {
          await guardarReferenciaVoz(session.referenciaVozDestino, destino.lat, destino.lng, destino.nombre || session.referenciaVozDestino, session.ciudadUsuario || "Cochabamba");
          log.info(`[APRENDIZAJE] Destino guardado: "${session.referenciaVozDestino}" → (${destino.lat}, ${destino.lng})`);
          if (session._detDestinoCalle1 && session._detDestinoCalle2) {
            await guardarEsquina(session._detDestinoCalle1, session._detDestinoCalle2, destino.lat, destino.lng, { phone, zona: session._detDestinoZona });
            log.info(`[CROWDSOURCE] Esquina compartida guardada: ${session._detDestinoCalle1} y ${session._detDestinoCalle2}`);
          }
        }

        // Continuar al resumen del viaje (si ya tiene origen) o pedirlo
        const nuevaSession = { ...session, destino };
        delete nuevaSession.referenciaVozOrigen;
        delete nuevaSession.referenciaVozDestino;

        if (!nuevaSession.origen?.lat) {
          // Falta el origen — pedirlo
          nuevaSession.step = "esperando_origen";
          await setSession(phone, nuevaSession);
          await enviarMensaje(phone,
            `✅ ¡Gracias! Aprendí *${session.referenciaVozDestino || "tu destino"}*. 🙌\n\n` +
            `📍 *ORIGEN — de dónde te recogemos*\n` +
            `Ahora envía el pin de tu origen con el 📎 adjunto → Ubicación.`
          );
        } else {
          nuevaSession.step = "preguntando_opciones";
          await setSession(phone, nuevaSession);
          await enviarMensaje(phone, `✅ ¡Gracias! Aprendí *${session.referenciaVozDestino || "tu destino"}*. 🙌`);
          await preguntarOpcionesViaje(phone, nuevaSession);
        }
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

        // DETECCIÓN AUTOMÁTICA DE CIUDAD por el pin del usuario
        const ciudadDetectada = detectarCiudadPorCoords(coords.lat, coords.lng);
        if (ciudadDetectada) {
          const usuarioCiudad = await Usuario.findOne({ phone }).lean();
          if (!usuarioCiudad?.ciudad) {
            // Primera vez — guardar ciudad detectada y confirmar al usuario
            await Usuario.findOneAndUpdate({ phone }, { ciudad: ciudadDetectada, ciudadDetectada: true });
            log.info(`[CIUDAD] Detectada: ${ciudadDetectada} para ${phone}`);
            // Actualizar sesión con la ciudad
            session.ciudadUsuario = ciudadDetectada;
          }
        } else if (!session.ciudadUsuario) {
          // No detectamos la ciudad — preguntar
          await updateSession(phone, { ...session, origen, step: "confirmando_ciudad", origenPendiente: origen });
          await enviarBotones(phone,
            `✅ *Origen recibido.* ¿En qué ciudad estás?`,
            Object.keys(CIUDADES).slice(0,3).map(c => ({ id: `ciudad_${c.replace(/ /g,"_")}`, title: c }))
          );
          break;
        }

        // CROWDSOURCING SILENCIOSO: si hay referencia de voz pendiente, mapearla con este pin
        if (session.referenciaVozOrigen) {
          try {
            const refNorm = normalizarReferencia(session.referenciaVozOrigen);
            const yaExiste = await LocationReference.findOne({ referencia: refNorm });
            if (!yaExiste) {
              await guardarReferenciaVoz(session.referenciaVozOrigen, coords.lat, coords.lng, origen.nombre || session.referenciaVozOrigen, session.ciudadUsuario || "Cochabamba");
              log.info(`[CROWDSOURCE] Origen mapeado silenciosamente: "${session.referenciaVozOrigen}" → (${coords.lat}, ${coords.lng})`);
            }
          } catch (e) { log.error("[CROWDSOURCE_ORIGEN]", e.message); }
        }

        // Si ya tiene destino guardado (del audio), ir directo al resumen
        if (session.destino?.lat) {
          const nuevaSession = { ...session, origen };
          delete nuevaSession.referenciaVozOrigen;
          delete nuevaSession.referenciaVozDestino;
          await setSession(phone, nuevaSession);
          await enviarMensaje(phone, `✅ *Origen recibido:* ${origen.nombre || "tu ubicación"}`);
          await preguntarOpcionesViaje(phone, nuevaSession);
        } else {
          await updateSession(phone, { ...session, origen, step: "esperando_destino" });
          await enviarMensaje(phone, `✅ *Origen recibido:* ${origen.nombre || "tu ubicación"}\n\n🏁 Ahora envía tu *ubicación de destino* (a dónde quieres ir).`);
        }
      }
      break;

    case "confirmando_ciudad": {
      // El usuario eligió su ciudad manualmente
      if (buttonId?.startsWith("ciudad_")) {
        const ciudadElegida = buttonId.replace("ciudad_", "").replace(/_/g, " ");
        if (CIUDADES[ciudadElegida]) {
          await Usuario.findOneAndUpdate({ phone }, { ciudad: ciudadElegida, ciudadDetectada: false });
          const nuevaSession = { ...session, ciudadUsuario: ciudadElegida };
          const origenGuardado = session.origenPendiente || session.origen;
          delete nuevaSession.origenPendiente;
          if (origenGuardado?.lat) {
            if (nuevaSession.destino?.lat) {
              await setSession(phone, { ...nuevaSession, origen: origenGuardado, step: "preguntando_opciones" });
              await preguntarOpcionesViaje(phone, { ...nuevaSession, origen: origenGuardado });
            } else {
              await updateSession(phone, { ...nuevaSession, origen: origenGuardado, step: "esperando_destino" });
              await enviarMensaje(phone, `✅ Ciudad: *${ciudadElegida}*\n\n🏁 Ahora envía tu *destino*.`);
            }
          } else {
            await updateSession(phone, { ...nuevaSession, step: "esperando_origen" });
            await enviarMensaje(phone, `✅ Ciudad: *${ciudadElegida}*\n\n📍 Ahora envía tu *origen*.`);
          }
        }
      } else {
        // Mostrar las ciudades restantes (segunda página)
        await enviarBotones(phone, `¿En qué ciudad estás?`,
          Object.keys(CIUDADES).slice(3,6).map(c => ({ id: `ciudad_${c.replace(/ /g,"_")}`, title: c }))
        );
      }
      break;
    }

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

        // CROWDSOURCING SILENCIOSO: si hay referencia de voz pendiente para el destino,
        // asociarla automáticamente con el pin
        if (session.referenciaVozDestino) {
          const refNorm = normalizarReferencia(session.referenciaVozDestino);
          const yaExiste = await LocationReference.findOne({ referencia: refNorm });
          if (!yaExiste) {
            await guardarReferenciaVoz(session.referenciaVozDestino, coords.lat, coords.lng, destino.nombre || session.referenciaVozDestino, session.ciudadUsuario || "Cochabamba");
            log.info(`[CROWDSOURCE] Destino mapeado silenciosamente: "${session.referenciaVozDestino}" → (${coords.lat}, ${coords.lng})`);
          }
        }

        // Limpiar referencias de voz pendientes
        const nuevaSession = { ...session, destino };
        delete nuevaSession.referenciaVozOrigen;
        delete nuevaSession.referenciaVozDestino;
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

    // ─── FLUJO RÁPIDO POR VOZ: el usuario confirma el viaje hablando ─────────
    case "confirmando_viaje_voz": {
      // El "sí/no" puede venir como botón o como audio (interpretado antes)
      let decision = null;
      if (buttonId === "confirmar_viaje_voz_si") decision = "si";
      else if (buttonId === "confirmar_viaje_voz_no") decision = "no";
      else if (texto) decision = interpretarSiNo(texto); // por si escribió "sí"/"no"

      if (decision === "si") {
        // Confirmado: armar viaje con auto y precio ya calculados, buscar chofer
        const sessionViaje = {
          ...session,
          tipoVehiculo: session.tipoVehiculo || "auto",
          precioFinal: session.precioAuto,
        };
        await asignarChofer(phone, sessionViaje);
      } else if (decision === "no") {
        await deleteSession(phone);
        await setSession(phone, { step: "inicio" });
        await enviarMensaje(phone, "Está bien, cancelé el viaje. Cuando quiera otro, solo dígame a dónde quiere ir. 🚖");
      } else {
        // No se entendió la respuesta — repetir la pregunta de forma simple
        await enviarMensaje(phone, "No le entendí. ¿Confirmo el viaje? Por favor dígame *sí* o *no*.");
      }
      break;
    }

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
        await updateSession(phone, { ...session, step: "confirmado" });
        // No mandar mensaje aquí — asignarChofer manda el suyo propio
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
        // Marcar como cancelando primero para bloquear el interval
        await ListaEspera.findOneAndUpdate({ userPhone: phone }, { $set: { cancelando: true } });
        await deleteSession(phone);
        await removeListaEspera(phone);
        await enviarMensaje(phone, "❌ Entendido. Escribe cuando necesites taxi. 🚖");
      } else {
        await enviarMensaje(phone, "⏳ Seguimos buscando un móvil para ti...");
      }
      break;

    case "calculando":
    case "confirmado":
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
        await Chofer.findOneAndUpdate({ traccarId: viajeActivo.choferTraccarId }, { $set: { estado: "libre", viajeReservado: null, reservadoHasta: null } });
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

    // FIX: antes de borrar sesión verificar estado real en DB
    // Evita que un step desconocido (ej: 'calculando', 'confirmado') resetee
    // la sesión de un usuario que está esperando chofer
    default: {
      const viajeActivoDefault = await Viaje.findOne({
        usuarioPhone: phone,
        estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] },
      });
      const enEsperaDefault = await ListaEspera.findOne({ userPhone: phone });

      if (viajeActivoDefault) {
        const stepReal = viajeActivoDefault.estado === "pendiente" ? "esperando_chofer"
          : viajeActivoDefault.estado === "en_camino" ? "chofer_en_camino"
          : viajeActivoDefault.estado === "esperando_pasajero" ? "chofer_esperando_pasajero"
          : "en_curso";
        await updateSession(phone, { ...session, step: stepReal });
        log.warn(`[DEFAULT] Corrigiendo step de ${phone}: ${session.step} → ${stepReal}`);
        await enviarMensaje(phone, `⚠️ Tu viaje sigue activo.\n\nEscribe CANCELAR para cancelarlo o AYUDA para soporte.`);
      } else if (enEsperaDefault) {
        await updateSession(phone, { ...session, step: "sin_chofer" });
        log.warn(`[DEFAULT] Corrigiendo step de ${phone}: ${session.step} → sin_chofer`);
        await enviarMensaje(phone, `⏳ Seguimos buscando un móvil para ti...\n\n_Escribe CANCELAR para dejar de buscar._`);
      } else {
        // No hay nada activo — reset seguro
        await deleteSession(phone);
        await setSession(phone, { step: "inicio" });
        await procesarMensajeUsuario(phone, mensaje, buttonId);
      }
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK META
// ═══════════════════════════════════════════════════════════════════════════

module.exports = { procesarMensajeUsuario, preguntarOpcionesViaje, procesarCalculoViaje };
