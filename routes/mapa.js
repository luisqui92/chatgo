// ChatGo — Mapa de ruta para choferes
// Sirve una página HTML con Google Maps, tráfico en tiempo real y ETA.
// GET /mapa/:viajeId

const { Viaje } = require("../db/models");
const { CONFIG } = require("../config");

module.exports = function (app) {
  app.get("/mapa/:viajeId", async (req, res) => {
    try {
      const viaje = await Viaje.findUnique({ where: { id: req.params.viajeId } });
      if (!viaje || !viaje.origenLat || !viaje.destinoLat) {
        return res.status(404).send("Viaje no encontrado.");
      }

      const paradas = Array.isArray(viaje.paradas) ? viaje.paradas : [];
      const origenNombre = viaje.origenNombre || "Origen";
      const destinoNombre = viaje.destinoNombre || "Destino";

      // Link de fallback a Google Maps nativo (para el botón "Navegar")
      let linkGmaps = `https://www.google.com/maps/dir/?api=1&origin=${viaje.origenLat},${viaje.origenLng}&destination=${viaje.destinoLat},${viaje.destinoLng}&travelmode=driving`;
      if (paradas.length > 0) {
        linkGmaps += `&waypoints=${encodeURIComponent(paradas.map(p => `${p.lat},${p.lng}`).join("|"))}`;
      }

      const html = generarHTML({
        origenLat: viaje.origenLat,
        origenLng: viaje.origenLng,
        origenNombre,
        destinoLat: viaje.destinoLat,
        destinoLng: viaje.destinoLng,
        destinoNombre,
        paradas,
        linkGmaps,
        apiKey: CONFIG.GOOGLE_MAPS_KEY || "",
      });

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.send(html);
    } catch (e) {
      res.status(500).send("Error cargando el mapa.");
    }
  });
};

function generarHTML({ origenLat, origenLng, origenNombre, destinoLat, destinoLng, destinoNombre, paradas, linkGmaps, apiKey }) {
  const paradasJson = JSON.stringify(paradas);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <meta name="theme-color" content="#0f172a">
  <title>ChatGo – Ruta del viaje</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }

    #header {
      background: #0f172a;
      padding: 10px 14px 8px;
      border-bottom: 1px solid #1e293b;
      flex-shrink: 0;
    }
    #brand { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    #brand-name { color: #22d3ee; font-size: 15px; font-weight: 700; letter-spacing: .5px; }

    #eta-row {
      display: flex;
      align-items: center;
      background: #1e293b;
      border-radius: 10px;
      padding: 8px 12px;
      gap: 12px;
      margin-bottom: 8px;
    }
    #eta-icon { font-size: 22px; }
    #eta-info { flex: 1; }
    #eta-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .8px; }
    #eta-value { font-size: 20px; font-weight: 700; color: #22d3ee; line-height: 1.1; }
    #eta-dist { font-size: 11px; color: #94a3b8; text-align: right; line-height: 1.5; }

    #puntos { display: flex; flex-direction: column; gap: 0; }
    .punto { display: flex; align-items: flex-start; gap: 8px; padding: 2px 0; }
    .punto-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; margin-top: 3px; border: 2px solid; }
    .dot-origen { background: #22c55e; border-color: #16a34a; }
    .dot-destino { background: #ef4444; border-color: #dc2626; }
    .punto-text { min-width: 0; }
    .punto-lbl { font-size: 9px; color: #475569; text-transform: uppercase; letter-spacing: .8px; }
    .punto-nom { font-size: 12px; color: #e2e8f0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: calc(100vw - 60px); }
    .punto-sep { width: 2px; height: 10px; background: #334155; margin-left: 5px; }

    #map { flex: 1; position: relative; }
    #map-loading {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; background: #0f172a; color: #475569; gap: 10px; z-index: 10;
    }
    .spinner { width: 36px; height: 36px; border: 3px solid #1e293b; border-top-color: #22d3ee; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    #footer {
      background: #0f172a;
      padding: 10px 14px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
      border-top: 1px solid #1e293b;
      flex-shrink: 0;
    }
    #btn-navegar {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      background: #2563eb; color: #fff; border-radius: 10px;
      padding: 14px; font-size: 15px; font-weight: 600;
      text-decoration: none; width: 100%;
    }
    #btn-navegar:active { background: #1d4ed8; }
  </style>
</head>
<body>
  <div id="header">
    <div id="brand">
      <span>🚖</span>
      <span id="brand-name">ChatGo</span>
    </div>
    <div id="eta-row">
      <div id="eta-icon">⏱️</div>
      <div id="eta-info">
        <div id="eta-label">Tiempo al destino</div>
        <div id="eta-value">Calculando…</div>
      </div>
      <div id="eta-dist">
        <div id="dist-value">—</div>
        <div style="font-size:9px;color:#475569">con tráfico</div>
      </div>
    </div>
    <div id="puntos">
      <div class="punto">
        <div class="punto-dot dot-origen"></div>
        <div class="punto-text">
          <div class="punto-lbl">Origen</div>
          <div class="punto-nom">${escHtml(origenNombre)}</div>
        </div>
      </div>
      <div class="punto-sep" style="margin-left:5px"></div>
      <div class="punto">
        <div class="punto-dot dot-destino"></div>
        <div class="punto-text">
          <div class="punto-lbl">Destino</div>
          <div class="punto-nom">${escHtml(destinoNombre)}</div>
        </div>
      </div>
    </div>
  </div>

  <div id="map">
    <div id="map-loading">
      <div class="spinner"></div>
      <span style="font-size:13px">Cargando mapa y tráfico…</span>
    </div>
  </div>

  <div id="footer">
    <a id="btn-navegar" href="${escHtml(linkGmaps)}" target="_blank" rel="noopener">
      🗺️ Navegar con Google Maps
    </a>
  </div>

  <script>
    const VIAJE = {
      origenLat:  ${origenLat},
      origenLng:  ${origenLng},
      destinoLat: ${destinoLat},
      destinoLng: ${destinoLng},
      paradas:    ${paradasJson}
    };

    function initMap() {
      const loading = document.getElementById("map-loading");
      const mapEl   = document.getElementById("map");

      const origen  = { lat: VIAJE.origenLat,  lng: VIAJE.origenLng  };
      const destino = { lat: VIAJE.destinoLat, lng: VIAJE.destinoLng };

      const map = new google.maps.Map(mapEl, {
        center: origen,
        zoom: 14,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        zoomControl: true,
        gestureHandling: "greedy",
        styles: [
          { featureType: "poi.business", stylers: [{ visibility: "off" }] },
          { featureType: "transit",      stylers: [{ visibility: "off" }] }
        ]
      });

      // Tráfico en tiempo real
      new google.maps.TrafficLayer().setMap(map);

      if (loading) loading.remove();

      // Marcador origen — pin verde
      new google.maps.Marker({
        position: origen, map, zIndex: 3,
        title: "Origen",
        icon: svgPin("#22c55e", "A")
      });

      // Marcador destino — pin rojo
      new google.maps.Marker({
        position: destino, map, zIndex: 3,
        title: "Destino",
        icon: svgPin("#ef4444", "B")
      });

      // Ruta + ETA con tráfico real
      const waypoints = (VIAJE.paradas || []).map(p => ({
        location: new google.maps.LatLng(p.lat, p.lng),
        stopover: true
      }));

      new google.maps.DirectionsService().route({
        origin: origen,
        destination: destino,
        waypoints,
        travelMode: google.maps.TravelMode.DRIVING,
        drivingOptions: {
          departureTime: new Date(),
          trafficModel: "bestguess"
        }
      }, function(result, status) {
        if (status === "OK") {
          new google.maps.DirectionsRenderer({
            map,
            suppressMarkers: true,
            polylineOptions: { strokeColor: "#3b82f6", strokeWeight: 5, strokeOpacity: 0.85 }
          }).setDirections(result);

          const leg = result.routes[0].legs[0];
          const dur = leg.duration_in_traffic || leg.duration;
          document.getElementById("eta-value").textContent = dur.text;
          document.getElementById("dist-value").textContent  = leg.distance.text;
        } else {
          document.getElementById("eta-value").textContent = "—";
          document.getElementById("eta-value").style.color = "#64748b";
        }
      });
    }

    function svgPin(color, letra) {
      const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="46" viewBox="0 0 34 46">
        <path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 29 17 29S34 29.7 34 17C34 7.6 26.4 0 17 0z" fill="\${color}"/>
        <circle cx="17" cy="17" r="9" fill="white"/>
        <text x="17" y="21.5" text-anchor="middle" font-size="11" font-weight="bold" font-family="sans-serif" fill="\${color}">\${letra}</text>
      </svg>\`;
      return {
        url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
        scaledSize: new google.maps.Size(34, 46),
        anchor: new google.maps.Point(17, 46)
      };
    }
  </script>
  <script async defer
    src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&language=es&v=weekly">
  </script>
</body>
</html>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
