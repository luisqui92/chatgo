// Cotización de vidrio por PIE CUADRADO (así se vende la vidriería en Bolivia).
// Regla del negocio: a cada medida se le suma un margen de desperdicio por lado,
// se convierte a pie² y se calcula el precio EXACTO ("cabal") y el REDONDEADO a
// múltiplo de 5.
const PIE_CM = 30.48; // 1 pie = 30.48 cm (pie real). Algunas vidrierías usan 30.

// datos: { ancho(cm), alto(cm), cantidad, precioPie(Bs/pie²), desperdicioCm, pieCm }
function cotizarVidrio(datos) {
  const a = Number(datos.ancho) || 0;
  const h = Number(datos.alto) || 0;
  const q = Math.max(1, parseInt(datos.cantidad) || 1);
  const desp = datos.desperdicioCm != null ? Number(datos.desperdicioCm) : 7;
  const pieCm = datos.pieCm != null ? Number(datos.pieCm) : PIE_CM;
  const precioPie = Number(datos.precioPie) || 0;

  const anchoDesp = a + desp;              // +desperdicio por lado
  const altoDesp = h + desp;
  const pie2Unidad = (anchoDesp / pieCm) * (altoDesp / pieCm);
  const pie2Total = pie2Unidad * q;
  const exacto = pie2Total * precioPie;

  return {
    anchoDesp: Math.round(anchoDesp * 10) / 10,
    altoDesp: Math.round(altoDesp * 10) / 10,
    pie2Unidad: Math.round(pie2Unidad * 100) / 100,
    pie2Total: Math.round(pie2Total * 100) / 100,
    precioCabal: Math.round(exacto * 100) / 100,      // exacto
    precioRedondeado: Math.round(exacto / 5) * 5,      // a múltiplo de 5 (más cercano)
  };
}

module.exports = { cotizarVidrio, PIE_CM };
