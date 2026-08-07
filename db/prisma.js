// ChatGo — Cliente Prisma (MySQL).
const { PrismaClient } = require("@prisma/client");
const { log } = require("../config");

const prisma = new PrismaClient();

// FAIL-FAST: si la base no conecta al arrancar, NO seguimos corriendo "sanos"
// (antes se logueaba el error y la app arrancaba igual, respondiendo mal a cada
// mensaje). Reintentamos unas veces con espera creciente; si aun así no conecta,
// salimos para que PM2 reinicie y vuelva a intentar hasta que la base esté arriba.
(async function conectarConReintentos() {
  const intentos = 5;
  for (let i = 1; i <= intentos; i++) {
    try {
      await prisma.$connect();
      log.info("✅ MySQL (Prisma) conectado");
      return;
    } catch (e) {
      log.error(`❌ MySQL intento ${i}/${intentos}: ${e.message}`);
      if (i < intentos) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  log.error("💥 MySQL no disponible tras varios intentos. Salgo para que PM2 reinicie.");
  process.exit(1);
})();

module.exports = prisma;
