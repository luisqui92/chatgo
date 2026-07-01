// ChatGo — Flujo Familiar / Adulto Mayor
//
// Permite a un familiar configurar remotamente la cuenta de un adulto mayor:
//   1. Vincular su cuenta con la del adulto mayor (con confirmación del adulto)
//   2. Agregar lugares favoritos con nombre propio (iglesia, casa de Ana, hospital…)
//   3. Ver y eliminar lugares guardados
//   4. Recargar saldo
//
// El familiar usa su propio WhatsApp. El adulto mayor no necesita hacer nada técnico;
// solo confirmar la vinculación la primera vez.

const { log } = require("../config");
const { Usuario } = require("../db/models");
const { getSession, updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones, enviarPlantillaVincular } = require("../services/whatsapp");
const { obtenerDireccion } = require("../services/google");
const {
  vincularFamiliar, cuentasQueGestiona,
  agregarLugarFamiliar, eliminarLugarFamiliar, listarLugaresFamiliar,
} = require("../ai/adulto_mayor");

// ─── DETECCIÓN ────────────────────────────────────────────────────────────────

// Devuelve true si este mensaje es del flujo familiar (por keyword o step activo).
async function esMensajeFamiliar(phone, texto, buttonId, session) {
  // Step activo de flujo familiar
  if (session?.step?.startsWith("familiar_")) return true;
  // Botones del flujo familiar
  if (buttonId?.startsWith("familiar_")) return true;
  // Keywords de entrada
  if (!texto) return false;
  const t = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (
    t === "vincular" ||
    t === "mis cuentas" ||
    t === "cuentas que gestiono" ||
    t === "gestionar familiar" ||
    t.startsWith("vincular con") ||
    t.startsWith("configurar ")
  );
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────

const FAMILIAR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

async function manejarFlujoFamiliar(phone, mensaje, buttonId) {
  const texto = mensaje?.text?.body?.trim() || "";
  const location = mensaje?.location || null;
  const contacto = mensaje?.contacts?.[0] || null;
  const session = await getSession(phone) || {};
  const step = session.step || "";
  const t = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

  // ── Timeout de 5 min en steps de menú familiar (no en vinculación) ────────
  const stepsConTimeout = ["familiar_gestionando", "familiar_esperando_alias", "familiar_esperando_pin", "familiar_eliminando"];
  if (stepsConTimeout.includes(step) && session.familiarTs) {
    if (Date.now() - session.familiarTs > FAMILIAR_TIMEOUT_MS) {
      await deleteSession(phone);
      await enviarMensaje(phone, "⏱️ La sesión familiar expiró por inactividad.\n\nEscribí tu 📍 ubicación para pedir un viaje, o *\"mis cuentas\"* para volver al menú familiar.");
      return;
    }
  }
  // Actualizar timestamp en cada interacción dentro del flujo familiar
  if (step.startsWith("familiar_")) {
    await updateSession(phone, { ...session, familiarTs: Date.now() });
  }

  // ── Contacto compartido (en cualquier step de vinculación) ───────────────
  if (contacto && (!step || step === "familiar_inicio" || step === "familiar_esperando_telefono")) {
    const numContacto = contacto.phones?.[0]?.phone?.replace(/\D/g, "");
    if (numContacto && numContacto.length >= 7) {
      return await _iniciarVinculacion(phone, _normalizarPhone(numContacto), session);
    }
    await enviarMensaje(phone, "❌ El contacto compartido no tiene un número válido. Escribí el número manualmente.");
    return;
  }

  // ── Iniciar vinculación ──────────────────────────────────────────────────
  if (!step || step === "familiar_inicio" || t === "vincular" || t.startsWith("vincular con")) {
    // Si viene el teléfono directo en el mensaje ("vincular con 71234567")
    const matchInline = texto.match(/vincular\s+con\s+(\d{7,15})/i);
    if (matchInline) {
      return await _iniciarVinculacion(phone, _normalizarPhone(matchInline[1]), session);
    }
    await updateSession(phone, { step: "familiar_esperando_telefono" });
    await enviarMensaje(phone,
      "👴 *Modo Familiar — ChatGo*\n\n" +
      "¿Cuál es el número de WhatsApp de tu familiar?\n\n" +
      "Podés escribir el número o *compartir el contacto* directamente desde tu agenda 📇\n" +
      "Ej: _71234567_"
    );
    return;
  }

  // ── Esperando teléfono del adulto ────────────────────────────────────────
  if (step === "familiar_esperando_telefono") {
    const num = texto.replace(/\D/g, "");
    if (num.length < 7) {
      await enviarMensaje(phone, "❌ Número no válido. Escribí el número o compartí el contacto desde tu agenda 📇");
      return;
    }
    return await _iniciarVinculacion(phone, _normalizarPhone(num), session);
  }

  // ── Adulto mayor confirma/rechaza la vinculación ─────────────────────────
  if (step === "familiar_confirmando_vinculo") {
    // Si el adulto escribió texto (tocó el link y mandó "hola") → enviarle los botones ahora
    if (!buttonId) {
      const { familiarPhone: fPhone, nombreFamiliar: nFam } = session;
      const adulto = await Usuario.findUnique({ where: { phone } }).catch(() => null);
      const nombreAdulto = session?.waName || adulto?.nombre;
      await enviarBotones(phone,
        `👋 Hola${nombreAdulto ? `, *${nombreAdulto}*` : ""}.\n\n` +
        `*${nFam || fPhone}* quiere vincularse a tu cuenta de ChatGo para ayudarte a configurar tus lugares favoritos y recargar saldo.\n\n` +
        `¿Aceptas?`,
        [
          { id: "familiar_confirmar_vinculo", title: "✅ Sí, acepto" },
          { id: "familiar_rechazar_vinculo",  title: "❌ No acepto" },
        ]
      );
      return;
    }
    if (buttonId === "familiar_confirmar_vinculo") {
      const { familiarPhone, nombreFamiliar } = session;
      const nombreFamiliarFinal = nombreFamiliar || familiarPhone;
      const res = await vincularFamiliar(phone, familiarPhone, nombreFamiliarFinal);
      await deleteSession(phone);
      if (res.ok) {
        await enviarMensaje(phone,
          `✅ ¡Listo! *${nombreFamiliarFinal}* ya puede ayudarte a configurar tus lugares favoritos en ChatGo.`
        );
        await enviarMensaje(familiarPhone,
          `✅ *${phone}* aceptó la vinculación.\n\n` +
          `Ahora podés gestionar su cuenta. Escribe *"mis cuentas"* para empezar.`
        );
      } else {
        await enviarMensaje(phone, "❌ No se pudo completar la vinculación. Intenta de nuevo.");
      }
      return;
    }
    if (buttonId === "familiar_rechazar_vinculo") {
      const { familiarPhone } = session;
      await deleteSession(phone);
      await enviarMensaje(phone, "❌ Vinculación rechazada.");
      if (familiarPhone) {
        await enviarMensaje(familiarPhone, "❌ Tu familiar rechazó la solicitud de vinculación.");
      }
      return;
    }
  }

  // ── Mis cuentas (familiar ve qué adultos gestiona) ───────────────────────
  if (t === "mis cuentas" || t === "cuentas que gestiono" || buttonId === "familiar_mis_cuentas") {
    const cuentas = await cuentasQueGestiona(phone);
    if (!cuentas.length) {
      await enviarMensaje(phone,
        "📋 No gestionás ninguna cuenta todavía.\n\n" +
        'Escribe *"vincular"* para vincularte con un familiar.'
      );
      return;
    }
    if (cuentas.length === 1) {
      return await _mostrarMenuCuenta(phone, cuentas[0].phone, session);
    }
    // Más de una cuenta → mostrar lista para elegir
    const botones = cuentas.slice(0, 3).map(u => ({
      id: `familiar_cuenta_${u.phone}`,
      title: `👤 ${u.nombre || u.phone}`,
    }));
    await updateSession(phone, { step: "familiar_eligiendo_cuenta" });
    await enviarBotones(phone,
      "👥 *Tus cuentas vinculadas*\n\n¿Cuál querés gestionar?",
      botones
    );
    return;
  }

  // ── Selección de cuenta desde lista ──────────────────────────────────────
  if (step === "familiar_eligiendo_cuenta" && buttonId?.startsWith("familiar_cuenta_")) {
    const adultoPhone = buttonId.replace("familiar_cuenta_", "");
    return await _mostrarMenuCuenta(phone, adultoPhone, session);
  }

  // ── Menú de gestión de cuenta (ya sabe qué adulto) ───────────────────────
  if (step === "familiar_gestionando") {
    const adultoPhone = session.adultoPhone;
    if (!adultoPhone) { await deleteSession(phone); return; }

    if (buttonId === "familiar_ver_lugares") {
      return await _mostrarLugares(phone, adultoPhone);
    }
    if (buttonId === "familiar_agregar_lugar") {
      await updateSession(phone, { ...session, step: "familiar_esperando_alias" });
      await enviarMensaje(phone,
        "📍 *Agregar lugar*\n\n" +
        "¿Cómo se llama este lugar para tu familiar?\n\n" +
        "Ejemplos: _Iglesia_, _Casa de Ana_, _Hospital_, _Mercado_\n\n" +
        "Escribí el nombre:"
      );
      return;
    }
    if (buttonId === "familiar_eliminar_lugar") {
      return await _mostrarLugaresParaEliminar(phone, adultoPhone, session);
    }
    if (buttonId === "familiar_volver") {
      await deleteSession(phone);
      await enviarMensaje(phone, '↩️ Saliste del menú familiar. Escribe *"mis cuentas"* para volver.');
      return;
    }
  }

  // ── Esperando el nombre/alias del lugar nuevo ─────────────────────────────
  if (step === "familiar_esperando_alias") {
    if (!texto || texto.length < 2) {
      await enviarMensaje(phone, "❌ Nombre muy corto. Escribe el nombre del lugar:");
      return;
    }
    const alias = texto.trim().toLowerCase();
    await updateSession(phone, { ...session, step: "familiar_esperando_pin", aliasNuevo: alias });
    await enviarMensaje(phone,
      `📌 Perfecto, el lugar se llamará *"${alias}"*.\n\n` +
      "Ahora compartí la *ubicación* del lugar (botón 📎 → Ubicación)."
    );
    return;
  }

  // ── Esperando el pin de ubicación para el lugar nuevo ────────────────────
  if (step === "familiar_esperando_pin") {
    if (!location?.latitude) {
      await enviarMensaje(phone, "📍 Por favor compartí la ubicación usando el botón 📎 → Ubicación.");
      return;
    }
    const { adultoPhone, aliasNuevo } = session;
    const lat = location.latitude;
    const lng = location.longitude;
    // Resolver nombre legible de la dirección
    const nombreResuelto = await obtenerDireccion(lat, lng).catch(() => null) || aliasNuevo;
    const res = await agregarLugarFamiliar(adultoPhone, phone, aliasNuevo, lat, lng, nombreResuelto);
    if (res.ok) {
      await updateSession(phone, { ...session, step: "familiar_gestionando", aliasNuevo: undefined });
      await enviarMensaje(phone,
        `✅ Lugar *"${aliasNuevo}"* guardado.\n\n` +
        `Tu familiar ahora puede decir por audio:\n` +
        `🎤 _"quiero ir a ${aliasNuevo}"_ o _"llévame a ${aliasNuevo}"_\n\n` +
        `¿Querés agregar otro lugar?`
      );
      return await _mostrarMenuCuenta(phone, adultoPhone, session);
    } else {
      await enviarMensaje(phone, "❌ No se pudo guardar. Asegurate de estar vinculado con esa cuenta.");
    }
    return;
  }

  // ── Eliminar lugar: adulto eligió cuál borrar ─────────────────────────────
  if (step === "familiar_eliminando" && buttonId?.startsWith("familiar_borrar_")) {
    const alias = buttonId.replace("familiar_borrar_", "");
    const adultoPhone = session.adultoPhone;
    const res = await eliminarLugarFamiliar(adultoPhone, phone, alias);
    await updateSession(phone, { ...session, step: "familiar_gestionando" });
    if (res.ok) {
      await enviarMensaje(phone, `✅ Lugar *"${alias}"* eliminado.`);
    } else {
      await enviarMensaje(phone, `❌ No se pudo eliminar "${alias}".`);
    }
    return await _mostrarMenuCuenta(phone, adultoPhone, session);
  }

  // ── Salir del flujo familiar ──────────────────────────────────────────────
  if (t === "salir" || t === "volver" || t === "menu" || t === "menú" || buttonId === "familiar_salir") {
    await deleteSession(phone);
    await enviarMensaje(phone, "✅ Saliste del modo familiar.\n\nEnviá tu ubicación o escribí a dónde querés ir para pedir un viaje 🚖");
    return;
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  await enviarMensaje(phone,
    '⚠️ No entendí. Escribe *"mis cuentas"* para ver tus familiares vinculados,\no *"vincular"* para agregar uno nuevo.\n\nEscribí *"salir"* para volver a pedir viajes.'
  );
}

// ─── HELPERS PRIVADOS ─────────────────────────────────────────────────────────

// Agrega 591 (Bolivia) si el número no trae código de país
function _normalizarPhone(num) {
  const n = String(num).replace(/\D/g, "");
  if (n.startsWith("591") && n.length >= 11) return n;
  return "591" + n;
}

async function _iniciarVinculacion(familiarPhone, adultoPhone, session) {
  const familiar = await Usuario.findUnique({ where: { phone: familiarPhone } });
  // Preferir el nombre real de WhatsApp (guardado en sesión) sobre el nombre del DB
  const nombreFamiliar = session?.waName || familiar?.nombre || familiarPhone;

  await updateSession(adultoPhone, {
    step: "familiar_confirmando_vinculo",
    familiarPhone,
    nombreFamiliar,
  });
  await updateSession(familiarPhone, { step: "familiar_esperando_confirmacion", adultoPhone });

  const enviado = await enviarPlantillaVincular(adultoPhone, nombreFamiliar);

  if (enviado) {
    await enviarMensaje(familiarPhone,
      `📨 *Solicitud enviada*\n\nLe llegó una notificación a *${adultoPhone}* para que acepte la vinculación.\n\n_Te aviso cuando confirme._ ✅`
    );
  } else {
    // Fallback: link wa.me si la plantilla falla (ej: número no registrado en WhatsApp)
    const botNum = process.env.WHATSAPP_NUMBER || "59177908529";
    const link = `https://wa.me/${botNum}?text=hola`;
    await enviarMensaje(familiarPhone,
      `📨 *Solicitud lista*\n\nReenviá este link a *${adultoPhone}* para que acepte:\n\n${link}`
    );
  }
}

async function _mostrarMenuCuenta(familiarPhone, adultoPhone, session) {
  const adulto = await Usuario.findUnique({ where: { phone: adultoPhone } });
  const adultoSession = await getSession(adultoPhone);
  const nombre = adultoSession?.waName || adulto?.nombre || adultoPhone;
  const lf = adulto?.lugaresFrecuentes || {};
  const otros = lf.otros || [];
  const totalLugares = (lf.casa ? 1 : 0) + (lf.trabajo ? 1 : 0) + otros.length;

  await updateSession(familiarPhone, { step: "familiar_gestionando", adultoPhone });
  await enviarBotones(familiarPhone,
    `👤 *Cuenta de ${nombre}*\n\n` +
    `📌 Lugares guardados: ${totalLugares}\n` +
    `💰 Saldo: Bs ${adulto?.saldo || 0}\n\n` +
    `¿Qué querés hacer?`,
    [
      { id: "familiar_ver_lugares",    title: "📌 Ver lugares" },
      { id: "familiar_agregar_lugar",  title: "➕ Agregar lugar" },
      { id: "familiar_salir",          title: "🚖 Pedir viaje" },
    ]
  );
}

async function _mostrarLugares(familiarPhone, adultoPhone) {
  const res = await listarLugaresFamiliar(adultoPhone, familiarPhone);
  if (!res.ok) {
    await enviarMensaje(familiarPhone, "❌ No estás autorizado para ver los lugares de esta cuenta.");
    return;
  }
  const { lugares } = res;
  let msg = "📌 *Lugares guardados*\n\n";
  msg += `🏠 *Casa:* ${lugares.casa?.nombre || "_no guardada_"}\n`;
  msg += `💼 *Trabajo:* ${lugares.trabajo?.nombre || "_no guardado_"}\n`;
  if (lugares.otros.length) {
    msg += "\n*Otros lugares:*\n";
    for (const o of lugares.otros) {
      msg += `• _${o.alias}_: ${o.nombre || o.alias}\n`;
    }
  } else {
    msg += "\n_Sin otros lugares guardados todavía._\n";
  }
  msg += '\n\nEscribe *"mis cuentas"* para volver al menú.';
  await enviarMensaje(familiarPhone, msg);
}

async function _mostrarLugaresParaEliminar(familiarPhone, adultoPhone, session) {
  const res = await listarLugaresFamiliar(adultoPhone, familiarPhone);
  if (!res.ok || !res.lugares.otros.length) {
    await enviarMensaje(familiarPhone, "ℹ️ No hay lugares personalizados para eliminar.");
    return await _mostrarMenuCuenta(familiarPhone, adultoPhone, session);
  }
  const botones = res.lugares.otros.slice(0, 3).map(o => ({
    id: `familiar_borrar_${o.alias}`,
    title: `🗑️ ${o.alias}`,
  }));
  await updateSession(familiarPhone, { ...session, step: "familiar_eliminando", adultoPhone });
  await enviarBotones(familiarPhone, "🗑️ ¿Cuál lugar querés eliminar?", botones);
}

module.exports = { esMensajeFamiliar, manejarFlujoFamiliar };
