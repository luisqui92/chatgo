// ChatGo — webhook.js
const mongoose = require("mongoose");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, ListaEspera, CodigoPromo, LocationReference } = require("../db/models");
const { getSession, checkRateLimit, sessionCache, yaProcesoMensaje } = require("../services/session");
const { enviarMensaje, enviarBotones, verificarFirmaMeta } = require("../services/whatsapp");
const { wialonLogin, obtenerUbicacionChofer } = require("../services/wialon");
const { fechaStrBolivia, promoCodigosActiva, enPromoGratis } = require("../services/utils");
const { procesarMensajeUsuario } = require("../flows/pasajero");
const { procesarMensajeChofer } = require("../flows/chofer");

module.exports = function(app, { procesarMensajeUsuario, procesarMensajeChofer, Chofer, Viaje, getSession, sessionCache, yaProcesoMensaje }) {

app.post("/webhook", async (req, res) => {
  if (!verificarFirmaMeta(req)) {
    log.warn("[WEBHOOK] Firma inválida, rechazado");
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      try {
        // FIX BUG#9 — deduplicar por msg.id (WhatsApp puede entregar el mismo mensaje dos veces)
        if (msg.id && yaProcesoMensaje(msg.id)) {
          log.warn(`[WEBHOOK] Mensaje duplicado ignorado: ${msg.id}`);
          continue;
        }

        const phone = msg.from;
        const buttonId = msg.interactive?.button_reply?.id || null;
        const textoUpper = msg.text?.body?.trim().toUpperCase() || "";
        const mediaId = msg.image?.id || null;

        log.info(`[WEBHOOK] From: ${phone}, Type: ${msg.type}, Text: "${msg.text?.body || ""}", Button: ${buttonId || "-"}`);

        const dentroLimite = await checkRateLimit(phone);
        if (!dentroLimite) { log.warn(`[WEBHOOK] Rate limit excedido para ${phone}`); continue; }

        // Admin approvals
        if (buttonId && (buttonId.startsWith("aprobar_pago_") || buttonId.startsWith("rechazar_pago_"))) {
          if (phone !== CONFIG.ADMIN_PHONE) {
            log.warn(`[SECURITY] ${phone} intentó aprobar pago sin ser admin`);
            await enviarMensaje(phone, "❌ No tienes permiso para esa acción.");
            continue;
          }
          const esAprobar = buttonId.startsWith("aprobar_pago_");
          const choferPhone = buttonId.replace(/^(aprobar|rechazar)_pago_/, "");
          if (esAprobar) {
            await Chofer.findOneAndUpdate(
              { phone: choferPhone },
              { "pagoDiario.aprobado": true, "pagoDiario.fecha": new Date(), "pagoDiario.fechaStr": fechaStrBolivia(), estado: "libre" }
            );
            await enviarBotones(choferPhone, `✅ *Pago confirmado!*\n🚖 Ya estás LIBRE para recibir viajes.`, [
              { id: "chofer_ocupado", title: "🔴 Ocupado" },
              { id: "chofer_ayuda", title: "❓ Ayuda" },
            ]);
            await enviarMensaje(phone, `✅ Pago aprobado para +${choferPhone}`);
          } else {
            await Chofer.findOneAndUpdate({ phone: choferPhone }, { "pagoDiario.pagado": false, "pagoDiario.aprobado": false, estado: "offline" });
            await enviarMensaje(choferPhone, `❌ Tu comprobante de pago fue rechazado. Contacta al admin: +591 62741818`);
            await enviarMensaje(phone, `❌ Pago rechazado para +${choferPhone}`);
          }
          continue;
        }

        // FIX BUG#8 — routing chofer/pasajero mejorado
        const esChofer = await Chofer.exists({ phone });
        const session = await getSession(phone);

        // Un pasajero con sesión activa de viaje NO debe ser re-ruteado al flujo chofer
        // aunque esté registrado como chofer en la BD
        const sesionEsPasajero = session && session.step && !session.step.startsWith("chofer_") && session.step !== "eligiendo_rol";

        // Verificar también si hay un viaje activo como pasajero en DB
        // Esto cubre el caso donde la sesión está corrupta pero el viaje sigue activo
        const tieneViajeActivoPasajero = sesionEsPasajero ? false : !!(await Viaje.findOne({
          usuarioPhone: phone,
          estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] },
        }).lean());

        const esRegistroChofer =
          !sesionEsPasajero && !tieneViajeActivoPasajero && (
            textoUpper === "CHOFER" ||
            textoUpper === "SOY CHOFER" ||
            textoUpper === "CONDUCTOR" ||
            (session && session.step?.startsWith("chofer_"))
          );

        // Prioridad: si tiene viaje activo como pasajero → siempre pasajero
        // Si está registrado como chofer Y no tiene sesión de pasajero → chofer
        if (tieneViajeActivoPasajero || sesionEsPasajero) {
          await procesarMensajeUsuario(phone, msg, buttonId);
        } else if (esChofer || esRegistroChofer) {
          await procesarMensajeChofer(phone, msg.text?.body || "", buttonId, mediaId, msg);
        } else {
          await procesarMensajeUsuario(phone, msg, buttonId);
        }
      } catch (eInner) {
        log.error("[WEBHOOK_MSG]", eInner.message, eInner.stack);
      }
    }
  } catch (e) {
    log.error("[WEBHOOK]", e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINTS AUXILIARES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/unidades", async (req, res) => {
  try {
    const eid = await wialonLogin();
    const resp = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "core/search_items",
        params: JSON.stringify({
          spec: { itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
          force: 1, flags: 4294967295, from: 0, to: 0,
        }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (!resp.data.items) return res.json({ error: "No se encontraron unidades", raw: resp.data });
    const unidades = resp.data.items.map(u => ({
      id: u.id,
      nombre: u.nm,
      uid: u.uid || u.uid2 || "",
      ultimaPos: u.pos ? { lat: u.pos.y, lng: u.pos.x, hace_min: Math.round((Date.now() / 1000 - (u.pos.t || 0)) / 60) } : null,
    }));
    res.json({ total: unidades.length, unidades });
  } catch (e) { res.json({ error: e.message }); }
});

app.get("/stats", async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const [usuarios, choferes, choferesLibres, choferesPagados, viajesHoy, viajesActivos, ratingPromedio] = await Promise.all([
      Usuario.countDocuments(),
      Chofer.countDocuments(),
      Chofer.countDocuments({ estado: "libre" }),
      Chofer.countDocuments({ "pagoDiario.aprobado": true, "pagoDiario.fechaStr": hoyStr }),
      Viaje.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }),
      Viaje.countDocuments({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }),
      Viaje.aggregate([{ $match: { ratingPasajero: { $exists: true } } }, { $group: { _id: null, avg: { $avg: "$ratingPasajero" }, count: { $sum: 1 } } }]),
    ]);
    res.json({ hoy: hoyStr, usuarios, choferes, choferesLibres, choferesPagadosHoy: choferesPagados, viajesUltimas24h: viajesHoy, viajesActivos, rating: ratingPromedio[0] ? { promedio: Math.round(ratingPromedio[0].avg * 10) / 10, cantidad: ratingPromedio[0].count } : null });
  } catch (e) { res.json({ error: e.message }); }
});

// Endpoint para ver referencias de voz (debug/admin)
app.get("/admin/referencias-voz", async (req, res) => {
  try {
    const refs = await LocationReference.find().sort({ contador: -1 }).limit(100).lean();
    res.json({ total: refs.length, referencias: refs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Endpoint público para verificar estado de la promo
app.get("/promo", (req, res) => {
  const activa = enPromoGratis();
  const hoy = fechaStrBolivia();
  res.json({
    promoActiva: activa,
    fechaHoy: hoy,
    fechaFin: CONFIG.PROMO_GRATIS_HASTA,
    fechaFinLegible: formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA),
    mensaje: activa
      ? `🎉 Promo gratis activa hasta el ${formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA)}.`
      : `💰 Promo terminada. Cobro normal de Bs 10/día activado.`,
  });
});

app.get("/admin/viaje/:id", async (req, res) => {
  try {
    const viaje = await Viaje.findById(req.params.id).lean();
    if (!viaje) { res.status(404).send("<h1>Viaje no encontrado</h1>"); return; }

    let posChofer = null, posError = null;
    if (viaje.choferWialonId) {
      try { const p = await obtenerUbicacionChofer(viaje.choferWialonId); posChofer = { lat: p.lat, lng: p.lng, hace_min: p.minutos }; }
      catch (e) { posError = e.message; }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viaje · ChatGo</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,sans-serif;background:#0f1419;color:#e6e6e6;}.header{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;}.header h1{font-size:16px;color:#00d97e;}.back{color:#58a6ff;text-decoration:none;font-size:13px;}.info{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;}.info-label{color:#8b949e;font-size:10px;text-transform:uppercase;}.info-value{font-size:14px;margin-top:2px;}.estado{padding:2px 8px;border-radius:10px;font-size:11px;display:inline-block;}.estado-en_curso{background:#0d3d20;color:#3fb950;}.estado-completado{background:#0d3d20;color:#3fb950;}.estado-pendiente,.estado-esperando_pasajero{background:#3d2c0d;color:#d29922;}.estado-en_camino{background:#0d2c3d;color:#58a6ff;}.estado-cancelado,.estado-cancelado_pasajero,.estado-cancelado_chofer{background:#3d0d0d;color:#f85149;}#map{height:calc(100vh - 200px);width:100%;}.leyenda{position:absolute;bottom:10px;left:10px;background:rgba(22,27,34,.95);padding:10px;border-radius:8px;border:1px solid #30363d;font-size:12px;z-index:1000;}.leyenda div{margin:3px 0;}.mi{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:6px;vertical-align:middle;}</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/></head>
<body>
<div class="header"><a href="/admin" class="back">← Volver al panel</a><h1>🚖 Viaje #${String(viaje._id).slice(-6).toUpperCase()}</h1><button onclick="location.reload()" style="background:#1f6feb;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🔄 Actualizar</button></div>
<div class="info">
  <div><div class="info-label">Estado</div><div class="info-value"><span class="estado estado-${viaje.estado}">${viaje.estado.toUpperCase()}</span></div></div>
  <div><div class="info-label">Pasajero</div><div class="info-value">+${viaje.usuarioPhone||"—"}</div></div>
  <div><div class="info-label">Chofer</div><div class="info-value">${viaje.choferNombre||"—"}<br><small style="color:#8b949e">${viaje.choferPlaca||""} · ${viaje.tipoVehiculo==="moto"?"🏍️ Moto":"🚗 Auto"}</small></div></div>
  <div><div class="info-label">Distancia</div><div class="info-value">${viaje.distanciaKm||"—"} km</div></div>
  <div><div class="info-label">Precio</div><div class="info-value">Bs ${viaje.precioTotal||"—"}${viaje.descuentoBs>0?' <small style="color:#3fb950">(-Bs '+viaje.descuentoBs+')</small>':""}</div></div>
  ${posChofer?`<div><div class="info-label">GPS Chofer</div><div class="info-value" style="color:${posChofer.hace_min<=5?"#3fb950":posChofer.hace_min<=15?"#d29922":"#f85149"}">📡 ${posChofer.hace_min} min</div></div>`:""}
  ${viaje.observaciones?`<div style="grid-column:span 2"><div class="info-label">📝 Observaciones</div><div class="info-value">${viaje.observaciones}</div></div>`:""}
</div>
<div id="map"></div>
<div class="leyenda">
  <div><span class="mi" style="background:#3fb950"></span>Origen</div>
  ${(viaje.paradas||[]).length>0?'<div><span class="mi" style="background:#d29922"></span>Paradas</div>':""}
  <div><span class="mi" style="background:#f85149"></span>Destino</div>
  ${posChofer?'<div><span class="mi" style="background:#58a6ff"></span>Chofer ahora</div>':""}
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const viaje=${JSON.stringify({origen:viaje.origen,paradas:viaje.paradas||[],destino:viaje.destino,posChofer,estado:viaje.estado})};
const puntos=[viaje.origen,...viaje.paradas,viaje.destino].filter(p=>p&&p.lat);
if(viaje.posChofer)puntos.push(viaje.posChofer);
const cLat=puntos.reduce((s,p)=>s+p.lat,0)/puntos.length;
const cLng=puntos.reduce((s,p)=>s+p.lng,0)/puntos.length;
const map=L.map('map').setView([cLat,cLng],14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
function mkIcon(color,label){return L.divIcon({html:'<div style="background:'+color+';width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;"><span style="transform:rotate(45deg)">'+label+'</span></div>',iconSize:[30,30],iconAnchor:[15,30],className:''});}
if(viaje.origen?.lat)L.marker([viaje.origen.lat,viaje.origen.lng],{icon:mkIcon('#3fb950','A')}).addTo(map).bindPopup('<b>📍 Origen</b><br>'+(viaje.origen.nombre||''));
viaje.paradas.forEach((p,i)=>L.marker([p.lat,p.lng],{icon:mkIcon('#d29922',String(i+1))}).addTo(map).bindPopup('<b>🚏 Parada '+(i+1)+'</b><br>'+(p.nombre||'')));
if(viaje.destino?.lat)L.marker([viaje.destino.lat,viaje.destino.lng],{icon:mkIcon('#f85149','B')}).addTo(map).bindPopup('<b>🏁 Destino</b><br>'+(viaje.destino.nombre||''));
if(viaje.posChofer){const ci=L.divIcon({html:'<div style="background:#58a6ff;width:36px;height:36px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:18px;">🚖</div>',iconSize:[36,36],iconAnchor:[18,18],className:''});L.marker([viaje.posChofer.lat,viaje.posChofer.lng],{icon:ci}).addTo(map).bindPopup('<b>🚖 Chofer ahora</b><br>Hace '+viaje.posChofer.hace_min+' min');}
const ruta=[];if(viaje.origen?.lat)ruta.push([viaje.origen.lat,viaje.origen.lng]);viaje.paradas.forEach(p=>ruta.push([p.lat,p.lng]));if(viaje.destino?.lat)ruta.push([viaje.destino.lat,viaje.destino.lng]);
if(ruta.length>=2)L.polyline(ruta,{color:'#58a6ff',weight:4,opacity:.7,dashArray:'8,8'}).addTo(map);
if(viaje.posChofer){const np=viaje.estado==='en_curso'&&viaje.destino?.lat?[viaje.destino.lat,viaje.destino.lng]:viaje.origen?.lat?[viaje.origen.lat,viaje.origen.lng]:null;if(np)L.polyline([[viaje.posChofer.lat,viaje.posChofer.lng],np],{color:'#3fb950',weight:3,opacity:.8}).addTo(map);}
const g=L.featureGroup();puntos.forEach(p=>g.addLayer(L.marker([p.lat,p.lng])));if(puntos.length>1)map.fitBounds(g.getBounds(),{padding:[50,50]});
if(['pendiente','en_camino','esperando_pasajero','en_curso'].includes(viaje.estado))setTimeout(()=>location.reload(),30000);
</script></body></html>`);
  } catch (e) { log.error("[ADMIN_VIAJE]", e.message); res.status(500).send("Error: " + e.message); }
});

app.get("/admin/mapa", async (req, res) => {
  try {
    const choferes = await Chofer.find().lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      if (!c.wialonId) return null;
      try { const p = await obtenerUbicacionChofer(c.wialonId); return { phone: c.phone, nombre: c.nombre, placa: c.placa, tipoVehiculo: c.tipoVehiculo||"auto", estado: c.estado, wialonId: c.wialonId, lat: p.lat, lng: p.lng, hace_min: p.minutos }; }
      catch { return null; }
    }));
    const validos = choferesConPos.filter(Boolean);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mapa Choferes · ChatGo</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,sans-serif;background:#0f1419;color:#e6e6e6;}.header{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;}.header h1{font-size:16px;color:#00d97e;}.header a{color:#58a6ff;text-decoration:none;font-size:13px;}.stats{display:flex;gap:14px;font-size:12px;}.stats span{color:#8b949e;}#map{height:calc(100vh - 60px);width:100%;}.leyenda{position:absolute;bottom:10px;left:10px;background:rgba(22,27,34,.95);padding:10px;border-radius:8px;border:1px solid #30363d;font-size:12px;z-index:1000;}</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/></head>
<body><div class="header"><a href="/admin">← Panel</a><h1>🗺️ Mapa de choferes en vivo</h1><div class="stats"><span>🟢 Libres: ${validos.filter(c=>c.estado==="libre").length}</span><span>🟡 Ocupados: ${validos.filter(c=>c.estado==="ocupado").length}</span><span>🔴 Offline: ${validos.filter(c=>c.estado==="offline").length}</span></div></div>
<div id="map"></div>
<div class="leyenda"><div>🟢 Libre</div><div>🟡 Ocupado</div><div>🔴 Offline</div><div style="margin-top:6px;color:#8b949e;font-size:11px">Auto-refresh: 30s</div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const choferes=${JSON.stringify(validos)};
let cLat=-17.39,cLng=-66.157;
if(choferes.length>0){cLat=choferes.reduce((s,c)=>s+c.lat,0)/choferes.length;cLng=choferes.reduce((s,c)=>s+c.lng,0)/choferes.length;}
const map=L.map('map').setView([cLat,cLng],13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
function colorE(e){return e==='libre'?'#3fb950':e==='ocupado'?'#d29922':'#f85149';}
function iconC(c){const color=colorE(c.estado);const em=c.tipoVehiculo==='moto'?'🏍️':'🚗';return L.divIcon({html:'<div style="background:'+color+';width:36px;height:36px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:16px;">'+em+'</div>',iconSize:[36,36],iconAnchor:[18,18],className:''});}
choferes.forEach(c=>L.marker([c.lat,c.lng],{icon:iconC(c)}).addTo(map).bindPopup('<b>'+(c.nombre||'Sin nombre')+'</b><br>Placa: '+(c.placa||'—')+'<br>'+(c.tipoVehiculo==='moto'?'🏍️ Moto':'🚗 Auto')+'<br>Estado: '+c.estado.toUpperCase()+'<br>GPS: hace '+c.hace_min+' min<br>Tel: +'+c.phone));
if(choferes.length>1){const g=L.featureGroup(choferes.map(c=>L.marker([c.lat,c.lng])));map.fitBounds(g.getBounds(),{padding:[50,50]});}
setTimeout(()=>location.reload(),30000);
</script></body></html>`);
  } catch (e) { log.error("[ADMIN_MAPA]", e.message); res.status(500).send("Error: " + e.message); }
});

app.get("/admin/mapa-data", async (req, res) => {
  try {
    const choferes = await Chofer.find().lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      if (!c.wialonId) return null;
      try { const pos = await obtenerUbicacionChofer(c.wialonId); if (pos.minutos > 30) return null; return { phone: c.phone, nombre: c.nombre||"—", placa: c.placa||"—", tipoVehiculo: c.tipoVehiculo||"auto", estado: c.estado||"offline", wialonId: c.wialonId, lat: pos.lat, lng: pos.lng, hace_min: pos.minutos, ratingPromedio: c.ratingPromedio||0, viajesTotal: c.viajesTotal||0 }; }
      catch { return null; }
    }));
    const viajesActivos = await Viaje.find({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }).lean();
    res.json({ timestamp: new Date().toISOString(), choferes: choferesConPos.filter(Boolean), viajesActivos });
  } catch (e) { log.error("[MAPA_DATA]", e.message); res.status(500).json({ error: e.message }); }
});

app.get("/admin/data", async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const ahora = Date.now();
    const choferes = await Chofer.find().sort({ updatedAt: -1 }).lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      let pos = null, posError = null;
      if (c.wialonId) { try { const p = await obtenerUbicacionChofer(c.wialonId); pos = { lat: p.lat, lng: p.lng, hace_min: p.minutos, wialonOk: true }; } catch (e) { posError = e.message; } }
      const pagoAlDia = !!(c.pagoDiario?.aprobado && c.pagoDiario?.fechaStr === hoyStr);
      return { _id: c._id, phone: c.phone, nombre: c.nombre||"", placa: c.placa||"", tipoVehiculo: c.tipoVehiculo||"auto", wialonId: c.wialonId||"", estado: c.estado||"offline", viajesTotal: c.viajesTotal||0, ratingPromedio: c.ratingPromedio||0, ratingCantidad: c.ratingCantidad||0, pagoDiario: c.pagoDiario||{}, pagoAlDia, viajeReservado: c.viajeReservado, ultimaPos: pos, posError };
    }));
    const viajesActivos = await Viaje.find({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }).sort({ createdAt: -1 }).lean();
    const viajesRecientes = await Viaje.find().sort({ createdAt: -1 }).limit(20).lean();
    const listaEspera = await ListaEspera.find().lean();
    const [totalUsuarios, usuariosNuevosHoy, viajes24h, viajesCompletados24h, ratingAgg, codigosActivos, codigosUsados] = await Promise.all([
      Usuario.countDocuments(),
      Usuario.countDocuments({ createdAt: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.countDocuments({ createdAt: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.countDocuments({ estado: "completado", fechaFin: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.aggregate([{ $match: { ratingPasajero: { $exists: true } } }, { $group: { _id: null, avg: { $avg: "$ratingPasajero" }, count: { $sum: 1 } } }]),
      CodigoPromo.countDocuments({ usado: false, fechaVencimiento: { $gt: new Date() } }),
      CodigoPromo.countDocuments({ usado: true }),
    ]);
    res.json({
      timestamp: new Date().toISOString(),
      hoy: hoyStr,
      stats: { totalUsuarios, usuariosNuevosHoy, viajes24h, viajesCompletados24h, rating: ratingAgg[0] ? { promedio: Math.round(ratingAgg[0].avg * 10) / 10, cantidad: ratingAgg[0].count } : null, codigosActivos, codigosUsados, choferesTotal: choferes.length, choferesLibres: choferesConPos.filter(c=>c.estado==="libre").length, choferesOcupados: choferesConPos.filter(c=>c.estado==="ocupado").length, choferesOffline: choferesConPos.filter(c=>c.estado==="offline").length, choferesPagadosHoy: choferesConPos.filter(c=>c.pagoAlDia).length, choferesConGPSReciente: choferesConPos.filter(c=>c.ultimaPos&&c.ultimaPos.hace_min<=15).length, viajesActivos: viajesActivos.length, enListaEspera: listaEspera.length },
      choferes: choferesConPos, viajesActivos, viajesRecientes, listaEspera,
      promo: { viajesActiva: enPromoGratis(), viajesFin: CONFIG.PROMO_GRATIS_HASTA, codigosActiva: promoCodigosActiva(), codigosFin: CONFIG.PROMO_CODIGOS_HASTA },
    });
  } catch (e) { log.error("[ADMIN_DATA]", e.message); res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRACKING EN TIEMPO REAL — página propia, expira al terminar el viaje
// ═══════════════════════════════════════════════════════════════════════════

// Diagnóstico de geocoding — para verificar qué coords devuelve Google Maps
// Aprobar chofer manualmente desde el navegador (sin necesidad del comprobante)
app.get("/admin/aprobar-chofer/:phone", async (req, res) => {
  try {
    const phone = req.params.phone;
    const chofer = await Chofer.findOne({ phone });
    if (!chofer) return res.json({ error: `Chofer +${phone} no encontrado` });

    await Chofer.findOneAndUpdate(
      { phone },
      {
        "pagoDiario.aprobado": true,
        "pagoDiario.pagado": true,
        "pagoDiario.fecha": new Date(),
        "pagoDiario.fechaStr": fechaStrBolivia(),
        estado: "libre",
        viajeReservado: null,
        reservadoHasta: null,
      }
    );

    // Notificar al chofer por WhatsApp
    await enviarBotones(
      phone,
      `✅ *¡Pago aprobado!*\n\n🟢 Ya estás LIBRE para recibir viajes.\n\n_Aprobado manualmente por el administrador._`,
      [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );

    res.json({
      ok: true,
      mensaje: `✅ Chofer ${chofer.nombre} (+${phone}) aprobado y notificado`,
      estado: "libre",
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Ver todos los choferes pendientes de aprobación
app.get("/admin/pendientes-aprobacion", async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const pendientes = await Chofer.find({
      $or: [
        { "pagoDiario.pagado": true, "pagoDiario.aprobado": false },
        { estado: "offline", "pagoDiario.fechaStr": { $ne: hoyStr } },
      ]
    }).lean();

    res.json({
      total: pendientes.length,
      hoy: hoyStr,
      choferes: pendientes.map(c => ({
        nombre: c.nombre,
        phone: c.phone,
        placa: c.placa,
        estado: c.estado,
        pagoDiario: c.pagoDiario,
        linkAprobar: `https://chatgo-production.up.railway.app/admin/aprobar-chofer/${c.phone}`,
      })),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});


};
