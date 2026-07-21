// ChatGo Bus — Geocodifica los DESTINOS de las 141 líneas reales UNA sola vez.
//
// Lee data/lineas_cochabamba.csv, geocodifica el destino ("hacia") de cada
// línea con Google (validando que caiga dentro de Cochabamba) y guarda el
// resultado en data/lineas_coords.json. Con esas coordenadas se arma la
// simulación de trufis moviéndose hacia su destino REAL.
//
// Se corre UNA vez en el VM (usa tu key de Google). El costo es ~Bs 5 o $0
// (entra en el free tier). Los resultados quedan cacheados para siempre.
//
//   cd ~/chatgo-app && node scripts/geocodificar_lineas.js

const fs = require("fs");
const path = require("path");

// Cargar .env (este script corre suelto)
(function cargarEnv() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    for (const linea of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
})();

// Geocodificador CRUDO (no el estricto del taxi): para la simulación del bus
// un punto aproximado del destino alcanza, así entran barrios, calles y zonas.
const { geocodificarDireccion, calcularRutasConTrafico, dentroDeCocha } = require("../services/google");
const { TODAS } = require("../services/lineasreales");

const CENTRO = { lat: -17.3895, lng: -66.1568 }; // Plaza Colón — arranque simulado de cada línea

// Destinos que NO son lugares (colores, descriptores) → no se geocodifican
function esVago(hacia) {
  const n = (hacia || "").toLowerCase().trim();
  if (/^(verde|azul|naranja|roja|rojo|amarilla|amarillo|blanco|negro|celeste)$/.test(n)) return true;
  if (/panter|bandera|letras|n[úu]mero|nro\.?|sin bandera|color/.test(n)) return true;
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const out = [];
  let vagos = 0, fallos = 0;
  console.log(`Geocodificando ${TODAS.length} líneas...\n`);
  for (const l of TODAS) {
    if (esVago(l.hacia)) { vagos++; continue; }
    let g = null;
    try { g = await geocodificarDireccion(l.hacia, true, "Cochabamba"); } catch (_) {}
    // Aceptar cualquier resultado dentro del área metropolitana de Cochabamba
    const enCocha = g && g.lat && (typeof dentroDeCocha !== "function" || dentroDeCocha(g.lat, g.lng));
    if (enCocha) {
      // Recorrido por CALLES REALES del centro al destino (para dibujar la ruta
      // y mover el micro por ella). Si la ruta falla, queda la recta centro→destino.
      let ruta = [[CENTRO.lat, CENTRO.lng], [g.lat, g.lng]];
      try {
        const rutas = await calcularRutasConTrafico(CENTRO, { lat: g.lat, lng: g.lng });
        if (rutas && rutas[0] && rutas[0].puntos && rutas[0].puntos.length > 1) {
          ruta = rutas[0].puntos.map((p) => [Number(p.lat.toFixed(5)), Number(p.lng.toFixed(5))]);
        }
      } catch (_) {}
      out.push({ nombre: l.nombre, hacia: l.hacia, sindicato: l.sindicato, tipo: l.tipo, lat: g.lat, lng: g.lng, ruta });
      console.log(`  ✅ ${l.nombre} → ${l.hacia}  (${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}) · ${ruta.length} pts`);
    } else {
      fallos++;
      console.log(`  ⚠️  ${l.nombre} → ${l.hacia}  (no se pudo ubicar)`);
    }
    await sleep(150);
  }
  const dest = path.join(__dirname, "..", "data", "lineas_coords.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`\n✅ ${out.length}/${TODAS.length} líneas con coordenadas → data/lineas_coords.json`);
  console.log(`   (${vagos} destinos vagos omitidos, ${fallos} no ubicados)`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
