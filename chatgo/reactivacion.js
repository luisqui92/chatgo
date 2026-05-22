// ═══════════════════════════════════════════════════════════════════════════
// IA de Reactivación y Retención de Usuarios
// Detecta usuarios inactivos y los reactiva con promos personalizadas
// ═══════════════════════════════════════════════════════════════════════════

const { Usuario, Viaje, CodigoPromo } = require("./models");
const { CONFIG, log } = require("./config");

const DIAS_INACTIVIDAD_PROMO = 15; // días sin usar antes de mandar promo

// Genera un código de reactivación para un usuario inactivo
async function crearCodigoReactivacion(phone) {
  const crypto = require("crypto");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  const codigo = `REACT-${random}`;
  const fechaVenc = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días

  await CodigoPromo.create({
    codigo,
    descuentoPorcentaje: 30, // 30% para reactivación
    generadoPor: phone,
    tipoOrigen: "reactivacion",
    fechaVencimiento: fechaVenc,
  });
  return codigo;
}

// Detecta usuarios inactivos y les manda una promo (se llama cada 24hs)
async function procesarReactivaciones(enviarMensajeFn) {
  try {
    const limiteInactividad = new Date(Date.now() - DIAS_INACTIVIDAD_PROMO * 24 * 60 * 60 * 1000);

    // Usuarios que no piden taxi hace más de 15 días y no recibieron promo de reactivación
    const usuariosInactivos = await Usuario.find({
      aceptoTerminos: true,
      promoReactivacionEnviada: { $ne: true },
      $or: [
        { ultimoViajeAt: { $lt: limiteInactividad } },
        { ultimoViajeAt: { $exists: false }, createdAt: { $lt: limiteInactividad } },
      ],
    }).limit(20).lean(); // Procesar de a 20 para no saturar

    log.info(`[REACTIVACION] ${usuariosInactivos.length} usuarios inactivos encontrados`);

    for (const usuario of usuariosInactivos) {
      try {
        const codigo = await crearCodigoReactivacion(usuario.phone);
        const nombre = usuario.nombre ? ` ${usuario.nombre}` : "";

        const mensaje =
          `👋 ¡Hola${nombre}! Te extrañamos en ChatGo.\n\n` +
          `🎁 Tenemos un código especial para vos:\n\n` +
          `*${codigo}*\n` +
          `30% OFF en tu próximo viaje\n` +
          `_Válido por 7 días_\n\n` +
          `📍 Pedí tu taxi escribiendo tu ubicación o mandando un audio.\n` +
          `¡Te esperamos! 🚖`;

        await enviarMensajeFn(usuario.phone, mensaje);
        await Usuario.findOneAndUpdate(
          { phone: usuario.phone },
          { promoReactivacionEnviada: true }
        );

        log.info(`[REACTIVACION] Promo enviada a ${usuario.phone}`);
        await new Promise(r => setTimeout(r, 1000)); // Rate limit
      } catch (eInner) {
        log.error(`[REACTIVACION] Error para ${usuario.phone}:`, eInner.message);
      }
    }
  } catch (e) {
    log.error("[REACTIVACION]", e.message);
  }
}

// Actualiza la fecha del último viaje de un usuario (llamar al completar viaje)
async function actualizarUltimoViaje(usuarioPhone) {
  try {
    await Usuario.findOneAndUpdate(
      { phone: usuarioPhone },
      {
        ultimoViajeAt: new Date(),
        promoReactivacionEnviada: false, // Reset para que pueda recibir otra en el futuro
      }
    );
  } catch (e) {
    log.error("[REACTIVACION] actualizarUltimoViaje:", e.message);
  }
}

module.exports = { procesarReactivaciones, actualizarUltimoViaje, crearCodigoReactivacion };
