// ChatGo — Índice de enlaces (tablero central con botones a todas las páginas)
// GET /links

module.exports = function (app) {
  app.get("/links", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(PAGINA);
  });
};

const SECCIONES = [
  {
    titulo: "🚖 Clientes / público",
    items: [
      { url: "/pedir", em: "🚕", tt: "Pedir ChatGo (web premium)", ss: "OTP, mapa, cotizar, seguimiento y push" },
      { url: "/ambulancias", em: "🚑", tt: "ChatGo Ambulancias", ss: "Página comunitaria del servicio gratuito" },
    ],
  },
  {
    titulo: "🚍 ChatGo Bus",
    items: [
      { url: "/trufis", em: "🚐", tt: "Trufis en vivo", ss: "Micros moviéndose por rutas reales + selector de línea" },
      { url: "/bus-demo", em: "🗺️", tt: "Demo de líneas", ss: "Vista de líneas simuladas" },
    ],
  },
  {
    titulo: "📊 Operaciones",
    items: [
      { url: "/panel", em: "🎛️", tt: "Panel de operaciones", ss: "Ciudades, mapa, feed, ranking y descargas ATT" },
      { url: "/flota", em: "📍", tt: "Flota en vivo", ss: "Choferes reales con su GPS (Traccar)" },
      { url: "/panel/kmz?ciudad=cbba", em: "🛰️", tt: "Bitácora KMZ · Cochabamba", ss: "Descarga (Art. 9 a)", dl: true },
      { url: "/panel/kmz?ciudad=scz", em: "🛰️", tt: "Bitácora KMZ · Santa Cruz", ss: "Descarga (Art. 9 a)", dl: true },
      { url: "/panel/estadistica?ciudad=cbba", em: "📄", tt: "Estadística CSV · Cochabamba", ss: "Descarga (Art. 9 b)", dl: true },
      { url: "/panel/estadistica?ciudad=scz", em: "📄", tt: "Estadística CSV · Santa Cruz", ss: "Descarga (Art. 9 b)", dl: true },
    ],
  },
  {
    titulo: "🔒 Administración",
    items: [
      { url: "/admin", em: "🛠️", tt: "Tablero admin", ss: "Gestión general" },
      { url: "/admin/mapa", em: "🗺️", tt: "Mapa admin", ss: "Viajes y choferes en el mapa" },
      { url: "/admin/pendientes-aprobacion", em: "✅", tt: "Aprobación de choferes", ss: "Pendientes de alta" },
      { url: "/stats", em: "📈", tt: "Estadísticas", ss: "Métricas del sistema" },
      { url: "/unidades", em: "🚗", tt: "Unidades", ss: "Listado de vehículos" },
      { url: "/promo", em: "🎟️", tt: "Promos", ss: "Códigos de descuento" },
    ],
  },
  {
    titulo: "🧪 Técnico (JSON y archivos)",
    items: [
      { url: "/panel/datos", em: "{ }", tt: "/panel/datos", ss: "JSON del panel" },
      { url: "/flota/datos", em: "{ }", tt: "/flota/datos", ss: "JSON de la flota" },
      { url: "/trufis/pos", em: "{ }", tt: "/trufis/pos", ss: "Posiciones de trufis" },
      { url: "/trufis/rutas", em: "{ }", tt: "/trufis/rutas", ss: "Rutas de trufis" },
      { url: "/logo.png", em: "🖼️", tt: "/logo.png", ss: "Logo público" },
      { url: "/sw.js", em: "⚙️", tt: "/sw.js", ss: "Service Worker del push" },
    ],
  },
];

const NOTA_PARAM = [
  { p: "/track/:id", d: "Rastreo público del viaje (se comparte). Necesita el id de un viaje activo." },
  { p: "/mapa/:id", d: "Navegación 3D del chofer. Necesita el id de un viaje activo." },
  { p: "/bus/:lineaId", d: "Vista de una línea puntual. Necesita el id de la línea." },
];

function bloque(s) {
  return '<div class="sec"><h2>' + s.titulo + "</h2><div class=\"grid\">" +
    s.items.map(i =>
      '<a class="btn" href="' + i.url + '"' + (i.dl ? " download" : ' target="_blank" rel="noopener"') + '>' +
      '<span class="em">' + i.em + '</span>' +
      '<span class="tx"><span class="tt">' + i.tt + '</span><span class="ss">' + i.ss + '</span></span>' +
      '<span class="ar">' + (i.dl ? "⬇️" : "↗") + "</span></a>"
    ).join("") + "</div></div>";
}

const PAGINA = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0c1310">
<link rel="icon" href="/logo.png">
<title>ChatGo — Enlaces</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--verde:#1D9E75;--verde2:#34d399;--fondo:#0c1310;--card:#131c18;--borde:#1e2b24;--txt:#e7efe9;--gris:#7f948b;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--fondo);color:var(--txt);min-height:100vh;padding-bottom:40px;}
  header{display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid var(--borde);position:sticky;top:0;background:#0c1310ee;backdrop-filter:blur(6px);z-index:5;}
  header img{width:34px;height:34px;border-radius:8px;}
  .h-t{font-size:17px;font-weight:800;} .h-t span{color:var(--verde2);}
  .h-sub{font-size:11px;color:var(--gris);margin-top:1px;}
  .wrap{max-width:1000px;margin:0 auto;padding:8px 16px;}
  .sec{margin-top:20px;}
  .sec h2{font-size:14px;font-weight:800;color:var(--verde2);margin:0 2px 10px;letter-spacing:.3px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  @media(max-width:640px){.grid{grid-template-columns:1fr;}}
  .btn{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--borde);border-radius:14px;padding:14px;color:var(--txt);text-decoration:none;transition:.15s;}
  .btn:hover{border-color:var(--verde);background:#16211b;}
  .btn .em{font-size:22px;width:30px;text-align:center;flex-shrink:0;}
  .btn .tx{flex:1;min-width:0;}
  .btn .tt{display:block;font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .btn .ss{display:block;font-size:11.5px;color:var(--gris);margin-top:2px;}
  .btn .ar{color:var(--verde2);font-size:16px;flex-shrink:0;}
  .nota{margin-top:24px;background:var(--card);border:1px solid var(--borde);border-radius:14px;padding:14px 16px;}
  .nota h3{font-size:12px;color:var(--gris);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;}
  .nota .row{font-size:12.5px;color:var(--txt);padding:4px 0;}
  .nota code{color:var(--verde2);font-weight:700;}
  .nota .d{color:var(--gris);}
  footer{text-align:center;color:var(--gris);font-size:11px;margin-top:28px;}
</style>
</head>
<body>
<header>
  <img src="/logo.png" alt="ChatGo">
  <div><div class="h-t">ChatGo <span>· Enlaces</span></div><div class="h-sub">Todas las páginas del sistema en un solo lugar</div></div>
</header>
<div class="wrap">
  ${SECCIONES.map(bloque).join("")}
  <div class="nota">
    <h3>Enlaces que necesitan un ID</h3>
    ${NOTA_PARAM.map(n => '<div class="row"><code>' + n.p + '</code> <span class="d">— ' + n.d + "</span></div>").join("")}
  </div>
  <footer>ChatGo · Cochabamba, Bolivia</footer>
</div>
</body>
</html>`;
