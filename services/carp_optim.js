// Optimización de corte 1D (cutting stock) para barras de aluminio de 6 m.
// Reparte una lista de piezas (largos en mm) en la menor cantidad de barras,
// dejando ver el desperdicio. Usa First-Fit Decreasing (heurística rápida y
// muy buena en la práctica) contemplando el ancho de sierra (kerf).

// piezas: [{ largo:mm, nota, ancho, alto }]  (cada objeto = UNA pieza a cortar)
// largoBarra: mm (6000)  ·  kerf: mm que consume cada corte
function optimizarBarras(piezas, largoBarra = 6000, kerf = 4) {
  const items = piezas
    .filter(p => p.largo > 0)
    .map(p => ({ ...p, largo: Math.round(p.largo) }))
    .sort((a, b) => b.largo - a.largo);

  // Piezas más largas que la barra: no entran; se reportan aparte.
  const imposibles = items.filter(p => p.largo > largoBarra);
  const cortables = items.filter(p => p.largo <= largoBarra);

  const barras = []; // [{ piezas:[], usado:mm }]
  for (const p of cortables) {
    let colocada = false;
    for (const barra of barras) {
      const extra = barra.piezas.length ? kerf : 0; // un corte separa de la pieza previa
      if (barra.usado + extra + p.largo <= largoBarra) {
        barra.piezas.push(p);
        barra.usado += extra + p.largo;
        colocada = true;
        break;
      }
    }
    if (!colocada) barras.push({ piezas: [p], usado: p.largo });
  }

  const totalPiezasMm = cortables.reduce((s, p) => s + p.largo, 0);
  const totalBarrasMm = barras.length * largoBarra;
  const desperdicioMm = totalBarrasMm - barras.reduce((s, b) => s + b.usado, 0);
  const retazos = barras.map(b => largoBarra - b.usado); // sobrante por barra

  return {
    barras,                       // detalle por barra (qué piezas caen en cada una)
    cantidadBarras: barras.length,
    largoBarra,
    totalPiezasMm,                // mm netos de pieza
    desperdicioMm,                // mm que se botan (incluye cortes)
    aprovechamiento: totalBarrasMm ? Math.round((totalPiezasMm / totalBarrasMm) * 1000) / 10 : 0, // %
    retazos,                      // sobrante final de cada barra (mm)
    imposibles,                   // piezas que no caben en una barra
  };
}

module.exports = { optimizarBarras };
