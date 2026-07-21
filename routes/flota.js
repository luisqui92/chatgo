// ChatGo — Mapa de flota en vivo
//
// GET /flota        → mapa con TODOS los choferes en su ubicación real + estado
// GET /flota/datos  → JSON [{ nombre, estado, lat, lng, minutos, ... }]
//
// Las posiciones vienen del snapshot de Traccar (services/traccar). El estado
// combina la base (libre/ocupado/offline) con la frescura del GPS: si un chofer
// no reporta hace >15 min se marca "sin_gps" aunque la base diga que está libre.

const { obtenerFlotaEnVivo } = require("../services/traccar");
const { log } = require("../config");

module.exports = function (app) {

  app.get("/flota/datos", async (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const flota = await obtenerFlotaEnVivo();
      res.json({ choferes: flota, total: flota.length, timestamp: Date.now() });
    } catch (e) {
      log.error("[FLOTA]", e.message);
      res.status(500).json({ error: "No se pudo obtener la flota." });
    }
  });

  app.get("/flota", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(PAGINA);
  });
};

const PAGINA = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>ChatGo — Flota en vivo</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  :root{
    --bg:#0c1310; --panel:#121b16; --border:#25342b; --text:#e7efe9; --muted:#93a49a;
    --libre:#2acb8c; --ocupado:#e8b04a; --singps:#8a978f; --offline:#5a6b62;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font-family:var(--sans);background:var(--bg);color:var(--text)}
  #app{display:flex;flex-direction:column;height:100%}
  header{background:var(--panel);border-bottom:1px solid var(--border);padding:10px 14px;
    display:flex;align-items:center;gap:12px;flex-wrap:wrap;z-index:1000}
  .logo{font-weight:800;letter-spacing:-.02em;font-size:17px}
  .logo b{color:var(--libre)}
  .tag{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .counts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
  .pill{font-size:12.5px;font-weight:700;padding:4px 10px;border-radius:999px;
    display:flex;align-items:center;gap:6px;background:#0c1310;border:1px solid var(--border)}
  .dot{width:9px;height:9px;border-radius:50%;flex:none}
  .d-libre{background:var(--libre)} .d-ocupado{background:var(--ocupado)}
  .d-singps{background:var(--singps)} .d-offline{background:var(--offline)}
  .num{font-variant-numeric:tabular-nums}
  #map{flex:1}
  .leaflet-container{background:#0c1310}
  .marker{position:relative;width:34px;height:34px}
  .marker .ring{position:absolute;inset:0;border-radius:50%;opacity:.22}
  .marker .core{position:absolute;inset:8px;border-radius:50%;border:2px solid #0c1310;
    display:flex;align-items:center;justify-content:center;font-size:11px}
  .leaflet-popup-content-wrapper{background:var(--panel);color:var(--text);border-radius:12px}
  .leaflet-popup-tip{background:var(--panel)}
  .pop b{font-size:14px} .pop .row{font-size:12.5px;color:var(--muted);margin-top:3px}
  .pop .est{font-weight:700}
  #stale{position:absolute;left:12px;bottom:12px;z-index:1000;background:var(--panel);
    border:1px solid var(--border);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--muted);
    max-width:70%}
  #stamp{font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="logo">Chat<b>Go</b></span>
    <span class="tag">Flota en vivo</span>
    <div class="counts" id="counts"></div>
  </header>
  <div id="map"></div>
</div>
<div id="stale">Actualizado <span id="stamp">—</span> · se refresca cada 5s</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var COCHA = [-17.3895, -66.1568];
  var map = L.map('map', { zoomControl: true, attributionControl: false }).setView(COCHA, 13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);

  var COLORS = { libre:'#2acb8c', ocupado:'#e8b04a', sin_gps:'#8a978f', offline:'#5a6b62' };
  var EMOJI = { auto:'🚗', moto:'🏍️', van:'🚐', todo:'🚕', ambulancia:'🚑' };
  var markers = {};       // key -> L.marker
  var primeraVez = true;

  function iconFor(c){
    var color = COLORS[c.estado] || COLORS.offline;
    var emoji = EMOJI[c.tipoVehiculo] || '🚗';
    var html = '<div class="marker">'
      + '<div class="ring" style="background:'+color+'"></div>'
      + '<div class="core" style="background:'+color+'">'+emoji+'</div>'
      + '</div>';
    return L.divIcon({ html: html, className: '', iconSize: [34,34], iconAnchor: [17,17] });
  }

  function labelEstado(e){
    return e==='libre'?'Libre':e==='ocupado'?'Ocupado':e==='sin_gps'?'GPS desconectado':'Desconectado';
  }

  function popupHtml(c){
    var gps = c.minutos<=1 ? 'GPS al día' : ('GPS de hace '+c.minutos+' min');
    return '<div class="pop"><b>'+c.nombre+'</b>'
      + '<div class="row est" style="color:'+(COLORS[c.estado]||COLORS.offline)+'">'+labelEstado(c.estado)+'</div>'
      + '<div class="row">'+(c.placa?('Placa '+c.placa+' · '):'')+(c.tipoVehiculo||'')+'</div>'
      + '<div class="row">'+gps+' · '+c.velocidadKmh+' km/h</div>'
      + '<div class="row">Tel '+c.phoneMask+'</div></div>';
  }

  function render(data){
    var counts = { libre:0, ocupado:0, sin_gps:0, offline:0 };
    var vistos = {};
    var bounds = [];
    (data.choferes||[]).forEach(function(c){
      var key = c.phoneMask + c.nombre;
      vistos[key] = true;
      counts[c.estado] = (counts[c.estado]||0) + 1;
      var pos = [c.lat, c.lng];
      bounds.push(pos);
      if (markers[key]) {
        markers[key].setLatLng(pos);
        markers[key].setIcon(iconFor(c));
        markers[key].getPopup().setContent(popupHtml(c));
      } else {
        markers[key] = L.marker(pos, { icon: iconFor(c) }).addTo(map).bindPopup(popupHtml(c));
      }
    });
    // Quitar choferes que ya no están
    Object.keys(markers).forEach(function(k){
      if (!vistos[k]) { map.removeLayer(markers[k]); delete markers[k]; }
    });
    // Contadores
    document.getElementById('counts').innerHTML =
        pill('libre', counts.libre) + pill('ocupado', counts.ocupado)
      + pill('singps', counts.sin_gps) + pill('offline', counts.offline);
    document.getElementById('stamp').textContent = new Date().toLocaleTimeString('es-BO');
    if (primeraVez && bounds.length) { map.fitBounds(bounds, { padding:[50,50], maxZoom:15 }); primeraVez = false; }
  }

  function pill(cls, n){
    var lbl = cls==='libre'?'Libres':cls==='ocupado'?'Ocupados':cls==='singps'?'Sin GPS':'Offline';
    return '<span class="pill"><span class="dot d-'+cls+'"></span>'+lbl+' <span class="num">'+(n||0)+'</span></span>';
  }

  function tick(){
    fetch('/flota/datos').then(function(r){return r.json();})
      .then(render).catch(function(e){ console.error(e); });
  }
  tick();
  setInterval(tick, 5000);
</script>
</body>
</html>`;
