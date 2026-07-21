// ChatGo — Flow chofer

function calcularDistanciaSimple(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const https = require("https");
const http = require("http");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, LocationReference, PreRegistroFlota, NotificacionPago } = require("../db/models");
const { getSession, setSession, updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones, enviarImagen, reenviarImagenPorId, relayMensajeChat, descargarImagenMeta } = require("../services/whatsapp");
const { obtenerUbicacionChofer, liberarReservaChoferTraccar, generarLinkRastreoPropio } = require("../services/traccar");
const { normalizarReferencia, guardarReferenciaVoz, calcularDistancia, calcularDistanciaConParadas, calcularTiempoConTrafico, obtenerRutaCompleta } = require("../services/google");
const { validarComprobantePago } = require("../services/openai");
const { registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge, registrarViajeEnDemanda, actualizarUltimoViaje } = require("../ai");
const { asignarChofer, procesarPedidoAyuda, solicitarRating } = require("../flows/viaje");
const { calcularPrecio, choferPagoAlDia, crearCodigoPromo, enPromoGratis, enviarCodigoDescuento, esPedidoAyuda, esPlusCode, fechaStrBolivia, formatearFechaPromo, guardarRutaFrecuente, promoCodigosActiva } = require("../services/utils");
const { enviarPushWeb, borrarSuscripcion } = require("../services/push");


// ¿El viaje es un pedido de DELIVERY? (marcador que pone modules/delivery.js
// en las observaciones). El cliente pidió comida, no un taxi: los mensajes
// de todo el ciclo hablan de su pedido, no de "tu chofer/tu viaje".
function esViajeDelivery(v) {
  return !!(v?.observaciones && v.observaciones.startsWith("🍔 DELIVERY"));
}

// Pedido hecho desde la WEB: el seguimiento (aceptado, llegó, en viaje) se
// muestra en la propia web (polling de /api/web/estado). NO se le manda nada al
// pasajero por WhatsApp durante el viaje; solo el "gracias" al finalizar.
function esViajeWeb(v) {
  return /🌐|desde la web/i.test(v?.observaciones || "");
}

async function procesarMensajeChofer(phone, mensajeTexto, buttonId, mediaId, mensaje) {
  let chofer = await Chofer.findUnique({ where: { phone } });

  if (!chofer) {
    const NUMERO_REGISTRO = process.env.NUMERO_REGISTRO || "59164637067";

    // PASO 1: preguntar si tiene código de radiotaxi (para vincularlo a su flota)
    // Códigos válidos en variable CODIGOS_RADIOTAXI: "clasico,radiomovil,..." (sin tildes)
    const codigosValidos = (process.env.CODIGOS_RADIOTAXI || "")
      .split(",").map(c => c.trim().toLowerCase()).filter(Boolean);

    // Si el chofer responde con botones a la pregunta del código
    if (buttonId === "chofer_tiene_codigo") {
      await setSession(phone, { step: "chofer_esperando_codigo_flota" });
      await enviarMensaje(phone, `🚕 Escribe el *código de tu radiotaxi*.\n\n_(Te lo dio el dueño o administrador de tu radiotaxi.)_`);
      return;
    }
    if (buttonId === "chofer_sin_codigo") {
      await enviarMensaje(phone,
        `👋 Para ser conductor de ChatGo tienes que registrarte con nosotros.\n\n` +
        `El registro es rápido (unos 5 minutos) y lo haces con otro número:\n\n` +
        `📱 https://wa.me/${NUMERO_REGISTRO}?text=Vengo+a+registrarme\n\n` +
        `Te vamos a pedir:\n` +
        `1️⃣ Foto de licencia de conducir\n2️⃣ Selfie tuya\n3️⃣ Foto del vehículo con placa visible\n4️⃣ RUAT\n5️⃣ SOAT\n\n` +
        `Una vez aprobado, te enviaremos las credenciales y podrás volver aquí 🚖`
      );
      await deleteSession(phone);
      return;
    }

    // Si está escribiendo el código de la flota
    const sesionChofer = await getSession(phone);
    if (sesionChofer?.step === "chofer_esperando_codigo_flota" && mensajeTexto) {
      const codigoIngresado = mensajeTexto.trim().toLowerCase().replace(/\s+/g, "");
      // Buscar coincidencia (acepta "clasico" o "radiomovilclasico" según config)
      const match = codigosValidos.find(c => c.replace(/\s+/g, "") === codigoIngresado);
      if (match) {
        // Guardar el pre-registro: este teléfono pertenece a esta flota
        await PreRegistroFlota.upsert({
          where: { phone },
          create: { phone, flota: match },
          update: { flota: match },
        });
        await deleteSession(phone);
        await enviarMensaje(phone,
          `✅ ¡Código correcto! Quedas registrado para el radiotaxi *${match}*.\n\n` +
          `Ahora completá tu registro en este número:\n📱 https://wa.me/${NUMERO_REGISTRO}?text=Vengo+a+registrarme+de+${match}\n\n` +
          `Te pediremos: licencia, selfie, foto del vehículo, RUAT y SOAT.\n\n` +
          `Cuando te aprobemos, ya quedarás vinculado a tu radiotaxi 🚖`
        );
      } else {
        await enviarMensaje(phone, `❌ Ese código no es válido. Verificá con el administrador de tu radiotaxi y volvé a escribirlo, o escribí *NO* si no tenés código.`);
        if (codigoIngresado === "no") { await deleteSession(phone); }
      }
      return;
    }

    // Primera vez: preguntar si tiene código
    await enviarBotones(
      phone,
      `👋 ¡Hola! Para ser conductor de ChatGo.\n\n¿Perteneces a un *radiotaxi* y tienes un código?`,
      [
        { id: "chofer_tiene_codigo", title: "✅ Sí, tengo código" },
        { id: "chofer_sin_codigo", title: "No tengo código" },
      ]
    );
    return;
  }

  if (!buttonId && mensajeTexto && esPedidoAyuda(mensajeTexto)) {
    await procesarPedidoAyuda(phone, true);
    return;
  }

  // ─── COPILOTO IA: pánico del chofer por palabra clave ────────────────────
  if (!buttonId && mensajeTexto && /\b(emergencia|auxilio|me asaltan|me est[aá]n robando|s[aá]quenme|pánico|panico)\b/i.test(mensajeTexto)) {
    const { activarPanico } = require("../ai/copiloto");
    const viajePanico = await Viaje.findFirst({
      where: {
        choferPhone: phone,
        estado: { in: ["en_curso", "esperando_pasajero", "en_camino"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (viajePanico) {
      await activarPanico(viajePanico, "chofer");
      await enviarMensaje(phone, "🆘 Alerta enviada. Nuestro equipo fue notificado y seguimos tu ubicación. Si es grave, llama al 110.");
      return;
    }
  }

  if (buttonId) {
    if (buttonId === "aceptar_viaje") {
      const viaje = await Viaje.findFirst({ where: { choferTraccarId: chofer.traccarId, estado: "pendiente" } });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes pendientes (quizás expiró).");

      const userPhone = viaje.usuarioPhone;
      const esWeb = esViajeWeb(viaje); // pedido web: no avisar por WhatsApp (la web muestra todo)
      await Chofer.update({ where: { id: chofer.id }, data: { estado: "ocupado", viajeReservado: null, reservadoHasta: null } });
      await Viaje.update({ where: { id: viaje.id }, data: { estado: "en_camino", fechaAceptacion: new Date() } });

      // IA: registrar aceptación para métricas de despacho
      const tiempoRespuesta = viaje.fechaAsignacion
        ? Math.round((Date.now() - new Date(viaje.fechaAsignacion).getTime()) / 1000)
        : null;
      registrarEventoChofer(chofer.phone, "aceptado", {
        viajeId: String(viaje.id),
        segundosParaResponder: tiempoRespuesta,
        distanciaAlOrigen: viaje.distanciaKm,
      }).catch(() => {});

      const session = await getSession(userPhone);
      if (session) await updateSession(userPhone, { ...session, step: "chofer_en_camino" });

      // Link de rastreo propio — expira exactamente cuando termina el viaje
      const linkRastreo = generarLinkRastreoPropio(viaje.id);
      // Superchofer ("todo"): mostrar al pasajero el tipo del VIAJE, no "todo"
      const tipoVeh = (chofer.tipoVehiculo === "todo" ? viaje.tipoVehiculo : chofer.tipoVehiculo) || "auto";
      const emojiV = tipoVeh === "moto" ? "🏍️" : "🚗";
      const labelV = tipoVeh === "moto" ? "Moto" : "Auto";
      const colorVStr = chofer.colorVehiculo ? ` ${chofer.colorVehiculo}` : "";

      // Foto combinada para demo: si está configurada FOTO_DEMO_COMBINADA,
      // manda UNA sola imagen (auto grande + chofer en recuadro) en vez de dos.
      // Para producción normal, manda las dos fotos por separado como siempre.
      // En pedidos WEB no se manda nada por WhatsApp: la web muestra al chofer.
      const fotoDemo = process.env.FOTO_DEMO_COMBINADA;
      if (esWeb) {
        // web: sin fotos ni mensaje al pasajero por WhatsApp
      } else if (fotoDemo) {
        await enviarImagen(
          userPhone,
          fotoDemo,
          `${emojiV} ${labelV}${colorVStr} · Placa: ${chofer.placa}\n👤 Tu chofer: ${chofer.nombre}`
        ).catch(() => {});
      } else {
        // Enviar foto del vehículo si existe
        if (chofer.fotoVehiculo) {
          await enviarImagen(
            userPhone,
            chofer.fotoVehiculo,
            `${emojiV} ${labelV}${colorVStr} · Placa: ${chofer.placa}`
          ).catch(() => {});
        }

        // Enviar foto del chofer si existe
        if (chofer.fotoChofer) {
          await enviarImagen(
            userPhone,
            chofer.fotoChofer,
            `👤 Tu chofer: ${chofer.nombre}`
          ).catch(() => {});
        }
      }

      if (esViajeDelivery(viaje)) {
        await enviarMensaje(
          userPhone,
          `🛵 *¡Tu pedido fue asignado!*\n\n` +
            `👤 Repartidor: *${chofer.nombre}*\n` +
            `${emojiV} ${labelV}${colorVStr} · Placa: *${chofer.placa}*\n\n` +
            `Ya está yendo al local a recoger tu pedido 🏪\n\n` +
            `📍 Seguí tu pedido en tiempo real:\n${linkRastreo}\n\n` +
            `💬 Escribe cualquier mensaje para chatear con el repartidor.\n` +
            `_Escribe CANCELAR si necesitas cancelar, o AYUDA para soporte._`
        );
        // Avisar al LOCAL que el repartidor va en camino a recoger
        try {
          const { Solicitud, Restaurante } = require("../db/models");
          const sol = await Solicitud.findFirst({ where: { viajeId: viaje.id } });
          const restId = sol?.detalle?.restauranteId;
          if (restId) {
            const rest = await Restaurante.findUnique({ where: { id: restId } });
            if (rest?.telefono) {
              await enviarMensaje(rest.telefono,
                `🛵 *Repartidor en camino al local*\n\n` +
                `👤 ${chofer.nombre} · ${chofer.placa}\n` +
                `🍽️ Recoge: ${sol.detalle?.plato || "el pedido"}\n\n` +
                `_Tenelo listo para la entrega rápida 🙏_`);
            }
          }
        } catch (e) { log.error("[DELIVERY_LOCAL]", e.message); }
        await enviarBotones(
          phone,
          `✅ Pedido aceptado!\n\nCuando llegues al LOCAL presiona el botón.`,
          [
            { id: "llegue_al_punto", title: "🏪 Llegué al local" },
            { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
          ]
        );
        return;
      }

      if (!esWeb) await enviarMensaje(
        userPhone,
        `🎉 *¡Viaje aceptado!*\n\n` +
          `👤 Chofer: *${chofer.nombre}*\n` +
          `${emojiV} ${labelV}${colorVStr} · Placa: *${chofer.placa}*\n\n` +
          `📍 Rastrea tu chofer en tiempo real:\n${linkRastreo}\n\n` +
          `💬 Escribe cualquier mensaje para chatear con él.\n` +
          `_Escribe CANCELAR si necesitas cancelar, o AYUDA para soporte._`
      );
      // Pedido web: push real al celular (funciona con el navegador cerrado)
      if (esWeb) await enviarPushWeb(userPhone, "🚖 ¡Chofer en camino!", `${chofer.nombre} · ${chofer.placa} va hacia vos.`, "/pedir");
      await enviarBotones(
        phone,
        `✅ Viaje aceptado!\n\nCuando llegues al punto de recojo presiona el botón.`,
        [
          { id: "llegue_al_punto", title: "🚕 Llegué" },
          { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
        ]
      );
      return;
    }

    if (buttonId === "rechazar_viaje") {
      const viaje = await Viaje.findFirst({ where: { choferTraccarId: chofer.traccarId, estado: "pendiente" } });
      if (viaje) {
        await Viaje.update({ where: { id: viaje.id }, data: { estado: "rechazado_chofer", cancelacionMotivo: "rechazo_chofer" } });
        await liberarReservaChoferTraccar(chofer.traccarId);
        // IA: registrar rechazo
        registrarEventoChofer(chofer.phone, "rechazado", { viajeId: String(viaje.id) }).catch(() => {});
        await enviarMensaje(phone, "Ok, buscaremos otro chofer para ese pasajero.");
        const session = await getSession(viaje.usuarioPhone);
        if (session) {
          await enviarMensaje(viaje.usuarioPhone, "⏳ Buscando otro chofer...");
          // Acumular al que rechazó para que la cascada siga al siguiente más
          // cercano y no vuelva atrás (antes hacía ping-pong entre los 2 más cercanos)
          const yaExcluidos = [...(session.choferesExcluidos || []), chofer.traccarId];
          await asignarChofer(viaje.usuarioPhone, { ...session, choferesExcluidos: yaExcluidos }, yaExcluidos);
        }
      }
      return;
    }

    // FIX BUG#3 — llegue_al_punto busca en en_camino Y en esperando_pasajero
    // para evitar conflicto con la detección GPS automática
    if (buttonId === "llegue_al_punto") {
      const viaje = await Viaje.findFirst({
        where: {
          choferTraccarId: chofer.traccarId,
          estado: { in: ["en_camino", "esperando_pasajero"] },
        },
      });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes activos.");

      // Si ya está en esperando_pasajero (GPS ya lo detectó), simplemente mostrar botones
      if (viaje.estado === "esperando_pasajero") {
        await enviarBotones(
          phone,
          `✅ El pasajero ya fue notificado de tu llegada.\nCuando el pasajero suba presiona:`,
          [
            { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
            { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
          ]
        );
        return;
      }

      // Estado en_camino — transición manual
      await Viaje.update({ where: { id: viaje.id }, data: { estado: "esperando_pasajero", llegadaOrigenNotificada: true } });
      const session = await getSession(viaje.usuarioPhone);
      if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "chofer_esperando_pasajero" });

      const tipoVeh = chofer.tipoVehiculo || "auto";
      const emoji = tipoVeh === "moto" ? "🏍️" : "🚗";
      const label = tipoVeh === "moto" ? "moto" : "auto";

      const colorLlegueManual = chofer.colorVehiculo ? ` ${chofer.colorVehiculo}` : "";
      if (esViajeDelivery(viaje)) {
        await enviarMensaje(viaje.usuarioPhone, `🏪 *El repartidor llegó al local*\n\nEstá recogiendo tu pedido. En cuanto lo tenga, sale para tu ubicación 🛵`);
        await enviarBotones(
          phone,
          `✅ Cliente notificado.\n\nCuando tengas el pedido en mano presiona:`,
          [
            { id: "iniciar_viaje", title: "🛵 Pedido recogido" },
            { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
          ]
        );
        return;
      }
      if (!esViajeWeb(viaje)) await enviarMensaje(viaje.usuarioPhone, `🚕 *¡Tu chofer llegó!*\n\n👤 ${chofer.nombre}\n${emoji} ${label}${colorLlegueManual} · placa: ${chofer.placa}\n\nDirígete al vehículo.`);
      else await enviarPushWeb(viaje.usuarioPhone, "📍 ¡Tu chofer llegó!", `${chofer.nombre} te espera. Dirigite al vehículo.`, "/pedir");
      const usuarioLlegueBtn = await Usuario.findUnique({ where: { phone: viaje.usuarioPhone } });
      const nombreLlegueBtn = usuarioLlegueBtn?.nombre ? `\n🙋 Pregunta por: *ChatGo para ${usuarioLlegueBtn.nombre}*` : "";
      await enviarBotones(
        phone,
        `✅ Pasajero notificado.${nombreLlegueBtn}\n\nCuando el pasajero suba presiona:`,
        [
          { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
          { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
        ]
      );
      return;
    }

    if (buttonId === "iniciar_viaje") {
      const viaje = await Viaje.findFirst({ where: { choferTraccarId: chofer.traccarId, estado: "esperando_pasajero" } });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes activos.");
      // Calcular ruta completa (polilínea + tiempo con tráfico) al iniciar
      let tiempoEstimadoMin = null;
      let rutaUpdate = {};
      try {
        const ruta = await obtenerRutaCompleta(
          viaje.origenLat, viaje.origenLng,
          viaje.destinoLat, viaje.destinoLng
        );
        if (ruta) {
          tiempoEstimadoMin = ruta.minutosEstimados;
          rutaUpdate = {
            rutaPolilinea: ruta.polilinea,
            rutaPuntos: ruta.puntos,
          };
        } else {
          // fallback: al menos el tiempo con tráfico
          const trafico = await calcularTiempoConTrafico(
            viaje.origenLat, viaje.origenLng,
            viaje.destinoLat, viaje.destinoLng
          );
          if (trafico) tiempoEstimadoMin = trafico.minutosConTrafico;
        }
      } catch(e) { log.error("[INICIO_VIAJE_RUTA]", e.message); }

      try {
        await Viaje.update({
          where: { id: viaje.id },
          data: {
            estado: "en_curso",
            tiempoEstimadoMin,
            fechaInicioViaje: new Date(),
            nivelAlerta: "verde",
            ...rutaUpdate,
          },
        });
      } catch (e) {
        // La metadata de ruta NUNCA debe trabar el viaje (pasó en producción:
        // rutaPolilinea > VARCHAR(191) tumbaba el update completo y el chofer
        // quedaba mudo). Reintentar sin los campos de ruta.
        log.error("[INICIO_VIAJE_UPDATE]", e.message);
        await Viaje.update({
          where: { id: viaje.id },
          data: {
            estado: "en_curso",
            tiempoEstimadoMin,
            fechaInicioViaje: new Date(),
            nivelAlerta: "verde",
          },
        });
      }
      const session = await getSession(viaje.usuarioPhone);
      if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "en_curso" });
      const linkAlDestino = `https://www.google.com/maps/dir/?api=1&origin=${viaje.origenLat},${viaje.origenLng}&destination=${viaje.destinoLat},${viaje.destinoLng}&travelmode=driving`;
      if (esViajeDelivery(viaje)) {
        await enviarMensaje(viaje.usuarioPhone, `🛵 *¡Tu pedido va en camino!*\n\n📍 Seguilo en tiempo real:\n${generarLinkRastreoPropio(viaje.id)}\n\n¡Preparate que ya llega! 🍔`);
        await enviarBotones(
          phone,
          `🛵 *Pedido en camino*\n\n` +
            `🏁 Entregar en: ${viaje.destinoNombre || "ubicación del cliente"}\n` +
            `📏 ${viaje.distanciaKm} km\n\n` +
            `🗺️ Ir a la entrega:\n${linkAlDestino}\n\nConduce con cuidado! 🛵`,
          [{ id: "terminar_viaje", title: "✅ Pedido entregado" }]
        );
        return;
      }
      if (!esViajeWeb(viaje)) await enviarMensaje(viaje.usuarioPhone, `🚖 *Viaje iniciado*\n\n¡Disfruta tu viaje con ChatGo!`);
      else await enviarPushWeb(viaje.usuarioPhone, "🛣️ Viaje iniciado", "¡Disfrutá tu viaje con ChatGo!", "/pedir");
      await enviarBotones(
        phone,
        `▶️ *Viaje iniciado*\n\n` +
          `🏁 Destino: ${viaje.destinoNombre || "destino del pasajero"}\n` +
          `📏 ${viaje.distanciaKm} km\n\n` +
          `🗺️ Ir al destino:\n${linkAlDestino}\n\nConduce con cuidado! 🚖`,
        [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
      );
      return;
    }

    if (buttonId === "cancelar_viaje_chofer") {
      const viaje = await Viaje.findFirst({
        where: {
          choferTraccarId: chofer.traccarId,
          estado: { in: ["en_camino", "esperando_pasajero"] },
        },
      });
      if (viaje) {
        await Viaje.update({
          where: { id: viaje.id },
          data: {
            estado: "cancelado_chofer",
            cancelacionMotivo: "cancelado_por_chofer",
            fechaFin: new Date(),
          },
        });
        await Chofer.update({ where: { id: chofer.id }, data: { estado: "libre" } });
        if (!esViajeWeb(viaje)) await enviarMensaje(viaje.usuarioPhone, `❌ Tu chofer canceló el viaje. Puedes pedir otro cuando quieras.`);
        else await enviarPushWeb(viaje.usuarioPhone, "❌ Viaje cancelado", "El chofer canceló. Podés pedir otro cuando quieras.", "/pedir");
        await enviarMensaje(phone, `❌ Viaje cancelado. Ya estás LIBRE.`);
        await deleteSession(viaje.usuarioPhone);
      }
      return;
    }

    if (buttonId === "terminar_viaje") {
      // Acepta en_curso o esperando_pasajero (edge case: pasajero no subió pero chofer quiere terminar)
      const viaje = await Viaje.findFirst({
        where: {
          choferTraccarId: chofer.traccarId,
          estado: { in: ["en_curso", "esperando_pasajero"] },
        },
      });
      if (!viaje) {
        await enviarMensaje(phone, "No tienes viajes activos para terminar.");
        return;
      }
      if (viaje) {
        // ─── VALIDACIÓN: verificar distancia al destino ───────────────────
        const METROS_MAX_DESTINO = 150;
        let finalizacionSospechosa = false;
        let distanciaAlDestino = null;

        if (viaje.destinoLat && viaje.destinoLng) {
          try {
            const posChofer = await obtenerUbicacionChofer(chofer.traccarId);
            const distKm = calcularDistanciaSimple(posChofer.lat, posChofer.lng, viaje.destinoLat, viaje.destinoLng);
            distanciaAlDestino = Math.round(distKm * 1000); // en metros
            if (distanciaAlDestino > METROS_MAX_DESTINO) {
              finalizacionSospechosa = true;
              log.warn(`[FIN_VIAJE] Chofer ${chofer.phone} finalizó a ${distanciaAlDestino}m del destino (max ${METROS_MAX_DESTINO}m)`);
            }
          } catch (e) {
            log.error("[FIN_VIAJE] Error verificando distancia:", e.message);
          }
        }
        // ─────────────────────────────────────────────────────────────────
        // Nota: finalizacionSospechosa/distanciaAlDestino son solo lógica en memoria
        // para esta solicitud (avisos a chofer/pasajero/admin) — no existen como
        // columnas en el modelo Viaje (tampoco existían en el schema Mongoose original).

        await Viaje.update({
          where: { id: viaje.id },
          data: {
            estado: "completado",
            fechaFin: new Date(),
          },
        });
        await Usuario.update({ where: { phone: viaje.usuarioPhone }, data: { viajesTotal: { increment: 1 } } });

        const choferActual = await Chofer.findUnique({ where: { id: chofer.id } });
        const sigueAlDia = enPromoGratis() || choferPagoAlDia(choferActual);
        await Chofer.update({
          where: { id: chofer.id },
          data: {
            estado: sigueAlDia ? "libre" : "offline",
            viajesTotal: { increment: 1 },
          },
        });
        const origenViaje = { lat: viaje.origenLat, lng: viaje.origenLng, nombre: viaje.origenNombre };
        const destinoViaje = { lat: viaje.destinoLat, lng: viaje.destinoLng, nombre: viaje.destinoNombre };
        await guardarRutaFrecuente(viaje.usuarioPhone, origenViaje, destinoViaje, viaje.tipoVehiculo || "auto");

  // IA: registrar evento completado para métricas del chofer
  if (chofer) {
    registrarEventoChofer(chofer.phone, "completado", {
      viajeId: String(viaje.id),
      distanciaAlOrigen: viaje.distanciaKm,
    }).catch(() => {});
  }

  // IA: registrar viaje en base de demanda para predicción
  registrarViajeEnDemanda(viaje).catch(() => {});

  // IA: actualizar último viaje del usuario para reactivación
  actualizarUltimoViaje(viaje.usuarioPhone).catch(() => {});

  // CROWDSOURCING SILENCIOSO POST-VIAJE: enriquecer la memoria de voz
  // con los nombres reales de origen y destino del viaje completado
  try {
    const usuarioViaje = await Usuario.findUnique({ where: { phone: viaje.usuarioPhone } });
    const ciudadViaje = usuarioViaje?.ciudad || "Cochabamba";
    if (viaje.origenLat && viaje.origenNombre && !esPlusCode(viaje.origenNombre)) {
      const normO = normalizarReferencia(viaje.origenNombre);
      const existeO = await LocationReference.findFirst({ where: { referencia: normO, ciudad: ciudadViaje } });
      if (!existeO) {
        await guardarReferenciaVoz(viaje.origenNombre, viaje.origenLat, viaje.origenLng, viaje.origenNombre, ciudadViaje);
        log.info(`[CROWDSOURCE] Post-viaje origen: "${viaje.origenNombre}" (${ciudadViaje})`);
      }
    }
    if (viaje.destinoLat && viaje.destinoNombre && !esPlusCode(viaje.destinoNombre)) {
      const normD = normalizarReferencia(viaje.destinoNombre);
      const existeD = await LocationReference.findFirst({ where: { referencia: normD, ciudad: ciudadViaje } });
      if (!existeD) {
        await guardarReferenciaVoz(viaje.destinoNombre, viaje.destinoLat, viaje.destinoLng, viaje.destinoNombre, ciudadViaje);
        log.info(`[CROWDSOURCE] Post-viaje destino: "${viaje.destinoNombre}" (${ciudadViaje})`);
      }
    }
  } catch (e) { log.error("[CROWDSOURCE_POST_VIAJE]", e.message); }

        // Único WhatsApp al pasajero en un pedido WEB: el "gracias" final.
        await enviarMensaje(
          viaje.usuarioPhone,
          esViajeWeb(viaje)
            ? `🙏 *¡Gracias por viajar con ChatGo!* 🚖\n\n¡Que tengas un buen día! Te esperamos para tu próximo viaje.`
            : esViajeDelivery(viaje)
              ? `✅ *¡Pedido entregado!*\n\n¡Buen provecho! 🍔\n\nGracias por usar ChatGo Delivery 🛵`
              : `✅ *Viaje completado*\n\n📏 ${viaje.distanciaKm} km\n💰 Bs ${viaje.precioTotal}\n\n¡Gracias por usar ChatGo! 🚖`
        );
        // Pedido web: push final al celular y limpieza de la suscripción (viaje cerrado)
        if (esViajeWeb(viaje)) {
          await enviarPushWeb(viaje.usuarioPhone, "🙏 ¡Gracias por viajar con ChatGo!", "¡Que tengas un buen día! Te esperamos para tu próximo viaje.", "/pedir");
          await borrarSuscripcion(viaje.usuarioPhone);
        }
        // Nota: el botón "pedir otro taxi" aparece después del rating

        // En pedidos WEB no mandamos promo ni rating por WhatsApp (solo el gracias).
        if (!esViajeWeb(viaje) && promoCodigosActiva()) {
          try {
            const nuevoCodigo = await crearCodigoPromo(viaje.usuarioPhone, "post_viaje");
            if (nuevoCodigo) {
              await Viaje.update({ where: { id: viaje.id }, data: { codigoPromoGenerado: nuevoCodigo.codigo } });
              await enviarCodigoDescuento(viaje.usuarioPhone, nuevoCodigo, "tu próximo viaje");
            }
          } catch (e) {
            log.error("[PROMO] Error generando código post-viaje:", e.message);
          }
        }

        // ─── Notificar si la finalización fue sospechosa ─────────────────
        if (finalizacionSospechosa && distanciaAlDestino !== null) {
          // Advertir al chofer
          await enviarMensaje(
            phone,
            `⚠️ *Atención*: Finalizaste el viaje a *${distanciaAlDestino} metros* del destino acordado.\n\nRecuerda llevar al pasajero hasta el punto de destino.`
          );
          // Consultar al pasajero (por WhatsApp solo si NO es pedido web)
          if (!esViajeWeb(viaje)) await enviarBotones(
            viaje.usuarioPhone,
            `⚠️ Detectamos que el viaje finalizó a *${distanciaAlDestino} metros* del destino.\n\n¿Llegaste a tu destino correctamente?`,
            [
              { id: `viaje_ok_${viaje.id}`, title: "✅ Sí, llegué bien" },
              { id: `viaje_problema_${viaje.id}`, title: "❌ No llegué" },
            ]
          );
          // Notificar al admin
          await enviarMensaje(
            CONFIG.ADMIN_PHONE,
            `🚨 *Finalización sospechosa*\n\n👤 Chofer: ${chofer.nombre} (+${phone})\n🚗 Placa: ${chofer.placa}\n📍 Finalizó a *${distanciaAlDestino}m* del destino\n🗺️ Destino: ${viaje.destinoNombre || "—"}\n🆔 Viaje: ${viaje.id}`
          );
          log.warn(`[ALERTA_VIAJE] Finalización sospechosa - chofer ${chofer.phone} a ${distanciaAlDestino}m del destino`);
        }
        // ─────────────────────────────────────────────────────────────────

        if (!esViajeWeb(viaje)) await solicitarRating(viaje.usuarioPhone, viaje.id);

        if (sigueAlDia) {
          await deleteSession(phone); // limpiar sesión para que el webhook no lo confunda con pasajero
          await enviarBotones(phone, `✅ Viaje finalizado!\n🟢 Ya estás LIBRE para el siguiente viaje.`, [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]);
        } else if (!enPromoGratis()) {
          await enviarMensaje(phone, `✅ Viaje finalizado!\n\n⚠️ Tu pago diario no está al día. Debes pagar Bs 10 para seguir recibiendo viajes.`);
          if (CONFIG.QR_IMAGE_URL) await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante*.`);
          await setSession(phone, { step: "chofer_esperando_comprobante" });
        }
      }
      return;
    }

    if (buttonId === "chofer_libre") {
      if (!choferPagoAlDia(chofer) && !enPromoGratis()) {
        await Chofer.update({ where: { id: chofer.id }, data: { estado: "offline" } });
        await enviarMensaje(phone, `Para estar LIBRE primero paga tu cuota diaria de *Bs 10*.`);
        if (CONFIG.QR_IMAGE_URL) await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante* para activarte.`);
        await setSession(phone, { step: "chofer_esperando_comprobante" });
        return;
      }
      try {
        const pos = await obtenerUbicacionChofer(chofer.traccarId);
        if (pos.minutos > 5) {
          await enviarMensaje(
            phone,
            `⚠️ Tu GPS no está enviando señal en este momento (última señal hace ${pos.minutos} min).\n\n` +
              `Para recibir viajes necesitas tener *ChatgoTrack abierto y activo*.\n\n` +
              `Revisa:\n✅ ChatgoTrack esté abierto (puede estar en segundo plano)\n✅ Permiso de ubicación *"Permitir todo el tiempo"*\n✅ Internet/datos activos\n✅ Optimización de batería DESACTIVADA para ChatgoTrack\n\n` +
              `Reintenta en 1 minuto presionando 🟢 Libre otra vez.`
          );
          return;
        }
      } catch (e) {
        await enviarMensaje(
          phone,
          `⚠️ No pude detectar tu GPS (${e.message}).\n\nAsegúrate que *ChatgoTrack esté activo* con tu identificador correcto.\n\nSi el problema persiste, contacta al admin: +591 62741818`
        );
        return;
      }
      await Chofer.update({ where: { id: chofer.id }, data: { estado: "libre" } });
      if (enPromoGratis()) {
        await enviarBotones(
          phone,
          `🎉 *¡Ya estás LIBRE y listo para viajes!* 🚖\n\n📡 GPS: conectado ✅\n\n━━━━━━━━━━━━━━━━━\n🎁 *PROMO DE LANZAMIENTO*\nHasta el ${formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA)} estás operando *GRATIS*.\nNo tienes que pagar la cuota diaria de Bs 10 ni mandar comprobantes.\nA partir del día siguiente: cuota normal Bs 10/día.\n━━━━━━━━━━━━━━━━━\n\n¡Gracias por confiar en ChatGo desde el día 1! 🙌`,
          [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]
        );
      } else {
        await enviarBotones(phone, `✅ Ya estás *LIBRE* y listo para viajes! 🚖\n\n📡 GPS: conectado ✅`, [
          { id: "chofer_ocupado", title: "🔴 Ocupado" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]);
      }
      return;
    }

    if (buttonId === "chofer_ocupado") {
      await Chofer.update({ where: { id: chofer.id }, data: { estado: "ocupado" } });
      await enviarBotones(phone, `🔴 Estado: *OCUPADO*`, [
        { id: "chofer_libre", title: "🟢 Libre" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]);
      return;
    }

    if (buttonId === "chofer_ayuda") {
      await enviarMensaje(
        phone,
        `❓ *Ayuda ChatGo*\n\n` +
          `🟢 Libre → Recibes viajes\n` +
          `🔴 Ocupado → No recibes viajes\n` +
          `💬 Antes de iniciar el viaje puedes chatear con el pasajero escribiendo cualquier mensaje\n` +
          `🆘 Escribe AYUDA en cualquier momento para contactar a soporte\n\n` +
          `Admin: +591 62741818`
      );
      return;
    }
  }

  // Comprobante de pago
  const session = await getSession(phone);
  if (session?.step === "chofer_esperando_comprobante" && mediaId) {
    await enviarMensaje(phone, "🔍 Analizando tu comprobante...");
    let comprobanteValido = false;
    try {
      const buffer = await descargarImagenMeta(mediaId);
      const resultado = await validarComprobantePago(buffer.toString("base64"));
      comprobanteValido = !!resultado.es_comprobante;
      if (resultado._error) comprobanteValido = true;
    } catch (e) {
      log.error("[COMPROBANTE]", e.message);
      comprobanteValido = true;
    }

    if (!comprobanteValido) {
      await enviarMensaje(phone, `❌ No pude identificar un comprobante de pago válido en esa imagen.\n\nMándame una captura clara del pago realizado (QR, transferencia, Tigo Money, etc).`);
      return;
    }

    await Chofer.update({
      where: { id: chofer.id },
      data: {
        pagoDiarioFecha: new Date(),
        pagoDiarioFechaStr: fechaStrBolivia(),
        pagoDiarioPagado: true,
        pagoDiarioAprobado: false,
        pagoDiarioComprobanteValidado: true,
      },
    });
    await deleteSession(phone);

    // El banco suele avisar (vía MacroDroid) ANTES de que el chofer mande la foto del
    // comprobante. Si ya llegó una notificación sin matchear, la usamos para aprobar
    // de una vez en lugar de esperar al admin.
    const notisRecientes = await NotificacionPago.findMany({ where: { usado: false } });
    let notiUsada = null;
    if (notisRecientes.length === 1) notiUsada = notisRecientes[0];

    if (notiUsada) {
      await NotificacionPago.update({ where: { id: notiUsada.id }, data: { usado: true } });
      await Chofer.update({
        where: { id: chofer.id },
        data: {
          pagoDiarioAprobado: true,
          estado: "libre",
        },
      });
      await enviarBotones(phone, `✅ *Pago confirmado automáticamente!*\n🚖 Ya estás LIBRE para recibir viajes.`, [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]);
      await enviarMensaje(CONFIG.ADMIN_PHONE, `🤖 Pago auto-aprobado: ${chofer.nombre} (+${phone}) — coincide con notificación bancaria recibida antes del comprobante.`);
      log.info(`[PAGO_YAPE] Auto-aprobado al validar comprobante: ${chofer.nombre} (+${phone})`);
      return;
    }

    const okImg = await reenviarImagenPorId(`${CONFIG.ADMIN_PHONE}`, mediaId, `💰 Comprobante recibido de ${chofer.nombre}\n📞 +${phone}\n🚗 ${chofer.placa}`);
    const okBtn = await enviarBotones(CONFIG.ADMIN_PHONE, `¿Apruebas el pago de ${chofer.nombre}?`, [
      { id: `aprobar_pago_${phone}`, title: "✅ Aprobar" },
      { id: `rechazar_pago_${phone}`, title: "❌ Rechazar" },
    ]);
    if (!okImg && !okBtn) {
      // Falla típica: ventana de 24h de Meta cerrada con el admin (error 131047).
      // El pago YA quedó registrado como pendiente; el admin puede aprobarlo desde
      // el panel (/admin/pendientes-aprobacion o /admin/aprobar-chofer/:phone).
      log.error(`[COMPROBANTE] No se pudo notificar al admin +${CONFIG.ADMIN_PHONE} (¿ventana 24h de Meta cerrada?). Chofer: ${chofer.nombre} +${phone}. Aprobar desde el panel.`);
      await enviarMensaje(phone, "⏳ Comprobante recibido y registrado. Si en unos minutos no recibes confirmación, avísale al administrador: +591 62741818");
    } else {
      await enviarMensaje(phone, "⏳ Comprobante recibido. Esperando aprobación del administrador...");
    }
    return;
  }

  // Chat con pasajero durante viaje
  const viajeActivo = await Viaje.findFirst({
    where: {
      choferTraccarId: chofer.traccarId,
      estado: { in: ["en_camino","esperando_pasajero","en_curso"] },
    },
  });
  if (viajeActivo && mensaje && mensaje.type) {
    const reenviado = await relayMensajeChat(phone, viajeActivo.usuarioPhone, mensaje, "tu chofer");
    if (reenviado) { await enviarMensaje(phone, "✅ Enviado al pasajero"); return; }
  }

  // Menú del chofer
  if (!choferPagoAlDia(chofer) && !enPromoGratis()) {
    await Chofer.update({ where: { id: chofer.id }, data: { estado: "offline" } });
    await enviarMensaje(phone, `👋 Hola ${chofer.nombre}!\n\nPara iniciar tu jornada necesitas pagar *Bs 10*.`);
    if (CONFIG.QR_IMAGE_URL) await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante*.`);
    await setSession(phone, { step: "chofer_esperando_comprobante" });
    return;
  }

  if (chofer.estado === "libre") {
    await enviarBotones(phone, `👋 Hola ${chofer.nombre}!\n\n🟢 Estás *LIBRE* y recibiendo viajes.`, [
      { id: "chofer_ocupado", title: "🔴 Ocupado" },
      { id: "chofer_ayuda", title: "❓ Ayuda" },
    ]);
  } else {
    await enviarBotones(phone, `👋 Hola ${chofer.nombre}!\n\n${chofer.estado === "ocupado" ? "🔴 Estás *OCUPADO*" : "⚪ Estás desconectado"}`, [
      { id: "chofer_libre", title: "🟢 Libre" },
      { id: "chofer_ayuda", title: "❓ Ayuda" },
    ]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL USUARIO
// ═══════════════════════════════════════════════════════════════════════════

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

async function procesarCalculoViaje(phone, session) {
  await updateSession(phone, { ...session, step: "calculando" });
  await enviarMensaje(phone, "⏳ Calculando ruta y precio...");

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
    log.error("[CALCULO]", e.message);
    await enviarMensaje(phone, "❌ Error calculando. Intenta de nuevo.");
    await updateSession(phone, { ...session, step: "esperando_origen" });
  }
}


module.exports = { procesarMensajeChofer };
