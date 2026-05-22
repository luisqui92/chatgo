// ═══════════════════════════════════════════════════════════════════════════
// IA de Pricing Inteligente
// Ajusta el precio según demanda, horario y escasez de choferes
// No es "tarifa dinámica agresiva" — es equilibrio inteligente
// ═══════════════════════════════════════════════════════════════════════════

const { Chofer, ListaEspera, Surge } = require("./models");
const { CONFIG, log } = require("./config");

// Horarios de alta demanda en Cochabamba
const HORAS_PICO = {
  manana: [7, 8, 9],      // entrada universidades/trabajo
  mediodia: [12, 13],     // salida al almuerzo
  tarde: [17, 18, 19],    // salida del trabajo
  noche: [22, 23],        // salida de eventos
};

// Días de alta demanda
const DIAS_ALTA_DEMANDA = {
  0: false, // Dom
  1: true,  // Lun
  2: true,  // Mar
  3: true,  // Mié
  4: true,  // Jue
  5: true,  // Vie — máxima demanda
  6: false, // Sáb — depende
};

async function calcularMultiplierSurge(origenLat, origenLng) {
  try {
    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const hora = ahora.getHours();
    const dia = ahora.getDay();

    let multiplier = 1.0;
    let motivos = [];

    // 1. Verificar escasez de choferes libres
    const choferesLibres = await Chofer.countDocuments({ estado: "libre" });
    const enEspera = await ListaEspera.countDocuments({});

    if (choferesLibres === 0) {
      multiplier = Math.max(multiplier, 1.3);
      motivos.push("sin_choferes");
    } else if (enEspera > choferesLibres * 2) {
      // Hay el doble de pasajeros esperando que choferes disponibles
      multiplier = Math.max(multiplier, 1.2);
      motivos.push("alta_demanda");
    }

    // 2. Hora pico
    const esManana = HORAS_PICO.manana.includes(hora);
    const esTarde = HORAS_PICO.tarde.includes(hora);
    const esNoche = HORAS_PICO.noche.includes(hora);

    if (esTarde && DIAS_ALTA_DEMANDA[dia]) {
      multiplier = Math.max(multiplier, 1.15);
      motivos.push("hora_pico_tarde");
    } else if (esManana) {
      multiplier = Math.max(multiplier, 1.1);
      motivos.push("hora_pico_manana");
    } else if (esNoche) {
      multiplier = Math.max(multiplier, 1.1);
      motivos.push("hora_pico_noche");
    }

    // 3. Viernes tarde = máxima demanda
    if (dia === 5 && esTarde) {
      multiplier = Math.max(multiplier, 1.25);
      motivos.push("viernes_tarde");
    }

    // Cap máximo de 1.5x (50% extra) para no ser abusivo
    multiplier = Math.min(1.5, multiplier);

    if (multiplier > 1.0) {
      log.info(`[PRICING] Surge x${multiplier} — motivos: ${motivos.join(", ")} — choferes libres: ${choferesLibres}`);
      // Registrar surge para análisis
      await Surge.create({ multiplier, motivo: motivos.join(","), viajesAfectados: enEspera }).catch(() => {});
    }

    return { multiplier, motivos };
  } catch (e) {
    log.error("[PRICING]", e.message);
    return { multiplier: 1.0, motivos: [] };
  }
}

// Aplica el multiplier al precio calculado
function aplicarSurge(precioBase, multiplier) {
  if (multiplier <= 1.0) return precioBase;
  return Math.ceil(precioBase * multiplier);
}

// Texto explicativo del surge para mostrar al usuario
function textoSurge(multiplier, motivos) {
  if (multiplier <= 1.0) return null;
  const pct = Math.round((multiplier - 1) * 100);

  if (motivos.includes("sin_choferes")) {
    return `⚠️ _Precio ajustado +${pct}% — hay poca disponibilidad de choferes en este momento._`;
  }
  if (motivos.includes("viernes_tarde") || motivos.includes("hora_pico_tarde")) {
    return `⚠️ _Precio ajustado +${pct}% por alta demanda en este horario._`;
  }
  return `⚠️ _Precio ajustado +${pct}% por alta demanda._`;
}

module.exports = { calcularMultiplierSurge, aplicarSurge, textoSurge };
