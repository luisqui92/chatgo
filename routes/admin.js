// ChatGo — admin.js
const mongoose = require("mongoose");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, ListaEspera, LocationReference } = require("../db/models");
const { obtenerUbicacionChofer } = require("../services/wialon");
const { geocodificarDireccion } = require("../services/google");

module.exports = function(app, deps) {

app.get("/admin/geocod", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ error: "Falta ?q=direccion" });
  try {
    const resultado = await geocodificarDireccion(q);
    if (!resultado) return res.json({ query: q, resultado: null, mensaje: "Sin resultados" });
    res.json({
      query: q,
      lat: resultado.lat,
      lng: resultado.lng,
      nombre: resultado.nombre,
      mapLink: `https://www.google.com/maps?q=${resultado.lat},${resultado.lng}`,
      routeLink: `https://www.google.com/maps/dir/?api=1&origin=${resultado.lat},${resultado.lng}&destination=${resultado.lat},${resultado.lng}&travelmode=driving`,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Diagnóstico de viaje — ver exactamente qué coords se usaron
app.get("/admin/viaje-coords/:viajeId", async (req, res) => {
  try {
    const viaje = await Viaje.findById(req.params.viajeId).lean();
    if (!viaje) return res.json({ error: "Viaje no encontrado" });
    const linkRuta = generarLinkRutaConParadas(viaje.origen, viaje.paradas || [], viaje.destino);
    res.json({
      viajeId: viaje._id,
      estado: viaje.estado,
      origen: {
        nombre: viaje.origen?.nombre,
        lat: viaje.origen?.lat,
        lng: viaje.origen?.lng,
        mapLink: `https://www.google.com/maps?q=${viaje.origen?.lat},${viaje.origen?.lng}`,
      },
      destino: {
        nombre: viaje.destino?.nombre,
        lat: viaje.destino?.lat,
        lng: viaje.destino?.lng,
        mapLink: `https://www.google.com/maps?q=${viaje.destino?.lat},${viaje.destino?.lng}`,
      },
      linkRutaChofer: linkRuta,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API de posición — consultada por chatgo.ia.bo cada 15s
app.get("/track/:viajeId/pos", async (req, res) => {
  // CORS para chatgo.ia.bo (página estática externa)
  res.setHeader("Access-Control-Allow-Origin", "https://chatgo.ia.bo");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  try {
    const viaje = await Viaje.findById(req.params.viajeId).lean();
    if (!viaje) return res.json({ error: "not_found" });

    const activo = ["en_camino","esperando_pasajero","en_curso"].includes(viaje.estado);
    if (!activo) {
      return res.json({ terminado: true, estado: viaje.estado, destino: viaje.destino });
    }

    const pos = await obtenerUbicacionChofer(viaje.choferWialonId);
    res.json({
      terminado: false,
      lat: pos.lat,
      lng: pos.lng,
      hace_min: pos.minutos,
      estado: viaje.estado,
      choferNombre: viaje.choferNombre,
      choferPlaca: viaje.choferPlaca,
      tipoVehiculo: viaje.tipoVehiculo || "auto",
      origen: viaje.origen,
      destino: viaje.destino,
      distanciaKm: viaje.distanciaKm,
      precioTotal: viaje.precioTotal,
    });
  } catch (e) {
    log.error("[TRACK_POS]", e.message);
    res.json({ error: e.message });
  }
});

// Página de rastreo HTML con Google Maps
app.get("/track/:viajeId", async (req, res) => {
  try {
    const viaje = await Viaje.findById(req.params.viajeId).lean();

    if (!viaje) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGo</title>
<style>body{font-family:sans-serif;background:#0f1419;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;flex-direction:column;gap:12px;}</style>
</head><body><div style="font-size:48px">🚖</div><h2>Link inválido</h2><p style="color:#8b949e">Este enlace de rastreo no existe.</p></body></html>`);
    }

    const activo = ["en_camino","esperando_pasajero","en_curso"].includes(viaje.estado);
    const emoji = viaje.tipoVehiculo === "moto" ? "🏍️" : "🚗";
    const label = viaje.tipoVehiculo === "moto" ? "Moto" : "Auto";
    const estadoTexto = viaje.estado === "esperando_pasajero"
      ? "Tu chofer llegó — dirígete al vehículo"
      : viaje.estado === "en_curso" ? "Viaje en curso"
      : "Tu chofer va en camino";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Rastreando tu ChatGo</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1419;color:#e6e6e6;display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:10px 14px;flex-shrink:0;}
.header-row{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.logo{background:#1D9E75;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.header-title{font-size:14px;font-weight:600;}
.header-sub{font-size:12px;color:#8b949e;}
.status-row{display:flex;align-items:center;gap:8px;font-size:12px;}
.dot{width:8px;height:8px;border-radius:50%;background:#1D9E75;}
.dot.pulse{animation:p 2s infinite;}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
.dot.off{background:#f85149;animation:none;}
.status-txt{color:#1D9E75;font-weight:500;}
.status-txt.fin{color:#f85149;}
.update-ts{font-size:10px;color:#8b949e;margin-left:auto;}
#map{flex:1;}
.info{background:#161b22;border-top:1px solid #30363d;padding:10px 14px;flex-shrink:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.info-item{background:#0d1117;border-radius:8px;padding:8px 10px;}
.info-label{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;}
.info-value{font-size:13px;font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.info-wide{grid-column:span 2;}
.overlay{display:none;position:fixed;inset:0;background:rgba(15,20,25,.96);align-items:center;justify-content:center;flex-direction:column;gap:14px;text-align:center;padding:24px;z-index:999;}
.overlay.show{display:flex;}
.ov-icon{font-size:52px;}
.ov-title{font-size:20px;font-weight:600;}
.ov-sub{font-size:14px;color:#8b949e;max-width:280px;line-height:1.5;}
</style>
</head>
<body>
<div class="header">
  <div class="header-row">
    <div class="logo">🚖</div>
    <div>
      <div class="header-title">ChatGo · Rastreo en vivo</div>
      <div class="header-sub">${viaje.choferNombre} · ${emoji} ${label} ${viaje.choferPlaca}</div>
    </div>
  </div>
  <div class="status-row">
    <div class="dot ${activo ? "pulse" : "off"}" id="dot"></div>
    <span class="status-txt ${activo ? "" : "fin"}" id="stxt">${activo ? estadoTexto : "Viaje finalizado"}</span>
    <span class="update-ts" id="ts"></span>
  </div>
</div>

<div id="map"></div>

<div class="info">
  <div class="info-item">
    <div class="info-label">Chofer</div>
    <div class="info-value">${viaje.choferNombre}</div>
  </div>
  <div class="info-item">
    <div class="info-label">Vehículo</div>
    <div class="info-value">${emoji} ${label} · ${viaje.choferPlaca}</div>
  </div>
  <div class="info-item info-wide">
    <div class="info-label">📍 Origen</div>
    <div class="info-value">${viaje.origen?.nombre || "Tu ubicación"}</div>
  </div>
  <div class="info-item info-wide">
    <div class="info-label">🏁 Destino</div>
    <div class="info-value">${viaje.destino?.nombre || "Tu destino"}</div>
  </div>
  <div class="info-item">
    <div class="info-label">Distancia</div>
    <div class="info-value">${viaje.distanciaKm} km</div>
  </div>
  <div class="info-item">
    <div class="info-label">Precio</div>
    <div class="info-value">Bs ${viaje.precioTotal}</div>
  </div>
</div>

<div class="overlay ${activo ? "" : "show"}" id="overlay">
  <div class="ov-icon">✅</div>
  <div class="ov-title">Viaje finalizado</div>
  <div class="ov-sub">Gracias por usar ChatGo.<br>¡Hasta la próxima!</div>
</div>

<script>
const VID = "${viaje._id}";
const GMKEY = "${CONFIG.GOOGLE_MAPS_KEY}";
const ORIGEN = ${JSON.stringify(viaje.origen || {})};
const DESTINO = ${JSON.stringify(viaje.destino || {})};
let map, taxiMarker, terminado = ${activo ? "false" : "true"};
let segundos = 0, timer;

function initMap() {
  const centro = { lat: ${viaje.origen?.lat || -17.3935}, lng: ${viaje.origen?.lng || -66.157} };
  map = new google.maps.Map(document.getElementById("map"), {
    center: centro, zoom: 14,
    disableDefaultUI: true, zoomControl: true,
    styles: [
      {elementType:"geometry",stylers:[{color:"#212121"}]},
      {elementType:"labels.text.fill",stylers:[{color:"#757575"}]},
      {elementType:"labels.text.stroke",stylers:[{color:"#212121"}]},
      {featureType:"road",elementType:"geometry",stylers:[{color:"#484848"}]},
      {featureType:"road.highway",elementType:"geometry",stylers:[{color:"#3c3c3c"}]},
      {featureType:"water",elementType:"geometry",stylers:[{color:"#000000"}]},
    ],
  });

  const mkCircle = (pos, color, title) => new google.maps.Marker({
    position: pos, map, title,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: color, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
    zIndex: 1,
  });

  if (ORIGEN.lat) mkCircle({ lat: ORIGEN.lat, lng: ORIGEN.lng }, "#1D9E75", "Origen");
  if (DESTINO.lat) mkCircle({ lat: DESTINO.lat, lng: DESTINO.lng }, "#f85149", "Destino");

  if (!terminado) poll();
  else showFin();
}

const TAXI_ICON = {
  url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42"><circle cx="21" cy="21" r="21" fill="#1D9E75"/><text x="21" y="28" text-anchor="middle" font-size="22">🚖</text></svg>'),
  scaledSize: new google.maps.Size(42, 42),
  anchor: new google.maps.Point(21, 21),
};

async function poll() {
  if (terminado) return;
  try {
    const r = await fetch("/track/" + VID + "/pos");
    const d = await r.json();
    if (d.error === "not_found") { showFin("Link inválido"); return; }
    if (d.terminado) { showFin(); return; }

    const pos = { lat: d.lat, lng: d.lng };
    if (!taxiMarker) {
      taxiMarker = new google.maps.Marker({ position: pos, map, icon: TAXI_ICON, title: d.choferNombre, zIndex: 10 });
      map.setCenter(pos);
    } else {
      taxiMarker.setPosition(pos);
    }

    const stxt = document.getElementById("stxt");
    stxt.textContent = d.estado === "esperando_pasajero"
      ? "Tu chofer llegó — dirígete al vehículo"
      : d.estado === "en_curso" ? "Viaje en curso"
      : "Tu chofer va en camino";

    // Contador desde última actualización
    clearInterval(timer);
    segundos = 0;
    document.getElementById("ts").textContent = "Ahora mismo";
    timer = setInterval(() => {
      segundos++;
      document.getElementById("ts").textContent = segundos < 60
        ? "Actualizado hace " + segundos + "s"
        : "Actualizado hace " + Math.floor(segundos/60) + " min";
    }, 1000);

  } catch(e) { console.error(e); }
  setTimeout(poll, 15000);
}

function showFin(msg) {
  terminado = true;
  clearInterval(timer);
  document.getElementById("overlay").classList.add("show");
  document.getElementById("dot").classList.remove("pulse");
  document.getElementById("dot").classList.add("off");
  document.getElementById("stxt").classList.add("fin");
  document.getElementById("stxt").textContent = "Viaje finalizado";
  if (msg) document.querySelector(".ov-sub").textContent = msg;
}

window.initMap = initMap;
</script>
<script async defer src="https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_KEY}&callback=initMap&language=es"></script>
</body></html>`);
  } catch (e) {
    log.error("[TRACK_PAGE]", e.message);
    res.status(500).send("Error: " + e.message);
  }
});

app.get("/admin", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGo Admin · RastreoPlus</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1419;color:#e6e6e6;padding:14px;font-size:14px;}h1{color:#00d97e;font-size:22px;margin-bottom:4px;}.subtitle{color:#8b949e;margin-bottom:16px;font-size:12px;}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px;}.btn{padding:6px 12px;background:#1f6feb;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;}.btn:hover{background:#388bfd;}.btn.muted{background:#30363d;}.updated{color:#8b949e;font-size:11px;}.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:18px;}.stat{background:#161b22;padding:10px 12px;border-radius:8px;border:1px solid #30363d;}.stat-label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}.stat-value{font-size:22px;font-weight:bold;margin-top:4px;}.stat-value.green{color:#3fb950;}.stat-value.yellow{color:#d29922;}.stat-value.red{color:#f85149;}.stat-value.blue{color:#58a6ff;}.section{background:#161b22;padding:14px;border-radius:8px;border:1px solid #30363d;margin-bottom:14px;}.section h2{font-size:15px;color:#58a6ff;margin-bottom:10px;display:flex;align-items:center;gap:8px;}.badge{padding:2px 8px;background:#30363d;border-radius:10px;font-size:11px;color:#8b949e;}table{width:100%;border-collapse:collapse;font-size:12px;}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #21262d;}th{color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.5px;}tr:hover{background:#0d1117;}.estado{padding:2px 8px;border-radius:10px;font-size:11px;display:inline-block;}.estado-libre{background:#0d3d20;color:#3fb950;}.estado-ocupado{background:#3d2c0d;color:#d29922;}.estado-offline{background:#3d0d0d;color:#f85149;}.gps-ok{color:#3fb950;}.gps-old{color:#d29922;}.gps-no{color:#f85149;}.pago-ok{color:#3fb950;}.pago-no{color:#f85149;}.vehiculo-auto{color:#58a6ff;}.vehiculo-moto{color:#d29922;}a.maplink{color:#58a6ff;text-decoration:none;}a.maplink:hover{text-decoration:underline;}.empty{color:#8b949e;font-style:italic;text-align:center;padding:18px;}.loading{text-align:center;color:#8b949e;padding:40px;}.filter{padding:4px 8px;background:#0d1117;border:1px solid #30363d;color:#e6e6e6;border-radius:4px;font-size:12px;}.truncate{max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}@media (max-width:768px){body{padding:8px;font-size:13px;}.stats-grid{grid-template-columns:repeat(2,1fr);}table{font-size:11px;}th,td{padding:6px 4px;}}</style>
</head><body>
<h1>🚖 ChatGo Admin</h1>
<div class="subtitle">RastreoPlus · Cochabamba · v4 FIXED</div>
<div class="toolbar">
  <button class="btn" onclick="cargar()">🔄 Actualizar</button>
  <button class="btn muted" id="btnAuto">▶️ Auto-refresh OFF</button>
  <a href="/admin/mapa" class="btn" style="text-decoration:none;background:#0d3d20;">🗺️ Mapa choferes</a>
  <span class="updated" id="updated">Cargando...</span>
</div>
<div id="content"><div class="loading">⏳ Cargando datos...</div></div>
<script>
let autoRefresh=false,intervaloRefresh=null;
document.getElementById("btnAuto").onclick=()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("btnAuto");if(autoRefresh){btn.textContent="⏸️ Auto-refresh ON (15s)";btn.style.background="#0d3d20";intervaloRefresh=setInterval(cargar,15000);}else{btn.textContent="▶️ Auto-refresh OFF";btn.style.background="#30363d";if(intervaloRefresh)clearInterval(intervaloRefresh);}};
function fmtHora(d){if(!d)return"—";return new Date(d).toLocaleString("es-BO",{timeZone:"America/La_Paz",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});}
function fmtTel(p){return p?"+"+p:"—";}
function gpsBadge(pos){if(!pos)return'<span class="gps-no">❌ Sin GPS</span>';if(pos.hace_min<=5)return'<span class="gps-ok">📡 '+pos.hace_min+'min</span>';if(pos.hace_min<=15)return'<span class="gps-old">⚠️ '+pos.hace_min+'min</span>';return'<span class="gps-no">🔴 '+pos.hace_min+'min</span>';}
function estadoBadge(estado){return'<span class="estado estado-'+estado+'">'+estado.toUpperCase()+'</span>';}
function tipoVehBadge(t){const e=t==="moto"?"🏍️":"🚗";return'<span class="vehiculo-'+t+'">'+e+' '+t.toUpperCase()+'</span>';}
function pagoBadge(c){if(c.pagoAlDia)return'<span class="pago-ok">✅ Pagado hoy</span>';if(c.pagoDiario?.pagado&&!c.pagoDiario?.aprobado)return'<span class="gps-old">⏳ Pendiente</span>';return'<span class="pago-no">❌ Sin pago</span>';}
async function cargar(){try{const r=await fetch("/admin/data");const d=await r.json();if(d.error){document.getElementById("content").innerHTML='<div class="section">❌ Error: '+d.error+'</div>';return;}renderizar(d);document.getElementById("updated").textContent="Actualizado: "+new Date().toLocaleTimeString("es-BO");}catch(e){document.getElementById("content").innerHTML='<div class="section">❌ Error de red: '+e.message+'</div>';}}
function renderizar(d){const s=d.stats;let html='';
html+='<div class="stats-grid">';
html+='<div class="stat"><div class="stat-label">Choferes</div><div class="stat-value blue">'+s.choferesTotal+'</div></div>';
html+='<div class="stat"><div class="stat-label">🟢 Libres</div><div class="stat-value green">'+s.choferesLibres+'</div></div>';
html+='<div class="stat"><div class="stat-label">🟡 Ocupados</div><div class="stat-value yellow">'+s.choferesOcupados+'</div></div>';
html+='<div class="stat"><div class="stat-label">🔴 Offline</div><div class="stat-value red">'+s.choferesOffline+'</div></div>';
html+='<div class="stat"><div class="stat-label">📡 GPS reciente</div><div class="stat-value blue">'+s.choferesConGPSReciente+'</div></div>';
html+='<div class="stat"><div class="stat-label">💰 Pagados hoy</div><div class="stat-value green">'+s.choferesPagadosHoy+'</div></div>';
html+='<div class="stat"><div class="stat-label">🚖 Activos</div><div class="stat-value yellow">'+s.viajesActivos+'</div></div>';
html+='<div class="stat"><div class="stat-label">⏳ En espera</div><div class="stat-value yellow">'+s.enListaEspera+'</div></div>';
html+='<div class="stat"><div class="stat-label">Usuarios</div><div class="stat-value blue">'+s.totalUsuarios+'</div></div>';
html+='<div class="stat"><div class="stat-label">+ Hoy</div><div class="stat-value green">'+s.usuariosNuevosHoy+'</div></div>';
html+='<div class="stat"><div class="stat-label">Viajes 24h</div><div class="stat-value blue">'+s.viajes24h+'</div></div>';
html+='<div class="stat"><div class="stat-label">✅ Completados</div><div class="stat-value green">'+s.viajesCompletados24h+'</div></div>';
if(s.rating)html+='<div class="stat"><div class="stat-label">⭐ Rating</div><div class="stat-value yellow">'+s.rating.promedio+' <span style="font-size:11px;color:#8b949e">('+s.rating.cantidad+')</span></div></div>';
html+='<div class="stat"><div class="stat-label">🎁 Códigos</div><div class="stat-value green">'+s.codigosActivos+'</div></div>';
html+='</div>';
html+='<div class="section"><h2>👥 Choferes <span class="badge">'+d.choferes.length+'</span> <select class="filter" id="filtroChofer" onchange="filtrarChoferes()"><option value="todos">Todos</option><option value="libre">Libres</option><option value="ocupado">Ocupados</option><option value="offline">Offline</option><option value="con-gps">Con GPS</option><option value="sin-gps">Sin GPS</option><option value="pagado">Pagados</option><option value="impago">Sin pagar</option></select></h2>';
if(d.choferes.length===0){html+='<div class="empty">No hay choferes registrados.</div>';}else{html+='<div style="overflow-x:auto"><table id="tablaChoferes"><thead><tr><th>Estado</th><th>Nombre</th><th>Placa</th><th>Tipo</th><th>Teléfono</th><th>Wialon ID</th><th>GPS</th><th>Pago</th><th>Viajes</th><th>⭐</th><th>Mapa</th></tr></thead><tbody>';
d.choferes.forEach(c=>{let mapaLink="—";if(c.ultimaPos)mapaLink='<a class="maplink" href="https://www.google.com/maps?q='+c.ultimaPos.lat+','+c.ultimaPos.lng+'" target="_blank">🗺️ Ver</a>';const rating=c.ratingCantidad>0?c.ratingPromedio.toFixed(1)+' ('+c.ratingCantidad+')':'—';let clase="chofer";clase+=" estado-"+c.estado;clase+=c.ultimaPos&&c.ultimaPos.hace_min<=15?" con-gps":" sin-gps";clase+=c.pagoAlDia?" pagado":" impago";html+='<tr class="'+clase+'"><td>'+estadoBadge(c.estado)+'</td><td class="truncate" title="'+(c.nombre||"")+'">'+(c.nombre||"—")+'</td><td>'+(c.placa||"—")+'</td><td>'+tipoVehBadge(c.tipoVehiculo)+'</td><td>'+fmtTel(c.phone)+'</td><td>'+(c.wialonId||"—")+'</td><td>'+gpsBadge(c.ultimaPos)+'</td><td>'+pagoBadge(c)+'</td><td>'+c.viajesTotal+'</td><td>'+rating+'</td><td>'+mapaLink+'</td></tr>';});
html+='</tbody></table></div>';}html+='</div>';
html+='<div class="section"><h2>🚖 Viajes activos <span class="badge">'+d.viajesActivos.length+'</span></h2>';
if(d.viajesActivos.length===0){html+='<div class="empty">No hay viajes activos.</div>';}else{html+='<div style="overflow-x:auto"><table><thead><tr><th>Estado</th><th>Tipo</th><th>Pasajero</th><th>Chofer</th><th>Origen</th><th>Destino</th><th>Km</th><th>Precio</th><th>Inicio</th><th>Mapa</th></tr></thead><tbody>';d.viajesActivos.forEach(v=>{html+='<tr><td><span class="estado estado-'+(v.estado==="en_curso"?"libre":"ocupado")+'">'+v.estado+'</span></td><td>'+tipoVehBadge(v.tipoVehiculo||"auto")+'</td><td>'+fmtTel(v.usuarioPhone)+'</td><td>'+(v.choferNombre||"—")+'<br><small>'+(v.choferPlaca||"")+'</small></td><td class="truncate">'+(v.origen?.nombre||"📍")+'</td><td class="truncate">'+(v.destino?.nombre||"🏁")+'</td><td>'+(v.distanciaKm||"—")+' km</td><td>Bs '+(v.precioTotal||"—")+'</td><td>'+fmtHora(v.fechaInicio)+'</td><td><a class="maplink" href="/admin/viaje/'+v._id+'" target="_blank">🗺️</a></td></tr>';});html+='</tbody></table></div>';}html+='</div>';
if(d.listaEspera.length>0){html+='<div class="section"><h2>⏳ Lista de espera <span class="badge">'+d.listaEspera.length+'</span></h2><div style="overflow-x:auto"><table><thead><tr><th>Pasajero</th><th>Tipo</th><th>Origen</th><th>Destino</th><th>Precio</th><th>Esperando desde</th><th>Notificado</th></tr></thead><tbody>';d.listaEspera.forEach(e=>{html+='<tr><td>'+fmtTel(e.userPhone)+'</td><td>'+(e.tipoVehiculoSolicitado?tipoVehBadge(e.tipoVehiculoSolicitado):"—")+'</td><td class="truncate">'+(e.origen?.nombre||"—")+'</td><td class="truncate">'+(e.destino?.nombre||"—")+'</td><td>Bs '+(e.precio||"—")+'</td><td>'+fmtHora(e.timestamp)+'</td><td>'+(e.notificado?"✅":"⏳")+'</td></tr>';});html+='</tbody></table></div></div>';}
html+='<div class="section"><h2>📜 Últimos 20 viajes</h2><div style="overflow-x:auto"><table><thead><tr><th>Fecha</th><th>Estado</th><th>Tipo</th><th>Pasajero</th><th>Chofer</th><th>Km</th><th>Precio</th><th>⭐</th><th>Mapa</th></tr></thead><tbody>';
d.viajesRecientes.forEach(v=>{const rTxt=v.ratingPasajero?"⭐"+v.ratingPasajero:"—";let clE="offline";if(v.estado==="completado")clE="libre";else if(["en_curso","en_camino","esperando_pasajero","pendiente"].includes(v.estado))clE="ocupado";html+='<tr><td>'+fmtHora(v.createdAt||v.fechaInicio)+'</td><td><span class="estado estado-'+clE+'">'+v.estado+'</span></td><td>'+tipoVehBadge(v.tipoVehiculo||"auto")+'</td><td>'+fmtTel(v.usuarioPhone)+'</td><td>'+(v.choferNombre||"—")+'</td><td>'+(v.distanciaKm||"—")+' km</td><td>Bs '+(v.precioTotal||"—")+'</td><td>'+rTxt+'</td><td><a class="maplink" href="/admin/viaje/'+v._id+'" target="_blank">🗺️</a></td></tr>';});
html+='</tbody></table></div></div>';
document.getElementById("content").innerHTML=html;}
function filtrarChoferes(){const filtro=document.getElementById("filtroChofer").value;const filas=document.querySelectorAll("#tablaChoferes tbody tr");filas.forEach(f=>{let m=true;if(filtro==="libre")m=f.classList.contains("estado-libre");else if(filtro==="ocupado")m=f.classList.contains("estado-ocupado");else if(filtro==="offline")m=f.classList.contains("estado-offline");else if(filtro==="con-gps")m=f.classList.contains("con-gps");else if(filtro==="sin-gps")m=f.classList.contains("sin-gps");else if(filtro==="pagado")m=f.classList.contains("pagado");else if(filtro==="impago")m=f.classList.contains("impago");f.style.display=m?"":"none";});}
cargar();
</script></body></html>`);
});

app.get("/", (_req, res) => { res.send("ChatGo v5.30 - RastreoPlus - Operativo ✅"); });

// ═══════════════════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

};
