const { verificarTraficoEnRuta } = require("../services/google");
// ChatGo — IA Cerebro central
const { CONFIG, log } = require("../config");
const os = require("os");
const { Chofer, Viaje, ListaEspera, Usuario, CodigoPromo, Demanda, AlertaSeg, EventoChofer } = require("../db/models");

// ─── IA INLINE (sin dependencias externas) ───────────────────────────────
function seleccionarMejorChofer(candidatos) {
  if (!candidatos.length) return null;
  return candidatos.reduce((a, b) => a.distanciaAlUsuario < b.distanciaAlUsuario ? a : b);
}
async function registrarEventoChofer(phone, tipo, datos = {}) {
  try {
    await EventoChofer.create({
      data: {
        choferPhone: phone,
        tipo,
        viajeId: datos.viajeId ? String(datos.viajeId) : null,
        zona: datos.zona || null,
        tiempoRespuesta: datos.segundosParaResponder ?? datos.tiempoRespuesta ?? null,
      },
    });
  } catch { }
}
async function calcularMultiplierSurge(lat, lng) {
  try {
    const [libres, espera] = await Promise.all([
      Chofer.count({ where: { estado: "libre" } }),
      ListaEspera.count(),
    ]);
    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const hora = ahora.getHours(); const dia = ahora.getDay();
    let m = 1.0; let motivos = [];
    if (libres === 0) { m = 1.3; motivos.push("sin_choferes"); }
    else if (espera > libres * 2) { m = 1.2; motivos.push("alta_demanda"); }
    if ([17,18,19].includes(hora) && [1,2,3,4,5].includes(dia)) { m = Math.max(m, 1.15); motivos.push("hora_pico"); }
    if (dia === 5 && [17,18,19].includes(hora)) { m = Math.max(m, 1.25); motivos.push("viernes_tarde"); }
    return { multiplier: Math.min(1.5, m), motivos };
  } catch (e) { 
    log.error("[SURGE]", e.message);
    return { multiplier: 1.0, motivos: [] }; 
  }
}
function aplicarSurge(precioBase, multiplier) {
  if (!multiplier || multiplier <= 1) return precioBase;
  return Math.round(precioBase * multiplier);
}
function textoSurge(m, motivos) {
  if (m <= 1.0) return null;
  return `⚠️ _Precio ajustado +${Math.round((m-1)*100)}% por alta demanda._`;
}
async function registrarViajeEnDemanda(viaje) {
  try {
    if (!viaje.origenLat) return;
    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const zona = `${Math.round(viaje.origenLat*200)/200}_${Math.round(viaje.origenLng*200)/200}`;
    const hora = ahora.getHours();
    const diaSemana = ahora.getDay();
    const existente = await Demanda.findFirst({ where: { zona, hora, diaSemana } });
    if (existente) {
      await Demanda.update({
        where: { id: existente.id },
        data: { cantidad: { increment: 1 }, ultimaActualizacion: new Date() },
      });
    } else {
      await Demanda.create({ data: { zona, hora, diaSemana, cantidad: 1, ultimaActualizacion: new Date() } });
    }
  } catch { }
}
async function enviarAlertasChoferes(enviarMensajeFn) {
  try {
    if (!enviarMensajeFn) return;
    const ahora = new Date();
    const hora = ahora.getHours();
    const diaSemana = ahora.getDay();
    
    // Buscar zonas calientes en esta hora/día
    const zonasCalientes = await Demanda.findMany({
      where: { hora, diaSemana, cantidad: { gte: 3 } },
      orderBy: { cantidad: "desc" },
      take: 3,
    });

    if (zonasCalientes.length === 0) return;

    // Choferes libres en el sistema
    const libres = await Chofer.findMany({ where: { estado: "libre" }, take: 50 });
    if (libres.length === 0) return;
    
    const zonasTexto = zonasCalientes.map(z => `📍 *${z.zona}* (${z.cantidad} viajes en esta hora)`).join("\n");
    const msg = `🔥 *Zonas con alta demanda ahora*

${zonasTexto}

Movete cerca de estas zonas para conseguir viajes más rápido.`;
    
    for (const chofer of libres) {
      // Solo enviar cada 2 horas máximo por chofer
      const ultimaAlerta = chofer.ultimaAlertaZona ? new Date(chofer.ultimaAlertaZona).getTime() : 0;
      if (Date.now() - ultimaAlerta < 2 * 60 * 60 * 1000) continue;
      
      await enviarMensajeFn(chofer.phone, msg).catch(() => {});
      await Chofer.update({ where: { id: chofer.id }, data: { ultimaAlertaZona: new Date() } }).catch(() => {});
    }
    
    log.info(`[IA_ALERTAS] Notificados ${libres.length} choferes sobre ${zonasCalientes.length} zonas calientes`);
  } catch (e) {
    log.error("[IA_ALERTAS_CH]", e.message);
  }
}
async function monitorearViajeEnCurso(viaje, posChofer, enviarFn) {
  try {
    const min = (Date.now() - new Date(viaje.fechaAceptacion).getTime()) / 60000;
    const esperado = (viaje.distanciaKm || 5) * 4;
    if (min > esperado * 2.5 && min > 30) {
      await enviarFn(CONFIG.ADMIN_PHONE, `⚠️ Viaje ${viaje.id} lleva ${Math.round(min)} min (esperado ~${Math.round(esperado)} min)
Chofer: ${viaje.choferNombre}`).catch(() => {});
    }
  } catch { }
  return [];
}
async function procesarReactivaciones(enviarMensajeFn) {
  try {
    if (!enviarMensajeFn) return;
    const hace15dias = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    
    // Usuarios que tuvieron al menos 1 viaje pero no han vuelto en 15+ días
    const inactivos = await Usuario.findMany({
      where: {
        ultimoViajeAt: { lt: hace15dias, not: null },
        promoReactivacionEnviada: { not: true },
        aceptoTerminos: true,
      },
      take: 30,
    });

    if (inactivos.length === 0) return;

    for (const usr of inactivos) {
      try {
        // Generar código de descuento 30% que dura 7 días
        const codigo = `VUELVE${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const venceEn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await CodigoPromo.create({
          data: {
            codigo,
            descuentoPorcentaje: 30,
            generadoPor: usr.phone,
            tipoOrigen: "reactivacion",
            fechaVencimiento: venceEn,
            usado: false,
          },
        });

        const nombre = usr.nombre || "amigo";
        const msg = `👋 Hola ${nombre}, te extrañamos en ChatGo!

🎁 Te regalamos un *30% de descuento* en tu próximo viaje.
Código: *${codigo}*
Válido por 7 días.

Pedí tu taxi cuando quieras y usá el código al confirmar el viaje.`;
        
        await enviarMensajeFn(usr.phone, msg).catch(() => {});
        await Usuario.update({ where: { id: usr.id }, data: { promoReactivacionEnviada: true } }).catch(() => {});
      } catch (e) {
        log.warn("[REACTIV_USR]", usr.phone, e.message);
      }
    }
    
    log.info(`[IA_REACTIVACION] Procesados ${inactivos.length} usuarios inactivos`);
  } catch (e) {
    log.error("[IA_REACTIV]", e.message);
  }
}
async function actualizarUltimoViaje(phone) {
  try {
    await Usuario.update({
      where: { phone },
      data: { ultimoViajeAt: new Date(), promoReactivacionEnviada: false },
    });
  } catch (e) {
    log.warn("[ACTUALIZAR_ULTIMO]", e.message);
  }
}

async function monitorearSeguridad(viaje, posChofer, posAnterior, enviarFn) {
  try {
    const alertas = [];
    const ahora = Date.now();

    const minutos = (ahora - new Date(viaje.fechaAceptacion || ahora).getTime()) / 60000;
    const esperado = (viaje.distanciaKm || 5) * 4;
    if (minutos > esperado * 2 && minutos > 25) {
      alertas.push({ tipo: "tiempo_excesivo", desc: `Lleva ${Math.round(minutos)} min (esperado ~${Math.round(esperado)} min)`, severidad: "media" });
    }

    if (posAnterior && posChofer && posAnterior.timestamp) {
      const dist = Math.sqrt(Math.pow(posChofer.lat - posAnterior.lat, 2) + Math.pow(posChofer.lng - posAnterior.lng, 2)) * 111000;
      const minDetenido = (ahora - posAnterior.timestamp) / 60000;
      const enOrigen = viaje.origenLat && Math.abs(posChofer.lat - viaje.origenLat) < 0.001;
      const enDestino = viaje.destinoLat && Math.abs(posChofer.lat - viaje.destinoLat) < 0.001;
      if (dist < 50 && minDetenido > 7 && !enOrigen && !enDestino) {
        alertas.push({ tipo: "parada_sospechosa", desc: `Detenido ${Math.round(minDetenido)} min sin estar en origen/destino`, severidad: "alta" });
      }
    }

    if (posChofer && viaje.destinoLat && viaje.estado === "en_curso") {
      const trafico = await verificarTraficoEnRuta(posChofer, { lat: viaje.destinoLat, lng: viaje.destinoLng });
      if (trafico && (trafico.severidad === "trafico_pesado" || trafico.severidad === "bloqueo_grave")) {
        const esBloqueo = trafico.severidad === "bloqueo_grave";
        alertas.push({
          tipo: esBloqueo ? "bloqueo" : "trafico",
          desc: `${esBloqueo ? "Bloqueo o trancadera detectada" : "Trafico pesado"}: +${trafico.retrasoMin} min de retraso`,
          severidad: esBloqueo ? "alta" : "media",
          retrasoMin: trafico.retrasoMin,
        });
      }
    }

    for (const alerta of alertas) {
      try {
        await AlertaSeg.create({
          data: {
            viajeId: String(viaje.id),
            tipo: alerta.tipo,
            descripcion: alerta.desc,
            posicionLat: posChofer ? posChofer.lat : undefined,
            posicionLng: posChofer ? posChofer.lng : undefined,
          },
        });
      } catch (_e) {}

      const yaNotificado = await AlertaSeg.findFirst({ where: { viajeId: String(viaje.id), tipo: alerta.tipo, notificadoPasajero: true } });

      if (!yaNotificado && enviarFn) {
        if (alerta.tipo === "trafico" || alerta.tipo === "bloqueo") {
          const ico = alerta.tipo === "bloqueo" ? "🚧" : "🚦";
          const msgPas = `${ico} ${alerta.desc}

Tu chofer está demorando por causas externas. Si necesitás cancelar sin penalización escribí *CANCELAR*.`;
          await enviarFn(viaje.usuarioPhone, msgPas).catch(() => {});
          if (viaje.choferPhone) {
            const accion = alerta.tipo === "bloqueo" ? "un bloqueo" : "tráfico pesado";
            const msgCh = `${ico} El sistema detectó ${accion} en tu ruta.
Si hay desvío posible, tomalo. Avisá al pasajero del retraso.`;
            await enviarFn(viaje.choferPhone, msgCh).catch(() => {});
          }
        } else if (alerta.tipo === "tiempo_excesivo") {
          const msgT = `⚠️ Tu chofer está demorando más de lo esperado.
Si necesitás ayuda escribí *AYUDA* o *CANCELAR* para cancelar sin penalización.`;
          await enviarFn(viaje.usuarioPhone, msgT).catch(() => {});
        }
        await AlertaSeg.updateMany({
          where: { viajeId: String(viaje.id), tipo: alerta.tipo },
          data: { notificadoPasajero: true },
        }).catch(() => {});
      }
    }

    const graves = alertas.filter(a => a.severidad === "alta");
    if (graves.length > 0) {
      const yaNotificadoAdmin = await AlertaSeg.findFirst({ where: { viajeId: String(viaje.id), notificadoAdmin: true } });
      if (!yaNotificadoAdmin && enviarFn) {
        const linea = graves.map(a => `⚠️ ${a.desc}`).join("\n");
        const msgAdmin = `🚨 *Alerta viaje ${String(viaje.id).slice(-6).toUpperCase()}*
Chofer: ${viaje.choferNombre || "?"} (+${viaje.choferPhone || "?"})
Pasajero: +${viaje.usuarioPhone}

${linea}`;
        await enviarFn(CONFIG.ADMIN_PHONE, msgAdmin).catch(() => {});
        await AlertaSeg.updateMany({
          where: { viajeId: String(viaje.id) },
          data: { notificadoAdmin: true },
        }).catch(() => {});
      }
    }

    return alertas;
  } catch (e) {
    log.error("[IA_SEG]", e.message);
    return [];
  }
}

module.exports = { seleccionarMejorChofer, registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge, registrarViajeEnDemanda, enviarAlertasChoferes, monitorearViajeEnCurso, monitorearSeguridad, procesarReactivaciones, actualizarUltimoViaje };
