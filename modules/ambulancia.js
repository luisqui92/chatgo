// ChatGo — Módulo AMBULANCIAS (servicio comunitario GRATUITO)
//
// FILOSOFÍA: EL PIN DESPACHA, LOS DETALLES DESPUÉS.
// En una emergencia cada mensaje de ida y vuelta son segundos que duelen:
//   - Un solo audio basta: "manden una ambulancia a la América y Pando, mi
//     papá no respira" → se extrae QUÉ pasó y DÓNDE del mismo mensaje →
//     despacho inmediato, cero preguntas.
//   - Pin = despacho instantáneo: la ayuda sale YA con la ubicación (se asume
//     lo peor); el "¿qué pasó?" se pregunta DESPUÉS, mientras la ayuda viaja,
//     y sirve para mandar la guía de primeros auxilios y enriquecer la alerta.
//
// Despacho: unidades tipo "ambulancia" (exentas de toda cuota — gratis) vía el
// motor del taxi si tienen GPS; sin GPS, difusión a toda la red registrada.
// ChatGo complementa, nunca reemplaza, la llamada de emergencia oficial.

const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { Solicitud, Viaje, Chofer } = require("../db/models");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { obtenerDireccion, geocodificarConMemoria } = require("../services/google");
const { extraerUbicaciones } = require("../services/openai");
const { buscarChoferDisponibleTraccar, reservarChoferTraccar } = require("../services/traccar");
const { textoDeMensaje } = require("./util");

// ─── Clasificación de prioridad (determinista, sin latencia) ─────────────────
const SIGNOS_CRITICOS = /inconsciente|no respira|respira mal|dificultad para respirar|infarto|paro card|convulsion|sangr|hemorragia|atropell|choque|volcadura|grave|embarazada|parto|quemad|quem[oó]|electrocut|ahog|arma|bala|apuñal/i;
const SIGNOS_MEDIOS = /fractura|caida|caída|golpe fuerte|dolor fuerte|dolor de pecho|fiebre alta|corte|herida|mareo|desmayo/i;

function clasificarPrioridad(descripcion) {
  if (SIGNOS_CRITICOS.test(descripcion)) return "critica";
  if (SIGNOS_MEDIOS.test(descripcion)) return "media";
  return "normal";
}

// ─── PRIMEROS AUXILIOS MIENTRAS LLEGA LA AYUDA ──────────────────────────────
// Guías básicas curadas — texto fijo, nunca IA improvisando en una emergencia.
const GUIAS_AUXILIO = [
  {
    k: /no respira|paro card|inconsciente|infarto/i,
    t: "🫀 *MIENTRAS LLEGA LA AYUDA — si NO respira:*\n" +
       "1️⃣ Acostala boca arriba en superficie firme\n" +
       "2️⃣ Con los brazos rectos, comprimí FUERTE y RÁPIDO el centro del pecho — 2 veces por segundo, sin miedo\n" +
       "3️⃣ NO pares hasta que llegue ayuda o vuelva a respirar\n" +
       "4️⃣ Si hay más personas, túrnense cada 2 minutos",
  },
  {
    k: /atragant/i,
    t: "🫁 *MIENTRAS LLEGA LA AYUDA — atragantamiento:*\n" +
       "1️⃣ Si tose, dejala toser — no golpees la espalda todavía\n" +
       "2️⃣ Si NO puede toser ni hablar: abrazala por detrás, puño cerrado sobre el ombligo, y presioná fuerte HACIA ADENTRO Y ARRIBA\n" +
       "3️⃣ Repetí hasta que expulse el objeto",
  },
  {
    k: /sangr|hemorragia|corte|herida|apuñal|bala/i,
    t: "🩸 *MIENTRAS LLEGA LA AYUDA — sangrado:*\n" +
       "1️⃣ Presioná DIRECTO sobre la herida con tela limpia, fuerte y sin soltar\n" +
       "2️⃣ Si la tela se empapa, poné otra ENCIMA (no la quites)\n" +
       "3️⃣ Si es un brazo o pierna, mantenelo elevado\n" +
       "4️⃣ NO saques objetos clavados — fijalos donde están",
  },
  {
    k: /convulsion/i,
    t: "🧠 *MIENTRAS LLEGA LA AYUDA — convulsión:*\n" +
       "1️⃣ NO la sujetes ni le pongas NADA en la boca\n" +
       "2️⃣ Apartá objetos con los que pueda golpearse; algo blando bajo la cabeza\n" +
       "3️⃣ Cuando termine, acostala DE LADO\n" +
       "4️⃣ Tomá el tiempo: si dura más de 5 minutos es muy grave",
  },
  {
    k: /quemad|quem[oó]|electrocut/i,
    t: "🔥 *MIENTRAS LLEGA LA AYUDA — quemadura:*\n" +
       "1️⃣ Agua FRESCA (no helada) sobre la zona por 10-20 minutos\n" +
       "2️⃣ NADA de hielo, cremas, pasta dental ni remedios caseros\n" +
       "3️⃣ No revientes ampollas; cubrí con tela limpia y húmeda\n" +
       "⚡ Si fue electricidad: cortá la corriente ANTES de tocar a la persona",
  },
  {
    k: /desmayo|mareo|se desmay/i,
    t: "😵 *MIENTRAS LLEGA LA AYUDA — desmayo:*\n" +
       "1️⃣ Acostala y levantale las piernas\n" +
       "2️⃣ Aflojá ropa apretada; que le llegue aire\n" +
       "3️⃣ Cuando despierte, que se levante DE A POCO\n" +
       "4️⃣ Si no despierta en 1 minuto, tratala como inconsciente",
  },
];

function guiaPrimerosAuxilios(descripcion) {
  const g = GUIAS_AUXILIO.find(g => g.k.test(descripcion));
  if (!g) return null;
  return g.t + "\n\n_Estas indicaciones básicas no reemplazan la atención médica profesional._";
}

// Limpia las palabras de invocación del mensaje de entrada para quedarnos con
// el CONTENIDO útil: "manden una ambulancia rápido, mi papá no respira" →
// "mi papá no respira"
function extraerContenidoUtil(texto) {
  const limpio = String(texto || "")
    .replace(/\b(manden?|env[ií]en?|necesito|quiero|una?|la|el|ambulancia|emergencia( m[eé]dica)?|urgente|r[aá]pido|ya|por favor|porfavor|auxilio|ayuda)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return limpio.length >= 8 ? limpio : null;
}

// ─── EL DESPACHO (una sola función, llamada desde todos los caminos) ─────────
// Registra la solicitud, intenta despacho con GPS, difunde a la red si no hay,
// manda la guía de auxilios y alerta al admin. Devuelve { despachada, solicitudId }.
async function despacharEmergencia(phone, ubi, descripcion, esGenerica = false) {
  const prioridad = esGenerica ? "critica" : clasificarPrioridad(descripcion); // sin datos, se asume lo peor

  // 1) Registrar SIEMPRE
  let solicitudId = null;
  try {
    const sol = await Solicitud.create({
      data: {
        tipo: "ambulancia", usuarioPhone: phone, estado: "nueva",
        detalle: { descripcion, prioridad, generica: esGenerica },
        origenLat: ubi.lat, origenLng: ubi.lng, origenNombre: ubi.nombre,
      },
    });
    solicitudId = sol.id;
  } catch (e) { log.error("[MOD:ambulancia] Error guardando solicitud:", e.message); }

  // 2) Despacho automático (unidad con GPS)
  let despachada = false;
  try {
    const unidad = await buscarChoferDisponibleTraccar(ubi, [], "ambulancia");
    if (unidad) {
      const viaje = await Viaje.create({
        data: {
          usuarioPhone: phone, choferPhone: unidad.phone, choferTraccarId: unidad.traccarId,
          choferNombre: unidad.nombre, choferPlaca: unidad.placa,
          ciudad: detectarCiudadPorCoords(ubi.lat, ubi.lng),
          origenLat: ubi.lat, origenLng: ubi.lng, origenNombre: ubi.nombre,
          destinoLat: ubi.lat, destinoLng: ubi.lng, destinoNombre: "Traslado según evaluación médica",
          observaciones: `🚑 EMERGENCIA MÉDICA [prioridad ${prioridad.toUpperCase()}]: ${descripcion}`,
          distanciaKm: 0, precioTotal: 0, precioBase: 0,
          tipoVehiculo: "ambulancia", estado: "pendiente", fechaAsignacion: new Date(),
        },
      });
      const reservada = await reservarChoferTraccar(unidad.traccarId, viaje.id);
      if (reservada) {
        despachada = true;
        if (solicitudId) await Solicitud.update({ where: { id: solicitudId }, data: { viajeId: viaje.id, estado: "asignada", asignadoPhone: unidad.phone } }).catch(() => {});
        await enviarBotones(unidad.phone,
          `🚨🚑 *EMERGENCIA MÉDICA — PRIORIDAD ${prioridad.toUpperCase()}*\n\n` +
          `🩺 ${descripcion}\n📍 ${ubi.nombre}\n` +
          `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}\n` +
          `📏 A ${unidad.distanciaAlUsuario?.toFixed(1) || "?"} km de ti\n\n⏱️ *RESPONDE DE INMEDIATO*`,
          [
            { id: "aceptar_viaje", title: "🚑 VOY" },
            { id: "rechazar_viaje", title: "❌ No puedo" },
          ]);
        await updateSession(phone, { step: "esperando_chofer", viajeId: viaje.id.toString(), choferPhone: unidad.phone });
        await enviarMensaje(phone,
          `🚑 *AYUDA EN CAMINO — ambulancia a ${unidad.distanciaAlUsuario?.toFixed(1) || "?"} km*\n\n` +
          `Estamos confirmando la unidad; te llega el enlace para verla llegar.\n\n` +
          `⚠️ _No muevas a la persona herida salvo peligro inminente._`);
      } else {
        await Viaje.delete({ where: { id: viaje.id } }).catch(() => {});
      }
    }
  } catch (e) { log.error("[MOD:ambulancia] Error en despacho:", e.message); }

  // 3) Guía de primeros auxilios (si sabemos qué pasó)
  const guia = guiaPrimerosAuxilios(descripcion);
  if (guia) await enviarMensaje(phone, guia);

  // 4) Sin unidad con GPS → difundir a TODA la red (servicio gratuito)
  if (!despachada) {
    try {
      const red = await Chofer.findMany({ where: { tipoVehiculo: "ambulancia" }, take: 20 });
      for (const unidad of red) {
        enviarMensaje(unidad.phone,
          `🚨🚑 *EMERGENCIA EN LA ZONA — ChatGo Ambulancias*\n\n` +
          `🩺 ${descripcion}\n📍 ${ubi.nombre}\n` +
          `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}\n\n` +
          `Si podés atenderla, respondé este mensaje y coordinamos de inmediato.`).catch(() => {});
      }
      if (red.length) log.info(`[MOD:ambulancia] Difundido a ${red.length} unidades de la red`);
    } catch (e) { log.error("[MOD:ambulancia] Error difundiendo:", e.message); }

    await enviarMensaje(phone,
      `🚑 *Alerta enviada a la red — prioridad ${prioridad.toUpperCase()}*\n\n` +
      `🚨 *Llama YA a los servicios de emergencia de tu ciudad* (SAMU / Cruz Roja / 110) — no esperes.\n\n` +
      `_ChatGo Ambulancias es un servicio gratuito para la comunidad._ ❤️`);
  }

  // 5) Alerta al admin SIEMPRE
  try {
    const icono = prioridad === "critica" ? "🔴🔴🔴" : prioridad === "media" ? "🟠" : "🟡";
    await enviarMensaje(CONFIG.ADMIN_PHONE,
      `${icono} *AMBULANCIA — PRIORIDAD ${prioridad.toUpperCase()}* ${despachada ? "(unidad despachada)" : "(SIN UNIDAD — OPERAR MANUAL)"}\n\n` +
      `👤 +${phone}\n🩺 ${descripcion}\n📍 ${ubi.nombre}\n` +
      `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}` +
      (solicitudId ? `\n🆔 ${solicitudId}` : ""));
  } catch (e) { log.error("[MOD:ambulancia] Error alertando admin:", e.message); }

  return { despachada, solicitudId };
}

// Resuelve un punto desde texto (para "a la América y Pando" en el audio inicial)
async function resolverUbicacionTexto(textoLugar) {
  const g = await geocodificarConMemoria(textoLugar, "Cochabamba").catch(() => null);
  // Solo aceptar resultados CONFIABLES: despachar una ambulancia a una
  // dirección adivinada es peor que pedir el pin (un mensaje más)
  if (g?.lat && !g._incierto) return { lat: g.lat, lng: g.lng, nombre: g.nombre || textoLugar };
  return null;
}

// ─── ENTRADA: minar el primer mensaje al máximo ──────────────────────────────
async function iniciar(phone, msg, session) {
  const { texto } = await textoDeMensaje(msg); // audio ya transcrito y cacheado
  const contenido = extraerContenidoUtil(texto);

  // ¿El mensaje de entrada YA dice dónde? ("...a la América y Pando")
  if (contenido) {
    try {
      const ubi = await extraerUbicaciones(texto);
      const lugarTxt = (ubi?.destinoDetalle?.texto || ubi?.destino || ubi?.origenDetalle?.texto || ubi?.origen || "").trim();
      if (lugarTxt) {
        const punto = await resolverUbicacionTexto(lugarTxt);
        if (punto) {
          // TODO en un solo mensaje → despacho inmediato, cero preguntas
          await enviarMensaje(phone, `🚑 *Entendido:* ${contenido}\n📍 *En:* ${punto.nombre}\n\n_Si el lugar NO es ese, mandá tu pin 📍 ahora._`);
          const r = await despacharEmergencia(phone, punto, contenido);
          if (!r.despachada) {
            await updateSession(phone, { modulo: "ambulancia", step: "mod_ambulancia_familiar", ambUbicacion: punto, ambDescripcion: contenido });
            await enviarMensaje(phone, `👪 ¿Aviso a un *familiar*? Mandame su número (ej: _71234567_) o escribí NO.`);
          }
          return true;
        }
      }
    } catch (e) { log.warn("[MOD:ambulancia] Extracción de entrada:", e.message); }
  }

  // Falta la ubicación: pedir SOLO el pin (lo único imprescindible)
  await enviarMensaje(phone,
    "🚑 *EMERGENCIA — mandá tu 📍 UBICACIÓN ya:*\n" +
    "📎 clip → *Ubicación* → *Enviar mi ubicación actual*\n\n" +
    "_Con el pin la ayuda sale de inmediato. Si es grave, llamá también al SAMU / 110._");
  await updateSession(phone, { ...(session || {}), modulo: "ambulancia", step: "mod_ambulancia_ubicacion", ambDescPrevia: contenido || null });
  return true;
}

async function procesar(phone, msg, buttonId, session) {
  const { texto } = await textoDeMensaje(msg);

  if (/^cancelar$/i.test(texto)) {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Solicitud de ambulancia cancelada.");
    return true;
  }

  switch (session.step) {

    // ── EL PIN DESPACHA ──────────────────────────────────────────────────────
    case "mod_ambulancia_ubicacion": {
      let punto = null;
      if (msg?.location) {
        const lat = parseFloat(msg.location.latitude ?? msg.location.lat);
        const lng = parseFloat(msg.location.longitude ?? msg.location.lng);
        if (!isNaN(lat) && !isNaN(lng)) {
          const nombre = msg.location.name || (await obtenerDireccion(lat, lng).catch(() => null)) || "Ubicación del incidente";
          punto = { lat, lng, nombre };
        }
      } else if (texto) {
        // Puede venir "en la América y Pando, se cayó mi mamá": dirección + detalle
        const contenidoNuevo = extraerContenidoUtil(texto);
        if (contenidoNuevo && !session.ambDescPrevia) session.ambDescPrevia = contenidoNuevo;
        punto = await resolverUbicacionTexto(texto);
      }
      if (!punto) {
        await enviarMensaje(phone, "📍 Mandá el PIN: 📎 clip → *Ubicación* → *Enviar mi ubicación actual*.");
        return true;
      }

      if (session.ambDescPrevia) {
        // Ya sabíamos qué pasó desde el primer mensaje → despacho completo
        const r = await despacharEmergencia(phone, punto, session.ambDescPrevia);
        if (!r.despachada) {
          await updateSession(phone, { modulo: "ambulancia", step: "mod_ambulancia_familiar", ambUbicacion: punto, ambDescripcion: session.ambDescPrevia });
          await enviarMensaje(phone, `👪 ¿Aviso a un *familiar*? Mandame su número (ej: _71234567_) o escribí NO.`);
        }
        return true;
      }

      // Sin detalle todavía: LA AYUDA SALE IGUAL (se asume lo peor) y el
      // "¿qué pasó?" viene después, mientras la ayuda ya viaja
      const r = await despacharEmergencia(phone, punto, "🚨 Emergencia médica (detalle en camino)", true);
      if (r.despachada) return true; // el chat con la unidad toma el control; lo que escriba le llega directo
      await updateSession(phone, {
        modulo: "ambulancia", step: "mod_ambulancia_detalle_post",
        ambUbicacion: punto, ambSolicitudId: r.solicitudId,
      });
      await enviarMensaje(phone, `✅ *Tu ubicación ya fue enviada a la red.*\n\n🩺 Ahora contame: ¿*qué pasó*? (así te guío mientras llega la ayuda)`);
      return true;
    }

    // ── Detalle DESPUÉS del despacho: guía + enriquecer la alerta ───────────
    case "mod_ambulancia_detalle_post": {
      if (!texto) { await enviarMensaje(phone, "🩺 Contame qué pasó (texto o audio)."); return true; }
      const descripcion = texto.substring(0, 300);
      const prioridad = clasificarPrioridad(descripcion);

      const guia = guiaPrimerosAuxilios(descripcion);
      if (guia) await enviarMensaje(phone, guia);

      if (session.ambSolicitudId) {
        await Solicitud.update({ where: { id: session.ambSolicitudId }, data: { detalle: { descripcion, prioridad } } }).catch(() => {});
      }
      enviarMensaje(CONFIG.ADMIN_PHONE, `🩺 *Detalle de la emergencia de +${phone}:* ${descripcion} (prioridad ${prioridad.toUpperCase()})`).catch(() => {});

      await updateSession(phone, { ...session, step: "mod_ambulancia_familiar", ambDescripcion: descripcion });
      await enviarMensaje(phone, `👪 ¿Aviso a un *familiar*? Mandame su número (ej: _71234567_) o escribí NO.`);
      return true;
    }

    // ── Aviso a un familiar (opcional) ───────────────────────────────────────
    case "mod_ambulancia_familiar": {
      if (/^(no|omitir|nada)$/i.test(texto)) {
        await deleteSession(phone);
        await enviarMensaje(phone, "👍 Listo. Cualquier novedad te escribimos por acá.");
        return true;
      }
      const num = String(texto || "").replace(/\D/g, "");
      if (!/^(591)?[67]\d{7}$/.test(num)) {
        await enviarMensaje(phone, "🙏 Mandame el número del familiar (ej: _71234567_) o escribí *NO* para omitir.");
        return true;
      }
      const familiar = num.startsWith("591") ? num : `591${num}`;
      const ubi = session.ambUbicacion;
      const ok = await enviarMensaje(familiar,
        `🚨 *Aviso de emergencia — ChatGo Ambulancias*\n\n` +
        `Un familiar tuyo (+${phone}) reportó una emergencia médica:\n` +
        `🩺 ${session.ambDescripcion || "emergencia médica"}\n` +
        `📍 ${ubi?.nombre || "Ver mapa"}\n` +
        (ubi ? `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}\n` : "") +
        `\nYa se avisó a la red de ambulancias y a los operadores.`);
      await deleteSession(phone);
      if (ok) {
        await enviarMensaje(phone, `✅ Le avisamos al +${familiar} con la ubicación.\n\nFuerza. Cualquier novedad te escribimos por acá. ❤️`);
      } else {
        await enviarMensaje(phone, `⚠️ No pudimos escribirle al +${familiar} (WhatsApp lo bloqueó por no conocer nuestro número).\n\nCompartile vos esta ubicación:\nhttps://maps.google.com/?q=${ubi?.lat},${ubi?.lng}`);
      }
      return true;
    }

    default:
      await deleteSession(phone);
      return false;
  }
}

module.exports = { id: "ambulancia", iniciar, procesar };
