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
        mapId: CONFIG.GOOGLE_MAP_ID || "",
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

function generarHTML({ viajeId, origenLat, origenLng, origenNombre, destinoLat, destinoLng, destinoNombre, paradas, linkGmaps, apiKey, mapId }) {
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

    /* Cartel de maniobra (turn-by-turn), estilo nav, colores ChatGo */
    #maniobra {
      position: absolute; z-index: 9; top: 10px; left: 10px; right: 10px;
      background: #0e7490; color: #fff; border-radius: 14px; padding: 12px 15px;
      display: none; align-items: center; gap: 13px;
      box-shadow: 0 6px 20px rgba(0,0,0,.45);
    }
    #maniobra.show { display: flex; }
    #man-flecha { font-size: 32px; font-weight: 800; line-height: 1; min-width: 34px; text-align: center; }
    .man-txt { min-width: 0; }
    #man-instr { font-size: 15px; font-weight: 700; line-height: 1.25; }
    #man-dist { font-size: 12.5px; opacity: .9; margin-top: 2px; font-weight: 600; }

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
      background: linear-gradient(135deg, #22d3ee, #0e7490); color: #06202b;
      border: none; border-radius: 12px;
      padding: 15px; font-size: 16px; font-weight: 800;
      width: 100%; cursor: pointer;
      box-shadow: 0 4px 14px rgba(34,211,238,.35);
    }
    #btn-navegar:active { filter: brightness(.92); }
    #btn-navegar.activo {
      background: linear-gradient(135deg, #16a34a, #15803d); color: #fff;
      box-shadow: 0 4px 14px rgba(22,163,74,.4);
    }
    #btn-gmaps {
      display: block; text-align: center; margin-top: 9px;
      color: #64748b; font-size: 12.5px; text-decoration: none; font-weight: 600;
    }
    #btn-gmaps:active { color: #94a3b8; }

    /* ══ MODO NAVEGACIÓN 3D (estilo Google/Waze, colores ChatGo) ══ */
    body.nav #header { display: none; }               /* pantalla completa al mapa */
    body.nav #footer { display: none; }
    body.nav #maniobra { display: none; }             /* usamos el banner grande */
    body.nav #btn-aqui { bottom: 96px; }              /* subir el botón sobre la barra */

    /* Cartel grande de maniobra (arriba), estilo nav */
    #nav-top {
      position: fixed; z-index: 30; top: 0; left: 0; right: 0;
      display: none; align-items: center; gap: 15px;
      background: #0f172a; color: #fff;
      padding: 14px 18px; padding-top: max(14px, env(safe-area-inset-top));
      box-shadow: 0 4px 18px rgba(0,0,0,.5);
      border-bottom: 2px solid #22d3ee;
    }
    body.nav #nav-top { display: flex; }
    #nav-flecha {
      font-size: 44px; font-weight: 800; line-height: 1;
      min-width: 52px; text-align: center; color: #22d3ee;
    }
    #nav-top .txt { min-width: 0; flex: 1; }
    #nav-dist { font-size: 26px; font-weight: 800; line-height: 1.1; }
    #nav-instr { font-size: 15px; font-weight: 600; color: #cbd5e1; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Barra inferior: velocidad + ETA + salir (gradiente ChatGo) */
    #nav-bottom {
      position: fixed; z-index: 30; left: 0; right: 0; bottom: 0;
      display: none; align-items: center; gap: 12px;
      background: linear-gradient(135deg, #0e7490, #0f172a);
      padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom));
      box-shadow: 0 -4px 18px rgba(0,0,0,.5);
    }
    body.nav #nav-bottom { display: flex; }
    #nav-vel { text-align: center; min-width: 62px; }
    #nav-vel .n { font-size: 24px; font-weight: 800; color: #fff; line-height: 1; }
    #nav-vel .u { font-size: 10px; color: #7dd3fc; letter-spacing: .5px; }
    #nav-eta { flex: 1; text-align: center; color: #e2e8f0; }
    #nav-eta .t { font-size: 20px; font-weight: 800; color: #22d3ee; line-height: 1.1; }
    #nav-eta .d { font-size: 12px; color: #94a3b8; margin-top: 1px; }
    #nav-salir {
      background: rgba(255,255,255,.12); color: #fff; border: none;
      border-radius: 10px; padding: 10px 14px; font-size: 13px; font-weight: 700; cursor: pointer;
    }
    #nav-salir:active { background: rgba(255,255,255,.22); }
  </style>
</head>
<body>
  <!-- Modo navegación 3D: cartel de maniobra (arriba) y barra de velocidad/ETA (abajo) -->
  <div id="nav-top">
    <div id="nav-flecha">↑</div>
    <div class="txt">
      <div id="nav-dist">—</div>
      <div id="nav-instr">Iniciando navegación…</div>
    </div>
  </div>
  <div id="nav-bottom">
    <div id="nav-vel"><div class="n" id="nav-vel-n">0</div><div class="u">km/h</div></div>
    <div id="nav-eta"><div class="t" id="nav-eta-t">—</div><div class="d" id="nav-eta-d">al destino</div></div>
    <button id="nav-salir" onclick="salirNavegacion()">✕ Salir</button>
  </div>

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
    <div id="maniobra">
      <span id="man-flecha">↑</span>
      <div class="man-txt"><div id="man-instr">Iniciando navegación…</div><div id="man-dist"></div></div>
    </div>
    <button id="btn-aqui" onclick="centrarEnChofer()" title="Centrar en mi ubicación">🧭 Centrar</button>
  </div>

  <div id="footer">
    <button id="btn-navegar" onclick="iniciarNavegacion()">
      <img src="/logo.png" alt="" style="width:22px;height:22px;border-radius:5px"> Iniciar navegación
    </button>
    <a id="btn-gmaps" href="${escHtml(linkGmaps)}" target="_blank" rel="noopener">Prefiero abrir Google Maps</a>
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
    const MAP_ID = "${mapId || ""}"; // Map ID vectorial → 3D (inclinación + rotación heading-up)

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
    let navMode = false, ultimaPosChofer = null; // navegación turn-by-turn propia de ChatGo
    let soporta3D = false, etaMin = null; // 3D disponible + ETA para la barra inferior

    function initMap() {
      const loading = document.getElementById("map-loading");
      const mapEl   = document.getElementById("map");

      const origen  = { lat: VIAJE.origenLat,  lng: VIAJE.origenLng  };
      const destino = { lat: VIAJE.destinoLat, lng: VIAJE.destinoLng };

      const opcionesMapa = {
        center: origen,
        zoom: 14,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        zoomControl: true,
        gestureHandling: "greedy",
      };
      // Con Map ID vectorial: mapa 3D (permite inclinación y rotación). Sin él:
      // mapa raster clásico con estilos (la navegación funciona igual, pero 2D).
      if (MAP_ID) {
        opcionesMapa.mapId = MAP_ID;
      } else {
        opcionesMapa.styles = [
          { featureType: "poi.business", stylers: [{ visibility: "off" }] },
          { featureType: "transit",      stylers: [{ visibility: "off" }] }
        ];
      }
      map = new google.maps.Map(mapEl, opcionesMapa);
      soporta3D = !!MAP_ID;

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
          ultimaPosChofer = p;
          if (!tengoUbiChofer) { tengoUbiChofer = true; map.setZoom(navMode ? 18 : 16); }
          // El auto (logo de ChatGo) SIEMPRE queda en el centro; la ruta ya recorrida se borra.
          map.panTo(p);
          recortarRuta(p);
          // En modo navegación 3D: girar el mapa hacia el rumbo (heading-up),
          // inclinarlo y mostrar la velocidad del GPS.
          if (navMode) {
            const rumbo = pos.coords.heading;
            if (soporta3D && typeof rumbo === "number" && !isNaN(rumbo)) {
              map.moveCamera({ center: p, heading: rumbo, tilt: 55, zoom: 18 });
            }
            const vel = pos.coords.speed; // m/s
            const kmh = (typeof vel === "number" && vel >= 0) ? Math.round(vel * 3.6) : null;
            document.getElementById("nav-vel-n").textContent = kmh == null ? "—" : kmh;
          }
          actualizarNavegacion(p); // maniobra + voz paso a paso
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
      if (choferMarker) { map.panTo(choferMarker.getPosition()); map.setZoom(navMode ? 17 : 16); }
    }

    // ── Navegación turn-by-turn 3D PROPIA de ChatGo (estilo Waze/Google, nuestros colores) ──
    function iniciarNavegacion() {
      navMode = true;
      seguirChofer = true;
      document.body.classList.add("nav");   // pantalla completa + banners de navegación
      setTimeout(() => window.dispatchEvent(new Event("resize")), 60); // el mapa ocupa toda la pantalla
      if (!vozActiva) toggleVoz();           // asegurar la voz encendida
      pedirWakeLock();                       // pantalla siempre encendida
      if (etaMin != null) document.getElementById("nav-eta-t").textContent = etaMin + " min";
      if (choferMarker) {
        const p = { lat: choferMarker.getPosition().lat(), lng: choferMarker.getPosition().lng() };
        if (soporta3D) map.moveCamera({ center: p, tilt: 55, zoom: 18 });
        else { map.panTo(p); map.setZoom(18); }
      }
      if (ultimaPosChofer && pasos.length) {
        recomputarIdxPaso(ultimaPosChofer);
        actualizarNavegacion(ultimaPosChofer);
      } else {
        document.getElementById("nav-instr").textContent = "Buscando tu ubicación…";
        document.getElementById("nav-dist").textContent = "";
      }
    }

    function salirNavegacion() {
      navMode = false;
      document.body.classList.remove("nav");
      setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
      try { if (soporta3D) map.moveCamera({ tilt: 0, heading: 0 }); } catch (e) {}
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

    // ── NAVEGACIÓN PASO A PASO (turn-by-turn con voz, estilo Google) ──
    let pasos = [], idxPaso = 0, avisoLejos = -1, avisoCerca = -1;
    function flecha(m) {
      m = (m || "").toUpperCase();
      if (m.includes("UTURN")) return "↩";
      if (m.includes("ROUNDABOUT") || m.includes("CIRCLE") || m.includes("ROTARY")) return "⟳";
      if (m.includes("SHARP_RIGHT")) return "⤵";
      if (m.includes("SHARP_LEFT")) return "⤴";
      if (m.includes("RIGHT")) return "↱";
      if (m.includes("LEFT")) return "↰";
      if (m.includes("RAMP") || m.includes("MERGE") || m.includes("FORK")) return "↗";
      if (m.includes("DESTINATION")) return "🏁";
      return "↑";
    }
    function distM(la1, ln1, la2, ln2) {
      const R = 6371000, dLa = (la2 - la1) * Math.PI / 180, dLn = (ln2 - ln1) * Math.PI / 180;
      const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLn / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    function recomputarIdxPaso(p) {
      let min = Infinity, idx = 0;
      for (let i = 0; i < pasos.length; i++) {
        const d = distM(p.lat, p.lng, pasos[i].lat, pasos[i].lng);
        if (d < min) { min = d; idx = i; }
      }
      idxPaso = idx; avisoLejos = -1; avisoCerca = -1;
    }
    function actualizarNavegacion(p) {
      if (!pasos.length) return;
      // Avanzar cuando ya estamos muy cerca del punto de la maniobra actual
      while (idxPaso < pasos.length - 1 && distM(p.lat, p.lng, pasos[idxPaso].lat, pasos[idxPaso].lng) < 22) idxPaso++;
      const paso = pasos[idxPaso];
      const d = Math.round(distM(p.lat, p.lng, paso.lat, paso.lng));
      const distTxt = d >= 1000 ? (d / 1000).toFixed(1) + " km" : d + " m";
      const flechaTxt = flecha(paso.maniobra);
      const instrTxt = paso.instruccion || "Seguí derecho";
      // Cartel chico (modo mapa normal)
      document.getElementById("maniobra").classList.add("show");
      document.getElementById("man-flecha").textContent = flechaTxt;
      document.getElementById("man-instr").textContent = instrTxt;
      document.getElementById("man-dist").textContent = distTxt;
      // Cartel grande (modo navegación 3D)
      document.getElementById("nav-flecha").textContent = flechaTxt;
      document.getElementById("nav-dist").textContent = distTxt;
      document.getElementById("nav-instr").textContent = instrTxt;
      const texto = paso.instruccion || "seguí derecho";
      if (d <= 170 && avisoLejos !== idxPaso) { avisoLejos = idxPaso; hablar("En " + d + " metros, " + texto); }
      if (d <= 45 && avisoCerca !== idxPaso) { avisoCerca = idxPaso; hablar(texto); }
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
      // Maniobras paso a paso (turn-by-turn con voz)
      pasos = rutas[mejorIdx].pasos || [];
      // Si ya sabemos dónde está el chofer, recortar lo recorrido y ubicar la maniobra
      if (choferMarker) {
        const cp = { lat: choferMarker.getPosition().lat(), lng: choferMarker.getPosition().lng() };
        recortarRuta(choferMarker.getPosition());
        if (pasos.length) { recomputarIdxPaso(cp); actualizarNavegacion(cp); } // mostrar el cartel ya, sin esperar movimiento
      }

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
      // Barra inferior del modo navegación 3D
      etaMin = minCon;
      document.getElementById("nav-eta-t").textContent = minCon + " min";
      document.getElementById("nav-eta-d").textContent = (distM / 1000).toFixed(1) + " km al destino";

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
