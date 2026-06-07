// ChatGo — Flow chofer
const mongoose = require("mongoose");
const https = require("https");
const http = require("http");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, LocationReference } = require("../db/models");
const { getSession, setSession, updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones, enviarImagen, reenviarImagenPorId, relayMensajeChat, descargarImagenMeta } = require("../services/whatsapp");
const { obtenerUbicacionChofer, liberarReservaChoferTraccar, generarLinkRastreoPropio } = require("../services/traccar");
const { normalizarReferencia, guardarReferenciaVoz, calcularDistancia, calcularDistanciaConParadas } = require("../services/google");
const { validarComprobantePago } = require("../services/openai");
const { registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge, registrarViajeEnDemanda, actualizarUltimoViaje } = require("../ai");
const { asignarChofer, procesarPedidoAyuda, solicitarRating } = require("../flows/viaje");
const { choferPagoAlDia, crearCodigoPromo, enPromoGratis, enviarCodigoDescuento, esPedidoAyuda, esPlusCode, fechaStrBolivia, formatearFechaPromo, guardarRutaFrecuente, promoCodigosActiva } = require("../services/utils");


async function procesarMensajeChofer(phone, mensajeTexto, buttonId, mediaId, mensaje) {
  let chofer = await Chofer.findOne({ phone });

  if (!chofer) {
    const NUMERO_REGISTRO = process.env.NUMERO_REGISTRO || "59164637067";
    await enviarMensaje(
      phone,
      `👋 Hola! Para ser conductor de ChatGo primero tienes que registrarte con nosotros.\n\n` +
        `El registro es rápido (unos 5 minutos) y lo haces con otro número:\n\n` +
        `📱 https://wa.me/${NUMERO_REGISTRO}?text=Vengo+a+registrarme\n\n` +
        `Te vamos a pedir:\n` +
        `1️⃣ Foto de licencia de conducir\n2️⃣ Selfie tuya\n3️⃣ Foto del vehículo con placa visible\n4️⃣ RUAT\n5️⃣ SOAT\n\n` +
        `Una vez aprobado tu registro, te enviaremos las credenciales y podrás volver aquí para iniciar tu jornada 🚖`
    );
    return;
  }

  if (!buttonId && mensajeTexto && esPedidoAyuda(mensajeTexto)) {
    await procesarPedidoAyuda(phone, true);
    return;
  }

  if (buttonId) {
    if (buttonId === "aceptar_viaje") {
      const viaje = await Viaje.findOne({ choferTraccarId: chofer.traccarId, estado: "pendiente" });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes pendientes (quizás expiró).");

      const userPhone = viaje.usuarioPhone;
      await Chofer.findByIdAndUpdate(chofer._id, { estado: "ocupado", viajeReservado: null, reservadoHasta: null });
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "en_camino", fechaAceptacion: new Date() });

      // IA: registrar aceptación para métricas de despacho
      const tiempoRespuesta = viaje.fechaAsignacion
        ? Math.round((Date.now() - new Date(viaje.fechaAsignacion).getTime()) / 1000)
        : null;
      registrarEventoChofer(chofer.phone, "aceptado", {
        viajeId: String(viaje._id),
        segundosParaResponder: tiempoRespuesta,
        distanciaAlOrigen: viaje.distanciaKm,
      }).catch(() => {});

      const session = await getSession(userPhone);
      if (session) await updateSession(userPhone, { ...session, step: "chofer_en_camino" });

      // Link de rastreo propio — expira exactamente cuando termina el viaje
      const linkRastreo = generarLinkRastreoPropio(viaje._id);
      const tipoVeh = chofer.tipoVehiculo || "auto";
      const emojiV = tipoVeh === "moto" ? "🏍️" : "🚗";
      const labelV = tipoVeh === "moto" ? "Moto" : "Auto";
      const colorVStr = chofer.colorVehiculo ? ` ${chofer.colorVehiculo}` : "";

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

      await enviarMensaje(
        userPhone,
        `🎉 *¡Viaje aceptado!*\n\n` +
          `👤 Chofer: *${chofer.nombre}*\n` +
          `${emojiV} ${labelV}${colorVStr} · Placa: *${chofer.placa}*\n\n` +
          `📍 Rastrea tu chofer en tiempo real:\n${linkRastreo}\n\n` +
          `💬 Escribe cualquier mensaje para chatear con él.\n` +
          `_Escribe CANCELAR si necesitas cancelar, o AYUDA para soporte._`
      );
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
      const viaje = await Viaje.findOne({ choferTraccarId: chofer.traccarId, estado: "pendiente" });
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, { estado: "rechazado_chofer", cancelacionMotivo: "rechazo_chofer" });
        await liberarReservaChoferTraccar(chofer.traccarId);
        // IA: registrar rechazo
        registrarEventoChofer(chofer.phone, "rechazado", { viajeId: String(viaje._id) }).catch(() => {});
        await enviarMensaje(phone, "Ok, buscaremos otro chofer para ese pasajero.");
        const session = await getSession(viaje.usuarioPhone);
        if (session) {
          await enviarMensaje(viaje.usuarioPhone, "⏳ Buscando otro chofer...");
          await asignarChofer(viaje.usuarioPhone, session, [chofer.traccarId]);
        }
      }
      return;
    }

    // FIX BUG#3 — llegue_al_punto busca en en_camino Y en esperando_pasajero
    // para evitar conflicto con la detección GPS automática
    if (buttonId === "llegue_al_punto") {
      const viaje = await Viaje.findOne({
        choferTraccarId: chofer.traccarId,
        estado: { $in: ["en_camino", "esperando_pasajero"] },
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
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "esperando_pasajero", llegadaOrigenNotificada: true });
      const session = await getSession(viaje.usuarioPhone);
      if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "chofer_esperando_pasajero" });

      const tipoVeh = chofer.tipoVehiculo || "auto";
      const emoji = tipoVeh === "moto" ? "🏍️" : "🚗";
      const label = tipoVeh === "moto" ? "moto" : "auto";

      const colorLlegueManual = chofer.colorVehiculo ? ` ${chofer.colorVehiculo}` : "";
      await enviarMensaje(viaje.usuarioPhone, `🚕 *¡Tu chofer llegó!*\n\n👤 ${chofer.nombre}\n${emoji} ${label}${colorLlegueManual} · placa: ${chofer.placa}\n\nDirígete al vehículo.`);
      const usuarioLlegueBtn = await Usuario.findOne({ phone: viaje.usuarioPhone }).lean();
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
      const viaje = await Viaje.findOne({ choferTraccarId: chofer.traccarId, estado: "esperando_pasajero" });
      if (!viaje) return enviarMensaje(phone, "No tienes viajes activos.");
      await Viaje.findByIdAndUpdate(viaje._id, { estado: "en_curso" });
      const session = await getSession(viaje.usuarioPhone);
      if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "en_curso" });
      await enviarMensaje(viaje.usuarioPhone, `🚖 *Viaje iniciado*\n\n¡Disfruta tu viaje con ChatGo!`);
      const linkAlDestino = `https://www.google.com/maps/dir/?api=1&origin=${viaje.origen.lat},${viaje.origen.lng}&destination=${viaje.destino.lat},${viaje.destino.lng}&travelmode=driving`;
      await enviarBotones(
        phone,
        `▶️ *Viaje iniciado*\n\n` +
          `🏁 Destino: ${viaje.destino.nombre || "destino del pasajero"}\n` +
          `📏 ${viaje.distanciaKm} km\n\n` +
          `🗺️ Ir al destino:\n${linkAlDestino}\n\nConduce con cuidado! 🚖`,
        [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
      );
      return;
    }

    if (buttonId === "cancelar_viaje_chofer") {
      const viaje = await Viaje.findOne({
        choferTraccarId: chofer.traccarId,
        estado: { $in: ["en_camino", "esperando_pasajero"] },
      });
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, {
          estado: "cancelado_chofer",
          cancelacionMotivo: "cancelado_por_chofer",
          fechaFin: new Date(),
        });
        await Chofer.findByIdAndUpdate(chofer._id, { estado: "libre" });
        await enviarMensaje(viaje.usuarioPhone, `❌ Tu chofer canceló el viaje. Puedes pedir otro cuando quieras.`);
        await enviarMensaje(phone, `❌ Viaje cancelado. Ya estás LIBRE.`);
        await deleteSession(viaje.usuarioPhone);
      }
      return;
    }

    if (buttonId === "terminar_viaje") {
      // Acepta en_curso o esperando_pasajero (edge case: pasajero no subió pero chofer quiere terminar)
      const viaje = await Viaje.findOne({
        choferTraccarId: chofer.traccarId,
        estado: { $in: ["en_curso", "esperando_pasajero"] },
      });
      if (!viaje) {
        await enviarMensaje(phone, "No tienes viajes activos para terminar.");
        return;
      }
      if (viaje) {
        await Viaje.findByIdAndUpdate(viaje._id, { estado: "completado", fechaFin: new Date() });
        await Usuario.findOneAndUpdate({ phone: viaje.usuarioPhone }, { $inc: { viajesTotal: 1 } });

        const choferActual = await Chofer.findById(chofer._id);
        const sigueAlDia = enPromoGratis() || choferPagoAlDia(choferActual);
        await Chofer.findByIdAndUpdate(chofer._id, {
          estado: sigueAlDia ? "libre" : "offline",
          $inc: { viajesTotal: 1 },
        });
        await guardarRutaFrecuente(viaje.usuarioPhone, viaje.origen, viaje.destino);

  // IA: registrar evento completado para métricas del chofer
  if (chofer) {
    registrarEventoChofer(chofer.phone, "completado", {
      viajeId: String(viaje._id),
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
    if (viaje.origen?.lat && viaje.origen?.nombre && !esPlusCode(viaje.origen.nombre)) {
      const normO = normalizarReferencia(viaje.origen.nombre);
      const existeO = await LocationReference.findOne({ referencia: normO });
      if (!existeO) {
        await guardarReferenciaVoz(viaje.origen.nombre, viaje.origen.lat, viaje.origen.lng, viaje.origen.nombre);
        log.info(`[CROWDSOURCE] Post-viaje origen: "${viaje.origen.nombre}"`);
      }
    }
    if (viaje.destino?.lat && viaje.destino?.nombre && !esPlusCode(viaje.destino.nombre)) {
      const normD = normalizarReferencia(viaje.destino.nombre);
      const existeD = await LocationReference.findOne({ referencia: normD });
      if (!existeD) {
        await guardarReferenciaVoz(viaje.destino.nombre, viaje.destino.lat, viaje.destino.lng, viaje.destino.nombre);
        log.info(`[CROWDSOURCE] Post-viaje destino: "${viaje.destino.nombre}"`);
      }
    }
  } catch (e) { log.error("[CROWDSOURCE_POST_VIAJE]", e.message); }

        await enviarMensaje(
          viaje.usuarioPhone,
          `✅ *Viaje completado*\n\n📏 ${viaje.distanciaKm} km\n💰 Bs ${viaje.precioTotal}\n\n¡Gracias por usar ChatGo! 🚖`
        );
        // Nota: el botón "pedir otro taxi" aparece después del rating

        if (promoCodigosActiva()) {
          try {
            const nuevoCodigo = await crearCodigoPromo(viaje.usuarioPhone, "post_viaje");
            if (nuevoCodigo) {
              await Viaje.findByIdAndUpdate(viaje._id, { codigoPromoGenerado: nuevoCodigo.codigo });
              await enviarCodigoDescuento(viaje.usuarioPhone, nuevoCodigo, "tu próximo viaje");
            }
          } catch (e) {
            log.error("[PROMO] Error generando código post-viaje:", e.message);
          }
        }

        await solicitarRating(viaje.usuarioPhone, viaje._id);

        if (sigueAlDia) {
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
        await Chofer.findByIdAndUpdate(chofer._id, { estado: "offline" });
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
      await Chofer.findByIdAndUpdate(chofer._id, { estado: "libre" });
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
      await Chofer.findByIdAndUpdate(chofer._id, { estado: "ocupado" });
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

    await Chofer.findByIdAndUpdate(chofer._id, {
      "pagoDiario.fecha": new Date(),
      "pagoDiario.fechaStr": fechaStrBolivia(),
      "pagoDiario.pagado": true,
      "pagoDiario.aprobado": false,
      "pagoDiario.comprobanteValidado": true,
    });
    await deleteSession(phone);
    await reenviarImagenPorId(`${CONFIG.ADMIN_PHONE}`, mediaId, `💰 Comprobante recibido de ${chofer.nombre}\n📞 +${phone}\n🚗 ${chofer.placa}`);
    await enviarBotones(CONFIG.ADMIN_PHONE, `¿Apruebas el pago de ${chofer.nombre}?`, [
      { id: `aprobar_pago_${phone}`, title: "✅ Aprobar" },
      { id: `rechazar_pago_${phone}`, title: "❌ Rechazar" },
    ]);
    await enviarMensaje(phone, "⏳ Comprobante recibido. Esperando aprobación del administrador...");
    return;
  }

  // Chat con pasajero durante viaje
  const viajeActivo = await Viaje.findOne({
    choferTraccarId: chofer.traccarId,
    estado: { $in: ["en_camino","esperando_pasajero","en_curso"] },
  });
  if (viajeActivo && mensaje && mensaje.type) {
    const reenviado = await relayMensajeChat(phone, viajeActivo.usuarioPhone, mensaje, "tu chofer");
    if (reenviado) { await enviarMensaje(phone, "✅ Enviado al pasajero"); return; }
  }

  // Menú del chofer
  if (!choferPagoAlDia(chofer) && !enPromoGratis()) {
    await Chofer.findByIdAndUpdate(chofer._id, { estado: "offline" });
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
