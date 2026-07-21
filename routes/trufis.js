// ChatGo Bus — Mapa de simulación de trufis con sus rutas reales
//
// GET /trufis        → mapa con las RUTAS + los micros (con su número) moviéndose
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
  header{background:var(--panel);border-bottom:1px solid var(--border);padding:9px 12px;
    display:flex;align-items:center;gap:10px;flex-wrap:wrap;z-index:1000}
  .logo{font-weight:800;letter-spacing:-.02em;font-size:16px}
  .logo b{color:#f5b73d}
  .tag{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
  #buscar{margin-left:auto;background:#0c1310;border:1px solid var(--border);color:var(--text);
    border-radius:8px;padding:7px 11px;font-size:13px;font-family:inherit;width:150px;outline:none}
  #buscar:focus{border-color:#f5b73d}
  .count{font-size:12.5px;font-weight:700;color:var(--muted)}
  .count b{color:var(--text)}
  #map{flex:1}
  .leaflet-container{background:#0c1310}
  /* Ícono del micro: número siempre visible */
  .micro{display:flex;align-items:center;justify-content:center;min-width:20px;height:18px;
    padding:0 5px;border-radius:9px;border:1.5px solid #0c1310;font-size:11px;font-weight:800;
    color:#0c1310;box-shadow:0 1px 3px rgba(0,0,0,.5);white-space:nowrap;transform:translate(-50%,-50%)}
  .micro.dim{opacity:.18}
  .ruta-dim{opacity:.06 !important}
  #demo{position:absolute;left:10px;bottom:10px;z-index:1000;background:rgba(18,27,22,.92);
    border:1px solid var(--border);border-radius:10px;padding:7px 11px;font-size:11.5px;color:var(--muted);max-width:80%}
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
    <input id="buscar" placeholder="🔍 buscar línea…" autocomplete="off">
  </header>
  <div id="map"></div>
</div>
<div id="empty">🌎 Todavía no hay rutas cargadas.<br>Corré <b>node scripts/geocodificar_lineas.js</b> en el servidor y recargá.</div>
<div id="demo">🚧 <b>Simulación</b> · nombres, destinos y sindicatos reales. La ruta es el camino por calles al destino; el recorrido oficial llega con el GPS del sindicato.</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('map',{zoomControl:true,attributionControl:false,preferCanvas:true}).setView([-17.389,-66.157],13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19}).addTo(map);
  var canvas = L.canvas({padding:0.5});
  var COLOR = { micro:'#f5b73d', minibus:'#ef8a52', trufi:'#2acb8c', tren:'#5aa6ef', teleferico:'#c084fc' };
  var markers = {};    // nombre -> marker (micro)
  var lineasRuta = {}; // nombre -> polyline
  var filtro = '';

  function numDe(nombre){
    var n = nombre.replace(/^(MicroBus|MiniBus|Trufi|L[ií]nea)\\s*/i,'').trim();
    return n.length > 6 ? n.slice(0,5)+'…' : n;
  }
  function popupHtml(m){
    return '<div class="pop"><b>'+m.nombre+'</b>'
      + '<div class="r">➡️ '+m.hacia+'</div>'
      + (m.sindicato?('<div class="r">🏛️ '+m.sindicato+'</div>'):'')
      + '<div class="r">💰 Tarifa aprox. Bs 2.50</div></div>';
  }
  function iconMicro(m){
    var color = COLOR[m.tipo]||'#f5b73d';
    return L.divIcon({ className:'', iconSize:[0,0],
      html:'<div class="micro" style="background:'+color+'">'+numDe(m.nombre)+'</div>' });
  }
  function coincide(nombre){ return !filtro || nombre.toLowerCase().indexOf(filtro) !== -1; }

  // 1) Dibujar RUTAS una sola vez
  fetch('/trufis/rutas').then(function(r){return r.json();}).then(function(d){
    var lineas = d.lineas||[];
    document.getElementById('empty').style.display = lineas.length ? 'none' : 'flex';
    lineas.forEach(function(l){
      var color = COLOR[l.tipo]||'#f5b73d';
      lineasRuta[l.nombre] = L.polyline(l.ruta,{renderer:canvas,color:color,weight:2,opacity:0.35})
        .addTo(map).bindPopup(popupHtml(l));
    });
  }).catch(function(e){console.error(e);});

  // 2) Mover MICROS cada 2s
  function render(data){
    var micros = data.micros||[];
    document.getElementById('count').innerHTML = '<b>'+micros.length+'</b> micros';
    var vistos={};
    micros.forEach(function(m){
      var k=m.nombre; vistos[k]=true;
      if(markers[k]){ markers[k].setLatLng([m.lat,m.lng]); }
      else{
        markers[k]=L.marker([m.lat,m.lng],{icon:iconMicro(m)}).addTo(map).bindPopup(popupHtml(m));
      }
      aplicarFiltroA(k);
    });
    Object.keys(markers).forEach(function(k){ if(!vistos[k]){ map.removeLayer(markers[k]); delete markers[k]; }});
  }
  function aplicarFiltroA(k){
    var el = markers[k] && markers[k].getElement();
    if(el){ var d=el.querySelector('.micro'); if(d) d.classList.toggle('dim', !coincide(k)); }
    if(lineasRuta[k]){ var p=lineasRuta[k].getElement && lineasRuta[k].getElement();
      if(p){ p.classList.toggle('ruta-dim', !coincide(k)); } }
  }
  function aplicarFiltro(){
    Object.keys(markers).forEach(aplicarFiltroA);
    // resaltar rutas por opacidad (canvas: se re-dibuja subiendo opacidad de las que coinciden)
    Object.keys(lineasRuta).forEach(function(k){
      lineasRuta[k].setStyle({ opacity: (!filtro || coincide(k)) ? 0.35 : 0.05, weight: coincide(k)&&filtro?3.5:2 });
    });
  }
  document.getElementById('buscar').addEventListener('input', function(e){
    filtro = (e.target.value||'').trim().toLowerCase();
    aplicarFiltro();
  });

  function tick(){ fetch('/trufis/pos').then(function(r){return r.json();}).then(render).catch(function(e){console.error(e);}); }
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
