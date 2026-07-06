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

const favor = require("./favor");
const ambulancia = require("./ambulancia");
const { crearModuloCaptura } = require("./captura");

// Módulos de captura (operación manual detrás de escena mientras no exista
// la contraparte automatizada: catálogos, colegios, cuentas Traccar, etc.)
const delivery = crearModuloCaptura({
  id: "delivery",
  titulo: "🍔 ChatGo Delivery",
  preguntas: [
    { campo: "pedido", texto: "¿Qué quieres pedir y cuál es tu presupuesto aproximado?\n\n_Ej: \"un pollo entero, tengo 60 Bs\"_" },
    { campo: "zona", texto: "📍 ¿En qué zona estás? Puedes mandarme tu ubicación o escribirla.", aceptaUbicacion: true },
  ],
  cierre: "🛵 ¡Listo! Un operador de ChatGo está buscando las mejores opciones para tu pedido y te escribe en unos minutos.",
});

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

const MODULOS = { favor, ambulancia, delivery, school, empresas, rastreo };

// Palabras que abren cada módulo (solo con el usuario en reposo)
const ENTRADAS = [
  // Ambulancia primero: en emergencia, cada segundo cuenta
  { modulo: "ambulancia", regex: /^(ambulancia|emergencia medica|emergencia médica|accidente|herido)s?\b/i },
  { modulo: "favor", regex: /^(favor|mandado|mandadito|tramite|trámite|encargo)s?\b/i },
  { modulo: "delivery", regex: /^(delivery|comida|pedido de comida|restaurante)s?\b/i },
  { modulo: "school", regex: /^(school|colegio|transporte escolar|escolar)\b/i },
  { modulo: "empresas", regex: /^(empresa|empresas|corporativo|logistica|logística)\b/i },
  { modulo: "rastreo", regex: /^(rastreo|rastrear|rastreoplus|gps)\b/i },
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
  await enviarMensaje(phone, lineas.join("\n"));
}

// ¿El usuario está "en reposo"? (no a mitad de un pedido/viaje de taxi)
function enReposo(session) {
  return !session || !session.step || session.step === "inicio";
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

  // 2) Entrada por palabra clave — solo en reposo
  if (!enReposo(session)) return false;

  const texto = textoDe(msg);
  if (!texto) return false;

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

  return false;
}

module.exports = { procesarModulos };
