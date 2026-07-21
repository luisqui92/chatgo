// ChatGo Bus — Importa las rutas REALES desde los 142 HTML de líneas.
//
// Cada HTML (Línea NNN · ChatGo Bus) trae el recorrido real como `const P=[[lat,lng],...]`
// más el número, nombre y sindicato. Este script lee TODOS los HTML de una
// carpeta, extrae la ruta y los datos, los une con el destino ("hacia") del CSV,
// y genera data/lineas_coords.json — que usa la simulación (/trufis) y el mapa.
//
//   node scripts/importar_rutas_html.js [carpeta_html]
//   (por defecto: data/rutas_html/)

const fs = require("fs");
const path = require("path");
const { TODAS, norm } = require("../services/lineasreales");

function tipoDe(nombre) {
  const n = (nombre || "").toLowerCase();
  if (n.startsWith("microbus")) return "micro";
  if (n.startsWith("minibus")) return "minibus";
  if (n.startsWith("trufi")) return "trufi";
  if (n.includes("telef")) return "teleferico";
  if (n.startsWith("linea ") || n.startsWith("línea ")) return "tren";
  return "trufi";
}

function tarifaNum(s) {
  const m = (s || "").match(/([\d.,]+)/);
  return m ? parseFloat(m[1].replace(",", ".")) : 2.5;
}

// buscar el "hacia" (destino) del CSV para esta línea, por nombre
function haciaDelCsv(nombre, badge) {
  const nN = norm(nombre);
  let hit = TODAS.find((l) => norm(l.nombre) === nN);
  if (!hit && badge) hit = TODAS.find((l) => norm(l.nombre).endsWith(" " + norm(badge)) || norm(l.nombre) === norm(badge));
  return hit ? hit.hacia : null;
}

function main() {
  const dir = process.argv[2] || path.join(__dirname, "..", "data", "rutas_html");
  if (!fs.existsSync(dir)) { console.error(`No existe la carpeta: ${dir}`); process.exit(1); }
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".html"));
  console.log(`Procesando ${files.length} archivos HTML de ${dir}...\n`);

  const out = [];
  let sinRuta = 0;
  for (const f of files) {
    const html = fs.readFileSync(path.join(dir, f), "utf8");
    const badge = (html.match(/class="badge">([^<]+)</) || [])[1] || "";
    const name = (html.match(/class="name">([^<]+)</) || [])[1] || ("Línea " + badge);
    const sub = (html.match(/class="sub">([^<]+)</) || [])[1] || "";
    const fvs = [...html.matchAll(/class="fv">([^<]+)</g)].map((m) => m[1]);
    const mP = html.match(/const\s+P\s*=\s*(\[\[[\s\S]*?\]\])\s*;/);
    if (!mP) { sinRuta++; console.log(`  ⚠️  ${f}: sin ruta (P)`); continue; }
    let ruta;
    try { ruta = JSON.parse(mP[1]); } catch { sinRuta++; console.log(`  ⚠️  ${f}: ruta ilegible`); continue; }
    ruta = ruta.map((p) => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]);
    const dest = ruta[ruta.length - 1];
    out.push({
      nombre: name.trim(),
      badge: badge.trim(),
      tipo: tipoDe(name),
      hacia: haciaDelCsv(name, badge) || "",
      sindicato: sub && sub.toLowerCase() !== "default" ? sub.trim() : null,
      tarifa: tarifaNum(fvs[0]),
      horario: fvs[1] || null,
      frecuencia: fvs[2] || null,
      lat: dest[0], lng: dest[1],
      ruta,
    });
    console.log(`  ✅ ${name}  ·  ${ruta.length} pts  ·  ${sub || "s/sind"}`);
  }

  out.sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
  const dest = path.join(__dirname, "..", "data", "lineas_coords.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`\n✅ ${out.length} líneas con ruta REAL → data/lineas_coords.json (${kb} KB)`);
  console.log(`   (${sinRuta} sin ruta)`);
}

main();
