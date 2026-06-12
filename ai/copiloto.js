// ChatGo — Copiloto IA: motor de seguridad multinivel
//
// Filosofía: REGLAS primero. Nada de ML hasta tener miles de viajes etiquetados.
// Cada viaje en_curso se evalúa periódicamente y escala niveles verde→amarillo→naranja→rojo.
//
// Niveles:
//   verde   = todo normal, solo se registra
//   amarillo= anomalía leve, se avisa al chofer
//   naranja = anomalía sostenida, se consulta al pasajero
//   rojo    = riesgo real, se activa protocolo (admin + ubicación en vivo)
//
// Las decisiones de subir de nivel son acumulativas y se guardan en viaje.eventosSeguridad
// para trazabilidad (requisito de auditoría).

const { CONFIG, log } = require("../config");
const { Viaje } = require("../db/models");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { calcularTiempoConTrafico, distanciaARuta, distanciaEntrePuntos } = require("../services/google");

// ─── UMBRALES (ajustables sin tocar lógica) ─────────────────────────────────
const UMBRAL = {
  DESVIO_NORMAL_M: 100,           // <100m de la ruta = normal
  DESVIO_SOSPECHOSO_M: 250,       // >250m sostenido = investigar
  DESVIO_PERSISTENCIA_MS: 90 * 1000, // el desvío debe sostenerse 90s para contar
  DETENIDO_AMARILLO_MIN: 4,       // detenido >4 min sin ser destino = amarillo
  DETENIDO_NARANJA_MIN: 8,        // detenido >8 min = naranja
  RETRASO_AMARILLO_FACTOR: 1.25,  // 25% sobre estimado = amarillo
  RETRASO_NARANJA_FACTOR: 1.6,    // 60% sobre estimado = naranja
  VELOCIDAD_ANORMAL_KMH: 110,     // >110 km/h en ciudad = anómalo
  GPS_FRESCO_MIN: 3,              // posición GPS debe ser de los últimos 3 min
  PROXIMIDAD_DESTINO_M: 150,      // a <150m del destino, no alertar (está llegando)
};

// Registra un evento de seguridad y actualiza el nivel del viaje si escala.
async function registrarEvento(viaje, tipo, nivel, detalle, pos) {
  const evento = {
    tipo, nivel, detalle,
    lat: pos?.lat, lng: pos?.lng,
    timestamp: new Date(),
  };
  const ordenNiveles = { verde: 0, amarillo: 1, naranja: 2, rojo: 3 };
  const nivelActual = viaje.nivelAlerta || "verde";
  const subeNivel = ordenNiveles[nivel] > ordenNiveles[nivelActual];

  const update = { $push: { eventosSeguridad: evento } };
  if (subeNivel) update.$set = { nivelAlerta: nivel };

  await Viaje.findByIdAndUpdate(viaje._id, update);
  log.warn(`[COPILOTO] Viaje ${viaje._id} — ${tipo}/${nivel}: ${detalle}`);
  return subeNivel;
}

// ─── ACCIONES POR NIVEL ─────────────────────────────────────────────────────
async function accionAmarillo(viaje, motivo) {
  // Avisar al chofer de forma no alarmante
  await enviarMensaje(
    viaje.choferPhone,
    `🟡 ChatGo monitorea tu viaje. ${motivo}\n\nSi todo está bien, continúa con normalidad. 🚖`
  );
}

async function accionNaranja(viaje, motivo) {
  // Consultar al pasajero si está todo bien (botones)
  if (!viaje.usuarioPhone) return;
  await enviarBotones(
    viaje.usuarioPhone,
    `🟠 *ChatGo Copiloto*\n\nNotamos algo inusual en tu viaje (${motivo}).\n\n¿Está todo bien?`,
    [
      { id: "seg_todo_bien", title: "✅ Todo bien" },
      { id: "seg_necesito_ayuda", title: "🆘 Necesito ayuda" },
    ]
  );
  // Avisar al admin en paralelo
  await enviarMensaje(
    CONFIG.ADMIN_PHONE,
    `🟠 *Alerta naranja*\n\n🆔 ${viaje._id}\n👤 Chofer: ${viaje.choferNombre || "—"} (+${viaje.choferPhone || "—"})\n🚗 ${viaje.choferPlaca || "—"}\n📋 ${motivo}\n\nSe consultó al pasajero.`
  );
}

async function accionRojo(viaje, motivo, pos) {
  // Protocolo de emergencia
  await Viaje.findByIdAndUpdate(viaje._id, { $set: { nivelAlerta: "rojo" } });

  const linkVivo = pos
    ? `https://chatgo.ia.bo/rastreo.html?id=${viaje._id}&api=${encodeURIComponent(CONFIG.APP_URL + "/track/" + viaje._id + "/pos")}`
    : "(GPS no disponible)";

  // 1. Alertar al centro de monitoreo (admin) con máxima prioridad
  await enviarMensaje(
    CONFIG.ADMIN_PHONE,
    `🔴🔴 *EMERGENCIA — ALERTA ROJA* 🔴🔴\n\n🆔 ${viaje._id}\n👤 Chofer: ${viaje.choferNombre || "—"} (+${viaje.choferPhone || "—"})\n🚗 Placa: ${viaje.choferPlaca || "—"}\n👥 Pasajero: +${viaje.usuarioPhone || "—"}\n\n📋 Motivo: ${motivo}\n📍 Ubicación en vivo:\n${linkVivo}\n\n⚠️ Requiere atención INMEDIATA.`
  );

  // 2. Avisar al pasajero que se activó el protocolo
  if (viaje.usuarioPhone) {
    await enviarMensaje(
      viaje.usuarioPhone,
      `🔴 *Protocolo de seguridad activado*\n\nChatGo detectó una situación de riesgo y nuestro equipo ya fue notificado. Estamos siguiendo tu ubicación en tiempo real.\n\nSi puedes, comparte tu ubicación de WhatsApp con un contacto de confianza. Si es una emergencia, llama al 110.`
    );
  }
}

// ─── EVALUACIÓN PRINCIPAL DE UN VIAJE ───────────────────────────────────────
// Recibe el viaje y la posición GPS actual del chofer (de Traccar).
// Devuelve el nivel resultante.
async function evaluarViaje(viaje, pos) {
  try {
    // GPS muerto o viejo: no podemos evaluar con certeza, pero lo registramos
    if (!pos || pos.minutos > UMBRAL.GPS_FRESCO_MIN) {
      return viaje.nivelAlerta || "verde";
    }

    // Si ya está muy cerca del destino, está llegando — no alertar
    if (viaje.destino?.lat) {
      const distDestinoM = distanciaEntrePuntos(pos.lat, pos.lng, viaje.destino.lat, viaje.destino.lng) * 1000;
      if (distDestinoM < UMBRAL.PROXIMIDAD_DESTINO_M) {
        return viaje.nivelAlerta || "verde";
      }
    }

    const ahora = Date.now();
    let pasajeroEnRiesgo = false;
    const motivos = [];

    // ─── 1) DESVÍO DE RUTA ───────────────────────────────────────────────
    if (viaje.rutaPuntos && viaje.rutaPuntos.length > 0) {
      const distRutaM = distanciaARuta(pos.lat, pos.lng, viaje.rutaPuntos);
      if (distRutaM !== null && distRutaM > UMBRAL.DESVIO_SOSPECHOSO_M) {
        // ¿hay tráfico/bloqueo que justifique? consultar Google
        let justificado = false;
        try {
          const trafico = await calcularTiempoConTrafico(pos.lat, pos.lng, viaje.destino.lat, viaje.destino.lng);
          if (trafico?.hayTrafico) justificado = true;
        } catch (e) { /* sin datos de tráfico, asumir no justificado */ }

        if (!justificado) {
          motivos.push(`desvío de ${distRutaM}m de la ruta`);
          // desvío grande + sin justificación = naranja (posible riesgo)
          pasajeroEnRiesgo = pasajeroEnRiesgo || distRutaM > UMBRAL.DESVIO_SOSPECHOSO_M * 2;
        }
      }
    }

    // ─── 2) VEHÍCULO DETENIDO ────────────────────────────────────────────
    const velocidad = pos.velocidad ?? pos.speed ?? null; // km/h si Traccar lo da
    const estaDetenido = velocidad !== null ? velocidad < 3 : false;
    if (estaDetenido) {
      if (!viaje.detenidoDesde) {
        await Viaje.findByIdAndUpdate(viaje._id, { $set: { detenidoDesde: new Date() } });
      } else {
        const minDetenido = (ahora - new Date(viaje.detenidoDesde).getTime()) / 60000;
        if (minDetenido > UMBRAL.DETENIDO_NARANJA_MIN) {
          motivos.push(`detenido ${Math.round(minDetenido)} min`);
          pasajeroEnRiesgo = true;
        } else if (minDetenido > UMBRAL.DETENIDO_AMARILLO_MIN) {
          motivos.push(`detenido ${Math.round(minDetenido)} min`);
        }
      }
    } else {
      // se movió: resetear contador de detención
      if (viaje.detenidoDesde) {
        await Viaje.findByIdAndUpdate(viaje._id, { $set: { detenidoDesde: null } });
      }
    }

    // ─── 3) VELOCIDAD ANORMAL ────────────────────────────────────────────
    if (velocidad !== null && velocidad > UMBRAL.VELOCIDAD_ANORMAL_KMH) {
      motivos.push(`velocidad ${Math.round(velocidad)} km/h`);
      pasajeroEnRiesgo = true;
    }

    // ─── 4) RETRASO RESPECTO AL ESTIMADO ─────────────────────────────────
    if (viaje.fechaInicioViaje && viaje.tiempoEstimadoMin) {
      const minTranscurridos = (ahora - new Date(viaje.fechaInicioViaje).getTime()) / 60000;
      const factor = minTranscurridos / viaje.tiempoEstimadoMin;
      if (factor > UMBRAL.RETRASO_NARANJA_FACTOR) {
        // verificar si es tráfico real antes de escalar
        let porTrafico = false;
        try {
          const trafico = await calcularTiempoConTrafico(pos.lat, pos.lng, viaje.destino.lat, viaje.destino.lng);
          if (trafico?.hayTrafico) porTrafico = true;
        } catch (e) {}
        if (!porTrafico) motivos.push(`retraso ${Math.round(factor * 100 - 100)}% sobre estimado`);
      }
    }

    // ─── DECISIÓN DE NIVEL ───────────────────────────────────────────────
    // Guardar última posición conocida siempre
    await Viaje.findByIdAndUpdate(viaje._id, {
      $set: { ultimaPosicionLat: pos.lat, ultimaPosicionLng: pos.lng, ultimaPosicionAt: new Date() },
    });

    if (motivos.length === 0) {
      return viaje.nivelAlerta || "verde";
    }

    const motivoTexto = motivos.join(" + ");

    // Múltiples señales de riesgo simultáneas O señal crítica = naranja/rojo
    if (pasajeroEnRiesgo && motivos.length >= 2) {
      // dos o más señales graves a la vez = rojo
      await registrarEvento(viaje, "multiples_riesgos", "rojo", motivoTexto, pos);
      await accionRojo(viaje, motivoTexto, pos);
      return "rojo";
    } else if (pasajeroEnRiesgo) {
      const subio = await registrarEvento(viaje, "riesgo", "naranja", motivoTexto, pos);
      if (subio) await accionNaranja(viaje, motivoTexto);
      return "naranja";
    } else {
      const subio = await registrarEvento(viaje, "anomalia", "amarillo", motivoTexto, pos);
      if (subio) await accionAmarillo(viaje, motivoTexto);
      return "amarillo";
    }
  } catch (e) {
    log.error("[COPILOTO_EVAL]", e.message);
    return viaje.nivelAlerta || "verde";
  }
}

// Maneja la respuesta del pasajero al botón de nivel naranja
async function manejarRespuestaPasajero(viaje, respuesta) {
  if (respuesta === "seg_necesito_ayuda") {
    await registrarEvento(viaje, "panico_pasajero", "rojo", "Pasajero pidió ayuda en consulta naranja", null);
    await accionRojo(viaje, "Pasajero confirmó que necesita ayuda", {
      lat: viaje.ultimaPosicionLat, lng: viaje.ultimaPosicionLng,
    });
    return "rojo";
  } else if (respuesta === "seg_todo_bien") {
    // bajar a verde y registrar que el pasajero confirmó
    await Viaje.findByIdAndUpdate(viaje._id, {
      $set: { nivelAlerta: "verde" },
      $push: { eventosSeguridad: { tipo: "confirmacion_ok", nivel: "verde", detalle: "Pasajero confirmó que todo está bien", timestamp: new Date() } },
    });
    await enviarMensaje(viaje.usuarioPhone, "✅ Gracias. Seguimos cuidando tu viaje. 🚖");
    return "verde";
  }
  return viaje.nivelAlerta;
}

// Botón de pánico manual (pasajero o chofer lo activan cuando quieran)
async function activarPanico(viaje, quien) {
  await Viaje.findByIdAndUpdate(viaje._id, {
    $set: { panicoActivado: true, panicoAt: new Date() },
  });
  await registrarEvento(viaje, "panico_manual", "rojo", `Botón de pánico activado por ${quien}`, {
    lat: viaje.ultimaPosicionLat, lng: viaje.ultimaPosicionLng,
  });
  await accionRojo(viaje, `🆘 Botón de pánico activado por ${quien}`, {
    lat: viaje.ultimaPosicionLat, lng: viaje.ultimaPosicionLng,
  });
}

module.exports = {
  evaluarViaje,
  manejarRespuestaPasajero,
  activarPanico,
  registrarEvento,
  UMBRAL,
};
