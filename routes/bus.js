// ChatGo — Página del pasajero de BUS + API de posición
//
// GET /bus/:lineaId?p=lat,lng  → mapa con LA línea del pasajero, su parada 📍
//                                y SOLO el micro que viene hacia él (con ETA)
// GET /bus/:lineaId/pos?lat&lng → JSON { micro: {lat,lng,id,etaMin,km} }
//
// Los micros son deterministas por reloj (services/buslineas): la página hace
// polling cada 3s y el micro avanza consistente para cualquier espectador.

const { LINEAS, proyectarPunto, microMasProximo } = require("../services/buslineas");

module.exports = function (app) {

  app.get("/bus/:lineaId/pos", (req, res) => {
    try {
      const linea = LINEAS.find(l => l.id === parseInt(req.params.lineaId));
      if (!linea) return res.json({ error: "linea_no_encontrada" });
      const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
      if (isNaN(lat) || isNaN(lng)) return res.json({ error: "parada_invalida" });
      const p = proyectarPunto(linea, lat, lng);
      const micro = microMasProximo(linea, p.t);
      res.json({
        micro: { id: micro.id, lat: micro.pos.lat, lng: micro.pos.lng, etaMin: micro.etaMin, km: micro.kmDeDistancia },
        paradaDistM: p.distM,
      });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  app.get("/bus/:lineaId", (req, res) => {
    const linea = LINEAS.find(l => l.id === parseInt(req.params.lineaId));
    if (!linea) return res.status(404).send("Línea no encontrada.");
    const [pLat, pLng] = String(req.query.p || "").split(",").map(parseFloat);
    const tieneParada = !isNaN(pLat) && !isNaN(pLng);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="theme-color" content="#0f1419">
<title>${linea.nombre} · ChatGo Bus</title>
<link rel="icon" href="/logo.png">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  body { background:#0f1419; color:#e8eaed; height:100dvh; display:flex; flex-direction:column; overflow:hidden; }
  header { background:#1a1f26; padding:12px 14px; border-bottom:2px solid ${linea.color}; flex-shrink:0; display:flex; align-items:center; gap:10px; }
  .dot { width:14px; height:14px; border-radius:50%; background:${linea.color}; flex-shrink:0; }
  .tit { font-size:16px; font-weight:800; }
  .sub { font-size:11px; color:#8a919a; }
  #map { flex:1; }
  footer { background:#1a1f26; border-top:1px solid #2a3038; padding:12px 14px; padding-bottom:max(12px, env(safe-area-inset-bottom)); flex-shrink:0; display:flex; align-items:center; gap:14px; }
  .eta { font-size:30px; font-weight:800; color:#1D9E75; white-space:nowrap; }
  .eta-info { font-size:12px; color:#8a919a; line-height:1.5; }
  .micro-marker { background:none; border:none; }
  .micro-icon { width:34px; height:34px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:18px; background:${linea.color}; border:2px solid #fff; box-shadow:0 2px 8px rgba(0,0,0,.5); }
</style>
</head>
<body>
<header>
  <div class="dot"></div>
  <div>
    <div class="tit">${linea.nombre}</div>
    <div class="sub">${linea.origen} → ${linea.destino} · 🚧 demo</div>
  </div>
</header>
<div id="map"></div>
<footer>
  <div class="eta" id="eta">…</div>
  <div class="eta-info" id="eta-info">Buscando tu micro…<br>&nbsp;</div>
</footer>

<script>
const RUTA = ${JSON.stringify(linea.ruta)};
const PARADA = ${tieneParada ? JSON.stringify([pLat, pLng]) : "null"};
const LINEA_ID = ${linea.id};

const map = L.map('map', { zoomControl:false, attributionControl:false }).setView(RUTA[Math.floor(RUTA.length/2)], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom:19 }).addTo(map);

// La línea del pasajero
L.polyline(RUTA, { color:'${linea.color}', weight:5, opacity:.8 }).addTo(map);
L.circleMarker(RUTA[0], { radius:6, color:'#fff', fillColor:'${linea.color}', fillOpacity:1, weight:2 }).addTo(map).bindTooltip('${linea.origen}');
L.circleMarker(RUTA[RUTA.length-1], { radius:6, color:'#fff', fillColor:'${linea.color}', fillOpacity:1, weight:2 }).addTo(map).bindTooltip('${linea.destino}');

// Su parada
if (PARADA) {
  L.marker(PARADA, { icon: L.divIcon({ className:'', html:'<div style="font-size:28px">📍</div>', iconSize:[28,28], iconAnchor:[14,28] }) })
    .addTo(map).bindTooltip('Tu parada');
}

// SOLO el micro que viene hacia el pasajero
let microMarker = null;
async function poll() {
  try {
    const q = PARADA ? '?lat=' + PARADA[0] + '&lng=' + PARADA[1] : '?lat=' + RUTA[0][0] + '&lng=' + RUTA[0][1];
    const r = await fetch('/bus/' + LINEA_ID + '/pos' + q);
    const d = await r.json();
    if (d.micro) {
      const pos = [d.micro.lat, d.micro.lng];
      if (!microMarker) {
        microMarker = L.marker(pos, { icon: L.divIcon({ className:'micro-marker', html:'<div class="micro-icon">🚌</div>', iconSize:[34,34], iconAnchor:[17,17] }) }).addTo(map);
        microMarker.bindTooltip('Micro ' + d.micro.id);
        // Encuadrar micro + parada al inicio
        const b = L.latLngBounds([pos]);
        if (PARADA) b.extend(PARADA);
        map.fitBounds(b, { padding:[60,60] });
      } else {
        microMarker.setLatLng(pos);
      }
      document.getElementById('eta').textContent = '~' + d.micro.etaMin + ' min';
      document.getElementById('eta-info').innerHTML =
        '🚌 Micro ' + d.micro.id + ' — a ' + d.micro.km + ' km de tu parada' +
        (d.paradaDistM ? '<br>📍 Tu parada queda a ' + d.paradaDistM + ' m' : '');
    }
  } catch(e) { /* reintenta en el próximo poll */ }
  setTimeout(poll, 3000);
}
poll();
</script>
</body>
</html>`);
  });
};
