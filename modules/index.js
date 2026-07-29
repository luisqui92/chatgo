// ChatGo — Plataforma modular: router de servicios
//
// Punto de entrada de todos los módulos no-taxi (favor, delivery, school,
// empresas, rastreo). El webhook llama a procesarModulos() ANTES del flujo
// pasajero; si ningún módulo toma el mensaje, devuelve false y el taxi sigue
// funcionando exactamente igual que siempre.
//
// TODO está detrás de CONFIG.MODULOS_ACTIVOS (env MODULOS_ACTIVOS):
//   - vacío (default)  → este archivo devuelve false de inmediato, costo cero
//   - "favor,delivery" → activa esos módulos
//
// Reglas de intercepción (para NUNCA romper el flujo taxi):
//   1. Usuario ya dentro de un módulo (step "mod_*")  → sigue en su módulo
//   2. Palabra clave de entrada SOLO si el usuario está en reposo
//      (sin sesión, step "inicio" o step vacío) — jamás a mitad de un pedido de taxi
//   3. Todo lo demás → false (flujo taxi normal)

const { CONFIG, log } = require("../config");
const { deleteSession } = require("../services/session");
const { enviarMensaje } = require("../services/whatsapp");
const { esAudio, textoDeMensaje } = require("./util");
const { clasificarIntencion } = require("../services/openai");

const favor = require("./favor");
const ambulancia = require("./ambulancia");
const delivery = require("./delivery"); // inteligente: catálogo + presupuesto + despacho
const bus = require("./bus"); // qué línea me lleva + micro más próximo (demo)
const auxilio = require("./auxilio"); // auxilio mecánico: mecánico más cercano
const agua = require("./agua"); // ChatGo Agua: agua de mesa a domicilio
const { crearModuloCaptura } = require("./captura");

// Módulos de captura (operación manual detrás de escena mientras no exista
// la contraparte automatizada: colegios, cuentas Traccar, etc.)

const school = crearModuloCaptura({
  id: "school",
  titulo: "🎒 ChatGo School",
  preguntas: [
    { campo: "colegio", texto: "¿De qué colegio necesitas transporte escolar?" },
    { campo: "detalle", texto: "Cuéntame: ¿turno mañana o tarde, y en qué zona vives?" },
  ],
  cierre: "🚌 ¡Gracias! Te contactaremos para coordinar el transporte escolar con seguimiento en tiempo real para los papás.",
});

const empresas = crearModuloCaptura({
  id: "empresas",
  titulo: "🏢 ChatGo Empresas",
  preguntas: [
    { campo: "empresa", texto: "¿Cuál es el nombre de tu empresa?" },
    { campo: "necesidad", texto: "¿Qué necesitas? (entregas, transporte de personal, logística diaria, etc.)" },
  ],
  cierre: "📦 ¡Perfecto! Un asesor de ChatGo Empresas te contactará hoy mismo con una propuesta.",
});

const rastreo = crearModuloCaptura({
  id: "rastreo",
  titulo: "📡 ChatGo Rastreo (RastreoPlus)",
  preguntas: [
    { campo: "que_rastrear", texto: "¿Qué quieres rastrear? (vehículo, moto, persona, mascota)" },
    { campo: "contacto", texto: "¿La unidad ya tiene GPS de RastreoPlus? Si sí, dime la placa o el nombre de la unidad." },
  ],
  cierre: "🛰️ ¡Anotado! Te contactaremos para activar el rastreo por WhatsApp: ubicación al instante, alertas y geocercas.",
});

const MODULOS = { favor, ambulancia, delivery, bus, auxilio, agua, school, empresas, rastreo };

// Palabras que abren cada módulo por TEXTO (solo con el usuario en reposo)
const ENTRADAS = [
  // Ambulancia primero: en emergencia, cada segundo cuenta
  { modulo: "ambulancia", regex: /^(ambulancia|emergencia medica|emergencia médica|accidente|herido)s?\b/i },
  { modulo: "favor", regex: /^(favor|mandado|mandadito|tramite|trámite|encargo)s?\b/i },
  { modulo: "delivery", regex: /^(delivery|comida|pedido de comida|restaurante)s?\b/i },
  { modulo: "school", regex: /^(school|colegio|transporte escolar|escolar)\b/i },
  { modulo: "empresas", regex: /^(empresa|empresas|corporativo|logistica|logística)\b/i },
  { modulo: "rastreo", regex: /^(rastreo|rastrear|rastreoplus|gps)\b/i },
  { modulo: "bus", regex: /^(bus|micro|trufi|l[ií]nea)s?\b|\bqu[eé] l[ií]nea\b/i },
  { modulo: "auxilio", regex: /^(auxilio(\s+mec[aá]nico)?|mec[aá]nico|gr[uú]a|cerrajer|bater[íi]a|llanta|pinchazo|se me pinch|no arranca|no prende|me qued[eé] (afuera|varad|sin llave))/i },
  { modulo: "agua", regex: /^(agua|bid[oó]n|bidones|dispensador|surtidor|lo de siempre)\b/i },
];

// ─── Intención de COMIDA en lenguaje natural ─────────────────────────────────
// "tengo 30 bs y quiero un pollo" debe abrir DELIVERY, no intentar geocodificar
// "pollo" como calle (pasó en producción). Requiere verbo de querer/pedir +
// palabra de comida, y NO frases de viaje ("llévame a Pollos Copacabana" es taxi).
const PALABRAS_COMIDA = "pollo|pizza|hamburguesa|salchipapa|silpancho|chicharr[oó]n|broaster|lomito|anticucho|salte[ñn]a|empanada|almuerzo|cena|desayuno|comida|sopa|helado|torta|sushi|chifa|churrasco|parrillada";
const PIDE_COMIDA = new RegExp(`\\b(quiero|quisiera|se me antoja|antojo|tengo ganas|ped(?:ir|ime|imos)|comprar|comer)\\b[\\s\\S]{0,40}?\\b(?:${PALABRAS_COMIDA})s?\\b`, "i");
const ES_FRASE_VIAJE = /\b(ll[eé]vame|llevame|ir (a|al|hasta)|voy (a|al)|vamos (a|al)|hasta (el|la|los)|taxi|recoja|recojan|b[uú]scame|esquina|calle|avenida)\b/i;

function esIntencionComida(texto) {
  return PIDE_COMIDA.test(texto) && !ES_FRASE_VIAJE.test(texto);
}

// Frases que abren cada módulo por VOZ (transcripción de nota de voz).
// Deliberadamente MÁS estrictas que las de texto: en el habla natural muchas
// palabras aparecen de pasada ("por favor", "cerca del colegio", "hubo un
// accidente en la América") y un falso positivo rompe un pedido de taxi.
// Ante la duda, NO se intercepta y el audio sigue al flujo taxi de siempre.
const ENTRADAS_VOZ = [
  { modulo: "ambulancia", regex: /\bambulancia\b|\bemergencia m[ée]dica\b/i },
  { modulo: "favor", regex: /\b(un mandado|mandadito|un encargo|hazme un favor|necesito un favor)\b/i },
  { modulo: "delivery", regex: /\bdelivery\b|\bcomida a domicilio\b|\bpedir comida\b/i },
  { modulo: "school", regex: /\btransporte escolar\b/i },
  { modulo: "empresas", regex: /\bchatgo empresas\b|\blog[íi]stica empresarial\b/i },
  { modulo: "rastreo", regex: /\brastrear\b|\brastreo\b|\brastreoplus\b/i },
  { modulo: "bus", regex: /\bqu[eé] l[ií]nea\b|\btrufi\b|\bchatgo ?bus\b/i },
  { modulo: "auxilio", regex: /\b(auxilio mec[aá]nico|cambio de llanta|se me pinch[oó]|necesito (una )?gr[uú]a|bater[íi]a descargada|no arranca|cerrajero)\b/i },
  { modulo: "agua", regex: /\b(agua de mesa|un bid[oó]n|dos bidones|bid[oó]n de agua|dispensador de agua|lo de siempre)\b/i },
];

function moduloActivo(id) {
  return CONFIG.MODULOS_ACTIVOS.includes(id);
}

function textoDe(msg) {
  return msg?.text?.body?.trim() || "";
}

// Menú de servicios (se muestra con la palabra "servicios" si hay módulos activos)
async function mostrarMenuServicios(phone) {
  const lineas = ["🐒 *ChatGo — Servicios disponibles*\n", "🚖 Escribe *taxi* o pide directo tu viaje"];
  if (moduloActivo("ambulancia")) lineas.push("🚑 Escribe *ambulancia* — emergencias médicas");
  if (moduloActivo("favor")) lineas.push("🛍️ Escribe *favor* — mandados y encargos");
  if (moduloActivo("delivery")) lineas.push("🍔 Escribe *delivery* — comida a domicilio");
  if (moduloActivo("school")) lineas.push("🎒 Escribe *colegio* — transporte escolar");
  if (moduloActivo("empresas")) lineas.push("🏢 Escribe *empresa* — logística corporativa");
  if (moduloActivo("rastreo")) lineas.push("📡 Escribe *rastreo* — GPS RastreoPlus");
  if (moduloActivo("bus")) lineas.push("🚌 Escribe *bus* — qué línea te lleva (demo)");
  if (moduloActivo("auxilio")) lineas.push("🔧 Escribe *auxilio* — mecánico a domicilio");
  if (moduloActivo("agua")) lineas.push("💧 Escribe *agua* — agua de mesa a domicilio");
  await enviarMensaje(phone, lineas.join("\n"));
}

// ¿El usuario está "en reposo"? (no a mitad de un pedido/viaje de taxi)
function enReposo(session) {
  return !session || !session.step || session.step === "inicio";
}

// Pasos TEMPRANOS del flujo taxi: el usuario todavía no confirmó nada del
// viaje. Acá una intención INEQUÍVOCA de otro módulo puede interceptar.
// Caso real: tras el saludo el taxi deja step="eligiendo_historial", y
// "tengo 30bs y quiero pollo" terminaba como destino "pollo" del taxi.
const PASOS_SUAVES = new Set([
  "eligiendo_historial", "esperando_origen", "esperando_destino",
  "esperando_origen_con_destino", "confirmando_ciudad", "preguntando_opciones",
]);

// En pasos suaves solo interceptan intenciones que NO pueden ser una dirección:
// emergencia médica explícita, "delivery"/"servicios" como palabra única, o
// la intención de comida estricta (verbo de querer + comida, sin palabras de viaje)
function intencionInequivoca(texto) {
  if (/^(ambulancia|emergencia m[eé]dica)\b/i.test(texto) && moduloActivo("ambulancia")) return "ambulancia";
  if (/\bqu[eé] l[ií]nea\b/i.test(texto) && moduloActivo("bus")) return "bus";
  if (/^(delivery|servicios?)$/i.test(texto)) return texto.toLowerCase().startsWith("s") ? "menu" : "delivery";
  if (moduloActivo("delivery") && esIntencionComida(texto)) return "delivery";
  return null;
}


// ─── CLASIFICADOR IA (última capa, solo EN REPOSO) ──────────────────────────
// Jerarquía para que NUNCA se crucen los cables:
//   1º keywords deterministas (gratis, instantáneas, precisas)
//   2º intención de comida por reglas
//   3º ESTA capa: gpt-4o-mini decide taxi/bus/delivery/ambulancia/favor/otro
// Solo con el usuario en reposo, con mensajes sustanciales, y ante cualquier
// duda la IA responde "taxi" → el flujo base procesa como siempre.
async function clasificarConIA(phone, texto, msg, session) {
  if (texto.length < 10 || texto.trim().split(/\s+/).length < 3) return false; // saludos/monosílabos: no gastar
  const servicio = await clasificarIntencion(texto);
  if (servicio === "taxi" || servicio === "otro") return false;
  if (!moduloActivo(servicio) || !MODULOS[servicio]) return false;
  log.info(`[MODULOS] IA clasificó "${servicio}" para ${phone}: "${texto.substring(0, 60)}"`);
  return await MODULOS[servicio].iniciar(phone, msg, session);
}

async function procesarModulos(phone, msg, buttonId, session) {
  if (CONFIG.MODULOS_ACTIVOS.length === 0) return false;

  // 1) Usuario ya dentro de un módulo → sigue ahí
  if (session?.step?.startsWith("mod_")) {
    const idModulo = session.modulo;
    const mod = MODULOS[idModulo];
    if (mod && moduloActivo(idModulo)) {
      return await mod.procesar(phone, msg, buttonId, session);
    }
    // Módulo desactivado a mitad de flujo: liberar al usuario al taxi
    await deleteSession(phone);
    return false;
  }

  const reposo = enReposo(session);
  const pasoSuave = !reposo && PASOS_SUAVES.has(session?.step);
  if (!reposo && !pasoSuave) return false;

  // 2a) Texto
  const texto = textoDe(msg);
  if (texto) {
    // En paso suave del taxi: solo intenciones inequívocas
    if (pasoSuave) {
      const que = intencionInequivoca(texto);
      if (!que) return false;
      if (que === "menu") { await mostrarMenuServicios(phone); return true; }
      log.info(`[MODULOS] ${phone} intercepta "${que}" en paso suave (${session.step}): "${texto}"`);
      return await MODULOS[que].iniciar(phone, msg, session);
    }

    if (/^servicios?$/i.test(texto)) {
      await mostrarMenuServicios(phone);
      return true;
    }
    for (const { modulo, regex } of ENTRADAS) {
      if (moduloActivo(modulo) && regex.test(texto)) {
        log.info(`[MODULOS] ${phone} entra al módulo "${modulo}" con: "${texto}"`);
        return await MODULOS[modulo].iniciar(phone, msg, session);
      }
    }
    // Intención de comida en lenguaje natural → delivery
    if (moduloActivo("delivery") && esIntencionComida(texto)) {
      log.info(`[MODULOS] ${phone} entra a delivery por intención de comida: "${texto}"`);
      return await MODULOS.delivery.iniciar(phone, msg, session);
    }
    // Última capa: clasificador IA (solo en reposo)
    return await clasificarConIA(phone, texto, msg, session);
  }

  // 2b) Nota de voz: transcribir y buscar frases de módulo (matching estricto).
  // Si no coincide ninguna, devolvemos false y el flujo taxi procesa el audio
  // como siempre (ubicaciones por voz, viaje rápido, etc.).
  if (esAudio(msg)) {
    const hayModuloConVoz = ENTRADAS_VOZ.some(e => moduloActivo(e.modulo));
    if (!hayModuloConVoz) return false;
    const { texto: transcripcion } = await textoDeMensaje(msg);
    if (!transcripcion) return false;

    // En paso suave del taxi: solo intenciones inequívocas
    if (pasoSuave) {
      const que = intencionInequivoca(transcripcion);
      if (!que || que === "menu") return false;
      log.info(`[MODULOS] ${phone} intercepta "${que}" por VOZ en paso suave (${session.step}): "${transcripcion.substring(0, 60)}"`);
      return await MODULOS[que].iniciar(phone, msg, session);
    }

    for (const { modulo, regex } of ENTRADAS_VOZ) {
      if (moduloActivo(modulo) && regex.test(transcripcion)) {
        log.info(`[MODULOS] ${phone} entra por VOZ al módulo "${modulo}": "${transcripcion.substring(0, 60)}"`);
        return await MODULOS[modulo].iniciar(phone, msg, session);
      }
    }
    // Intención de comida hablada → delivery
    if (moduloActivo("delivery") && esIntencionComida(transcripcion)) {
      log.info(`[MODULOS] ${phone} entra a delivery por comida (voz): "${transcripcion.substring(0, 60)}"`);
      return await MODULOS.delivery.iniciar(phone, msg, session);
    }
    // Última capa: clasificador IA sobre la transcripción (solo en reposo)
    return await clasificarConIA(phone, transcripcion, msg, session);
  }

  return false;
}

module.exports = { procesarModulos };
