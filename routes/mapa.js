// ChatGo — Mapa de ruta para choferes (copiloto con voz)
// Sirve una página HTML con Google Maps, tráfico en tiempo real, ETA,
// rutas alternativas y avisos hablados de trancadera/desvíos.
// GET /mapa/:viajeId

const { Viaje } = require("../db/models");
const { CONFIG, log } = require("../config");
const { calcularRutasConTrafico } = require("../services/google");

module.exports = function (app) {
  // Rutas con tráfico vía Routes API (server-side: la Directions legacy del
  // navegador da REQUEST_DENIED en proyectos nuevos de Google Cloud)
  app.get("/mapa/:viajeId/ruta", async (req, res) => {
    try {
      const viaje = await Viaje.findUnique({ where: { id: req.params.viajeId } });
      if (!viaje || !viaje.origenLat || !viaje.destinoLat) {
        return res.json({ error: "not_found" });
      }
      const paradas = Array.isArray(viaje.paradas) ? viaje.paradas : [];
      const rutas = await calcularRutasConTrafico(
        { lat: viaje.origenLat, lng: viaje.origenLng },
        { lat: viaje.destinoLat, lng: viaje.destinoLng },
        paradas
      );
      res.json({ rutas });
    } catch (e) {
      const detalle = e.response?.data?.error?.message || e.message;
      log.error("[MAPA_RUTA]", detalle);
      res.json({ error: detalle });
    }
  });

  app.get("/mapa/:viajeId", async (req, res) => {
    try {
      const viaje = await Viaje.findUnique({ where: { id: req.params.viajeId } });
      if (!viaje || !viaje.origenLat || !viaje.destinoLat) {
        return res.status(404).send("Viaje no encontrado.");
      }
      // El link de navegación SOLO vive mientras el viaje está activo. Al
      // terminar/cancelar se rompe (antes seguía activo para siempre).
      const finalizado = /^(terminad|finalizad|cancelad|rechazad|completad)/i.test(viaje.estado || "");
      if (finalizado) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(410).send(paginaFinalizado());
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
        viajeId: viaje.id,
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

function paginaFinalizado() {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Viaje finalizado</title>
<link rel="icon" href="/logo.png">
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#0c1310;color:#e7efe9;font-family:system-ui,sans-serif;text-align:center;padding:24px}
.c{max-width:340px}.e{font-size:52px}h1{font-size:20px;margin:14px 0 6px}p{color:#93a49a;font-size:14px;line-height:1.5}</style>
</head><body><div class="c"><div class="e">🏁</div><h1>Viaje finalizado</h1>
<p>Este enlace de navegación ya no está activo porque el viaje terminó.<br><br>Cuando tomes un nuevo viaje, ChatGo te manda un enlace nuevo.</p></div></body></html>`;
}

function generarHTML({ viajeId, origenLat, origenLng, origenNombre, destinoLat, destinoLng, destinoNombre, paradas, linkGmaps, apiKey }) {
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
    #btn-voz {
      margin-left: auto; background: #1e293b; border: 1px solid #334155; color: #e2e8f0;
      border-radius: 8px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    #btn-voz.on { background: #164e63; border-color: #22d3ee; color: #22d3ee; }

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

    /* Banner de tráfico / avisos del copiloto */
    #aviso {
      display: none;
      border-radius: 10px;
      padding: 8px 12px;
      margin-bottom: 8px;
      font-size: 12px;
      line-height: 1.45;
      font-weight: 500;
    }
    #aviso.verde   { display: block; background: #052e1b; color: #4ade80; border: 1px solid #14532d; }
    #aviso.amarillo{ display: block; background: #3a2c07; color: #fbbf24; border: 1px solid #713f12; }
    #aviso.rojo    { display: block; background: #3a0a0a; color: #f87171; border: 1px solid #7f1d1d; }

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

    #btn-aqui {
      position: absolute; z-index: 9;
      right: 12px; bottom: 16px;
      display: flex; align-items: center; gap: 6px;
      background: #0f172a; color: #22d3ee;
      border: 1px solid #22d3ee; border-radius: 999px;
      padding: 9px 15px; font-size: 14px; font-weight: 700;
      box-shadow: 0 3px 12px rgba(0,0,0,.45); cursor: pointer;
    }
    #btn-aqui:active { background: #164e63; }

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
      <button id="btn-voz" class="on" onclick="toggleVoz()">🔊 Voz ON</button>
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
    <div id="aviso"></div>
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
    <button id="btn-aqui" onclick="centrarEnChofer()" title="Centrar en mi ubicación">🧭 Centrar</button>
  </div>

  <div id="footer">
    <a id="btn-navegar" href="${escHtml(linkGmaps)}" target="_blank" rel="noopener">
      🗺️ Navegar con Google Maps
    </a>
  </div>

  <script>
    const VIAJE = {
      id:         "${viajeId}",
      origenLat:  ${origenLat},
      origenLng:  ${origenLng},
      destinoLat: ${destinoLat},
      destinoLng: ${destinoLng},
      paradas:    ${paradasJson}
    };

    // ── COPILOTO DE VOZ (speechSynthesis del navegador: gratis y sin red) ──
    let vozActiva = true;
    let ultimoAviso = "";

    function toggleVoz() {
      vozActiva = !vozActiva;
      const b = document.getElementById("btn-voz");
      b.textContent = vozActiva ? "🔊 Voz ON" : "🔇 Voz OFF";
      b.classList.toggle("on", vozActiva);
      if (vozActiva && ultimoAviso) hablar(ultimoAviso);
      else speechSynthesis.cancel();
    }

    function hablar(texto) {
      if (!vozActiva || !("speechSynthesis" in window)) return;
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = "es-US";
        const voces = speechSynthesis.getVoices();
        const vozEs = voces.find(v => /^es[-_]/i.test(v.lang));
        if (vozEs) u.voice = vozEs;
        u.rate = 1.0;
        speechSynthesis.speak(u);
      } catch (e) { /* sin soporte de voz: seguimos en silencio */ }
    }
    // Algunos navegadores cargan las voces async
    if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

    function mostrarAviso(nivel, texto) {
      const el = document.getElementById("aviso");
      el.className = nivel;
      el.textContent = texto;
    }

    // ── MAPA + RUTAS ──────────────────────────────────────────────────────
    let map, rendererPrincipal, polysAlternativas = [], etaAnteriorMin = null;
    let rutaPuntos = []; // puntos de la ruta recomendada (para recortar lo ya recorrido)
    // Ubicación EN VIVO del chofer (GPS del propio celular)
    let choferMarker = null, seguirChofer = true, tengoUbiChofer = false, watchIdChofer = null;

    function initMap() {
      const loading = document.getElementById("map-loading");
      const mapEl   = document.getElementById("map");

      const origen  = { lat: VIAJE.origenLat,  lng: VIAJE.origenLng  };
      const destino = { lat: VIAJE.destinoLat, lng: VIAJE.destinoLng };

      map = new google.maps.Map(mapEl, {
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

      new google.maps.Marker({ position: origen, map, zIndex: 3, title: "Origen", icon: svgPin("#22c55e", "A") });
      new google.maps.Marker({ position: destino, map, zIndex: 3, title: "Destino", icon: svgPin("#ef4444", "B") });

      // El auto queda SIEMPRE centrado (seguimiento permanente, como una nav real).
      iniciarSeguimientoChofer();
      pedirWakeLock(); // mantener la pantalla encendida durante la navegación
      calcularRuta(true);
      // Re-chequear el tráfico cada 2 minutos: si empeora, el copiloto avisa
      setInterval(() => calcularRuta(false), 120000);
    }

    // ── UBICACIÓN EN VIVO DEL CHOFER ──────────────────────────────────────
    // Ícono de auto (vista superior) que APUNTA hacia donde se mueve y se
    // actualiza en cada cambio de posición del GPS del celular.
    function iconoAuto(rumbo) {
      const rot = (typeof rumbo === "number" && !isNaN(rumbo)) ? rumbo : 0;
      const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42">
        <g transform="rotate(\${rot} 21 21)">
          <circle cx="21" cy="21" r="20" fill="#22d3ee" fill-opacity="0.16"/>
          <rect x="14" y="9" width="14" height="24" rx="5" fill="#f5b73d" stroke="#5a4310" stroke-width="1.6"/>
          <rect x="16" y="12" width="10" height="6" rx="2" fill="#0d1411" fill-opacity="0.75"/>
          <rect x="16" y="24" width="10" height="5" rx="2" fill="#0d1411" fill-opacity="0.45"/>
          <circle cx="21" cy="7" r="2.4" fill="#ffffff"/>
        </g>
      </svg>\`;
      return {
        url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
        scaledSize: new google.maps.Size(42, 42),
        anchor: new google.maps.Point(21, 21)
      };
    }

    function iniciarSeguimientoChofer() {
      if (!navigator.geolocation) {
        mostrarAviso("amarillo", "⚠️ Tu teléfono no permite ubicación en vivo. Podés navegar igual con el botón de abajo.");
        return;
      }
      watchIdChofer = navigator.geolocation.watchPosition(
        (pos) => {
          const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (!choferMarker) {
            choferMarker = new google.maps.Marker({
              position: p, map, zIndex: 6, title: "Tu ubicación",
              icon: { url: "/logo.png", scaledSize: new google.maps.Size(42, 42), anchor: new google.maps.Point(21, 21) }
            });
          } else {
            choferMarker.setPosition(p);
          }
          if (!tengoUbiChofer) { tengoUbiChofer = true; map.setZoom(16); }
          // El auto (logo de ChatGo) SIEMPRE queda en el centro; la ruta ya recorrida se borra.
          map.panTo(p);
          recortarRuta(p);
        },
        (err) => {
          const msg = err.code === 1
            ? "⚠️ Activá el permiso de ubicación para ver tu auto en el mapa."
            : "⚠️ No pudimos leer tu GPS. Revisá que la ubicación esté encendida.";
          mostrarAviso("amarillo", msg);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
    }

    // ── PANTALLA SIEMPRE ENCENDIDA (Wake Lock) ──
    // Sin esto, al atenuarse la pantalla el navegador congela el GPS y el auto
    // queda estático. Mantenerla encendida hace que el seguimiento no se corte.
    let wakeLock = null;
    async function pedirWakeLock() {
      try {
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
          wakeLock.addEventListener("release", () => {});
        }
      } catch (e) { /* algunos navegadores exigen gesto del usuario; se reintenta al tocar */ }
    }
    // Reacquirir cuando la pestaña vuelve a estar visible (el lock se suelta al ocultarse)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pedirWakeLock();
    });
    // Reintentar en el primer toque (por si el navegador rechazó el pedido inicial sin gesto)
    document.addEventListener("click", () => { if (!wakeLock) pedirWakeLock(); }, { once: false });

    function centrarEnChofer() {
      seguirChofer = true;
      if (choferMarker) { map.panTo(choferMarker.getPosition()); map.setZoom(16); }
    }

    // Recorta la ruta: borra lo YA recorrido y deja solo lo que falta (como una
    // navegación real). Busca el punto de la ruta más cercano al chofer y dibuja
    // desde ahí hasta el destino, arrancando en la posición exacta del auto.
    function recortarRuta(pos) {
      if (!rendererPrincipal || rutaPuntos.length < 2 || !pos) return;
      const pLat = (typeof pos.lat === "function") ? pos.lat() : pos.lat;
      const pLng = (typeof pos.lng === "function") ? pos.lng() : pos.lng;
      let minD = Infinity, idx = 0;
      for (let i = 0; i < rutaPuntos.length; i++) {
        const pt = rutaPuntos[i];
        const la = (typeof pt.lat === "function") ? pt.lat() : (pt.lat !== undefined ? pt.lat : pt[0]);
        const ln = (typeof pt.lng === "function") ? pt.lng() : (pt.lng !== undefined ? pt.lng : pt[1]);
        const d = (la - pLat) * (la - pLat) + (ln - pLng) * (ln - pLng);
        if (d < minD) { minD = d; idx = i; }
      }
      rendererPrincipal.setPath([{ lat: pLat, lng: pLng }, ...rutaPuntos.slice(idx)]);
    }

    function calcularRuta(esPrimeraVez) {
      const origen  = { lat: VIAJE.origenLat,  lng: VIAJE.origenLng  };
      const destino = { lat: VIAJE.destinoLat, lng: VIAJE.destinoLng };

      // Routes API vía nuestro backend (la Directions legacy del navegador
      // da REQUEST_DENIED en proyectos nuevos de Google Cloud)
      fetch("/mapa/" + VIAJE.id + "/ruta")
        .then(r => r.json())
        .then(d => {
          if (d.error || !d.rutas || !d.rutas.length) {
            console.error("Ruta falló:", d.error);
            document.getElementById("eta-value").textContent = "—";
            document.getElementById("eta-value").style.color = "#64748b";
            mostrarAviso("amarillo", "⚠️ No se pudo calcular la ruta con tráfico" + (d.error ? " (" + d.error + ")" : "") + ". Se muestra la ruta directa; usá el botón Navegar.");
            dibujarLineaRespaldo(origen, destino);
            return;
          }
          pintarRutas(d.rutas, esPrimeraVez);
        })
        .catch(e => {
          console.error("Ruta falló:", e);
          mostrarAviso("amarillo", "⚠️ Error de red calculando la ruta. Se muestra la ruta directa.");
          dibujarLineaRespaldo(origen, destino);
        });
    }

    // Si Directions falla (API deshabilitada, sin cuota, etc.) igual se ve una línea A→B
    function dibujarLineaRespaldo(origen, destino) {
      const puntos = [origen, ...(VIAJE.paradas || []).map(p => ({ lat: p.lat, lng: p.lng })), destino];
      new google.maps.Polyline({
        map, path: puntos, geodesic: true,
        strokeColor: "#3b82f6", strokeOpacity: 0.6, strokeWeight: 4,
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 }, offset: "0", repeat: "14px" }]
      });
      if (tengoUbiChofer) return; // ya seguimos al chofer: no le movemos la vista
      const b = new google.maps.LatLngBounds();
      puntos.forEach(p => b.extend(p));
      map.fitBounds(b, 60);
    }

    function pintarRutas(rutas, esPrimeraVez) {
      // Elegir la ruta MÁS RÁPIDA con tráfico
      let mejorIdx = 0, mejorSeg = Infinity;
      rutas.forEach((r, i) => {
        if (r.duracionSeg < mejorSeg) { mejorSeg = r.duracionSeg; mejorIdx = i; }
      });

      // Limpiar dibujos anteriores (refrescos)
      if (rendererPrincipal) rendererPrincipal.setMap(null);
      polysAlternativas.forEach(p => p.setMap(null));
      polysAlternativas = [];

      // Alternativas en gris (debajo)
      rutas.forEach((r, i) => {
        if (i === mejorIdx) return;
        const poly = new google.maps.Polyline({
          map, path: r.puntos,
          strokeColor: "#64748b", strokeOpacity: 0.55, strokeWeight: 4, zIndex: 1
        });
        polysAlternativas.push(poly);
      });

      // Ruta recomendada en azul (encima)
      rutaPuntos = rutas[mejorIdx].puntos || [];
      rendererPrincipal = new google.maps.Polyline({
        map, path: rutaPuntos,
        strokeColor: "#3b82f6", strokeWeight: 6, strokeOpacity: 0.9, zIndex: 2
      });
      // Si ya sabemos dónde está el chofer, recortar de una lo ya recorrido
      if (choferMarker) recortarRuta(choferMarker.getPosition());

      // Encuadrar el mapa a la ruta (solo la primera vez, y solo si todavía
      // no estamos siguiendo al chofer — su ubicación en vivo tiene prioridad)
      if (esPrimeraVez && rutas[mejorIdx].puntos.length && !tengoUbiChofer) {
        const b = new google.maps.LatLngBounds();
        rutas[mejorIdx].puntos.forEach(p => b.extend(p));
        map.fitBounds(b, 60);
      }

      // ── ETA y análisis de tráfico ──
      const mejor = rutas[mejorIdx];
      const segCon = mejor.duracionSeg;
      const segSin = mejor.duracionSinTraficoSeg;
      const distM  = mejor.distanciaM;
      const minCon = Math.round(segCon / 60);
      const demoraMin = Math.max(0, Math.round((segCon - segSin) / 60));
      const via = mejor.via || "la ruta marcada";

      const etaEl = document.getElementById("eta-value");
      etaEl.textContent = minCon + " min";
      etaEl.style.color = demoraMin >= 10 ? "#f87171" : demoraMin >= 4 ? "#fbbf24" : "#22d3ee";
      document.getElementById("dist-value").textContent = (distM / 1000).toFixed(1) + " km";

      // ── Mensaje del copiloto ──
      let nivel, textoAviso, textoVoz;
      if (demoraMin >= 10) {
        nivel = "rojo";
        textoAviso = "🚨 Trancadera fuerte: +" + demoraMin + " min de demora. Ruta recomendada: " + via + ".";
        textoVoz = "Atención. Hay trancadera fuerte, " + demoraMin + " minutos más de lo normal. Te recomiendo ir por " + via + ". Llegás en " + minCon + " minutos.";
      } else if (demoraMin >= 4) {
        nivel = "amarillo";
        textoAviso = "⚠️ Tráfico moderado: +" + demoraMin + " min. Mejor ruta: " + via + ".";
        textoVoz = "Ojo, hay algo de tráfico, " + demoraMin + " minutos extra. La mejor ruta es por " + via + ". Llegás en " + minCon + " minutos.";
      } else {
        nivel = "verde";
        textoAviso = "✅ Ruta despejada por " + via + ".";
        textoVoz = "Ruta despejada. Andá por " + via + ". Llegás en " + minCon + " minutos.";
      }
      // Si Google trae una alternativa apenas más lenta, mencionarla como plan B
      if (rutas.length > 1) {
        const otra = rutas.find((r, i) => i !== mejorIdx);
        if (otra && otra.via && otra.via !== via) {
          textoAviso += " Alternativa: " + otra.via + " (gris en el mapa).";
        }
      }
      mostrarAviso(nivel, textoAviso);

      // Hablar: siempre en la primera carga; en refrescos solo si el tráfico CAMBIÓ (±4 min)
      const cambio = etaAnteriorMin === null || Math.abs(minCon - etaAnteriorMin) >= 4;
      etaAnteriorMin = minCon;
      ultimoAviso = textoVoz;
      if (esPrimeraVez || cambio) hablar(textoVoz);
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
