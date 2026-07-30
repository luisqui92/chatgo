// Identidad y continuación de conversaciones de ventas.
// Dos objetivos:
//   1) Detectar cuando se sube el MISMO chat otra vez (idéntico) -> avisar.
//   2) Cuando exportan el chat entero de nuevo, detectar dónde quedó la última
//      revisión y evaluar SOLO los mensajes nuevos (continuación).
const crypto = require("crypto");

function sha(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

// Normaliza el texto para comparar: quita marcas de hora tipo WhatsApp,
// espacios repetidos, mayúsculas y saltos, para que un mismo chat exportado
// dos veces produzca el mismo hash aunque cambie algún espacio invisible.
function normaliza(t) {
  return String(t || "")
    .replace(/‎|‏|‪|‬/g, "")     // marcas RTL/LTR invisibles de WhatsApp
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .toLowerCase();
}

// Deriva un identificador estable de la conversación a partir del nombre del
// archivo ("Chat de WhatsApp con Juan Perez.txt") y, si no hay pista en el
// nombre, de las primeras líneas del contenido. Sirve para agrupar la misma
// conversación aunque se suba varias veces con más mensajes.
function convId(filename, texto) {
  const base = String(filename || "")
    .replace(/\.(txt|zip|rar|opus|ogg|m4a|mp3|wav)$/i, "")
    .replace(/whatsapp\s*chat\s*(with|con)?/i, "")
    .replace(/chat\s*de\s*whatsapp\s*(con)?/i, "")
    .replace(/[_\-]+/g, " ")
    .trim()
    .toLowerCase();
  if (base) return "n:" + base;
  // Sin pista en el nombre: usar el arranque del contenido normalizado.
  return "h:" + sha(normaliza(texto).slice(0, 400)).slice(0, 24);
}

// Compara el chat anterior (ya evaluado) con el nuevo y decide qué evaluar.
// Devuelve { tipo, texto }:
//   - "nuevo"        : no hay anterior -> se evalúa todo.
//   - "igual"        : el nuevo no agrega nada -> no re-evaluar.
//   - "continuacion" : el nuevo contiene al anterior + mensajes extra ->
//                      se evalúa solo la parte nueva (texto = cola nueva).
//   - "distinto"     : no se solapan -> tratar como chat aparte, evaluar todo.
function continuacion(viejo, nuevo) {
  const vn = normaliza(viejo);
  const nn = normaliza(nuevo);
  if (!vn) return { tipo: "nuevo", texto: nuevo };
  if (vn === nn) return { tipo: "igual", texto: "" };

  // Caso típico: el export nuevo empieza igual que el viejo y sigue con más.
  if (nn.startsWith(vn)) {
    // Recuperar la cola en el texto ORIGINAL (no normalizado) por proporción.
    const cola = colaOriginal(viejo, nuevo);
    return cola.trim() ? { tipo: "continuacion", texto: cola } : { tipo: "igual", texto: "" };
  }

  // A veces el export recorta el inicio (WhatsApp limita). Buscamos el final
  // del chat viejo dentro del nuevo usando un ancla de los últimos caracteres.
  const ancla = vn.slice(-500);
  const idx = ancla.length >= 40 ? nn.indexOf(ancla) : -1;
  if (idx !== -1) {
    const finAncla = idx + ancla.length;
    if (finAncla >= nn.length - 2) return { tipo: "igual", texto: "" };
    const cola = colaOriginal(nn.slice(0, finAncla), nuevo);
    return cola.trim() ? { tipo: "continuacion", texto: cola } : { tipo: "igual", texto: "" };
  }

  return { tipo: "distinto", texto: nuevo };
}

// Devuelve la parte final del texto ORIGINAL `nuevo` que sobra respecto a lo
// ya cubierto por `cubierto` (comparado sobre versión normalizada). Como la
// normalización cambia longitudes, alineamos por líneas.
function colaOriginal(cubierto, nuevo) {
  const nLineas = normaliza(cubierto).split("\n").filter(Boolean).length;
  const lineasNuevo = String(nuevo).split("\n");
  // Saltamos tantas líneas NO vacías como tenía la parte cubierta.
  let saltar = nLineas, i = 0;
  for (; i < lineasNuevo.length && saltar > 0; i++) {
    if (lineasNuevo[i].trim()) saltar--;
  }
  return lineasNuevo.slice(i).join("\n");
}

module.exports = { sha, normaliza, convId, continuacion };
