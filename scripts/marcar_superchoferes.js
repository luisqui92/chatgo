// ChatGo — Marca números como SUPERCHOFERES (tipoVehiculo = "todo").
//
// Un superchofer recibe CUALQUIER tipo de servicio: taxi, moto, van,
// delivery y ambulancia. Combinado con CHOFER_PRUEBA_PHONE (lista separada
// por comas), además se le fuerza la asignación sin filtros de distancia/
// ciudad para ver la secuencia de llegada de trabajos entre varios números.
//
// Uso en el VM:
//   cd ~/chatgo-app
//   node scripts/marcar_superchoferes.js 59176496075 591XXXXXXXX 591YYYYYYYY 591ZZZZZZZZ
//
// Reporta si cada número ya está registrado como chofer y si tiene GPS
// (traccarId) para poder recibir viajes.

const prisma = require("../db/prisma");

async function main() {
  const phones = process.argv.slice(2).map((n) => n.trim()).filter(Boolean);
  if (!phones.length) {
    console.log("Uso: node scripts/marcar_superchoferes.js <phone1> <phone2> ...");
    process.exit(1);
  }

  for (const phone of phones) {
    const chofer = await prisma.chofer.findUnique({ where: { phone } });
    if (!chofer) {
      console.log(`⚠️  ${phone}: NO está registrado como chofer todavía. ` +
        `Debe hacer el alta por WhatsApp (mandar "soy chofer") y tener la app de GPS andando antes de recibir viajes.`);
      continue;
    }
    await prisma.chofer.update({ where: { phone }, data: { tipoVehiculo: "todo" } });
    const gps = chofer.traccarId ? `GPS OK (traccarId ${chofer.traccarId})` : "⚠️ SIN GPS (traccarId vacío) — no recibirá hasta vincular la app";
    console.log(`✅ ${phone}: ahora es SUPERCHOFER (tipoVehiculo="todo"). ${gps}. Nombre: ${chofer.nombre || "s/n"}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
