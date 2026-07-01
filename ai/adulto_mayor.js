// ChatGo — Modo Adulto Mayor: respuestas por voz (TTS) + billetera familiar
//
// Dos capacidades, ambas sobre la infraestructura que ChatGo ya tiene:
//   1. responderPorVoz(): convierte texto en audio amigable y lo manda como nota de voz
//   2. Billetera familiar: un familiar recarga saldo y guarda lugares para el adulto mayor
//
// No reemplaza nada: es una capa adicional. El modo se activa por usuario
// (Usuario.modoAdultoMayor) y los familiares se vinculan por comandos de texto.

const { CONFIG, log } = require("../config");
const { Usuario } = require("../db/models");
const { generarAudioDesdeTexto } = require("../services/openai");
const { enviarVoz, enviarMensaje } = require("../services/whatsapp");

// ─── RESPUESTA POR VOZ ──────────────────────────────────────────────────────
// Manda la respuesta como audio si el usuario está en modo adulto mayor.
// Siempre manda también el texto como respaldo (por si el audio falla o no se escucha).
async function responderPorVoz(phone, texto, opciones = {}) {
  const usuario = opciones.usuario || await Usuario.findUnique({ where: { phone } });
  const usaVoz = usuario?.modoAdultoMayor || usuario?.respuestasPorVoz;

  if (!usaVoz) {
    // Modo normal: solo texto
    await enviarMensaje(phone, texto);
    return;
  }

  // Modo voz: generar audio y enviarlo
  // El texto para voz se limpia de emojis y formato markdown (suena raro leído)
  const textoParaVoz = limpiarTextoParaVoz(texto);
  const audio = await generarAudioDesdeTexto(textoParaVoz, opciones.voz || "shimmer");

  if (audio) {
    const ok = await enviarVoz(phone, audio);
    if (ok) {
      // Voz enviada. Texto de respaldo solo si se pidió explícitamente.
      if (opciones.textoRespaldo === true) {
        await enviarMensaje(phone, texto);
      }
    } else {
      // El envío de voz falló → SIEMPRE caer a texto para no dejar al usuario sin respuesta
      log.warn(`[VOZ] Falló envío de voz a ${phone}, usando texto como respaldo`);
      await enviarMensaje(phone, texto);
    }
  } else {
    // TTS falló: caer a texto
    await enviarMensaje(phone, texto);
  }
}

// Quita emojis y markdown para que el TTS no los lea en voz alta
function limpiarTextoParaVoz(texto) {
  return texto
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "") // emojis
    .replace(/\*([^*]+)\*/g, "$1")  // *negrita* → negrita
    .replace(/_([^_]+)_/g, "$1")    // _cursiva_ → cursiva
    .replace(/https?:\/\/\S+/g, "") // quitar URLs (no se leen)
    .replace(/\n{2,}/g, ". ")       // dobles saltos → pausa
    .replace(/\n/g, ". ")
    .replace(/\.\s*\.+/g, ".")      // colapsar puntos repetidos ".. ." → "."
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")    // espacio antes de puntuación
    .trim();
}

// ─── BILLETERA FAMILIAR ─────────────────────────────────────────────────────

// Vincula a un familiar con la cuenta del adulto mayor.
// El familiar ejecuta esto desde su propio WhatsApp.
async function vincularFamiliar(adultoPhone, familiarPhone, nombreFamiliar = "familiar") {
  const usuario = await Usuario.findUnique({ where: { phone: adultoPhone } });
  if (!usuario) return { ok: false, motivo: "no_existe" };

  const yaVinculado = usuario.familiaresVinculados?.some(f => f.phone === familiarPhone);
  if (yaVinculado) return { ok: true, motivo: "ya_vinculado" };

  const familiaresVinculados = usuario.familiaresVinculados || [];
  familiaresVinculados.push({ phone: familiarPhone, nombre: nombreFamiliar });
  await Usuario.update({
    where: { phone: adultoPhone },
    data: { familiaresVinculados, modoAdultoMayor: true }, // al vincular familiar, se asume modo adulto mayor
  });
  return { ok: true, motivo: "vinculado" };
}

// Verifica si un teléfono es familiar autorizado de algún adulto mayor.
// Devuelve la lista de cuentas que ese familiar gestiona.
async function cuentasQueGestiona(familiarPhone) {
  const todos = await Usuario.findMany();
  return todos.filter(u => u.familiaresVinculados?.some(f => f.phone === familiarPhone));
}

// Recarga saldo en la cuenta del adulto mayor. Solo un familiar vinculado puede hacerlo.
async function recargarSaldo(adultoPhone, familiarPhone, monto, comprobante = null) {
  const usuario = await Usuario.findUnique({ where: { phone: adultoPhone } });
  if (!usuario) return { ok: false, motivo: "no_existe" };

  const esFamiliar = usuario.familiaresVinculados?.some(f => f.phone === familiarPhone);
  if (!esFamiliar) return { ok: false, motivo: "no_autorizado" };

  if (!monto || monto <= 0) return { ok: false, motivo: "monto_invalido" };

  const saldoNuevo = (usuario.saldo || 0) + monto;
  const recargas = usuario.recargas || [];
  recargas.push({ monto, familiarPhone, comprobante, fecha: new Date() });
  await Usuario.update({ where: { phone: adultoPhone }, data: { saldo: saldoNuevo, recargas } });

  return { ok: true, saldoNuevo };
}

// Descuenta el costo del viaje del saldo. Devuelve si alcanzó y el saldo restante.
async function descontarViaje(adultoPhone, costo) {
  const usuario = await Usuario.findUnique({ where: { phone: adultoPhone } });
  if (!usuario) return { ok: false, motivo: "no_existe" };

  const saldoActual = usuario.saldo || 0;
  if (saldoActual < costo) {
    return { ok: false, motivo: "saldo_insuficiente", saldoActual, falta: costo - saldoActual };
  }

  const saldoNuevo = saldoActual - costo;
  await Usuario.update({ where: { phone: adultoPhone }, data: { saldo: saldoNuevo } });
  return { ok: true, saldoNuevo };
}

// Avisa a los familiares vinculados cuando el saldo está bajo (para que recarguen)
async function avisarSaldoBajoAFamiliares(adultoPhone, umbral = 20) {
  const usuario = await Usuario.findUnique({ where: { phone: adultoPhone } });
  if (!usuario || (usuario.saldo || 0) > umbral) return;
  if (!usuario.familiaresVinculados?.length) return;

  const nombre = usuario.nombre || "su familiar";
  for (const fam of usuario.familiaresVinculados) {
    await enviarMensaje(
      fam.phone,
      `💳 Hola. El saldo de ChatGo de *${nombre}* está bajo (Bs ${usuario.saldo || 0}).\n\nPuedes recargarle saldo para que siga viajando sin preocupaciones. Escribe *"recargar"* para hacerlo.`
    );
  }
}

// ─── GESTIÓN DE LUGARES FAMILIARES ─────────────────────────────────────────
const { guardarLugarOtros, eliminarLugarOtros, guardarLugarPersonal } = require("../services/utils");

async function _verificarFamiliar(adultoPhone, familiarPhone) {
  const u = await Usuario.findUnique({ where: { phone: adultoPhone } });
  if (!u) return { ok: false, motivo: "no_existe" };
  const esFamiliar = u.familiaresVinculados?.some(f => f.phone === familiarPhone);
  if (!esFamiliar) return { ok: false, motivo: "no_autorizado", usuario: u };
  return { ok: true, usuario: u };
}

// Familiar agrega un lugar personalizado a la cuenta del adulto mayor.
const _ALIAS_CASA    = ["casa", "mi casa", "hogar", "mi hogar", "home"];
const _ALIAS_TRABAJO = ["trabajo", "mi trabajo", "oficina", "mi oficina", "work"];

async function agregarLugarFamiliar(adultoPhone, familiarPhone, alias, lat, lng, nombre) {
  const { ok, motivo } = await _verificarFamiliar(adultoPhone, familiarPhone);
  if (!ok) return { ok: false, motivo };
  const norm = alias.toLowerCase().trim();
  if (_ALIAS_CASA.includes(norm)) {
    await guardarLugarPersonal(adultoPhone, "casa", lat, lng, nombre);
    // limpiar TODOS los alias de casa que pudieran estar en otros[]
    for (const a of _ALIAS_CASA) await eliminarLugarOtros(adultoPhone, a);
  } else if (_ALIAS_TRABAJO.includes(norm)) {
    await guardarLugarPersonal(adultoPhone, "trabajo", lat, lng, nombre);
    for (const a of _ALIAS_TRABAJO) await eliminarLugarOtros(adultoPhone, a);
  } else {
    await guardarLugarOtros(adultoPhone, alias, lat, lng, nombre);
  }
  return { ok: true };
}

// Familiar elimina un lugar personalizado.
async function eliminarLugarFamiliar(adultoPhone, familiarPhone, alias) {
  const { ok, motivo } = await _verificarFamiliar(adultoPhone, familiarPhone);
  if (!ok) return { ok: false, motivo };
  await eliminarLugarOtros(adultoPhone, alias);
  return { ok: true };
}

// Familiar lista los lugares guardados del adulto mayor.
async function listarLugaresFamiliar(adultoPhone, familiarPhone) {
  const { ok, motivo, usuario } = await _verificarFamiliar(adultoPhone, familiarPhone);
  if (!ok) return { ok: false, motivo };
  const lf = usuario.lugaresFrecuentes || {};
  return { ok: true, lugares: { casa: lf.casa || null, trabajo: lf.trabajo || null, otros: lf.otros || [] } };
}

module.exports = {
  responderPorVoz,
  limpiarTextoParaVoz,
  vincularFamiliar,
  cuentasQueGestiona,
  recargarSaldo,
  descontarViaje,
  avisarSaldoBajoAFamiliares,
  agregarLugarFamiliar,
  eliminarLugarFamiliar,
  listarLugaresFamiliar,
};
