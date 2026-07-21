// ChatGo Bus — Mapa de trufis con sus rutas REALES (140 líneas de Cochabamba)
//
// GET /trufis        → mapa con las RUTAS reales + micros + lista de líneas
// GET /trufis/rutas  → JSON [{ id, nombre, badge, tipo, hacia, sindicato, ruta:[[lat,lng]] }]
// GET /trufis/pos    → JSON [{ id, nombre, badge, tipo, hacia, sindicato, lat, lng }]

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
<title>ChatGo Bus — Trufis en vivo</title>
<link rel="icon" href="/logo.png">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  :root{ --bg:#0c1310; --panel:#121b16; --border:#25342b; --text:#e7efe9; --muted:#93a49a;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font-family:var(--sans);background:var(--bg);color:var(--text);overflow:hidden}
  #app{display:flex;flex-direction:column;height:100%}
  header{background:var(--panel);border-bottom:1px solid var(--border);padding:8px 12px;
    display:flex;align-items:center;gap:10px;z-index:1100}
  header img{width:26px;height:26px;border-radius:6px}
  .logo{font-weight:800;letter-spacing:-.02em;font-size:16px}
  .logo b{color:#f5b73d}
  .count{margin-left:auto;font-size:12.5px;font-weight:700;color:var(--muted)}
  .count b{color:var(--text)}
  #btn-lista{background:#0c1310;border:1px solid var(--border);color:var(--text);border-radius:8px;
    padding:7px 12px;font-size:13px;font-weight:700;cursor:pointer}
  #btn-lista:active{border-color:#f5b73d}
  #map{flex:1;position:relative}
  .leaflet-container{background:#0c1310}
  /* micro: logo ChatGo + número */
  .micro{position:relative;width:26px;height:26px;transform:translate(-50%,-50%)}
  .micro img{width:26px;height:26px;border-radius:50%;border:2px solid #0c1310;background:#0c1310;display:block}
  .micro .n{position:absolute;bottom:-5px;right:-6px;min-width:16px;height:14px;padding:0 3px;border-radius:7px;
    border:1px solid #0c1310;font-size:9px;font-weight:800;color:#0c1310;display:flex;align-items:center;justify-content:center;white-space:nowrap}
  /* panel lista */
  #panel{position:absolute;top:0;left:0;bottom:0;width:290px;max-width:82%;background:var(--panel);
    border-right:1px solid var(--border);z-index:1200;display:flex;flex-direction:column;
    transform:translateX(-102%);transition:transform .22s ease;box-shadow:6px 0 24px rgba(0,0,0,.4)}
  #panel.open{transform:translateX(0)}
  .ptop{padding:12px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center}
  .ptop b{font-size:14px}
  #cerrar{margin-left:auto;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
  #buscar{width:100%;margin:10px 12px 0;background:#0c1310;border:1px solid var(--border);color:var(--text);
    border-radius:8px;padding:8px 11px;font-size:13px;font-family:inherit;outline:none;width:calc(100% - 24px)}
  #buscar:focus{border-color:#f5b73d}
  #lista{flex:1;overflow-y:auto;padding:8px}
  .item{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13px}
  .item:hover{background:#0c1310}
  .item.sel{background:rgba(245,183,61,.14)}
  .dot{width:10px;height:10px;border-radius:50%;flex:none}
  .item .nm{font-weight:700}
  .item .hc{color:var(--muted);font-size:11.5px}
  .todas{color:#f5b73d;font-weight:800}
  #overlay{position:absolute;inset:0;background:rgba(0,0,0,.4);z-index:1150;display:none}
  #overlay.show{display:block}
  #demo{position:absolute;left:10px;bottom:10px;z-index:900;background:rgba(18,27,22,.92);
    border:1px solid var(--border);border-radius:10px;padding:7px 11px;font-size:11.5px;color:var(--muted);max-width:74%}
  #demo b{color:#f5b73d}
  .leaflet-popup-content-wrapper{background:var(--panel);color:var(--text);border-radius:12px}
  .leaflet-popup-tip{background:var(--panel)}
  .pop b{font-size:14px}.pop .r{font-size:12.5px;color:var(--muted);margin-top:3px}
</style>
</head>
<body>
<div id="app">
  <header>
    <img src="/logo.png" alt="ChatGo">
    <span class="logo">Chat<b>Go</b> Bus</span>
    <span class="count" id="count">—</span>
    <button id="btn-lista" onclick="abrirPanel()">☰ Líneas</button>
  </header>
  <div id="map">
    <div id="overlay" onclick="cerrarPanel()"></div>
    <div id="panel">
      <div class="ptop"><b>Líneas de Cochabamba</b><button id="cerrar" onclick="cerrarPanel()">✕</button></div>
      <input id="buscar" placeholder="🔍 buscar línea o zona…" autocomplete="off">
      <div id="lista"></div>
    </div>
    <div id="demo">🚌 <b>Rutas reales</b> · tocá <b>☰ Líneas</b> para ver una sola. Posición del micro simulada hasta que el sindicato suma su GPS.</div>
  </div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('map',{zoomControl:true,attributionControl:false,preferCanvas:true}).setView([-17.389,-66.157],13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19}).addTo(map);
  var canvas = L.canvas({padding:0.5});
  var COLOR = { micro:'#f5b73d', minibus:'#ef8a52', trufi:'#2acb8c', tren:'#5aa6ef', teleferico:'#c084fc' };
  var markers={}, rutasLayer={}, info={};   // id -> ...
  var seleccion = null; // null = todas; id = solo esa línea

  function labelDe(m){ if(m.badge) return m.badge;
    var n=m.nombre.replace(/^(MicroBus|MiniBus|Trufi|L[ií]nea)\\s*/i,'').trim(); return n.length>5?n.slice(0,4)+'…':n; }
  function popupHtml(m){ return '<div class="pop"><b>'+m.nombre+'</b>'
      + (m.hacia?('<div class="r">➡️ '+m.hacia+'</div>'):'')
      + (m.sindicato?('<div class="r">🏛️ '+m.sindicato+'</div>'):'')
      + '<div class="r">💰 Tarifa aprox. Bs 2.50</div></div>'; }
  function iconMicro(m){ var c=COLOR[m.tipo]||'#f5b73d';
    return L.divIcon({className:'',iconSize:[0,0],
      html:'<div class="micro"><img src="/logo.png"><span class="n" style="background:'+c+'">'+labelDe(m)+'</span></div>'}); }
  function visible(id){ return seleccion===null || String(seleccion)===String(id); }

  // ── RUTAS (una vez) + LISTA ──
  fetch('/trufis/rutas').then(function(r){return r.json();}).then(function(d){
    var lineas=(d.lineas||[]).slice();
    lineas.forEach(function(l){
      info[l.id]=l;
      rutasLayer[l.id]=L.polyline(l.ruta,{renderer:canvas,color:COLOR[l.tipo]||'#f5b73d',weight:2,opacity:0.35}).bindPopup(popupHtml(l));
      rutasLayer[l.id].addTo(map);
    });
    construirLista(lineas);
  }).catch(function(e){console.error(e);});

  function construirLista(lineas){
    lineas.sort(function(a,b){ return String(a.nombre).localeCompare(String(b.nombre),'es',{numeric:true}); });
    window._lineas = lineas;
    pintarLista('');
  }
  function pintarLista(q){
    q=(q||'').toLowerCase();
    var cont=document.getElementById('lista');
    var html='<div class="item" onclick="verTodas()"><span class="dot" style="background:#f5b73d"></span><span class="nm todas">▸ Ver todas</span></div>';
    (window._lineas||[]).forEach(function(l){
      if(q && (l.nombre+' '+(l.hacia||'')).toLowerCase().indexOf(q)===-1) return;
      var c=COLOR[l.tipo]||'#f5b73d';
      html+='<div class="item'+(String(seleccion)===String(l.id)?' sel':'')+'" onclick="seleccionar('+l.id+')">'
        +'<span class="dot" style="background:'+c+'"></span>'
        +'<span><span class="nm">'+l.nombre+'</span>'+(l.hacia?(' <span class="hc">→ '+l.hacia+'</span>'):'')+'</span></div>';
    });
    cont.innerHTML=html;
  }

  // ── Selección: mostrar SOLO esa línea ──
  function aplicarSeleccion(){
    Object.keys(rutasLayer).forEach(function(id){
      var vis=visible(id), lyr=rutasLayer[id];
      if(vis && !map.hasLayer(lyr)) lyr.addTo(map);
      if(!vis && map.hasLayer(lyr)) map.removeLayer(lyr);
      if(vis) lyr.setStyle({opacity: seleccion!==null?0.9:0.35, weight: seleccion!==null?5:2});
    });
    Object.keys(markers).forEach(function(id){
      var vis=visible(id), mk=markers[id];
      if(vis && !map.hasLayer(mk)) mk.addTo(map);
      if(!vis && map.hasLayer(mk)) map.removeLayer(mk);
    });
  }
  function seleccionar(id){
    seleccion=id;
    aplicarSeleccion();
    var l=info[id];
    if(l && l.ruta && l.ruta.length){ map.fitBounds(l.ruta,{padding:[40,40]}); }
    pintarLista(document.getElementById('buscar').value);
    cerrarPanel();
  }
  function verTodas(){ seleccion=null; aplicarSeleccion(); pintarLista(document.getElementById('buscar').value); cerrarPanel(); }

  function abrirPanel(){ document.getElementById('panel').classList.add('open'); document.getElementById('overlay').classList.add('show'); }
  function cerrarPanel(){ document.getElementById('panel').classList.remove('open'); document.getElementById('overlay').classList.remove('show'); }
  document.getElementById('buscar').addEventListener('input',function(e){ pintarLista(e.target.value); });

  // ── MICROS (cada 2.5s) ──
  function render(data){
    var micros=data.micros||[];
    document.getElementById('count').innerHTML='<b>'+micros.length+'</b> micros';
    var vistos={};
    micros.forEach(function(m){
      var k=m.id; vistos[k]=true;
      if(markers[k]){ markers[k].setLatLng([m.lat,m.lng]); }
      else{ markers[k]=L.marker([m.lat,m.lng],{icon:iconMicro(m)}).bindPopup(popupHtml(m)); if(visible(k)) markers[k].addTo(map); }
      if(visible(k) && !map.hasLayer(markers[k])) markers[k].addTo(map);
      if(!visible(k) && map.hasLayer(markers[k])) map.removeLayer(markers[k]);
    });
  }
  function tick(){ fetch('/trufis/pos').then(function(r){return r.json();}).then(render).catch(function(e){console.error(e);}); }
  tick(); setInterval(tick,2500);
</script>
</body>
</html>`;
