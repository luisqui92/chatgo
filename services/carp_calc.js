// Motor de cálculo del panel de corte de aluminio.
//   1) Evalúa las fórmulas de despiece (en función de A=ancho y H=alto, en mm).
//   2) Junta todas las piezas de todos los ítems de la cotización.
//   3) Optimiza el corte por perfil en barras de 6 m (carp_optim).
//   4) Suma vidrio (m²) y accesorios, y calcula los costos.
const { optimizarBarras } = require("./carp_optim");

// Evaluador de fórmulas SEGURO: solo números, A, H, + - * / ( ) y unas pocas
// funciones. Se valida con lista blanca y recién ahí se evalúa. Nunca ejecuta
// código arbitrario del usuario.
const FUNCS = { round: Math.round, ceil: Math.ceil, floor: Math.floor, max: Math.max, min: Math.min, abs: Math.abs };
function evalFormula(formula, A, H) {
  const f = String(formula == null ? "" : formula).trim();
  if (!f) return 0;
  // Permitido: dígitos, punto, A, H, operadores, paréntesis, comas, espacios y nombres de función conocidos.
  const limpio = f.replace(/round|ceil|floor|max|min|abs/gi, "");
  if (!/^[0-9A-Za-z.+\-*/(),\s]*$/.test(f) || /[A-Za-z]/.test(limpio.replace(/[AH]/g, ""))) {
    throw new Error(`Fórmula inválida: "${f}" (usá solo números, A, H, + - * / ( ) y round/ceil/floor/max/min)`);
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("A", "H", "round", "ceil", "floor", "max", "min", "abs", `"use strict"; return (${f});`);
    const v = fn(A, H, FUNCS.round, FUNCS.ceil, FUNCS.floor, FUNCS.max, FUNCS.min, FUNCS.abs);
    return Number.isFinite(v) ? v : 0;
  } catch (e) {
    throw new Error(`No pude calcular la fórmula "${f}": ${e.message}`);
  }
}

// Convierte los catálogos (arrays) en mapas por id para acceso rápido.
function indexar(arr) { const m = {}; for (const x of arr) m[x.id] = x; return m; }

// items: [{ productoId, ancho(mm), alto(mm), cantidad }]
// catalogos: { productos, perfiles, vidrios, accesorios }
// opts: { kerf, descuento(%), manoObra(Bs) }
function calcularCotizacion(items, catalogos, opts = {}) {
  const kerf = opts.kerf != null ? Number(opts.kerf) : 4;
  const productos = indexar(catalogos.productos);
  const perfiles = indexar(catalogos.perfiles);
  const vidrios = indexar(catalogos.vidrios);
  const accesorios = indexar(catalogos.accesorios);

  const piezasPorPerfil = {}; // perfilId -> [{ largo, nota, ancho, alto }]
  const vidrioAgg = {};       // vidrioId -> m²
  const accAgg = {};          // accesorioId -> cantidad
  const avisos = [];

  for (const it of items) {
    const prod = productos[it.productoId];
    const A = Number(it.ancho) || 0, H = Number(it.alto) || 0;
    const qty = Math.max(1, parseInt(it.cantidad) || 1);
    if (!prod) { avisos.push(`Producto no encontrado en un ítem.`); continue; }
    if (A <= 0 || H <= 0) { avisos.push(`${prod.nombre}: falta ancho/alto.`); continue; }

    const piezas = Array.isArray(prod.piezas) ? prod.piezas : [];
    for (const pz of piezas) {
      const perfil = perfiles[pz.perfilId];
      if (!perfil) { avisos.push(`${prod.nombre}: un perfil de la receta ya no existe.`); continue; }
      const cant = Math.max(0, parseInt(pz.cantidad) || 0);
      const largo = evalFormula(pz.formula, A, H);
      if (largo <= 0 || cant <= 0) continue;
      (piezasPorPerfil[pz.perfilId] = piezasPorPerfil[pz.perfilId] || []);
      for (let u = 0; u < qty; u++)
        for (let c = 0; c < cant; c++)
          piezasPorPerfil[pz.perfilId].push({ largo, nota: `${prod.nombre} ${A}×${H}`, ancho: A, alto: H });
    }

    const vids = Array.isArray(prod.vidrios) ? prod.vidrios : [];
    for (const v of vids) {
      const cant = Math.max(0, parseInt(v.cantidad) || 0);
      const va = evalFormula(v.formulaAncho, A, H);
      const vh = evalFormula(v.formulaAlto, A, H);
      if (va <= 0 || vh <= 0 || cant <= 0) continue;
      const m2 = (va / 1000) * (vh / 1000) * cant * qty;
      vidrioAgg[v.vidrioId] = (vidrioAgg[v.vidrioId] || 0) + m2;
    }

    const accs = Array.isArray(prod.accesorios) ? prod.accesorios : [];
    for (const a of accs) {
      const cant = a.formula ? evalFormula(a.formula, A, H) : (parseInt(a.cantidad) || 0);
      if (cant <= 0) continue;
      accAgg[a.accesorioId] = (accAgg[a.accesorioId] || 0) + cant * qty;
    }
  }

  // Optimización de corte + costo por perfil
  const detallePerfiles = [];
  let costoPerfiles = 0;
  for (const perfilId of Object.keys(piezasPorPerfil)) {
    const perfil = perfiles[perfilId];
    const opt = optimizarBarras(piezasPorPerfil[perfilId], perfil.largoBarraMm || 6000, kerf);
    const costo = opt.cantidadBarras * (perfil.precioBarra || 0);
    costoPerfiles += costo;
    if (opt.imposibles.length) avisos.push(`${perfil.nombre}: ${opt.imposibles.length} pieza(s) más largas que la barra de ${(perfil.largoBarraMm||6000)/1000} m.`);
    detallePerfiles.push({
      perfilId, nombre: perfil.nombre, linea: perfil.linea, color: perfil.color,
      largoBarraMm: perfil.largoBarraMm || 6000, precioBarra: perfil.precioBarra || 0,
      cantidadPiezas: piezasPorPerfil[perfilId].length,
      cantidadBarras: opt.cantidadBarras, aprovechamiento: opt.aprovechamiento,
      desperdicioMm: opt.desperdicioMm, retazos: opt.retazos,
      barras: opt.barras.map(b => ({ usado: b.usado, sobra: (perfil.largoBarraMm||6000) - b.usado, piezas: b.piezas.map(p => p.largo) })),
      costo: Math.round(costo * 100) / 100,
    });
  }
  detallePerfiles.sort((a, b) => b.costo - a.costo);

  // Vidrio
  const detalleVidrios = Object.keys(vidrioAgg).map(id => {
    const v = vidrios[id]; const m2 = Math.round(vidrioAgg[id] * 1000) / 1000;
    const costo = Math.round(m2 * (v?.precioM2 || 0) * 100) / 100;
    return { vidrioId: id, nombre: v?.nombre || "Vidrio", m2, precioM2: v?.precioM2 || 0, costo };
  });
  const costoVidrio = detalleVidrios.reduce((s, x) => s + x.costo, 0);

  // Accesorios
  const detalleAccesorios = Object.keys(accAgg).map(id => {
    const a = accesorios[id]; const cant = Math.ceil(accAgg[id] * 100) / 100;
    const costo = Math.round(cant * (a?.precio || 0) * 100) / 100;
    return { accesorioId: id, nombre: a?.nombre || "Accesorio", unidad: a?.unidad || "u", cantidad: cant, precio: a?.precio || 0, costo };
  });
  const costoAccesorios = detalleAccesorios.reduce((s, x) => s + x.costo, 0);

  const materiales = Math.round((costoPerfiles + costoVidrio + costoAccesorios) * 100) / 100;
  const manoObra = Number(opts.manoObra) || 0;
  const subtotal = Math.round((materiales + manoObra) * 100) / 100;
  const descuentoPct = Math.max(0, Math.min(100, Number(opts.descuento) || 0));
  const descuentoBs = Math.round(subtotal * (descuentoPct / 100) * 100) / 100;
  const total = Math.round((subtotal - descuentoBs) * 100) / 100;

  return {
    perfiles: detallePerfiles,
    vidrios: detalleVidrios,
    accesorios: detalleAccesorios,
    costos: { perfiles: Math.round(costoPerfiles * 100) / 100, vidrio: Math.round(costoVidrio * 100) / 100, accesorios: Math.round(costoAccesorios * 100) / 100, materiales, manoObra, subtotal, descuentoPct, descuentoBs, total },
    avisos,
  };
}

module.exports = { calcularCotizacion, evalFormula };
