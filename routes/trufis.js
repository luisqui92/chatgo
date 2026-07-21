// ChatGo Bus — Mapa de simulación de trufis con sus rutas reales
//
// GET /trufis        → mapa con las RUTAS dibujadas + los micros moviéndose
// GET /trufis/rutas  → JSON [{ nombre, tipo, hacia, sindicato, ruta:[[lat,lng]] }]
// GET /trufis/pos    → JSON [{ nombre, tipo, hacia, sindicato, lat, lng }]
//
// SIMULACIÓN: nombres y destinos reales (141 líneas de Cochabamba); la ruta es
// el camino por calles del centro al destino. El recorrido oficial exacto y la
// posición en vivo llegan cuando el sindicato suma su GPS.

const { posicionesAhora, rutas, total } = require("../services/simtrufis");

module.exports = function (app) {

  app.get("/trufis/rutas", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ lineas: rutas(), total: total() });
  });

  app.get("/trufis/pos", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ micros: posicionesAhora(Date.now()), total: total() });
  });

  app.get("/trufis", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(PAGINA);
  });
};

const PAGINA = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>ChatGo Bus — Trufis en vivo (simulación)</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  :root{ --bg:#0c1310; --panel:#121b16; --border:#25342b; --text:#e7efe9; --muted:#93a49a;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font-family:var(--sans);background:var(--bg);color:var(--text)}
  #app{display:flex;flex-direction:column;height:100%}
  header{background:var(--panel);border-bottom:1px solid var(--border);padding:10px 14px;
    display:flex;align-items:center;gap:12px;flex-wrap:wrap;z-index:1000}
  .logo{font-weight:800;letter-spacing:-.02em;font-size:17px}
  .logo b{color:#f5b73d}
  .tag{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .count{margin-left:auto;font-size:13px;font-weight:700;color:var(--muted)}
  .count b{color:var(--text)}
  #map{flex:1}
  .leaflet-container{background:#0c1310}
  #demo{position:absolute;left:12px;bottom:12px;z-index:1000;background:rgba(18,27,22,.92);
    border:1px solid var(--border);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--muted);max-width:78%}
  #demo b{color:#f5b73d}
  #empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
    text-align:center;color:var(--muted);font-size:14px;padding:24px;z-index:1001;background:var(--bg)}
  #empty b{color:#f5b73d}
  .leaflet-popup-content-wrapper{background:var(--panel);color:var(--text);border-radius:12px}
  .leaflet-popup-tip{background:var(--panel)}
  .pop b{font-size:14px}.pop .r{font-size:12.5px;color:var(--muted);margin-top:3px}
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="logo">ChatGo <b>Bus</b></span>
    <span class="tag">Trufis en vivo</span>
    <span class="count" id="count">—</span>
  </header>
  <div id="map"></div>
</div>
<div id="empty">🌎 Todavía no hay rutas cargadas.<br>Corré <b>node scripts/geocodificar_lineas.js</b> en el servidor y recargá.</div>
<div id="demo">🚧 <b>Simulación</b> · nombres, destinos y sindicatos reales (141 líneas). La ruta es el camino por calles al destino; el recorrido oficial y la posición real llegan con el GPS del sindicato.</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('map',{zoomControl:true,attributionControl:false,preferCanvas:true}).setView([-17.389,-66.157],13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19}).addTo(map);
  var canvas = L.canvas({padding:0.5});
  var COLOR = { micro:'#f5b73d', minibus:'#ef8a52', trufi:'#2acb8c', tren:'#5aa6ef', teleferico:'#c084fc' };
  var markers = {};

  function popupHtml(m){
    return '<div class="pop"><b>'+m.nombre+'</b>'
      + '<div class="r">➡️ '+m.hacia+'</div>'
      + (m.sindicato?('<div class="r">🏛️ '+m.sindicato+'</div>'):'')
      + '<div class="r">💰 Tarifa aprox. Bs 2.50</div></div>';
  }

  // 1) Dibujar las RUTAS una sola vez
  fetch('/trufis/rutas').then(function(r){return r.json();}).then(function(d){
    var lineas = d.lineas||[];
    document.getElementById('empty').style.display = lineas.length ? 'none' : 'flex';
    lineas.forEach(function(l){
      var color = COLOR[l.tipo]||'#f5b73d';
      L.polyline(l.ruta,{renderer:canvas,color:color,weight:2,opacity:0.35})
        .addTo(map).bindPopup(popupHtml(l));
    });
  }).catch(function(e){console.error(e);});

  // 2) Mover los MICROS cada 2s
  function render(data){
    var micros = data.micros||[];
    document.getElementById('count').innerHTML = '<b>'+micros.length+'</b> micros';
    var vistos={};
    micros.forEach(function(m){
      var k=m.nombre; vistos[k]=true;
      var color=COLOR[m.tipo]||'#f5b73d';
      if(markers[k]){ markers[k].setLatLng([m.lat,m.lng]); }
      else{
        markers[k]=L.circleMarker([m.lat,m.lng],{renderer:canvas,radius:5,
          color:'#0c1310',weight:1.5,fillColor:color,fillOpacity:1})
          .addTo(map).bindPopup(popupHtml(m));
      }
    });
    Object.keys(markers).forEach(function(k){ if(!vistos[k]){ map.removeLayer(markers[k]); delete markers[k]; }});
  }
  function tick(){ fetch('/trufis/pos').then(function(r){return r.json();}).then(render).catch(function(e){console.error(e);}); }
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
