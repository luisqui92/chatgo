// ChatGo Bus — Simulación de trufis moviéndose por sus rutas REALES.
//
// Toma las líneas geocodificadas con su recorrido por calles (data/lineas_coords.json,
// generado por scripts/geocodificar_lineas.js) y simula cada micro yendo por su
// ruta del centro al destino y volviendo (ida y vuelta), con posición determinista
// por reloj (sin estado en memoria: cualquiera que mire ve lo mismo).
//
// SIMULACIÓN: la ruta es el camino por calles del centro al destino REAL (no el
// recorrido oficial exacto del micro, que llega con el GPS del sindicato), pero
// el destino, el nombre y el sindicato de cada línea SÍ son reales.

const fs = require("fs");
const path = require("path");
const { log } = require("../config");

function cargar() {
  try {
    const p = path.join(__dirname, "..", "data", "lineas_coords.json");
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, "utf8")).filter((l) => Array.isArray(l.ruta) && l.ruta.length >= 2);
    log.info(`[SIM_TRUFIS] ${arr.length} líneas con ruta cargadas`);
    return arr;
  } catch (e) {
    log.error("[SIM_TRUFIS]", e.message);
    return [];
  }
}

const LINEAS = cargar();

// Punto sobre la polilínea de la ruta según una fracción 0..1 (interpolado).
function puntoEnRuta(ruta, frac) {
  const n = ruta.length;
  if (n === 1) return ruta[0];
  const x = Math.max(0, Math.min(1, frac)) * (n - 1);
  const i = Math.floor(x);
  const t = x - i;
  const a = ruta[Math.min(i, n - 1)];
  const b = ruta[Math.min(i + 1, n - 1)];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Posición de cada micro AHORA (determinista por reloj), moviéndose por su ruta.
function posicionesAhora(ahoraMs) {
  return LINEAS.map((l, i) => {
    const periodo = 150000 + (i % 50) * 4000; // 2.5–5.8 min por tramo, varía por línea
    const desfase = (i * 37) % periodo;
    const raw = (((ahoraMs + desfase) / periodo) % 2 + 2) % 2;
    const frac = raw <= 1 ? raw : 2 - raw; // ping-pong 0..1..0 (ida y vuelta)
    const p = puntoEnRuta(l.ruta, frac);
    return {
      id: i, nombre: l.nombre, badge: l.badge, tipo: l.tipo, hacia: l.hacia, sindicato: l.sindicato,
      lat: p[0], lng: p[1], haciaDestino: raw <= 1,
    };
  });
}

// Rutas estáticas (para dibujarlas en el mapa una sola vez).
function rutas() {
  return LINEAS.map((l, i) => ({ id: i, nombre: l.nombre, badge: l.badge, tipo: l.tipo, hacia: l.hacia, sindicato: l.sindicato, ruta: l.ruta }));
}

function total() { return LINEAS.length; }

module.exports = { posicionesAhora, rutas, total };
