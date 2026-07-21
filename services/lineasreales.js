// ChatGo Bus — Líneas REALES de Cochabamba (141 líneas)
//
// Datos reales: nombre de línea, hacia dónde va (destino) y sindicato.
// Fuente: relevamiento propio + wiki OSM Cochabamba. NO tienen coordenadas de
// recorrido (eso llega cuando el sindicato suma su GPS con RastreoPlus), así
// que el buscador funciona por DESTINO (texto), no por mapa.
//
// buscarPorDestino("tamborada") → líneas cuyo destino coincide, con sindicato.

const fs = require("fs");
const path = require("path");
const { log } = require("../config");

const TARIFA_DEF = 2.5;

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // sin acentos
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tipoDe(nombre) {
  const n = nombre.toLowerCase();
  if (n.startsWith("microbus")) return "micro";
  if (n.startsWith("minibus")) return "minibus";
  if (n.startsWith("trufi")) return "trufi";
  if (n.startsWith("teleferico") || n.startsWith("teleférico")) return "teleferico";
  if (n.startsWith("linea ") || n.startsWith("línea ")) return "tren";
  return "trufi";
}

function cargar() {
  try {
    const csv = fs.readFileSync(path.join(__dirname, "..", "data", "lineas_cochabamba.csv"), "utf8");
    const filas = csv.split("\n").map((l) => l.trim()).filter(Boolean);
    filas.shift(); // encabezado
    const lineas = [];
    for (const fila of filas) {
      const partes = fila.split(",");
      if (partes.length < 3) continue;
      const linea = partes[0].trim();
      const sindicato = partes[partes.length - 1].trim();
      const hacia = partes.slice(1, partes.length - 1).join(",").trim();
      if (!linea) continue;
      lineas.push({
        nombre: linea,
        hacia,
        sindicato: sindicato && sindicato !== "default" ? sindicato : null,
        tipo: tipoDe(linea),
        tarifa: TARIFA_DEF,
        _n: norm(linea + " " + hacia),
        _nHacia: norm(hacia),
      });
    }
    log.info(`[LINEAS_REALES] ${lineas.length} líneas de Cochabamba cargadas`);
    return lineas;
  } catch (e) {
    log.error("[LINEAS_REALES] No se pudo cargar el CSV:", e.message);
    return [];
  }
}

const TODAS = cargar();

// Buscar líneas que van HACIA un lugar. Match por tokens del destino: si el
// usuario dice "tamborada", devuelve todas las que tienen "tamborada" en su
// destino. Devuelve ordenadas por mejor coincidencia.
function buscarPorDestino(texto) {
  const q = norm(texto);
  if (!q) return [];
  const tokens = q.split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return [];
  const res = [];
  for (const l of TODAS) {
    let score = 0;
    // coincidencia fuerte: el destino contiene la frase completa
    if (l._nHacia.includes(q)) score += 100;
    // coincidencia por tokens (en destino pesa más que en el nombre)
    for (const t of tokens) {
      if (l._nHacia.includes(t)) score += 10;
      else if (l._n.includes(t)) score += 3;
    }
    if (score > 0) res.push({ ...l, _score: score });
  }
  res.sort((a, b) => b._score - a._score);
  return res;
}

// Buscar una línea por su nombre/número exacto o parcial (ej: "trufi 130", "130", "micro b")
function buscarPorNombre(texto) {
  const q = norm(texto);
  if (!q) return [];
  return TODAS.filter((l) => norm(l.nombre).includes(q) || q.includes(norm(l.nombre)))
    .slice(0, 8);
}

function totalLineas() { return TODAS.length; }

module.exports = { TODAS, buscarPorDestino, buscarPorNombre, totalLineas, norm };
