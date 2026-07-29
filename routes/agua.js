// ChatGo — ChatGo Agua: panel de despacho y control de rutas 💧
//
//   GET  /admin/agua                    → panel HTML (mapa + pedidos + ruta)
//   GET  /admin/agua/pedidos            → pedidos pendientes/del día
//   POST /admin/agua/pedidos/:id/estado → cambiar estado (en_ruta|entregado|cancelado)
//   GET  /admin/agua/ruta               → ruta optimizada del día + link a Google Maps
//
// Protegido con AGUA_ADMIN_TOKEN (cae a AUXILIO_ADMIN_TOKEN si no está seteado).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CONFIG, log } = require("../config");
const { PedidoAgua } = require("../db/models");
const { distanciaEntrePuntos, calcularRutasConTrafico } = require("../services/google");

const ESTADOS = ["nuevo", "en_ruta", "entregado", "cancelado"];

module.exports = function (app) {
  function auth(req, res) {
    const token = String(req.query.token || "");
    const esperado = CONFIG.AGUA_ADMIN_TOKEN || "";
    let ok = false;
    if (esperado && token.length === esperado.length) {
      try { ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado)); } catch (_) {}
    }
    if (!ok) { res.status(401).json({ error: "No autorizado" }); return false; }
    return true;
  }

  // Pedidos pendientes (nuevo / en_ruta) + entregados de hoy
  app.get("/admin/agua/pedidos", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
      const pedidos = await PedidoAgua.findMany({
        where: { OR: [{ estado: { in: ["nuevo", "en_ruta"] } }, { createdAt: { gte: inicioDia } }] },
        orderBy: { createdAt: "desc" }, take: 200,
      });
      res.json({ pedidos, fabrica: { lat: CONFIG.AGUA_FABRICA_LAT, lng: CONFIG.AGUA_FABRICA_LNG, nombre: CONFIG.AGUA_FABRICA_NOMBRE } });
    } catch (e) { log.error("[AGUA_PEDIDOS]", e.message); res.status(500).json({ error: "Error al listar." }); }
  });

  app.post("/admin/agua/pedidos/:id/estado", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const estado = req.body && req.body.estado;
      if (!ESTADOS.includes(estado)) return res.status(400).json({ error: "Estado inválido." });
      await PedidoAgua.update({ where: { id: req.params.id }, data: { estado } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "Error al actualizar." }); }
  });

  // Ruta optimizada (vecino más cercano desde la fábrica) + link a Google Maps
  app.get("/admin/agua/ruta", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const base = { lat: CONFIG.AGUA_FABRICA_LAT, lng: CONFIG.AGUA_FABRICA_LNG };
      const pend = await PedidoAgua.findMany({ where: { estado: { in: ["nuevo", "en_ruta"] }, lat: { not: null } }, take: 25 });
      const conUbi = pend.filter(p => typeof p.lat === "number");
      if (!conUbi.length) return res.json({ base, orden: [], puntos: [], totalKm: 0 });

      // Greedy: siempre al pedido más cercano al punto actual
      const rest = conUbi.slice(); const orden = []; let cur = base; let totalKm = 0;
      while (rest.length) {
        let bi = 0, bd = Infinity;
        rest.forEach((p, i) => { const d = distanciaEntrePuntos(cur.lat, cur.lng, p.lat, p.lng); if (d < bd) { bd = d; bi = i; } });
        totalKm += bd; cur = rest[bi]; orden.push(rest.splice(bi, 1)[0]);
      }
      // Trazado por calles a través de las paradas (para la navegación ChatGo)
      let puntos = [];
      try {
        const dest = orden[orden.length - 1];
        const medias = orden.slice(0, -1).map(p => ({ lat: p.lat, lng: p.lng }));
        const rutas = await calcularRutasConTrafico(base, { lat: dest.lat, lng: dest.lng }, medias);
        puntos = (rutas[0] && rutas[0].puntos) || [];
      } catch (e) { log.warn("[AGUA_RUTA] trazado:", e.message); }

      res.json({
        base,
        orden: orden.map((p, i) => ({ n: i + 1, id: p.id, direccion: p.direccion, cantidad: p.cantidad, productoNombre: p.productoNombre, telefono: p.telefono, lat: p.lat, lng: p.lng })),
        puntos, totalKm: Math.round(totalKm * 10) / 10,
      });
    } catch (e) { log.error("[AGUA_RUTA]", e.message); res.status(500).json({ error: "Error al calcular la ruta." }); }
  });

  app.get("/admin/agua", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(PANEL);
  });

  // Navegación PROPIA de ChatGo para la ruta de reparto (no abre Google Maps)
  app.get("/agua/nav", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(NAV.replace(/__GMAPS_KEY__/g, CONFIG.GOOGLE_MAPS_KEY || ""));
  });
};

const PANEL = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0c1310"><link rel="icon" href="/logo.png">
<title>ChatGo Agua — Despacho</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--verde:#1D9E75;--verde2:#34d399;--azul:#38bdf8;--fondo:#0c1310;--card:#131c18;--borde:#1e2b24;--txt:#e7efe9;--gris:#7f948b;--amar:#fbbf24;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--fondo);color:var(--txt);min-height:100vh;padding-bottom:40px;}
  header{position:sticky;top:0;z-index:10;background:#0c1310ee;backdrop-filter:blur(6px);border-bottom:1px solid var(--borde);padding:12px 16px;display:flex;align-items:center;gap:10px;}
  header img{width:30px;height:30px;border-radius:8px;} .h-t{font-size:15px;font-weight:800;} .h-t span{color:var(--azul);}
  .wrap{max-width:1000px;margin:0 auto;padding:14px 16px;}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;}
  .kpi{background:var(--card);border:1px solid var(--borde);border-radius:12px;padding:11px;text-align:center;}
  .kpi .n{font-size:21px;font-weight:800;color:var(--azul);} .kpi .l{font-size:9.5px;color:var(--gris);text-transform:uppercase;margin-top:4px;}
  #mapa{height:300px;border-radius:12px;border:1px solid var(--borde);overflow:hidden;margin-bottom:12px;background:#0a0f0c;}
  .leaflet-tile{filter:brightness(.85) saturate(.85);}
  .num{width:26px;height:26px;border-radius:50%;background:var(--azul);color:#04140d;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;border:2px solid #04140d;}
  .fab{font-size:20px;}
  .barra{display:flex;gap:8px;margin-bottom:10px;}
  .btn{background:var(--verde);color:#04140d;border:none;border-radius:10px;padding:11px 14px;font-weight:800;cursor:pointer;font-size:14px;flex:1;}
  .btn.azul{background:var(--azul);} .btn.sec{background:transparent;border:1px solid var(--borde);color:var(--txt);}
  .ped{background:var(--card);border:1px solid var(--borde);border-radius:12px;padding:12px 14px;margin-bottom:9px;}
  .ped .top{display:flex;justify-content:space-between;gap:8px;}
  .ped .nom{font-weight:700;font-size:14px;} .ped .sub{font-size:12px;color:var(--gris);margin-top:4px;line-height:1.5;}
  .est{font-size:10px;padding:2px 8px;border-radius:6px;font-weight:700;}
  .est.nuevo{background:#0e2a4a;color:var(--azul);} .est.en_ruta{background:#2a2a0a;color:var(--amar);} .est.entregado{background:#0e3a2a;color:var(--verde2);} .est.cancelado{background:#3a0a0a;color:#f87171;}
  .acc{display:flex;gap:8px;margin-top:10px;} .acc button{flex:1;border-radius:9px;padding:8px;font-weight:700;font-size:12px;cursor:pointer;border:1px solid var(--borde);background:transparent;color:var(--txt);}
  #rutaBox{background:var(--card);border:1px solid var(--azul);border-radius:12px;padding:12px 14px;margin-bottom:12px;display:none;}
  #rutaBox a{display:block;text-align:center;background:var(--azul);color:#04140d;border-radius:10px;padding:11px;font-weight:800;text-decoration:none;margin-top:10px;}
  .ro{font-size:13px;padding:5px 0;border-bottom:1px solid #0e1512;}
</style></head><body>
<header><img src="/logo.png"><div class="h-t">ChatGo <span>Agua · Despacho</span></div></header>
<div class="wrap">
  <div class="kpis" id="kpis"></div>
  <div class="barra">
    <button class="btn azul" onclick="optimizar()">🗺️ Optimizar ruta del día</button>
    <button class="btn sec" onclick="cargar()">↻ Actualizar</button>
  </div>
  <div id="rutaBox"></div>
  <div id="mapa"></div>
  <div id="pedidos"></div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||"";
let PEDIDOS=[], FAB=null, map, capa;
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(ruta,opts={}){const sep=ruta.includes("?")?"&":"?";const r=await fetch(ruta+sep+"token="+encodeURIComponent(TOKEN),{method:opts.method||(opts.body?"POST":"GET"),headers:{"Content-Type":"application/json"},body:opts.body?JSON.stringify(opts.body):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Error");return d;}
function initMapa(){map=L.map("mapa",{zoomControl:true,attributionControl:false}).setView([-17.3895,-66.1568],12);L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:19}).addTo(map);capa=L.layerGroup().addTo(map);}
async function cargar(){
  try{
    const d=await api("/admin/agua/pedidos"); PEDIDOS=d.pedidos||[]; FAB=d.fabrica;
    const pend=PEDIDOS.filter(p=>p.estado==="nuevo"||p.estado==="en_ruta");
    const entreg=PEDIDOS.filter(p=>p.estado==="entregado");
    document.getElementById("kpis").innerHTML=kpi(pend.length,"Pendientes")+kpi(entreg.length,"Entregados hoy")+kpi(PEDIDOS.reduce((s,p)=>s+(p.total||0),0),"Bs del día");
    pintarMapa(); pintarPedidos();
  }catch(e){ document.getElementById("kpis").innerHTML='<div class="kpi" style="grid-column:1/-1"><div class="n" style="color:#f87171;font-size:14px">'+esc(e.message)+'</div><div class="l">Revisá el token</div></div>'; }
}
function kpi(n,l){return '<div class="kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>';}
function pinNum(n){return L.divIcon({className:"",html:'<div class="num">'+n+'</div>',iconSize:[26,26],iconAnchor:[13,13]});}
function pintarMapa(){
  if(!map)return; capa.clearLayers(); const pts=[];
  if(FAB&&typeof FAB.lat==="number"){ L.marker([FAB.lat,FAB.lng],{icon:L.divIcon({className:"",html:'<div class="fab">🏭</div>',iconSize:[26,26],iconAnchor:[13,13]})}).bindPopup("🏭 "+esc(FAB.nombre)).addTo(capa); pts.push([FAB.lat,FAB.lng]); }
  PEDIDOS.filter(p=>p.estado==="nuevo"||p.estado==="en_ruta").forEach((p,i)=>{ if(typeof p.lat!=="number")return; L.marker([p.lat,p.lng],{icon:pinNum(i+1)}).bindPopup('<b>'+p.cantidad+'× '+esc(p.productoNombre)+'</b><br>'+esc(p.direccion||"")+'<br>📞 '+esc(p.telefono)).addTo(capa); pts.push([p.lat,p.lng]); });
  if(pts.length) map.fitBounds(pts,{padding:[30,30],maxZoom:14});
}
function pintarPedidos(){
  const pend=PEDIDOS.filter(p=>p.estado==="nuevo"||p.estado==="en_ruta");
  if(!pend.length){document.getElementById("pedidos").innerHTML='<div class="ped" style="color:var(--gris)">No hay pedidos pendientes. Cuando alguien pida agua por WhatsApp, aparece acá.</div>';return;}
  document.getElementById("pedidos").innerHTML=pend.map(p=>
    '<div class="ped"><div class="top"><div class="nom">'+p.cantidad+'× '+esc(p.productoNombre)+' · Bs '+(p.total||0)+'</div><span class="est '+p.estado+'">'+p.estado.replace("_"," ")+'</span></div>'+
    '<div class="sub">📍 '+esc(p.direccion||"—")+'<br>📞 '+esc(p.telefono)+' · 💳 '+esc(p.metodoPago||"—")+'</div>'+
    '<div class="acc">'+(p.estado==="nuevo"?'<button onclick="estado(\\''+p.id+'\\',\\'en_ruta\\')">🚚 En ruta</button>':'')+
    '<button onclick="estado(\\''+p.id+'\\',\\'entregado\\')" style="border-color:var(--verde);color:var(--verde2)">✅ Entregado</button>'+
    '<button onclick="estado(\\''+p.id+'\\',\\'cancelado\\')" style="border-color:#f87171;color:#f87171">✕</button></div></div>'
  ).join("");
}
async function estado(id,e){ try{ await api("/admin/agua/pedidos/"+id+"/estado",{method:"POST",body:{estado:e}}); cargar(); }catch(err){alert(err.message);} }
async function optimizar(){
  try{
    const d=await api("/admin/agua/ruta");
    const box=document.getElementById("rutaBox");
    if(!d.orden||!d.orden.length){ box.style.display="block"; box.innerHTML='<b>Sin pedidos con ubicación para rutear.</b>'; return; }
    box.style.display="block";
    box.innerHTML='<b>🗺️ Ruta óptima ('+d.orden.length+' paradas · ~'+d.totalKm+' km)</b>'+
      d.orden.map(o=>'<div class="ro"><b>'+o.n+'.</b> '+o.cantidad+'× '+esc(o.productoNombre)+' — '+esc(o.direccion||"")+'</div>').join("")+
      '<a href="/agua/nav?token='+encodeURIComponent(TOKEN)+'" target="_blank">🧭 Abrir navegación ChatGo</a>';
    window.scrollTo({top:0,behavior:"smooth"});
  }catch(e){ alert(e.message); }
}
initMapa(); cargar(); setInterval(cargar,15000);
</script></body></html>`;

// ── Navegación ChatGo para la ruta de reparto (mapa propio, no Google Maps) ──
const NAV = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#0c1310"><link rel="icon" href="/logo.png">
<title>ChatGo — Ruta de reparto</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0c1310;height:100dvh;display:flex;flex-direction:column;overflow:hidden;color:#e7efe9;}
  #top{background:#0c1310;padding:12px 15px;border-bottom:2px solid #1D9E75;display:flex;align-items:center;gap:12px;flex-shrink:0;}
  #top img{width:30px;height:30px;border-radius:7px;}
  #top .t{font-size:13px;font-weight:800;color:#34d399;}
  #top .p{font-size:14px;font-weight:700;margin-top:2px;}
  #top .p small{color:#7f948b;font-weight:600;}
  #map{flex:1;position:relative;background:#0a0f0c;}
  #load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#475569;font-size:13px;}
  #foot{background:#0c1310;border-top:1px solid #1e2b24;padding:10px 14px;padding-bottom:max(10px,env(safe-area-inset-bottom));flex-shrink:0;display:flex;gap:10px;}
  #foot button{flex:1;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:14px;cursor:pointer;}
  #btn-centrar{background:#0f3d2e;color:#34d399;border:1px solid #14532d!important;}
  #btn-cerrar{background:#1e2b24;color:#e7efe9;}
</style></head>
<body>
<div id="top"><img src="/logo.png"><div><div class="t">ChatGo · Ruta de reparto 💧</div><div class="p" id="prox">Cargando ruta…</div></div></div>
<div id="map"><div id="load">Cargando el mapa…</div></div>
<div id="foot"><button id="btn-centrar" onclick="centrar()">🧭 Centrar</button><button id="btn-cerrar" onclick="history.back()">✕ Cerrar</button></div>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||"";
let map,driverMk,seguir=true,RUTA=null,wakeLock=null;
function dist(a,b){const R=6371000,dLa=(b[0]-a[0])*Math.PI/180,dLn=(b[1]-a[1])*Math.PI/180,x=Math.sin(dLa/2)**2+Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLn/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
function svgNum(n,color){const s='<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38"><path d="M15 0C7 0 0 6 0 15c0 10 15 23 15 23s15-13 15-23C30 6 23 0 15 0z" fill="'+color+'" stroke="#04140d" stroke-width="1.5"/><text x="15" y="20" font-size="14" font-weight="bold" fill="#04140d" text-anchor="middle">'+n+'</text></svg>';return{url:"data:image/svg+xml;charset=UTF-8,"+encodeURIComponent(s),scaledSize:new google.maps.Size(30,38),anchor:new google.maps.Point(15,38)};}
async function initNav(){
  map=new google.maps.Map(document.getElementById("map"),{center:{lat:-17.3895,lng:-66.1568},zoom:13,mapTypeControl:false,streetViewControl:false,fullscreenControl:false,gestureHandling:"greedy",styles:[{featureType:"poi",stylers:[{visibility:"off"}]},{featureType:"transit",stylers:[{visibility:"off"}]}]});
  const l=document.getElementById("load"); if(l)l.remove();
  try{
    const r=await fetch("/admin/agua/ruta?token="+encodeURIComponent(TOKEN)); RUTA=await r.json();
  }catch(e){ document.getElementById("prox").textContent="No se pudo cargar la ruta"; return; }
  if(!RUTA.orden||!RUTA.orden.length){ document.getElementById("prox").innerHTML="Sin paradas pendientes"; return; }
  // Fábrica
  if(RUTA.base) new google.maps.Marker({position:RUTA.base,map,label:{text:"🏭",fontSize:"20px"},title:"Fábrica"});
  // Paradas numeradas
  RUTA.orden.forEach(o=>{ new google.maps.Marker({position:{lat:o.lat,lng:o.lng},map,icon:svgNum(o.n,"#34d399"),title:o.direccion||""}).addListener("click",()=>{}); });
  // Trazado por calles (verde con contorno)
  if(RUTA.puntos&&RUTA.puntos.length){
    new google.maps.Polyline({map,path:RUTA.puntos,strokeColor:"#0b3b2c",strokeWeight:10,strokeOpacity:.95,zIndex:2});
    new google.maps.Polyline({map,path:RUTA.puntos,strokeColor:"#1D9E75",strokeWeight:6,strokeOpacity:1,zIndex:3});
    const b=new google.maps.LatLngBounds(); RUTA.puntos.forEach(p=>b.extend(p)); map.fitBounds(b,40);
  }
  document.getElementById("prox").innerHTML="Parada 1: <small>"+(RUTA.orden[0].direccion||"—")+"</small>";
  seguimiento(); pedirWake();
}
function seguimiento(){
  if(!navigator.geolocation) return;
  navigator.geolocation.watchPosition(pos=>{
    const p={lat:pos.coords.latitude,lng:pos.coords.longitude};
    if(!driverMk){ driverMk=new google.maps.Marker({position:p,map,zIndex:9,icon:{url:"/logo.png",scaledSize:new google.maps.Size(40,40),anchor:new google.maps.Point(20,20)}}); }
    else driverMk.setPosition(p);
    if(seguir) map.panTo(p);
    // Próxima parada = la más cercana al repartidor
    if(RUTA&&RUTA.orden.length){ let bi=0,bd=1e12; RUTA.orden.forEach((o,i)=>{const d=dist([p.lat,p.lng],[o.lat,o.lng]); if(d<bd){bd=d;bi=i;}}); const o=RUTA.orden[bi]; document.getElementById("prox").innerHTML="Próxima (parada "+o.n+"): <small>"+(o.direccion||"—")+" · "+(bd>=1000?(bd/1000).toFixed(1)+" km":Math.round(bd)+" m")+"</small>"; }
  },()=>{},{enableHighAccuracy:true,maximumAge:0,timeout:20000});
}
function centrar(){ seguir=true; if(driverMk){ map.panTo(driverMk.getPosition()); map.setZoom(16);} }
async function pedirWake(){ try{ if("wakeLock" in navigator) wakeLock=await navigator.wakeLock.request("screen"); }catch(e){} }
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible") pedirWake(); });
</script>
<script async defer src="https://maps.googleapis.com/maps/api/js?key=__GMAPS_KEY__&callback=initNav&language=es&v=weekly"></script>
</body></html>`;
