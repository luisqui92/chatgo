// Rubro de evaluación de ventas — versionado y auditable (no hardcodeado en el
// prompt de scoring). Editá acá las dimensiones y su descripción.
module.exports = {
  version: "1.0",
  escala: "1 a 10 (1 = muy pobre, 10 = excelente)",
  regla: "Cada dimensión requiere una CITA TEXTUAL de la conversación como evidencia. Sin cita, el score no es válido.",
  dimensiones: [
    { key: "tiempo_respuesta", nombre: "Tiempo de respuesta", desc: "¿Responde rápido o deja al cliente esperando?" },
    { key: "descubrimiento", nombre: "Descubrimiento de necesidad", desc: "¿Pregunta para entender al cliente, o solo empuja el producto?" },
    { key: "objeciones", nombre: "Manejo de objeciones", desc: "¿Argumenta con valor ante las dudas, o se rinde?" },
    { key: "seguimiento", nombre: "Seguimiento", desc: "¿Insiste con tacto tras el silencio del cliente?" },
    { key: "cierre", nombre: "Cierre", desc: "¿Pide la venta de forma explícita?" },
    { key: "cumplimiento", nombre: "Cumplimiento de promesas", desc: "¿Hizo lo que dijo que haría?" },
  ],
};
