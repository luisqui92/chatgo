// ChatGo — index.js
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, SessionState, ListaEspera } = require("../db/models");
const { getSession, updateSession, deleteSession, removeListaEspera, sessionCache } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
function getTraccar() { return require("../services/traccar"); }
const { calcularTiempoConTrafico, distanciaEntrePuntos: distPuntos } = require("../services/google");
const { distanciaEntrePuntos } = require("../services/google");
const { registrarEventoChofer, registrarViajeEnDemanda, monitorearSeguridad, enviarAlertasChoferes, procesarReactivaciones, actualizarUltimoViaje } = require("../ai");
const { asignarChofer } = require("../flows/viaje");
const { enviarPushWeb } = require("../services/push");

function iniciarIntervals(deps) {
  const {
    enviarMensaje, enviarBotones, enviarImagen, getSession, updateSession, deleteSession,
    sessionCache, distanciaEntrePuntos,
    monitorearSeguridad, asignarChofer,
    registrarViajeEnDemanda, actualizarUltimoViaje, registrarEventoChofer,
    Chofer, Viaje, ListaEspera, SessionState, Usuario, CONFIG, log,
    fechaStrBolivia, enPromoGratis,
  } = deps;

const alertasTraficoEnviadas = new Set(); // viajeId_tipo → evitar spam de alertas

// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  try {
    const stepsPedido = [
      "esperando_origen","esperando_destino","esperando_origen_con_destino",
      "eligiendo_historial","preguntando_opciones","calculando",
      "eligiendo_tipo_vehiculo","confirmando_moto_incompatible",
      "ofreciendo_codigo","esperando_codigo","esperando_parada","esperando_observacion",
      "confirmando_ubicaciones_voz","aprendiendo_origen_voz","aprendiendo_destino_voz",
      "esperando_nombre_usuario","esperando_rating"
    ];
    const limite = new Date(Date.now() - CONFIG.SESSION_PEDIDO_TIMEOUT_MS);
    // SessionState.data es un blob Json — no se puede filtrar eficientemente por
    // sub-campos en MySQL/Prisma, así que se trae todo y se filtra en JS.
    const todasSesiones = await SessionState.findMany({});
    const sesiones = todasSesiones.filter((s) =>
      s.data && stepsPedido.includes(s.data.step) && s.data.updatedAt && new Date(s.data.updatedAt) < limite
    );
    for (const s of sesiones) {
      log.info(`[SESSION_CLEANUP] Limpiando sesión abandonada: ${s.phone} step=${s.data.step} updatedAt=${s.data.updatedAt}`);
      await SessionState.deleteMany({ where: { phone: s.phone } });
      sessionCache.delete(s.phone);
    }
    if (sesiones.length > 0) log.info(`[SESSION_CLEANUP] ${sesiones.length} sesiones abandonadas limpiadas`);
  } catch (e) {
    log.error("[SESSION_CLEANUP]", e.message);
  }
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// LISTA DE ESPERA (interval) — búsqueda activa desde el segundo 0
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const ahora = new Date();
    const pendientes = await ListaEspera.findMany({
      where: { timestamp: { gt: new Date(Date.now() - 30 * 60 * 1000) } },
      take: 50,
    });

    for (const espera of pendientes) {
      try {
        // Si está siendo cancelada por el usuario, ignorar esta entrada
        if (espera.cancelando) continue;

        const segundos = (ahora.getTime() - new Date(espera.timestamp).getTime()) / 1000;

        if (espera.ofertaActivaWialonId && espera.ofertaActivaHasta) {
          const expirada = new Date(espera.ofertaActivaHasta) < ahora;
          if (!expirada) continue;
          log.info(`[ESPERA] Oferta expirada para ${espera.userPhone}`);
          await ListaEspera.update({
            where: { userPhone: espera.userPhone },
            data: {
              ofertasRechazadas: [...(espera.ofertasRechazadas || []), espera.ofertaActivaWialonId],
              ofertaActivaWialonId: null,
              ofertaActivaHasta: null,
            },
          });
        }

        if (segundos > CONFIG.ESPERA_TIMEOUT_TOTAL) {
          log.info(`[ESPERA] Timeout total para ${espera.userPhone}`);
          await removeListaEspera(espera.userPhone);
          await updateSession(espera.userPhone, { step: "inicio" });
          await enviarMensaje(
            espera.userPhone,
            `😔 No encontramos chofer disponible en los últimos ${Math.round(CONFIG.ESPERA_TIMEOUT_TOTAL / 60)} minutos.\n\nPor favor intenta de nuevo en un ratito. 🚖`
          );
          continue;
        }

        const chofer = await getTraccar().buscarChoferDisponibleTraccar(
          { lat: espera.origenLat, lng: espera.origenLng },
          espera.ofertasRechazadas || [],
          espera.tipoVehiculoSolicitado || null
        );

        // Anti-spam: no mandar mensaje si ya se mandó uno en los últimos 90s
        const ahoraMs = Date.now();
        const msSinMensaje = espera.ultimoMensajeAt
          ? ahoraMs - new Date(espera.ultimoMensajeAt).getTime()
          : Infinity;
        const puedeMandarMensaje = msSinMensaje > 90000;

        if (chofer) {
          const ofertaActivaHasta = new Date(ahoraMs + CONFIG.ESPERA_OFERTA_VIGENCIA * 1000);

          if (puedeMandarMensaje) {
            await ListaEspera.update({
              where: { userPhone: espera.userPhone },
              data: {
                ofertaActivaWialonId: chofer.traccarId,
                ofertaActivaHasta,
                ultimoMensajeAt: new Date(),
              },
            });
            const sesionActual1 = await getSession(espera.userPhone) || {};
            await updateSession(espera.userPhone, { ...sesionActual1, step: "sin_chofer" });
            await enviarBotones(
              espera.userPhone,
              `🚖 *Taxi disponible*\n\n` +
                `📍 ${espera.origenNombre || "Tu origen"}\n` +
                `🏁 ${espera.destinoNombre || "Tu destino"}\n` +
                `💰 *Bs ${espera.precio}*`,
              [
                { id: "confirmar_viaje_recordatorio", title: "✅ Confirmar" },
                { id: "cancelar_viaje", title: "❌ Cancelar" },
              ]
            );
          } else {
            await ListaEspera.update({
              where: { userPhone: espera.userPhone },
              data: { ofertaActivaWialonId: chofer.traccarId, ofertaActivaHasta },
            });
            log.info(`[ESPERA] Anti-spam: chofer encontrado para ${espera.userPhone} pero mensaje reciente (${Math.round(msSinMensaje/1000)}s ago) — silencioso`);
          }
        } else {
          if (segundos > CONFIG.ESPERA_NOTIFICAR_SIN_CHOFER && !espera.notificado) {
            await ListaEspera.update({
              where: { userPhone: espera.userPhone },
              data: { notificado: true, ultimoMensajeAt: new Date() },
            });
            const sesionActual2 = await getSession(espera.userPhone) || {};
            await updateSession(espera.userPhone, { ...sesionActual2, step: "sin_chofer" });
            await enviarMensaje(
              espera.userPhone,
              `😔 Por ahora no hay móviles disponibles cerca tuyo.\n\nSeguimos buscando — te avisaremos apenas aparezca uno. 🚖\n\n_Escribe CANCELAR para dejar de buscar._`
            );
          }
        }
      } catch (eInner) {
        log.error("[ESPERA_ITEM]", eInner.message);
      }
    }
  } catch (e) {
    log.error("[ESPERA_LOOP]", e.message);
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// TIMEOUT DE ACEPTACIÓN DEL CHOFER (30s)
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const limite = new Date(Date.now() - CONFIG.TIMEOUT_ACEPTACION_CHOFER * 1000);
    const pendientes = await Viaje.findMany({ where: { estado: "pendiente", fechaAsignacion: { lt: limite } } });

    for (const viaje of pendientes) {
      try {
        log.warn(`[TIMEOUT] Viaje ${viaje.id} sin respuesta del chofer ${viaje.choferPhone}`);
        await getTraccar().liberarReservaChoferTraccar(viaje.choferTraccarId);
        await Viaje.update({ where: { id: viaje.id }, data: { estado: "buscando_otro_chofer", cancelacionMotivo: "timeout_chofer" } });
        await enviarMensaje(viaje.choferPhone, "⏰ Se te pasó el tiempo para aceptar el viaje. Pasamos al siguiente chofer.");
        const session = await getSession(viaje.usuarioPhone);
        if (session && session.step === "esperando_chofer") {
          if (!session.origen || !session.destino) {
            log.warn(`[TIMEOUT] Sesión de ${viaje.usuarioPhone} sin origen/destino — cancelando`);
            await updateSession(viaje.usuarioPhone, { step: "inicio" });
            await enviarMensaje(viaje.usuarioPhone, "⏳ Hubo un problema buscando chofer. Por favor intenta de nuevo.");
          } else {
            // Avanzar al siguiente chofer SIN spamear al pasajero: la cascada
            // recorre a todos en silencio; el pasajero solo vio el "Buscando tu
            // chofer" inicial y verá el "Viaje aceptado" cuando alguno confirme.
            // Acumular el chofer que no respondió (si no, hace ping-pong entre
            // los 2 más cercanos y nunca llega a los lejanos).
            const yaExcluidos = [...(session.choferesExcluidos || []), viaje.choferTraccarId];
            await asignarChofer(viaje.usuarioPhone, { ...session, choferesExcluidos: yaExcluidos }, yaExcluidos);
          }
        }
      } catch (eInner) {
        log.error("[TIMEOUT_ITEM]", eInner.message);
      }
    }

    // FIX BUG#4 — limpiar viajes zombie en estado buscando_otro_chofer más de 10 min
    const limiteZombie = new Date(Date.now() - 10 * 60 * 1000);
    await Viaje.updateMany({
      where: { estado: "buscando_otro_chofer", updatedAt: { lt: limiteZombie } },
      data: { estado: "cancelado_timeout", cancelacionMotivo: "zombie_cleanup", fechaFin: new Date() },
    });

    // ZOMBIE CLEANUP INTELIGENTE — límite dinámico según tiempo estimado del viaje
    // en_camino: 30 min máx (el chofer aceptó estando a <5 min del origen)
    // esperando_pasajero: 20 min máx esperando que suba
    // en_curso: tiempoEstimadoMin x2.5 (mín 40) — verificando tráfico real con Google antes de cerrar
    const viajesActivos = await Viaje.findMany({
      where: { estado: { in: ["en_camino", "esperando_pasajero", "en_curso"] } },
    });

    for (const viaje of viajesActivos) {
      try {
        const minutosTranscurridos = Math.round((Date.now() - new Date(viaje.updatedAt).getTime()) / 60000);

        let limiteMin;
        if (viaje.estado === "en_camino") limiteMin = 30;
        else if (viaje.estado === "esperando_pasajero") limiteMin = 20;
        else limiteMin = Math.max(Math.round((viaje.tiempoEstimadoMin || 20) * 2.5), 40);

        if (minutosTranscurridos < limiteMin) continue;

        // Para en_curso: antes de cerrar, verificar con GPS + Google si sigue avanzando legítimamente
        if (viaje.estado === "en_curso" && viaje.choferTraccarId && viaje.destinoLat) {
          try {
            const pos = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);
            if (pos && pos.minutos <= 5) {
              const distKm = distPuntos(pos.lat, pos.lng, viaje.destinoLat, viaje.destinoLng);
              const trafico = await calcularTiempoConTrafico(pos.lat, pos.lng, viaje.destinoLat, viaje.destinoLng);
              const minRestantes = trafico?.minutosConTrafico ?? null;

              // Si está a <1km del destino o Google dice que le faltan ≤15 min, extender (no cerrar)
              if (distKm < 1 || (minRestantes !== null && minRestantes <= 15)) {
                // tocar updatedAt para resetear el contador y avisar al admin solo una vez
                await Viaje.update({ where: { id: viaje.id }, data: { extendidoPorTrafico: true } });
                const keyExt = `${viaje.id}_extendido`;
                if (!alertasTraficoEnviadas.has(keyExt)) {
                  alertasTraficoEnviadas.add(keyExt);
                  await enviarMensaje(
                    CONFIG.ADMIN_PHONE,
                    `⏱️ *Viaje extendido por tráfico*\n\n🆔 ${viaje.id}\n👤 ${viaje.choferNombre || "—"} (+${viaje.choferPhone || "—"})\n⏳ Lleva ${minutosTranscurridos} min (estimado: ${viaje.tiempoEstimadoMin || "?"} min)\n📍 A ${Math.round(distKm * 1000)}m del destino\n🚦 Google estima ${minRestantes ?? "?"} min restantes\n\nSigue en curso, no se cerró.`
                  );
                }
                continue;
              }
            }
          } catch (eVerif) {
            log.error("[ZOMBIE_VERIF]", eVerif.message);
          }
        }

        // Cerrar el viaje zombie
        await Viaje.update({
          where: { id: viaje.id },
          data: {
            estado: "cancelado_timeout",
            cancelacionMotivo: `zombie_${viaje.estado}_${minutosTranscurridos}min`,
            fechaFin: new Date(),
          },
        });
        if (viaje.choferPhone) {
          await Chofer.update({
            where: { phone: viaje.choferPhone },
            data: { estado: "libre", viajeReservado: null, reservadoHasta: null },
          });
          await deleteSession(viaje.choferPhone); // limpiar sesión del chofer
          await enviarMensaje(
            viaje.choferPhone,
            `⏱️ El viaje fue cerrado automáticamente (${minutosTranscurridos} min sin completarse, límite: ${limiteMin} min). Ya estás *LIBRE* para nuevos viajes.\n\nSi olvidaste presionar *Terminar viaje*, recuerda hacerlo al finalizar cada carrera. 🙏`
          );
        }
        if (viaje.usuarioPhone) {
          await deleteSession(viaje.usuarioPhone); // limpiar sesión del pasajero (evita step zombie)
          await enviarMensaje(
            viaje.usuarioPhone,
            "❌ Tu viaje fue cerrado automáticamente por inactividad. Escribe cuando quieras pedir un nuevo taxi. 🚖"
          );
        }
        await enviarMensaje(
          CONFIG.ADMIN_PHONE,
          `⚠️ *Viaje zombie cerrado*\n\n🆔 ${viaje.id}\n👤 Chofer: ${viaje.choferNombre || "—"} (+${viaje.choferPhone || "—"})\n🚗 Placa: ${viaje.choferPlaca || "—"}\n📍 Estado: ${viaje.estado}\n⏱️ ${minutosTranscurridos} min (límite: ${limiteMin} min)`
        );
        log.warn(`[ZOMBIE] Viaje ${viaje.id} cerrado — ${viaje.estado}, ${minutosTranscurridos}min/${limiteMin}min, chofer: ${viaje.choferPhone}`);
      } catch (eZombie) {
        log.error("[ZOMBIE_ITEM]", eZombie.message);
      }
    }
  } catch (e) {
    log.error("[TIMEOUT_LOOP]", e.message);
  }
}, 15000);

// ═══════════════════════════════════════════════════════════════════════════
// IA INTERVALS
// ═══════════════════════════════════════════════════════════════════════════

// Alertas de zonas calientes a choferes — cada hora
setInterval(async () => {
  try {
    await enviarAlertasChoferes(enviarMensaje);
  } catch (e) { log.error("[IA_PREDICCION_INTERVAL]", e.message); }
}, 60 * 60 * 1000);

// Reactivación de usuarios inactivos — cada 24 horas
setInterval(async () => {
  try {
    await procesarReactivaciones(enviarMensaje);
  } catch (e) { log.error("[IA_REACTIVACION_INTERVAL]", e.message); }
}, 24 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR CHOFER — FIX BUG#1 (race condition promo) + FIX BUG#7 (recursión)
// ═══════════════════════════════════════════════════════════════════════════


  
// ═══════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE LLEGADA AL DESTINO
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    // A) LLEGADA AL ORIGEN DEL PASAJERO (≤50m)
    const enCamino = await Viaje.findMany({ where: { estado: "en_camino", llegadaOrigenNotificada: false } });
    for (const viaje of enCamino) {
      try {
        const posChofer = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);
        if (posChofer.minutos > 5) continue;
        const distOrigen = distanciaEntrePuntos(posChofer.lat, posChofer.lng, viaje.origenLat, viaje.origenLng);
        if (distOrigen <= 0.05) {
          const { count } = await Viaje.updateMany({
            where: { id: viaje.id, llegadaOrigenNotificada: false },
            data: { llegadaOrigenNotificada: true, estado: "esperando_pasajero" },
          });
          if (count === 0) continue;
          const updated = await Viaje.findUnique({ where: { id: viaje.id } });

          const session = await getSession(viaje.usuarioPhone);
          if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "chofer_esperando_pasajero" });

          const tipoVeh = updated.tipoVehiculo || "auto";
          const emoji = tipoVeh === "moto" ? "🏍️" : "🚗";
          const label = tipoVeh === "moto" ? "moto" : "auto";

          const choferColorGPS = await Chofer.findUnique({ where: { traccarId: viaje.choferTraccarId } });
          const colorGPS = choferColorGPS?.colorVehiculo ? ` ${choferColorGPS.colorVehiculo}` : "";
          // Pedido web: el "llegó" va por push al celular, no por WhatsApp
          if (!/🌐|desde la web/i.test(viaje.observaciones || "")) await enviarMensaje(
            viaje.usuarioPhone,
            `🚕 *¡Tu chofer llegó!*\n\n👤 ${viaje.choferNombre}\n${emoji} ${label}${colorGPS} · placa: ${viaje.choferPlaca}\n\nPor favor dirígete al vehículo. 🚖`
          );
          else await enviarPushWeb(viaje.usuarioPhone, "📍 ¡Tu chofer llegó!", `${viaje.choferNombre} te espera. Dirigite al vehículo.`, "/pedir");

          // FIX BUG#3 — el GPS detectó llegada, le enviamos botones nuevos al chofer
          // y NO esperamos que presione el botón "Llegué" que ya está obsoleto
          const usuarioLlegada = await Usuario.findUnique({ where: { phone: viaje.usuarioPhone } });
          const nombrePasajeroLlegada = usuarioLlegada?.nombre ? `\n🙋 Pregunta por: *ChatGo para ${usuarioLlegada.nombre}*` : "";
          await enviarBotones(
            viaje.choferPhone,
            `📍 *Estás a 50m del pasajero*${nombrePasajeroLlegada}\n\nYa le avisamos que llegaste.\nCuando el pasajero suba presiona:`,
            [
              { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
              { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
            ]
          );
          log.info(`[LLEGADA_ORIGEN] Notificado viaje ${viaje.id}`);
        }
      } catch { /* ignorar fallo individual */ }
    }

    // B) LLEGADA AL DESTINO (≤150m) + MONITOREO DE SEGURIDAD
    const enCurso = await Viaje.findMany({ where: { estado: "en_curso", llegadaNotificada: false } });
    for (const viaje of enCurso) {
      try {
        const posChofer = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);

        const distDestino = distanciaEntrePuntos(posChofer.lat, posChofer.lng, viaje.destinoLat, viaje.destinoLng);
        if (distDestino < 0.15) {
          await Viaje.update({ where: { id: viaje.id }, data: { llegadaNotificada: true } });
          await enviarBotones(viaje.choferPhone, "📍 Parece que llegaste al destino. ¿Finalizas el viaje?",
            [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]);
          if (!/🌐|desde la web/i.test(viaje.observaciones || "")) await enviarMensaje(viaje.usuarioPhone, "📍 ¡Tu chofer llegó al destino!");
        }
      } catch { /* ignorar fallo individual */ }
    }
  } catch (e) {
    log.error("[LLEGADA_LOOP]", e.message);
  }
}, 30000);

  
// ═══════════════════════════════════════════════════════════════════════════
// COPILOTO IA — MONITOREO DE SEGURIDAD MULTINIVEL — cada 60 segundos
// Reemplaza los monitoreos dispersos anteriores con el motor unificado ai/copiloto.js
// ═══════════════════════════════════════════════════════════════════════════
const { evaluarViaje } = require("../ai/copiloto");

setInterval(async () => {
  try {
    // Solo viajes en curso (el pasajero está a bordo = donde importa la seguridad)
    const enCurso = await Viaje.findMany({ where: { estado: "en_curso" }, take: 50 });
    for (const viaje of enCurso) {
      try {
        if (!viaje.choferTraccarId) continue;
        const pos = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);
        // evaluarViaje maneja internamente GPS muerto, desvío, detención, velocidad, retraso
        // y escala verde→amarillo→naranja→rojo con sus acciones
        await evaluarViaje(viaje, pos);
      } catch (e) {
        log.warn("[COPILOTO_ITEM]", e.message);
      }
    }
  } catch (e) {
    log.error("[COPILOTO_INTERVAL]", e.message);
  }
}, 60 * 1000); // cada 60 segundos

// ═══════════════════════════════════════════════════════════════════════════
// MONITOREO DE TRÁFICO Y DESVÍO DE RUTA — cada 2 minutos
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const enCurso = await Viaje.findMany({
      where: {
        estado: "en_curso",
        destinoLat: { not: null },
        tiempoEstimadoMin: { not: null },
      },
      take: 20,
    });

    for (const viaje of enCurso) {
      try {
        if (!viaje.choferTraccarId) continue;

        const posChofer = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);
        if (!posChofer || posChofer.minutos > 3) continue;

        // ─── A) TIMEOUT: ¿lleva más del doble del tiempo estimado? ───────
        const minutosEnViaje = viaje.fechaInicioViaje
          ? Math.round((Date.now() - new Date(viaje.fechaInicioViaje).getTime()) / 60000)
          : null;

        const limiteMinutos = viaje.tiempoEstimadoMin * 2;

        if (minutosEnViaje && minutosEnViaje > limiteMinutos) {
          const keyTimeout = `${viaje.id}_timeout`;
          if (!alertasTraficoEnviadas.has(keyTimeout)) {
            alertasTraficoEnviadas.add(keyTimeout);

            // Consultar tráfico actual desde posición del chofer al destino
            const traficoActual = await calcularTiempoConTrafico(
              posChofer.lat, posChofer.lng,
              viaje.destinoLat, viaje.destinoLng
            );

            const linkMonitoreo = "https://chatgo.ia.bo/rastreo.html?id=" + viaje.id + "&api=" + encodeURIComponent(CONFIG.APP_URL + "/track/" + viaje.id + "/pos");

            if (traficoActual?.hayTrafico) {
              // Hay tráfico real — avisar al chofer
              const linkAlternativo = "https://www.google.com/maps/dir/?api=1&origin=" + posChofer.lat + "," + posChofer.lng + "&destination=" + viaje.destinoLat + "," + viaje.destinoLng + "&travelmode=driving";
              await enviarMensaje(
                viaje.choferPhone,
                `🚦 *Aviso de tráfico*\n\nHay tráfico significativo en tu zona (factor x\${traficoActual.factorTrafico}).\n\nTiempo estimado restante: ~\${traficoActual.minutosConTrafico} min\n\n🗺️ Considera ruta alternativa:\n\${linkAlternativo}`
              );
              log.info(`[TRAFICO] Viaje \${viaje._id} — tráfico x\${traficoActual.factorTrafico}, avisando a chofer`);
            } else {
              // No hay tráfico pero igual se está tardando — posible desvío
              const distDestino = distPuntos(posChofer.lat, posChofer.lng, viaje.destinoLat, viaje.destinoLng);
              await enviarMensaje(
                CONFIG.ADMIN_PHONE,
                `🚨 *Posible desvío de ruta*\n\n👤 Chofer: \${viaje.choferNombre} (+\${viaje.choferPhone})\n🚗 Placa: \${viaje.choferPlaca}\n⏱️ Lleva \${minutosEnViaje} min (estimado: \${viaje.tiempoEstimadoMin} min)\n📍 A \${Math.round(distDestino * 1000)}m del destino\n\n🔍 Monitoreo: \${linkMonitoreo}`
              );
              log.warn(`[DESVIO] Viaje \${viaje._id} — \${minutosEnViaje}min / estimado \${viaje.tiempoEstimadoMin}min`);
            }
          }
        }

        // ─── B) DESVÍO GEOGRÁFICO: ¿está muy lejos de la línea origen-destino? ──
        // Calcular si el chofer se alejó más de 1km de la línea recta origen→destino
        if (viaje.origenLat && viaje.destinoLat) {
          const distAlOrigen = distPuntos(posChofer.lat, posChofer.lng, viaje.origenLat, viaje.origenLng);
          const distAlDestino = distPuntos(posChofer.lat, posChofer.lng, viaje.destinoLat, viaje.destinoLng);
          const distOrigenDestino = distPuntos(viaje.origenLat, viaje.origenLng, viaje.destinoLat, viaje.destinoLng);

          // Si la suma de distancias es más del doble de la distancia directa → desvío
          const ratioDesvio = (distAlOrigen + distAlDestino) / (distOrigenDestino || 1);
          const keyDesvio = `${viaje.id}_desvio_geo`;

          if (ratioDesvio > 2.5 && !alertasTraficoEnviadas.has(keyDesvio)) {
            alertasTraficoEnviadas.add(keyDesvio);
            const linkMonitoreo = "https://chatgo.ia.bo/rastreo.html?id=" + viaje.id + "&api=" + encodeURIComponent(CONFIG.APP_URL + "/track/" + viaje.id + "/pos");
            await enviarMensaje(
              CONFIG.ADMIN_PHONE,
              `🚨 *Desvío de ruta detectado*\n\n👤 Chofer: \${viaje.choferNombre} (+\${viaje.choferPhone})\n🚗 Placa: \${viaje.choferPlaca}\n📐 Ratio de desvío: x\${Math.round(ratioDesvio * 10) / 10}\n\n🔍 Monitoreo: \${linkMonitoreo}`
            );
            log.warn(`[DESVIO_GEO] Viaje \${viaje._id} — ratio \${ratioDesvio.toFixed(2)}`);
          }
        }

      } catch (e) {
        log.warn("[TRAFICO_DESVIO]", e.message);
      }
    }

    // Limpiar alertas de viajes terminados
    if (alertasTraficoEnviadas.size > 200) {
      alertasTraficoEnviadas.clear();
    }

  } catch (e) {
    log.error("[TRAFICO_INTERVAL]", e.message);
  }
}, 2 * 60 * 1000); // cada 2 minutos

// ═══════════════════════════════════════════════════════════════════════════
// CORTE DIARIO DE PAGO — a las 4am hora Bolivia, choferes que no pagaron
// el día anterior pasan a "offline" y se les avisa proactivamente con el QR,
// en vez de esperar a que ellos intenten ponerse libres o terminen un viaje.
// ═══════════════════════════════════════════════════════════════════════════
let ultimoCorteFechaStr = null;

setInterval(async () => {
  try {
    const horaBolivia = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000).getUTCHours();
    if (horaBolivia !== 4) return;

    const hoyStr = fechaStrBolivia();
    if (ultimoCorteFechaStr === hoyStr) return; // ya se ejecutó hoy
    ultimoCorteFechaStr = hoyStr;

    if (enPromoGratis()) {
      log.info("[CORTE_PAGO] Promo gratis activa, no se exige pago diario");
      return;
    }

    const choferesSinPagar = await Chofer.findMany({
      where: {
        estado: { not: "offline" },
        OR: [
          { pagoDiarioFechaStr: { not: hoyStr } },
          { pagoDiarioAprobado: { not: true } },
        ],
      },
    });

    for (const chofer of choferesSinPagar) {
      try {
        await Chofer.update({
          where: { id: chofer.id },
          data: {
            estado: "offline",
            pagoDiarioPagado: false,
            pagoDiarioAprobado: false,
            pagoDiarioComprobanteValidado: false,
          },
        });
        await updateSession(chofer.phone, { step: "chofer_esperando_comprobante" });
        await enviarMensaje(chofer.phone, `🌅 ¡Buen día! Para empezar a recibir viajes hoy necesitas pagar tu cuota diaria de *Bs 10*.`);
        if (CONFIG.QR_IMAGE_URL) {
          await enviarImagen(chofer.phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante* para activarte.`);
        }
      } catch (e) {
        log.warn("[CORTE_PAGO_CHOFER]", chofer.phone, e.message);
      }
    }

    log.info(`[CORTE_PAGO] Corte diario aplicado a ${choferesSinPagar.length} choferes`);
  } catch (e) {
    log.error("[CORTE_PAGO]", e.message);
  }
}, 10 * 60 * 1000); // revisa cada 10 min si ya es la hora del corte

  log.info("✅ Todos los intervals iniciados");
}

module.exports = { iniciarIntervals };
