// ChatGo Bus — Simulación de trufis moviéndose hacia sus destinos REALES.
//
// Toma las coordenadas geocodificadas (data/lineas_coords.json) y simula cada
// micro yendo del centro a su destino real y volviendo (ida y vuelta), con
// posición determinista por reloj (sin estado en memoria: cualquiera que mire
// ve lo mismo). Es una SIMULACIÓN: el recorrido exacto no es real hasta que el
// sindicato suma su GPS — pero el destino y el nombre de cada línea SÍ lo son.

const fs = require("fs");
const path = require("path");
const { log } = require("../config");

const CENTRO = { lat: -17.3895, lng: -66.1568 }; // Plaza Colón, Cochabamba

function cargar() {
  try {
    const p = path.join(__dirname, "..", "data", "lineas_coords.json");
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    log.info(`[SIM_TRUFIS] ${arr.length} líneas con coordenadas cargadas`);
    return arr;
  } catch (e) {
    log.error("[SIM_TRUFIS]", e.message);
    return [];
  }
}

const LINEAS = cargar();

// Posición de cada micro AHORA (determinista por reloj). ida-y-vuelta
// centro↔destino con período distinto por línea para que no vayan sincronizados.
function posicionesAhora(ahoraMs) {
  return LINEAS.map((l, i) => {
    const periodo = 150000 + (i % 50) * 4000; // 2.5–5.8 min por tramo, varía por línea
    const desfase = (i * 37) % periodo;
    const raw = (((ahoraMs + desfase) / periodo) % 2 + 2) % 2;
    const frac = raw <= 1 ? raw : 2 - raw; // ping-pong 0..1..0
    // pequeña curva para que no sea una recta perfecta (más orgánico)
    const curva = Math.sin(frac * Math.PI) * 0.006 * (i % 2 === 0 ? 1 : -1);
    const lat = CENTRO.lat + (l.lat - CENTRO.lat) * frac + curva * 0.4;
    const lng = CENTRO.lng + (l.lng - CENTRO.lng) * frac + curva;
    return {
      nombre: l.nombre, tipo: l.tipo, hacia: l.hacia, sindicato: l.sindicato,
      lat, lng, haciaDestino: raw <= 1,
    };
  });
}

function total() { return LINEAS.length; }

module.exports = { posicionesAhora, total, CENTRO };
