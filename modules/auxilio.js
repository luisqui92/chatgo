// ChatGo — Módulo Auxilio Mecánico (Etapa 2)
//
// El conductor varado escribe "necesito cambio de llanta" (o audio), el bot
// entiende el problema, le pide la ubicación y busca al mecánico afiliado más
// cercano que haga ese servicio (activo + suscripción vigente). Le manda el
// pedido al mecánico y le pasa sus datos al cliente. Registra el Auxilio.
//
// Aditivo y detrás de MODULOS_ACTIVOS: si "auxilio" no está activo, no corre.

const { CONFIG, log } = require("../config");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje } = require("../services/whatsapp");
const { obtenerDireccion, distanciaEntrePuntos } = require("../services/google");
const { textoDeMensaje } = require("./util");
const { Mecanico, Auxilio } = require("../db/models");

// ── Detección del tipo de problema desde el texto ────────────────────────────
const PATRONES = [
  { tipo: "llanta",     re: /llanta|pinch|goma|neum[aá]tico|rueda desinfl|se me revent[oó]/i },
  { tipo: "bateria",    re: /bater[íi]a|pila (del )?auto|se descarg[oó]|cables? (para )?arranc/i },
  { tipo: "cerrajeria", re: /cerrajer|me qued[eé] (afuera|sin llave)|se me quedaron las llaves|llave adentro|no puedo abrir (el|mi) (auto|carro|coche)/i },
  { tipo: "grua",       re: /gr[uú]a|remolqu|no puedo mover|llevarlo al taller|se malogr[oó] (el|mi)/i },
  { tipo: "no_arranca", re: /no arranca|no prende|no enciende|se apag[oó] y no/i },
];
function detectarTipo(texto) {
  for (const p of PATRONES) if (p.re.test(texto || "")) return p.tipo;
  return "otro";
}
const LABEL = {
  llanta: "🛞 Cambio/reparación de llanta", bateria: "🔋 Batería / no arranca",
  cerrajeria: "🔑 Cerrajería (llaves)", grua: "🚛 Grúa / remolque",
  no_arranca: "🔧 No arranca", otro: "🔧 Auxilio mecánico",
};
// Qué servicio del mecánico cubre cada problema
function servicioRequerido(tipo) {
  if (tipo === "no_arranca" || tipo === "otro") return "mecanica_general";
  return tipo;
}

// ── Buscar mecánicos disponibles ordenados por cercanía ──────────────────────
async function buscarMecanicos(tipo, punto) {
  const servicio = servicioRequerido(tipo);
  let todos = [];
  try { todos = await Mecanico.findMany({ where: { activo: true } }); }
  catch (e) { log.error("[MOD:auxilio] buscar:", e.message); return []; }
  return todos
    .filter(m => {
      const sus = (m.suscripcion || {}).estado;
      const vigente = sus === "mes_gratis" || sus === "activa";
      const serv = Array.isArray(m.tiposServicio) ? m.tiposServicio : [];
      const hace = serv.includes(servicio) || serv.includes("mecanica_general");
      const ub = m.ubicacionBase;
      return vigente && hace && ub && typeof ub.lat === "number";
    })
    .map(m => ({ m, dist: distanciaEntrePuntos(punto.lat, punto.lng, m.ubicacionBase.lat, m.ubicacionBase.lng) }))
    .sort((a, b) => a.dist - b.dist);
}

// ── Despacho: crea el auxilio, avisa al mecánico y responde al cliente ───────
async function despachar(phone, punto, tipo) {
  const lista = await buscarMecanicos(tipo, punto);
  if (!lista.length) {
    await enviarMensaje(phone,
      "😕 Ahora mismo no tengo un mecánico disponible para ese servicio en tu zona.\n\n" +
      "Escribí *AUXILIO* de nuevo en un rato, o llamá a tu taller de confianza. Ya estamos sumando más mecánicos a la red. 🔧");
    return true;
  }
  const { m: mec, dist } = lista[0];
  const linkUbi = `https://www.google.com/maps?q=${punto.lat},${punto.lng}`;

  let aux = null;
  try {
    aux = await Auxilio.create({
      data: {
        telefonoVarado: phone,
        ubicacion: { lat: punto.lat, lng: punto.lng, descripcion: punto.nombre || null },
        tipoProblema: tipo,
        estado: "asignado",
        mecanicoId: mec.id,
      },
    });
    await Mecanico.update({ where: { id: mec.id }, data: { totalAuxilios: (mec.totalAuxilios || 0) + 1 } }).catch(() => {});
  } catch (e) { log.error("[MOD:auxilio] crear:", e.message); }

  // Aviso al MECÁNICO
  await enviarMensaje(mec.telefono,
    `🔧 *ChatGo Auxilio — nuevo pedido*\n\n` +
    `Problema: ${LABEL[tipo]}\n` +
    `📍 Ubicación: ${punto.nombre || "ver mapa"}\n${linkUbi}\n` +
    `📞 Cliente: +${phone}\n` +
    `📏 A ~${dist.toFixed(1)} km de tu base\n\n` +
    `Si podés ir, *contactá al cliente ahora*. 🙏`
  ).catch(() => {});

  // Respuesta al CLIENTE
  await enviarMensaje(phone,
    `✅ *¡Encontramos ayuda cerca!*\n\n` +
    `🔧 *${mec.nombre}*\n` +
    `📞 ${mec.telefono}\n` +
    `📏 A ~${dist.toFixed(1)} km${mec.atiende24h ? " · 🌙 atiende 24h" : ""}\n\n` +
    `Ya le mandamos tu ubicación y va a contactarte. También podés llamarlo directo. 🚗`
  );

  // Aviso al admin (visibilidad de la operación)
  enviarMensaje(CONFIG.ADMIN_PHONE,
    `🔧 [AUXILIO] +${phone} pidió ${LABEL[tipo]} → asignado a ${mec.nombre} (${mec.telefono}), ~${dist.toFixed(1)} km.`
  ).catch(() => {});

  await deleteSession(phone);
  return true;
}

// ── Entrada al módulo ────────────────────────────────────────────────────────
async function iniciar(phone, msg, session) {
  const { texto } = await textoDeMensaje(msg);
  const tipo = detectarTipo(texto);

  // Si ya mandó la ubicación junto al pedido (raro pero posible)
  if (msg?.location) {
    const lat = parseFloat(msg.location.latitude ?? msg.location.lat);
    const lng = parseFloat(msg.location.longitude ?? msg.location.lng);
    if (!isNaN(lat) && !isNaN(lng)) {
      const nombre = msg.location.name || (await obtenerDireccion(lat, lng).catch(() => null)) || "Tu ubicación";
      return await despachar(phone, { lat, lng, nombre }, tipo);
    }
  }

  await updateSession(phone, { ...(session || {}), modulo: "auxilio", step: "mod_auxilio_ubicacion", auxTipo: tipo });
  await enviarMensaje(phone,
    `🔧 *ChatGo Auxilio Mecánico*\n\n` +
    `Entendido: ${LABEL[tipo]}.\n\n` +
    `📍 Mandame tu *ubicación* para buscar al mecánico más cercano:\n` +
    `📎 clip → *Ubicación* → *Enviar mi ubicación actual*\n\n` +
    `_Escribí CANCELAR para salir._`
  );
  return true;
}

// ── Procesar pasos del módulo ────────────────────────────────────────────────
async function procesar(phone, msg, buttonId, session) {
  const { texto } = await textoDeMensaje(msg);

  if (/^cancelar$/i.test(texto || "")) {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Auxilio cancelado. Escribí *AUXILIO* cuando lo necesites. 🔧");
    return true;
  }

  if (session.step === "mod_auxilio_ubicacion") {
    let punto = null;
    if (msg?.location) {
      const lat = parseFloat(msg.location.latitude ?? msg.location.lat);
      const lng = parseFloat(msg.location.longitude ?? msg.location.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        const nombre = msg.location.name || (await obtenerDireccion(lat, lng).catch(() => null)) || "Tu ubicación";
        punto = { lat, lng, nombre };
      }
    }
    if (!punto) {
      await enviarMensaje(phone, "📍 Necesito tu *ubicación* (el pin): 📎 clip → *Ubicación* → *Enviar mi ubicación actual*.");
      return true;
    }
    return await despachar(phone, punto, session.auxTipo || "otro");
  }

  // Paso desconocido: liberar
  await deleteSession(phone);
  return false;
}

module.exports = { id: "auxilio", iniciar, procesar };
