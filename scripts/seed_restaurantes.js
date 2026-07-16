// ChatGo — Carga inicial del catálogo de DELIVERY
//
// EDITÁ este archivo con tus locales reales (nombre, teléfono, coords, menú)
// y corrélo en la VM:   node scripts/seed_restaurantes.js
//
// Es idempotente: si un restaurante con el mismo nombre ya existe, lo salta
// (así podés agregar locales nuevos al final y volver a correr sin duplicar).
//
// Las coordenadas (lat/lng) IMPORTAN: con ellas el pedido se despacha solo
// con el motor del taxi (origen = restaurante). Sin coords, el pedido cae a
// coordinación manual del admin. Sacalas de Google Maps: clic derecho en el
// local → copiar coordenadas.

const { Restaurante, Plato, prisma } = require("../db/models");

const CATALOGO = [
  {
    nombre: "Pollos Copacabana",
    categorias: "pollo,broaster,comida rapida",
    telefono: "59162741818",  // encargado de prueba (EDITAR con el real del local)
    lat: -17.3939, lng: -66.1571,      // ← EDITAR (Google Maps → clic derecho → copiar coords)
    zona: "Centro",
    horario: "11:00 a 22:30",
    platos: [
      { nombre: "Pollo entero", precioBs: 58, etiquetas: "pollo,entero,broaster", descripcion: "Con papas y ensalada" },
      { nombre: "Medio pollo", precioBs: 30, etiquetas: "pollo,medio,broaster", descripcion: "Con papas" },
      { nombre: "Cuarto de pollo", precioBs: 17, etiquetas: "pollo,cuarto,broaster", descripcion: "Con arroz y papas" },
    ],
  },
  {
    nombre: "Pollos Kansas",
    categorias: "pollo,spiedo",
    telefono: "59162741818",  // encargado de prueba (EDITAR con el real del local)
    lat: -17.3862, lng: -66.1650,      // ← EDITAR
    zona: "Cala Cala",
    horario: "11:30 a 22:00",
    platos: [
      { nombre: "Pollo entero al spiedo", precioBs: 55, etiquetas: "pollo,entero,spiedo" },
      { nombre: "Medio pollo al spiedo", precioBs: 29, etiquetas: "pollo,medio,spiedo" },
    ],
  },
  {
    nombre: "Burger House CBBA",
    categorias: "hamburguesa,comida rapida",
    telefono: "59162741818",  // encargado de prueba (EDITAR con el real del local)
    lat: -17.3894, lng: -66.1602,      // ← EDITAR
    zona: "Centro",
    horario: "17:00 a 23:30",
    platos: [
      { nombre: "Hamburguesa doble", precioBs: 25, etiquetas: "hamburguesa,doble,carne" },
      { nombre: "Hamburguesa simple", precioBs: 16, etiquetas: "hamburguesa,simple,carne" },
      { nombre: "Salchipapa", precioBs: 12, etiquetas: "salchipapa,comida rapida" },
    ],
  },
  {
    nombre: "Pizzería Nápoles",
    categorias: "pizza,italiana",
    telefono: "59162741818",  // encargado de prueba (EDITAR con el real del local)
    lat: -17.3798, lng: -66.1585,      // ← EDITAR
    zona: "Recoleta",
    horario: "18:00 a 23:00",
    platos: [
      { nombre: "Pizza familiar", precioBs: 65, etiquetas: "pizza,familiar" },
      { nombre: "Pizza mediana", precioBs: 45, etiquetas: "pizza,mediana" },
      { nombre: "Pizza personal", precioBs: 25, etiquetas: "pizza,personal" },
    ],
  },
];

async function main() {
  let creados = 0, saltados = 0;
  for (const r of CATALOGO) {
    const existe = await Restaurante.findFirst({ where: { nombre: r.nombre } });
    if (existe) {
      // Ya existe: actualizar datos del local (teléfono, coords, horario) sin duplicar platos
      const { platos, ...datos } = r;
      await Restaurante.update({ where: { id: existe.id }, data: datos });
      console.log(`↻ actualizado: ${r.nombre}`);
      saltados++;
      continue;
    }
    const { platos, ...datos } = r;
    await Restaurante.create({
      data: { ...datos, platos: { create: platos } },
    });
    console.log(`✅ creado: ${r.nombre} (${platos.length} platos)`);
    creados++;
  }
  console.log(`\nListo: ${creados} restaurantes creados, ${saltados} ya existían.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
