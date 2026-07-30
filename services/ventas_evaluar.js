// Evaluación de un chat con detección de repetidos y continuación.
// Compartido por el panel (subida manual) y el enlace en vivo por WhatsApp (Baileys).
const { EvaluacionVenta } = require("../db/models");
const { evaluarConversacion } = require("./ventas_scoring");
const conv = require("./ventas_conv");

const MAP = { tiempo_respuesta: "tiempoRespuesta", descubrimiento: "descubrimiento", objeciones: "objeciones", seguimiento: "seguimiento", cierre: "cierre", cumplimiento: "cumplimiento" };

// Evalúa un chat detectando repetidos y continuaciones:
//   - Chat idéntico ya subido        -> error REPETIDO ("necesito otro").
//   - Mismo chat sin mensajes nuevos -> error SIN_NUEVOS.
//   - Mismo chat con mensajes extra  -> evalúa SOLO lo nuevo.
//   - Chat distinto                  -> evalúa todo.
// convIdExplicito: fuerza la identidad de la conversación (para el enlace en vivo,
// donde el "archivo" no existe y agrupamos por el contacto del cliente).
async function evaluarChat(vendedor, textoNuevo, nombreArchivo, fechaConversacion, convIdExplicito) {
  const convId = convIdExplicito || conv.convId(nombreArchivo || "", textoNuevo);
  const convHash = conv.sha(conv.normaliza(textoNuevo));

  const previas = await EvaluacionVenta.findMany({
    where: { vendedorId: vendedor.id, convId },
    orderBy: { createdAt: "desc" }, take: 20,
  });

  if (previas.some(p => p.convHash && p.convHash === convHash)) {
    const err = new Error("Oye, este chat ya lo anexé antes (es idéntico). Necesito otro chat, o el mismo pero con mensajes nuevos.");
    err.code = "REPETIDO";
    throw err;
  }

  const prev = previas[0];
  let aEvaluar = textoNuevo, tipo = "nuevo";
  if (prev && prev.conversacion) {
    const r = conv.continuacion(prev.conversacion, textoNuevo);
    tipo = r.tipo;
    if (tipo === "igual") {
      const err = new Error("Este chat ya lo revisé y no tiene mensajes nuevos desde la última vez. Subí uno con conversación nueva.");
      err.code = "SIN_NUEVOS";
      throw err;
    }
    if (tipo === "continuacion") aEvaluar = r.texto; // solo la parte nueva
  }

  const ev = await evaluarConversacion(aEvaluar, vendedor.id);
  const data = {
    vendedorId: vendedor.id,
    fechaConversacion: fechaConversacion || new Date(),
    promedio: ev.promedio,
    fortalezas: ev.fortalezas, debilidades: ev.debilidades,
    mejoraConcreta: ev.mejora_concreta,
    conversacion: textoNuevo.slice(0, 60000), // chat completo, para comparar la próxima vez
    analisis: ev.analisis || null,
    convId, convHash,
  };
  for (const k of Object.keys(MAP)) data[MAP[k]] = ev.scores[k];
  const guardada = await EvaluacionVenta.create({ data });
  return { evaluacion: guardada, tipo };
}

module.exports = { evaluarChat, MAP };
