// Carga los tipos de vidrio de la vidriería con su precio por pie².
// Uso en el VM:  cd ~/chatgo-app && node scripts/seed_vidrios.js
const fs = require("fs");
const path = require("path");
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

const prisma = require("../db/prisma");

const VIDRIOS = [
  { nombre: "Vidrio doble", precioPie: 12 },
  { nombre: "4mm bronce", precioPie: 15 },
  { nombre: "4mm incoloro", precioPie: 15 },
  { nombre: "Espejo", precioPie: 15 },
  { nombre: "Catedral", precioPie: 15 },
];

async function main() {
  for (const v of VIDRIOS) {
    const existe = await prisma.vidrioCarp.findFirst({ where: { nombre: v.nombre } });
    if (existe) {
      await prisma.vidrioCarp.update({ where: { id: existe.id }, data: { precioPie: v.precioPie, activo: true } });
      console.log(`  · Actualizado: ${v.nombre} → Bs ${v.precioPie}/pie²`);
    } else {
      await prisma.vidrioCarp.create({ data: { nombre: v.nombre, precioPie: v.precioPie } });
      console.log(`  ✅ Creado: ${v.nombre} → Bs ${v.precioPie}/pie²`);
    }
  }
  await prisma.$disconnect();
  console.log("Listo. Entrá al panel → pestaña Vidrio.");
}

main().catch((e) => { console.error(e); process.exit(1); });
