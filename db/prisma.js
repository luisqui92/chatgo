// ChatGo — Cliente Prisma (MySQL). Reemplaza la conexión Mongoose.
const { PrismaClient } = require("@prisma/client");
const { log } = require("../config");

const prisma = new PrismaClient();

prisma.$connect().then(
  () => log.info("✅ MySQL (Prisma) conectado"),
  (e) => log.error("❌ MySQL:", e.message)
);

module.exports = prisma;
