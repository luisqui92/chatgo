// ChatGo — Módulo AMBULANCIAS
//
// Emergencias médicas por WhatsApp: pide la ubicación PRIMERO (mínima fricción),
// clasifica la prioridad por palabras clave, y despacha la ambulancia más cercana
// reutilizando el motor del taxi — las ambulancias se registran como choferes con
// tipoVehiculo "ambulancia" y el filtro por tipo del motor hace el resto (GPS,
// reserva atómica, botones Aceptar/Rechazar, tracking en vivo, chat).
//
// Si no hay ambulancia disponible (la realidad de hoy en las sombras), guarda la
// solicitud, alerta al ADMIN con máxima prioridad y orienta al usuario a llamar
// a los servicios de emergencia oficiales. ChatGo complementa, nunca reemplaza,
// la llamada de emergencia.

const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { Solicitud, Viaje } = require("../db/models");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { obtenerDireccion, geocodificarConMemoria } = require("../services/google");
const { buscarChoferDisponibleTraccar, reservarChoferTraccar } = require("../services/traccar");
const { textoDeMensaje } = require("./util");

// Clasificación de prioridad por palabras clave (determinista y sin latencia —
// en una emergencia no hay tiempo para esperar a un modelo)
const SIGNOS_CRITICOS = /inconsciente|no respira|respira mal|dificultad para respirar|infarto|paro card|convulsion|sangr|hemorragia|atropell|choque|volcadura|grave|embarazada|parto|quemad|quem[oó]|electrocut|ahog|arma|bala|apuñal/i;
const SIGNOS_MEDIOS = /fractura|caida|caída|golpe fuerte|dolor fuerte|dolor de pecho|fiebre alta|corte|herida|mareo|desmayo/i;

function clasificarPrioridad(descripcion) {
  if (SIGNOS_CRITICOS.test(descripcion)) return "critica";
  if (SIGNOS_MEDIOS.test(descripcion)) return "media";
  return "normal";
}

// ─── PRIMEROS AUXILIOS MIENTRAS LLEGA LA AYUDA ──────────────────────────────
// Guías básicas curadas (estándar de primeros auxilios para personas sin
// entrenamiento). Elegidas por la condición detectada — texto fijo, nunca
// generado por IA en el momento: en emergencias no se improvisa.
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

async function iniciar(phone, msg, session) {
  await enviarMensaje(phone,
    "🚑 *ChatGo Ambulancias — Emergencia médica*\n\n" +
    "📍 Mándame *AHORA la ubicación* del incidente (pin de WhatsApp) o escribe la dirección exacta.\n\n" +
    "⚠️ _Si la emergencia es grave, llama también a los servicios de emergencia de tu ciudad._");
  await updateSession(phone, { ...(session || {}), modulo: "ambulancia", step: "mod_ambulancia_ubicacion" });
  return true;
}

async function procesar(phone, msg, buttonId, session) {
  // Acepta texto o nota de voz — en una emergencia, hablar es más rápido que escribir
  const { texto } = await textoDeMensaje(msg);

  if (/^cancelar$/i.test(texto)) {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Solicitud de ambulancia cancelada.");
    return true;
  }

  switch (session.step) {

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
        const geo = await geocodificarConMemoria(texto, session.ciudadUsuario || null).catch(() => null);
        if (geo && geo.lat) punto = { lat: geo.lat, lng: geo.lng, nombre: geo.nombre || texto };
      }
      if (!punto) {
        await enviarMensaje(phone, "📍 Necesito la ubicación exacta: toca el clip 📎 → *Ubicación* → *Enviar mi ubicación actual*.");
        return true;
      }
      await updateSession(phone, { ...session, ambUbicacion: punto, step: "mod_ambulancia_detalle" });
      await enviarMensaje(phone, `✅ Ubicación recibida: *${punto.nombre}*\n\n🩺 En pocas palabras: ¿*qué pasó* y cuántas personas necesitan ayuda?`);
      return true;
    }

    case "mod_ambulancia_detalle": {
      if (!texto) {
        await enviarMensaje(phone, "🩺 Escríbeme brevemente qué pasó (ej: _persona inconsciente_, _accidente de tránsito, 2 heridos_).");
        return true;
      }
      const descripcion = texto.substring(0, 300);
      const prioridad = clasificarPrioridad(descripcion);
      const ubi = session.ambUbicacion;

      // 1) Guardar la solicitud SIEMPRE (auditoría y operación manual)
      let solicitudId = null;
      try {
        const sol = await Solicitud.create({
          data: {
            tipo: "ambulancia",
            usuarioPhone: phone,
            estado: "nueva",
            detalle: { descripcion, prioridad },
            origenLat: ubi.lat,
            origenLng: ubi.lng,
            origenNombre: ubi.nombre,
          },
        });
        solicitudId = sol.id;
      } catch (e) {
        log.error("[MOD:ambulancia] Error guardando solicitud:", e.message);
      }

      // 2) Intentar despacho automático: ambulancias = choferes tipo "ambulancia"
      let despachada = false;
      try {
        const unidad = await buscarChoferDisponibleTraccar(ubi, [], "ambulancia");
        if (unidad) {
          const viaje = await Viaje.create({
            data: {
              usuarioPhone: phone,
              choferPhone: unidad.phone,
              choferTraccarId: unidad.traccarId,
              choferNombre: unidad.nombre,
              choferPlaca: unidad.placa,
              ciudad: detectarCiudadPorCoords(ubi.lat, ubi.lng),
              origenLat: ubi.lat,
              origenLng: ubi.lng,
              origenNombre: ubi.nombre,
              destinoLat: ubi.lat,
              destinoLng: ubi.lng,
              destinoNombre: "Traslado según evaluación médica",
              observaciones: `🚑 EMERGENCIA MÉDICA [prioridad ${prioridad.toUpperCase()}]: ${descripcion}`,
              distanciaKm: 0,
              precioTotal: 0,
              precioBase: 0,
              tipoVehiculo: "ambulancia",
              estado: "pendiente",
              fechaAsignacion: new Date(),
            },
          });
          const reservada = await reservarChoferTraccar(unidad.traccarId, viaje.id);
          if (reservada) {
            despachada = true;
            if (solicitudId) {
              await Solicitud.update({ where: { id: solicitudId }, data: { viajeId: viaje.id, estado: "asignada", asignadoPhone: unidad.phone } }).catch(() => {});
            }
            // Orden URGENTE a la ambulancia — los botones Aceptar/Rechazar
            // los procesa el flujo chofer existente (aceptar_viaje / rechazar_viaje)
            await enviarBotones(unidad.phone,
              `🚨🚑 *EMERGENCIA MÉDICA — PRIORIDAD ${prioridad.toUpperCase()}*\n\n` +
              `🩺 ${descripcion}\n` +
              `📍 ${ubi.nombre}\n` +
              `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}\n` +
              `📏 A ${unidad.distanciaAlUsuario?.toFixed(1) || "?"} km de ti\n\n` +
              `⏱️ *RESPONDE DE INMEDIATO*`,
              [
                { id: "aceptar_viaje", title: "🚑 VOY" },
                { id: "rechazar_viaje", title: "❌ No puedo" },
              ]);
            await updateSession(phone, { step: "esperando_chofer", viajeId: viaje.id.toString(), choferPhone: unidad.phone });
            await enviarMensaje(phone,
              `🚑 *Ambulancia localizada a ${unidad.distanciaAlUsuario?.toFixed(1) || "?"} km*\n\n` +
              `Estamos confirmando la unidad. En cuanto acepte te llega el enlace para verla llegar en tiempo real.\n\n` +
              `⚠️ _Mientras tanto: no muevas a la persona herida salvo peligro inminente._`);
          } else {
            await Viaje.delete({ where: { id: viaje.id } }).catch(() => {});
          }
        }
      } catch (e) {
        log.error("[MOD:ambulancia] Error en despacho:", e.message);
      }

      // 2b) PRIMEROS AUXILIOS mientras llega la ayuda (según lo que pasó).
      // Es la parte más valiosa del servicio comunitario: minutos que salvan vidas.
      const guia = guiaPrimerosAuxilios(descripcion);
      if (guia) await enviarMensaje(phone, guia);

      // 3) Sin unidad con GPS disponible → difundir a TODA la red de ambulancias
      //    registradas (servicio comunitario: sin cuotas, sin cobros) + operación manual
      if (!despachada) {
        try {
          const { Chofer } = require("../db/models");
          const red = await Chofer.findMany({ where: { tipoVehiculo: "ambulancia" }, take: 20 });
          for (const unidad of red) {
            enviarMensaje(unidad.phone,
              `🚨🚑 *EMERGENCIA EN LA ZONA — ChatGo Ambulancias*\n\n` +
              `🩺 ${descripcion}\n📍 ${ubi.nombre}\n` +
              `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}\n\n` +
              `Si podés atenderla, respondé este mensaje y coordinamos de inmediato.`).catch(() => {});
          }
          if (red.length) log.info(`[MOD:ambulancia] Difundido a ${red.length} unidades de la red`);
        } catch (e) { log.error("[MOD:ambulancia] Error difundiendo a la red:", e.message); }

        await enviarMensaje(phone,
          `🚑 *Solicitud registrada — prioridad ${prioridad.toUpperCase()}*\n\n` +
          `🚨 *Llama YA a los servicios de emergencia de tu ciudad* (SAMU / Cruz Roja / 110) — no esperes.\n\n` +
          `Avisamos a nuestra red de ambulancias y un operador de ChatGo está viendo tu solicitud.\n\n` +
          `_ChatGo Ambulancias es un servicio gratuito para la comunidad._ ❤️`);

        // Ofrecer avisar a un familiar con la ubicación
        await updateSession(phone, { ...session, step: "mod_ambulancia_familiar", ambDescripcion: descripcion });
        await enviarMensaje(phone,
          `👪 ¿Querés que le avisemos a un *familiar*?\n\nMandame su número (ej: _71234567_) y le comparto la ubicación y lo que pasó.\n\n_Escribí NO para omitir._`);
      }

      // 4) Alerta al admin SIEMPRE (crítica o no)
      try {
        const icono = prioridad === "critica" ? "🔴🔴🔴" : prioridad === "media" ? "🟠" : "🟡";
        await enviarMensaje(CONFIG.ADMIN_PHONE,
          `${icono} *AMBULANCIA — PRIORIDAD ${prioridad.toUpperCase()}* ${despachada ? "(unidad despachada)" : "(SIN UNIDAD — OPERAR MANUAL)"}\n\n` +
          `👤 +${phone}\n🩺 ${descripcion}\n📍 ${ubi.nombre}\n` +
          `🗺️ https://maps.google.com/?q=${ubi.lat},${ubi.lng}` +
          (solicitudId ? `\n🆔 ${solicitudId}` : ""));
      } catch (e) {
        log.error("[MOD:ambulancia] Error alertando admin:", e.message);
      }

      return true;
    }

    // ── Aviso a un familiar (opcional) ───────────────────────────────────
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
        // Ventana de 24h de Meta: si el familiar nunca habló con el bot puede no llegar
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
