// ChatGo — Webhook de notificaciones bancarias (Yape vía MacroDroid)
// Permite auto-aprobar el pago diario del chofer apenas el banco confirma el
// depósito real, sin esperar a que el admin toque el botón "Aprobar" a mano.
// No reemplaza la foto del comprobante (sigue siendo el primer filtro vía IA);
// esto es una SEGUNDA confirmación, esta vez del lado del banco.
const { CONFIG, log } = require("../config");
const { fechaStrBolivia } = require("../services/utils");

// Extrae el monto en bolivianos de un texto de notificación tipo
// "Has recibido Bs10.00 de Juan Perez" / "Recibiste Bs. 10,00 ..."
function extraerMonto(texto) {
  const m = texto.match(/Bs\.?\s*([\d]+(?:[.,]\d{1,2})?)/i);
  if (!m) return null;
  return parseFloat(m[1].replace(",", "."));
}

module.exports = function (app, { Chofer, NotificacionPago, enviarMensaje, enviarBotones, deleteSession }) {
  // Resetea el pago diario del chofer de prueba para repetir el flujo desde cero.
  app.get("/admin/resetear-chofer-prueba", async (req, res) => {
    if (!CONFIG.PAGO_WEBHOOK_SECRET || req.headers["x-pago-secret"] !== CONFIG.PAGO_WEBHOOK_SECRET) {
      return res.sendStatus(401);
    }
    try {
      const phone = CONFIG.CHOFER_PRUEBA_PHONE;
      await Chofer.findOneAndUpdate({ phone }, {
        estado: "offline",
        "pagoDiario.fecha": null,
        "pagoDiario.fechaStr": null,
        "pagoDiario.pagado": false,
        "pagoDiario.aprobado": false,
        "pagoDiario.comprobanteValidado": false,
      });
      await deleteSession(phone);
      log.info(`[PAGO_YAPE] Chofer de prueba (+${phone}) reseteado`);
      res.json({ ok: true, phone });
    } catch (e) {
      log.error("[PAGO_YAPE] Error reseteando chofer de prueba", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/webhook/pago-yape", async (req, res) => {
    if (!CONFIG.PAGO_WEBHOOK_SECRET || req.headers["x-pago-secret"] !== CONFIG.PAGO_WEBHOOK_SECRET) {
      log.warn("[PAGO_YAPE] Secret inválido o no configurado, rechazado");
      return res.sendStatus(401);
    }
    res.sendStatus(200); // responder ya — MacroDroid no necesita esperar el procesamiento

    try {
      const texto = String(req.body?.texto || "").trim();
      if (!texto) return;
      log.info(`[PAGO_YAPE] Notificación recibida: "${texto}"`);

      const monto = extraerMonto(texto);
      const hoyStr = fechaStrBolivia();

      const pendientes = await Chofer.find({
        "pagoDiario.pagado": true,
        "pagoDiario.aprobado": false,
        "pagoDiario.comprobanteValidado": true,
        "pagoDiario.fechaStr": hoyStr,
      }).sort({ "pagoDiario.fecha": 1 });

      if (!pendientes.length) {
        // La notificación llegó antes que la foto del comprobante (es lo normal: el banco
        // avisa al instante, el chofer recién manda la foto después). La guardamos un rato
        // para que el flujo de validación del comprobante la matchee cuando llegue.
        await NotificacionPago.create({ texto, monto });
        log.info("[PAGO_YAPE] Sin choferes esperando aprobación todavía, notificación guardada para matchear después");
        return;
      }

      // Solo se aprueba automático si no hay ambigüedad: un único chofer pendiente,
      // o el monto extraído coincide con la cuota y deja un único candidato posible.
      // Si hay duda, se deja para que el admin apruebe a mano (no se arriesga a
      // aprobarle el pago al chofer equivocado).
      let candidato = pendientes.length === 1 ? pendientes[0] : null;
      if (!candidato && monto != null) {
        const conMontoCoincidente = pendientes.filter(() => monto >= CONFIG.CUOTA_DIARIA_BS - 0.5);
        if (conMontoCoincidente.length === 1) candidato = conMontoCoincidente[0];
      }

      if (!candidato) {
        log.warn(`[PAGO_YAPE] Ambigüedad: ${pendientes.length} choferes pendientes, no se pudo determinar a quién aprobar`);
        await enviarMensaje(CONFIG.ADMIN_PHONE, `⚠️ Llegó una notificación de pago (Bs ${monto ?? "?"}) pero hay ${pendientes.length} choferes esperando aprobación. Aprueba manualmente con los botones que ya te llegaron.`);
        return;
      }

      await Chofer.findByIdAndUpdate(candidato._id, {
        "pagoDiario.aprobado": true,
        "pagoDiario.fecha": new Date(),
        "pagoDiario.fechaStr": hoyStr,
        estado: "libre",
      });
      await enviarBotones(candidato.phone, `✅ *Pago confirmado automáticamente!*\n🚖 Ya estás LIBRE para recibir viajes.`, [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]);
      await enviarMensaje(CONFIG.ADMIN_PHONE, `🤖 Pago auto-aprobado: ${candidato.nombre} (+${candidato.phone}) — Bs ${monto ?? "?"}`);
      log.info(`[PAGO_YAPE] Auto-aprobado: ${candidato.nombre} (+${candidato.phone})`);
    } catch (e) {
      log.error("[PAGO_YAPE]", e.message);
    }
  });
};
