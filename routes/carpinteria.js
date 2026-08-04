// Panel de Corte de Aluminio (despiece + optimización de barras de 6 m).
// SEPARADO de ChatGo: solo reusa el servidor Express y la base MySQL.
//
//   GET  /aluminio                     → panel HTML
//   GET  /aluminio/catalogo            → perfiles, vidrios, accesorios, productos
//   POST /aluminio/perfiles|vidrios|accesorios|productos  → crear/editar
//   POST /aluminio/<tipo>/:id/borrar   → desactivar
//   POST /aluminio/cotizar             → calcular (sin guardar)
//   POST /aluminio/cotizaciones        → guardar cotización
//   GET  /aluminio/cotizaciones        → historial
//
// Protegido con CARP_ADMIN_TOKEN (token propio, separado de ChatGo).
const crypto = require("crypto");
const { CONFIG, log } = require("../config");
const { PerfilAluminio, VidrioCarp, AccesorioCarp, ProductoCarp, CotizacionCarp } = require("../db/models");
const { calcularCotizacion } = require("../services/carp_calc");
const { cotizarVidrio } = require("../services/vidrio_calc");

module.exports = function (app) {
  function auth(req, res) {
    const token = String(req.query.token || "");
    const esperado = CONFIG.CARP_ADMIN_TOKEN || "";
    let ok = false;
    if (esperado && token.length === esperado.length) {
      try { ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado)); } catch (_) {}
    }
    if (!ok) { res.status(401).json({ error: "No autorizado" }); return false; }
    return true;
  }

  app.get("/aluminio/catalogo", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [perfiles, vidrios, accesorios, productos] = await Promise.all([
        PerfilAluminio.findMany({ where: { activo: true }, orderBy: { nombre: "asc" } }),
        VidrioCarp.findMany({ where: { activo: true }, orderBy: { nombre: "asc" } }),
        AccesorioCarp.findMany({ where: { activo: true }, orderBy: { nombre: "asc" } }),
        ProductoCarp.findMany({ where: { activo: true }, orderBy: { nombre: "asc" } }),
      ]);
      res.json({ perfiles, vidrios, accesorios, productos });
    } catch (e) { log.error("[CARP_CAT]", e.message); res.status(500).json({ error: "Error al cargar el catálogo." }); }
  });

  // ── Materiales (CRUD genérico) ──────────────────────────────────────────
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  app.post("/aluminio/perfiles", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const data = {
        codigo: b.codigo || null, nombre: String(b.nombre || "").trim(), linea: b.linea || null,
        color: b.color || "natural", largoBarraMm: Math.round(num(b.largoBarraMm, 6000)) || 6000,
        precioBarra: num(b.precioBarra), activo: true,
      };
      if (!data.nombre) return res.status(400).json({ error: "El perfil necesita un nombre." });
      const r = b.id ? await PerfilAluminio.update({ where: { id: String(b.id) }, data }) : await PerfilAluminio.create({ data });
      res.json({ ok: true, item: r });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  app.post("/aluminio/vidrios", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const data = { nombre: String(b.nombre || "").trim(), precioM2: num(b.precioM2), precioPie: num(b.precioPie), activo: true };
      if (!data.nombre) return res.status(400).json({ error: "El vidrio necesita un nombre." });
      const r = b.id ? await VidrioCarp.update({ where: { id: String(b.id) }, data }) : await VidrioCarp.create({ data });
      res.json({ ok: true, item: r });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  app.post("/aluminio/accesorios", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const data = { nombre: String(b.nombre || "").trim(), unidad: b.unidad || "u", precio: num(b.precio), activo: true };
      if (!data.nombre) return res.status(400).json({ error: "El accesorio necesita un nombre." });
      const r = b.id ? await AccesorioCarp.update({ where: { id: String(b.id) }, data }) : await AccesorioCarp.create({ data });
      res.json({ ok: true, item: r });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  app.post("/aluminio/productos", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const data = {
        nombre: String(b.nombre || "").trim(), descripcion: b.descripcion || null,
        piezas: Array.isArray(b.piezas) ? b.piezas : [],
        vidrios: Array.isArray(b.vidrios) ? b.vidrios : [],
        accesorios: Array.isArray(b.accesorios) ? b.accesorios : [],
        activo: true,
      };
      if (!data.nombre) return res.status(400).json({ error: "El producto necesita un nombre." });
      const r = b.id ? await ProductoCarp.update({ where: { id: String(b.id) }, data }) : await ProductoCarp.create({ data });
      res.json({ ok: true, item: r });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  const modelos = { perfiles: PerfilAluminio, vidrios: VidrioCarp, accesorios: AccesorioCarp, productos: ProductoCarp };
  app.post("/aluminio/:tipo/:id/borrar", async (req, res) => {
    if (!auth(req, res)) return;
    const M = modelos[req.params.tipo];
    if (!M) return res.status(400).json({ error: "Tipo inválido." });
    try { await M.update({ where: { id: String(req.params.id) }, data: { activo: false } }); res.json({ ok: true }); }
    catch (e) { res.status(422).json({ error: e.message }); }
  });

  // ── Cotizar (calcular) ──────────────────────────────────────────────────
  async function catalogoCompleto() {
    const [perfiles, vidrios, accesorios, productos] = await Promise.all([
      PerfilAluminio.findMany({ where: { activo: true } }),
      VidrioCarp.findMany({ where: { activo: true } }),
      AccesorioCarp.findMany({ where: { activo: true } }),
      ProductoCarp.findMany({ where: { activo: true } }),
    ]);
    return { perfiles, vidrios, accesorios, productos };
  }

  app.post("/aluminio/cotizar", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) return res.status(400).json({ error: "Agregá al menos un ítem (producto + medidas)." });
      const cat = await catalogoCompleto();
      const resultado = calcularCotizacion(items, cat, { kerf: b.kerf, descuento: b.descuento, manoObra: b.manoObra });
      res.json({ ok: true, resultado });
    } catch (e) { log.error("[CARP_COTIZAR]", e.message); res.status(422).json({ error: e.message }); }
  });

  app.post("/aluminio/cotizaciones", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const items = Array.isArray(b.items) ? b.items : [];
      const cat = await catalogoCompleto();
      const resultado = calcularCotizacion(items, cat, { kerf: b.kerf, descuento: b.descuento, manoObra: b.manoObra });
      const guardada = await CotizacionCarp.create({ data: {
        cliente: b.cliente || null, telefono: b.telefono || null, items,
        resultado, descuento: num(b.descuento), manoObra: num(b.manoObra), total: resultado.costos.total,
      } });
      res.json({ ok: true, cotizacion: guardada });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  app.get("/aluminio/cotizaciones", async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json({ cotizaciones: await CotizacionCarp.findMany({ orderBy: { createdAt: "desc" }, take: 100 }) }); }
    catch (e) { res.status(500).json({ error: "Error al listar." }); }
  });

  // Cotización de vidrio por pie² (venta directa): +7cm/lado, precio cabal y redondeado a 5
  app.post("/aluminio/vidrio-cotizar", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const vidrio = await VidrioCarp.findUnique({ where: { id: String(b.vidrioId || "") } });
      if (!vidrio) return res.status(400).json({ error: "Elegí un tipo de vidrio." });
      if (!(Number(b.ancho) > 0) || !(Number(b.alto) > 0)) return res.status(400).json({ error: "Poné ancho y alto en cm." });
      const r = cotizarVidrio({
        ancho: b.ancho, alto: b.alto, cantidad: b.cantidad,
        precioPie: vidrio.precioPie,
        desperdicioCm: b.desperdicioCm != null ? b.desperdicioCm : 7,
        pieCm: b.pieCm != null ? b.pieCm : undefined,
      });
      res.json({ ok: true, vidrio: { id: vidrio.id, nombre: vidrio.nombre, precioPie: vidrio.precioPie }, resultado: r });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  app.get("/aluminio", (req, res) => { res.setHeader("Cache-Control", "no-cache"); res.type("html").send(PANEL); });
};

const PANEL = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Corte de Aluminio</title>
<style>
  :root{--bg:#0f1216;--card:#171b21;--card2:#1e242c;--bd:#2a323c;--acc:#3f7cc4;--acc2:#5a9be0;--tx:#e8edf3;--gr:#93a1b0;--ok:#4caf7d;--warn:#d9a441;--rojo:#d9705a;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:15px}
  .wrap{max-width:920px;margin:0 auto;padding:16px}
  h1{font-size:22px;margin:6px 0 2px} h1 b{color:var(--acc2)} h3{margin:0 0 10px}
  .sub{color:var(--gr);font-size:13px;margin-bottom:14px}
  .tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
  .tab{background:var(--card);border:1px solid var(--bd);color:var(--gr);border-radius:10px;padding:10px 14px;font-weight:700;font-size:13.5px;cursor:pointer}
  .tab.act{background:linear-gradient(135deg,var(--acc2),var(--acc));color:#fff;border-color:transparent}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;margin-bottom:14px}
  label{display:block;font-size:12px;color:var(--gr);margin:8px 0 3px}
  input,select,textarea{width:100%;background:var(--card2);border:1px solid var(--bd);color:var(--tx);border-radius:9px;padding:10px;font-size:14px}
  textarea{min-height:44px;resize:vertical}
  .btn{background:linear-gradient(135deg,var(--acc2),var(--acc));color:#fff;border:none;border-radius:10px;padding:12px 16px;font-weight:800;font-size:15px;cursor:pointer}
  .btn.sec{background:var(--card2);border:1px solid var(--bd);color:var(--tx)}
  .btn.mini{padding:7px 10px;font-size:12.5px;border-radius:8px}
  .row{display:flex;gap:8px;flex-wrap:wrap} .row>*{flex:1;min-width:90px}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--bd)} th{color:var(--gr);font-weight:600}
  .rt{text-align:right} .pill{display:inline-block;background:var(--card2);border:1px solid var(--bd);border-radius:20px;padding:2px 9px;font-size:11.5px;color:var(--gr)}
  .msg{font-size:13px;margin-top:10px} .msg.err{color:var(--rojo)} .msg.ok{color:var(--ok)} .msg.warn{color:var(--warn)}
  .item{background:var(--card2);border:1px solid var(--bd);border-radius:10px;padding:10px;margin-bottom:8px}
  .big{font-size:26px;font-weight:800;color:var(--acc2)} .tot{font-size:20px;font-weight:800}
  .barra{height:14px;background:#0b0e12;border-radius:7px;overflow:hidden;border:1px solid var(--bd);display:flex}
  .barra i{display:block;height:100%} .g{background:var(--ok)} .w{background:#39424d}
  .hint{font-size:11.5px;color:var(--gr);margin-top:3px}
  footer{text-align:center;color:var(--gr);font-size:12px;margin:20px 0;opacity:.8}
  .x{color:var(--rojo);cursor:pointer;font-weight:800}
  @media print{.tabs,.noprint{display:none!important}}
</style></head><body><div class="wrap">
  <h1>Corte de <b>Aluminio</b></h1>
  <div class="sub">Despiece y optimización de barras de 6 m · cotización automática</div>
  <div class="tabs noprint">
    <button class="tab act" id="t-cot" onclick="tab('cot')">Ventana/Puerta</button>
    <button class="tab" id="t-vidrio" onclick="tab('vidrio')">Vidrio</button>
    <button class="tab" id="t-prod" onclick="tab('prod')">Productos</button>
    <button class="tab" id="t-mat" onclick="tab('mat')">Materiales</button>
    <button class="tab" id="t-hist" onclick="tab('hist')">Historial</button>
  </div>

  <div id="sec-cot">
    <div class="card noprint">
      <h3>Nueva cotización</h3>
      <div class="row"><div><label>Cliente</label><input id="c-cli" placeholder="Nombre"></div><div><label>Teléfono</label><input id="c-tel" placeholder="opcional"></div></div>
      <div id="c-items"></div>
      <button class="btn sec mini" style="margin-top:8px" onclick="addItem()">＋ Agregar ventana/puerta</button>
      <div class="row" style="margin-top:12px">
        <div><label>Mano de obra (Bs)</label><input id="c-mo" type="number" value="0"></div>
        <div><label>Descuento (%)</label><input id="c-desc" type="number" value="0"></div>
        <div><label>Sierra/kerf (mm)</label><input id="c-kerf" type="number" value="4"></div>
      </div>
      <div style="margin-top:12px" class="row"><button class="btn" onclick="cotizar()">Calcular despiece</button><button class="btn sec" onclick="guardar()">Guardar</button></div>
      <div class="msg" id="c-msg"></div>
    </div>
    <div id="c-res"></div>
  </div>

  <div id="sec-prod" style="display:none"></div>
  <div id="sec-vidrio" style="display:none">
    <div class="card">
      <h3>Cotización de vidrio</h3>
      <div class="sub">Se le suma <b>7 cm por lado</b> de desperdicio, se pasa a <b>pie²</b> y sale el precio cabal y el redondeado a múltiplo de 5.</div>
      <label>Tipo de vidrio</label><select id="g-tipo"></select>
      <div class="row">
        <div><label>Ancho (cm)</label><input id="g-ancho" type="number" value="100"></div>
        <div><label>Alto (cm)</label><input id="g-alto" type="number" value="100"></div>
        <div><label>Cantidad</label><input id="g-cant" type="number" value="1"></div>
      </div>
      <div class="row" style="margin-top:6px">
        <div><label>Desperdicio por lado (cm)</label><input id="g-desp" type="number" value="7"></div>
        <div><label>1 pie = (cm)</label><input id="g-pie" type="number" value="30.48" step="0.01"></div>
      </div>
      <div style="margin-top:12px"><button class="btn" onclick="cotizarVidrio()">Calcular</button></div>
      <div class="msg" id="g-msg"></div>
    </div>
    <div id="g-res"></div>
  </div>
  <div id="sec-mat" style="display:none"></div>
  <div id="sec-hist" style="display:none"></div>

  <footer>🐵 Powered by ChatGo</footer>
</div>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||"";
let CAT={perfiles:[],vidrios:[],accesorios:[],productos:[]}, ITEMS=[], RES=null;
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function bs(n){return "Bs "+(Math.round(Number(n||0)*100)/100).toLocaleString("es-BO");}
async function api(ruta,opts={}){const sep=ruta.includes("?")?"&":"?";const r=await fetch(ruta+sep+"token="+encodeURIComponent(TOKEN),{method:opts.method||(opts.body?"POST":"GET"),headers:{"Content-Type":"application/json"},body:opts.body?JSON.stringify(opts.body):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Error");return d;}
function tab(t){["cot","vidrio","prod","mat","hist"].forEach(function(x){document.getElementById("t-"+x).classList.toggle("act",t===x);document.getElementById("sec-"+x).style.display=t===x?"block":"none";});if(t==="vidrio")llenarVidrios();if(t==="prod")pintarProductos();if(t==="mat")pintarMateriales();if(t==="hist")pintarHistorial();}
function llenarVidrios(){ var s=document.getElementById("g-tipo"); s.innerHTML=CAT.vidrios.length?CAT.vidrios.map(function(v){return '<option value="'+v.id+'">'+esc(v.nombre)+' (Bs '+(v.precioPie||0)+'/pie²)</option>';}).join(""):'<option value="">— cargá vidrios en Materiales —</option>'; }
async function cotizarVidrio(){
  var m=document.getElementById("g-msg"); var vid=document.getElementById("g-tipo").value;
  if(!vid){ m.className="msg err"; m.textContent="Elegí un tipo de vidrio (cargalos en Materiales)."; return; }
  m.className="msg"; m.textContent="Calculando…";
  try{
    var d=await api("/aluminio/vidrio-cotizar",{body:{vidrioId:vid,ancho:Number(document.getElementById("g-ancho").value),alto:Number(document.getElementById("g-alto").value),cantidad:Number(document.getElementById("g-cant").value),desperdicioCm:Number(document.getElementById("g-desp").value),pieCm:Number(document.getElementById("g-pie").value)}});
    m.textContent=""; var r=d.resultado;
    document.getElementById("g-res").innerHTML='<div class="card">'+
      '<h3>'+esc(d.vidrio.nombre)+'</h3>'+
      '<table>'+
        '<tr><td>Medida con desperdicio</td><td class="rt">'+r.anchoDesp+' × '+r.altoDesp+' cm</td></tr>'+
        '<tr><td>Superficie</td><td class="rt">'+r.pie2Total+' pie²</td></tr>'+
        '<tr><td>Precio por pie²</td><td class="rt">'+bs(d.vidrio.precioPie)+'</td></tr>'+
      '</table>'+
      '<div class="row" style="margin-top:10px;text-align:center">'+
        '<div><div class="hint">Cabal</div><div class="tot">'+bs(r.precioCabal)+'</div></div>'+
        '<div><div class="hint">Redondeado a 5</div><div class="big">'+bs(r.precioRedondeado)+'</div></div>'+
      '</div>'+
      '<button class="btn sec mini noprint" style="margin-top:10px" onclick="window.print()">🖨 Imprimir</button></div>';
  }catch(e){ m.className="msg err"; m.textContent=e.message; }
}

// ── Cotizar ──
function addItem(){ ITEMS.push({productoId:CAT.productos[0]?CAT.productos[0].id:"",ancho:1000,alto:1000,cantidad:1}); pintarItems(); }
function delItem(i){ ITEMS.splice(i,1); pintarItems(); }
function pintarItems(){
  if(!CAT.productos.length){ document.getElementById("c-items").innerHTML='<div class="msg warn">Primero creá al menos un producto en la pestaña <b>Productos</b>.</div>'; return; }
  document.getElementById("c-items").innerHTML=ITEMS.map(function(it,i){
    var opts=CAT.productos.map(function(p){return '<option value="'+p.id+'"'+(p.id===it.productoId?' selected':'')+'>'+esc(p.nombre)+'</option>';}).join("");
    return '<div class="item"><div class="row"><div style="flex:2"><label>Producto</label><select onchange="setIt('+i+',\\'productoId\\',this.value)">'+opts+'</select></div>'+
      '<div><label>Ancho (mm)</label><input type="number" value="'+it.ancho+'" onchange="setIt('+i+',\\'ancho\\',this.value)"></div>'+
      '<div><label>Alto (mm)</label><input type="number" value="'+it.alto+'" onchange="setIt('+i+',\\'alto\\',this.value)"></div>'+
      '<div><label>Cant.</label><input type="number" value="'+it.cantidad+'" onchange="setIt('+i+',\\'cantidad\\',this.value)"></div>'+
      '<div style="flex:none;display:flex;align-items:flex-end"><span class="x" onclick="delItem('+i+')">✕</span></div></div></div>';
  }).join("");
}
function setIt(i,k,v){ ITEMS[i][k]=(k==="productoId")?v:Number(v); }
function payload(){ return {items:ITEMS,manoObra:Number(document.getElementById("c-mo").value)||0,descuento:Number(document.getElementById("c-desc").value)||0,kerf:Number(document.getElementById("c-kerf").value)||4,cliente:document.getElementById("c-cli").value,telefono:document.getElementById("c-tel").value}; }
async function cotizar(){ var m=document.getElementById("c-msg"); if(!ITEMS.length){m.className="msg err";m.textContent="Agregá al menos una ventana/puerta.";return;} m.className="msg";m.textContent="Calculando…"; try{ var d=await api("/aluminio/cotizar",{body:payload()}); RES=d.resultado; m.textContent=""; pintarResultado(); }catch(e){ m.className="msg err"; m.textContent=e.message; } }
async function guardar(){ var m=document.getElementById("c-msg"); if(!ITEMS.length)return; try{ await api("/aluminio/cotizaciones",{body:payload()}); m.className="msg ok"; m.textContent="Cotización guardada ✅"; }catch(e){ m.className="msg err"; m.textContent=e.message; } }
function pintarResultado(){
  if(!RES){document.getElementById("c-res").innerHTML="";return;}
  var c=RES.costos;
  var perf=RES.perfiles.map(function(p){
    var apro='<div class="barra"><i class="g" style="width:'+p.aprovechamiento+'%"></i><i class="w" style="width:'+(100-p.aprovechamiento)+'%"></i></div>';
    return '<tr><td>'+esc(p.nombre)+'<div class="hint">'+p.cantidadPiezas+' piezas · aprov. '+p.aprovechamiento+'% · sobra '+(p.desperdicioMm/1000).toFixed(2)+' m</div>'+apro+'</td><td class="rt"><b>'+p.cantidadBarras+'</b><div class="hint">barras 6m</div></td><td class="rt">'+bs(p.costo)+'</td></tr>';
  }).join("");
  var vid=RES.vidrios.map(function(v){return '<tr><td>'+esc(v.nombre)+'</td><td class="rt">'+v.m2.toFixed(2)+' m²</td><td class="rt">'+bs(v.costo)+'</td></tr>';}).join("");
  var acc=RES.accesorios.map(function(a){return '<tr><td>'+esc(a.nombre)+'</td><td class="rt">'+a.cantidad+' '+esc(a.unidad)+'</td><td class="rt">'+bs(a.costo)+'</td></tr>';}).join("");
  var avisos=(RES.avisos||[]).map(function(x){return '<div class="msg warn">⚠️ '+esc(x)+'</div>';}).join("");
  document.getElementById("c-res").innerHTML=
    '<div class="card"><h3>Despiece de perfiles</h3><table><tr><th>Perfil</th><th class="rt">Barras</th><th class="rt">Costo</th></tr>'+(perf||'<tr><td colspan=3 class="hint">Sin perfiles</td></tr>')+'</table></div>'+
    (vid?'<div class="card"><h3>Vidrio</h3><table>'+vid+'</table></div>':'')+
    (acc?'<div class="card"><h3>Accesorios</h3><table>'+acc+'</table></div>':'')+
    '<div class="card"><table>'+
      '<tr><td>Perfiles</td><td class="rt">'+bs(c.perfiles)+'</td></tr>'+
      '<tr><td>Vidrio</td><td class="rt">'+bs(c.vidrio)+'</td></tr>'+
      '<tr><td>Accesorios</td><td class="rt">'+bs(c.accesorios)+'</td></tr>'+
      '<tr><td>Mano de obra</td><td class="rt">'+bs(c.manoObra)+'</td></tr>'+
      (c.descuentoBs?'<tr><td>Descuento ('+c.descuentoPct+'%)</td><td class="rt" style="color:var(--rojo)">- '+bs(c.descuentoBs)+'</td></tr>':'')+
      '<tr><td class="tot">TOTAL</td><td class="rt tot" style="color:var(--acc2)">'+bs(c.total)+'</td></tr>'+
    '</table><button class="btn sec mini noprint" style="margin-top:10px" onclick="window.print()">🖨 Imprimir</button></div>'+avisos;
}

// ── Productos (recetas) ──
function pintarProductos(){
  var lista=CAT.productos.map(function(p){
    return '<div class="item"><div class="row"><div style="flex:2"><b>'+esc(p.nombre)+'</b><div class="hint">'+(p.piezas||[]).length+' perfiles · '+(p.vidrios||[]).length+' vidrio(s) · '+(p.accesorios||[]).length+' accesorio(s)</div></div>'+
      '<div style="flex:none"><button class="btn sec mini" onclick=\\'editProd("'+p.id+'")\\'>Editar</button> <span class="x" onclick=\\'borrar("productos","'+p.id+'")\\'>✕</span></div></div></div>';
  }).join("");
  document.getElementById("sec-prod").innerHTML='<div class="card"><h3>Productos (recetas de despiece)</h3><div class="sub">Cada producto define qué perfiles se cortan y a qué medida, con fórmulas en función de <b>A</b> (ancho) y <b>H</b> (alto) en mm. Ej: <span class="pill">A</span> <span class="pill">H</span> <span class="pill">A/2-30</span> <span class="pill">H-50</span></div>'+(lista||'<div class="hint">Todavía no hay productos.</div>')+'<button class="btn mini" style="margin-top:8px" onclick="editProd()">＋ Nuevo producto</button></div><div id="prod-edit"></div>';
}
function selPerfil(v){ return CAT.perfiles.map(function(p){return '<option value="'+p.id+'"'+(p.id===v?' selected':'')+'>'+esc(p.nombre)+'</option>';}).join(""); }
function selVidrio(v){ return CAT.vidrios.map(function(p){return '<option value="'+p.id+'"'+(p.id===v?' selected':'')+'>'+esc(p.nombre)+'</option>';}).join(""); }
function selAcc(v){ return CAT.accesorios.map(function(p){return '<option value="'+p.id+'"'+(p.id===v?' selected':'')+'>'+esc(p.nombre)+'</option>';}).join(""); }
let PE={id:"",nombre:"",descripcion:"",piezas:[],vidrios:[],accesorios:[]};
function editProd(id){ var p=id?CAT.productos.find(function(x){return x.id===id;}):null; PE=p?JSON.parse(JSON.stringify({id:p.id,nombre:p.nombre,descripcion:p.descripcion||"",piezas:p.piezas||[],vidrios:p.vidrios||[],accesorios:p.accesorios||[]})):{id:"",nombre:"",descripcion:"",piezas:[],vidrios:[],accesorios:[]}; pintarProdEdit(); }
function pintarProdEdit(){
  if(!CAT.perfiles.length){ document.getElementById("prod-edit").innerHTML='<div class="card"><div class="msg warn">Primero cargá perfiles en <b>Materiales</b>.</div></div>'; return; }
  function baseSel(i,val){ return '<select onchange="pePieza('+i+',\\'base\\',this.value)"><option value="A"'+(val==="H"?"":" selected")+'>Ancho</option><option value="H"'+(val==="H"?" selected":"")+'>Alto</option></select>'; }
  var piezas='<div class="row hint" style="gap:8px;margin-bottom:2px"><div style="flex:2">Perfil</div><div>Cant.</div><div>Mide</div><div>÷</div><div>Descuento mm</div><div style="flex:none;width:14px"></div></div>'+
    PE.piezas.map(function(pz,i){var f=construirFormula(pz);return '<div class="row" style="margin-bottom:6px"><div style="flex:2"><select onchange="pePieza('+i+',\\'perfilId\\',this.value)">'+selPerfil(pz.perfilId)+'</select></div><div><input type="number" value="'+(pz.cantidad||1)+'" onchange="pePieza('+i+',\\'cantidad\\',this.value)"></div><div>'+baseSel(i,pz.base)+'</div><div><input type="number" value="'+(pz.partes||1)+'" onchange="pePieza('+i+',\\'partes\\',this.value)"></div><div><input type="number" value="'+(pz.descuento||0)+'" onchange="pePieza('+i+',\\'descuento\\',this.value)"></div><div style="flex:none;display:flex;align-items:center"><span class="x" onclick="peDel(\\'piezas\\','+i+')">✕</span></div></div><div class="hint" style="margin:-4px 0 6px">corte = '+esc(f)+' mm</div>';}).join("");
  var vids='<div class="row hint" style="gap:8px;margin-bottom:2px"><div style="flex:2">Vidrio</div><div>Paños</div><div>÷ ancho</div><div>Desc. ancho</div><div>Desc. alto</div><div style="flex:none;width:14px"></div></div>'+
    PE.vidrios.map(function(v,i){return '<div class="row" style="margin-bottom:6px"><div style="flex:2"><select onchange="peVid('+i+',\\'vidrioId\\',this.value)">'+selVidrio(v.vidrioId)+'</select></div><div><input type="number" value="'+(v.cantidad||1)+'" onchange="peVid('+i+',\\'cantidad\\',this.value)"></div><div><input type="number" value="'+(v.partesAncho||1)+'" onchange="peVid('+i+',\\'partesAncho\\',this.value)"></div><div><input type="number" value="'+(v.descAncho||0)+'" onchange="peVid('+i+',\\'descAncho\\',this.value)"></div><div><input type="number" value="'+(v.descAlto||0)+'" onchange="peVid('+i+',\\'descAlto\\',this.value)"></div><div style="flex:none;display:flex;align-items:center"><span class="x" onclick="peDel(\\'vidrios\\','+i+')">✕</span></div></div>';}).join("");
  var accs=PE.accesorios.map(function(a,i){return '<div class="row" style="margin-bottom:6px"><div style="flex:2"><select onchange="peAcc('+i+',\\'accesorioId\\',this.value)">'+selAcc(a.accesorioId)+'</select></div><div style="flex:2"><input value="'+esc(a.formula!=null?a.formula:(a.cantidad!=null?a.cantidad:""))+'" placeholder="cantidad o fórmula (ej: 4, 2*H/1000)" onchange="peAcc('+i+',\\'formula\\',this.value)"></div><div style="flex:none"><span class="x" onclick="peDel(\\'accesorios\\','+i+')">✕</span></div></div>';}).join("");
  document.getElementById("prod-edit").innerHTML='<div class="card"><h3>'+(PE.id?"Editar":"Nuevo")+' producto</h3>'+
    '<label>Nombre</label><input id="pe-nom" value="'+esc(PE.nombre)+'" placeholder="Ventana corrediza 2 hojas">'+
    '<label>Descripción</label><input id="pe-desc" value="'+esc(PE.descripcion)+'" placeholder="opcional">'+
    '<label style="margin-top:12px">Perfiles a cortar <span class="hint">(perfil · cuántas piezas · si mide del ancho o alto · en cuántas partes se divide · descuento en mm)</span></label>'+piezas+'<button class="btn sec mini" onclick="peAdd(\\'piezas\\')">＋ perfil</button>'+
    '<label style="margin-top:12px">Vidrios <span class="hint">(vidrio · cuántos paños · en cuántas partes va el ancho · descuento de ancho · descuento de alto)</span></label>'+vids+'<button class="btn sec mini" onclick="peAdd(\\'vidrios\\')">＋ vidrio</button>'+
    '<label style="margin-top:12px">Accesorios <span class="hint">(accesorio · cantidad o fórmula)</span></label>'+accs+'<button class="btn sec mini" onclick="peAdd(\\'accesorios\\')">＋ accesorio</button>'+
    '<div style="margin-top:14px" class="row"><button class="btn" onclick="guardarProd()">Guardar producto</button><button class="btn sec" onclick="document.getElementById(\\'prod-edit\\').innerHTML=\\'\\'">Cancelar</button></div><div class="msg" id="pe-msg"></div></div>';
}
function peAdd(k){ if(k==="piezas")PE.piezas.push({perfilId:CAT.perfiles[0].id,cantidad:1,base:"A",partes:1,descuento:0}); if(k==="vidrios")PE.vidrios.push({vidrioId:(CAT.vidrios[0]||{}).id||"",cantidad:1,partesAncho:1,descAncho:0,descAlto:0}); if(k==="accesorios")PE.accesorios.push({accesorioId:(CAT.accesorios[0]||{}).id||"",formula:""}); pintarProdEdit(); }
function peDel(k,i){ PE[k].splice(i,1); pintarProdEdit(); }
// Arma la fórmula de corte a partir del modelo simple: base(A/H) ÷ partes − descuento(mm)
function construirFormula(pz){ var base=pz.base||"A"; var partes=(pz.partes&&pz.partes>1)?("/"+pz.partes):""; var d=Number(pz.descuento||0); var desc=d>0?("-"+d):(d<0?("+"+Math.abs(d)):""); return base+partes+desc; }
function pePieza(i,k,v){ var p=PE.piezas[i]; if(k==="perfilId")p.perfilId=v; else if(k==="base")p.base=v; else p[k]=Number(v); p.formula=construirFormula(p); if(k==="base"||k==="partes"||k==="descuento")pintarProdEdit(); }
function peVid(i,k,v){ var g=PE.vidrios[i]; if(k==="vidrioId")g.vidrioId=v; else g[k]=Number(v); var pa=(g.partesAncho&&g.partesAncho>1)?("/"+g.partesAncho):""; var da=Number(g.descAncho||0), dh=Number(g.descAlto||0); g.formulaAncho="A"+pa+(da>0?("-"+da):""); g.formulaAlto="H"+(dh>0?("-"+dh):""); }
function peAcc(i,k,v){ if(k==="accesorioId")PE.accesorios[i].accesorioId=v; else {PE.accesorios[i].formula=v; delete PE.accesorios[i].cantidad;} }
async function guardarProd(){ var m=document.getElementById("pe-msg"); PE.nombre=document.getElementById("pe-nom").value; PE.descripcion=document.getElementById("pe-desc").value; if(!PE.nombre){m.className="msg err";m.textContent="Ponele un nombre.";return;}
  // Asegurar que toda pieza/vidrio tenga su fórmula calculada (aunque no se haya tocado)
  PE.piezas.forEach(function(p){ p.formula=construirFormula(p); });
  PE.vidrios.forEach(function(g){ var pa=(g.partesAncho&&g.partesAncho>1)?("/"+g.partesAncho):""; var da=Number(g.descAncho||0), dh=Number(g.descAlto||0); g.formulaAncho="A"+pa+(da>0?("-"+da):""); g.formulaAlto="H"+(dh>0?("-"+dh):""); });
  try{ await api("/aluminio/productos",{body:PE}); await cargar(); tab("prod"); }catch(e){ m.className="msg err"; m.textContent=e.message; } }

// ── Materiales ──
function pintarMateriales(){
  function tabla(tit,tipo,rows,form){ return '<div class="card"><h3>'+tit+'</h3>'+rows+form+'</div>'; }
  var perf=CAT.perfiles.map(function(p){return '<tr><td>'+esc(p.nombre)+(p.linea?' <span class="pill">'+esc(p.linea)+'</span>':'')+'</td><td class="rt">'+bs(p.precioBarra)+'/barra</td><td class="rt"><span class="x" onclick=\\'borrar("perfiles","'+p.id+'")\\'>✕</span></td></tr>';}).join("");
  var vid=CAT.vidrios.map(function(p){return '<tr><td>'+esc(p.nombre)+'</td><td class="rt">'+bs(p.precioPie)+'/pie²'+(p.precioM2?' · '+bs(p.precioM2)+'/m²':'')+'</td><td class="rt"><span class="x" onclick=\\'borrar("vidrios","'+p.id+'")\\'>✕</span></td></tr>';}).join("");
  var acc=CAT.accesorios.map(function(p){return '<tr><td>'+esc(p.nombre)+'</td><td class="rt">'+bs(p.precio)+'/'+esc(p.unidad)+'</td><td class="rt"><span class="x" onclick=\\'borrar("accesorios","'+p.id+'")\\'>✕</span></td></tr>';}).join("");
  document.getElementById("sec-mat").innerHTML=
    tabla("Perfiles de aluminio (barra 6 m)","perfiles",'<table>'+(perf||'')+'</table>','<div class="row" style="margin-top:8px"><input id="np-nom" placeholder="Nombre del perfil"><input id="np-lin" placeholder="Serie (opc)" style="max-width:120px"><input id="np-pre" type="number" placeholder="Bs/barra" style="max-width:110px"><button class="btn mini" onclick="addPerfil()">＋</button></div>')+
    tabla("Vidrios","vidrios",'<table>'+(vid||'')+'</table>','<div class="row" style="margin-top:8px"><input id="nv-nom" placeholder="Nombre del vidrio"><input id="nv-pie" type="number" placeholder="Bs/pie²" style="max-width:100px"><input id="nv-pre" type="number" placeholder="Bs/m² (opc)" style="max-width:110px"><button class="btn mini" onclick="addVidrio()">＋</button></div>')+
    tabla("Accesorios","accesorios",'<table>'+(acc||'')+'</table>','<div class="row" style="margin-top:8px"><input id="na-nom" placeholder="Nombre"><select id="na-uni" style="max-width:90px"><option value="u">u</option><option value="m">m</option><option value="par">par</option><option value="jgo">jgo</option></select><input id="na-pre" type="number" placeholder="Bs" style="max-width:100px"><button class="btn mini" onclick="addAcc()">＋</button></div>');
}
async function addPerfil(){ try{ await api("/aluminio/perfiles",{body:{nombre:document.getElementById("np-nom").value,linea:document.getElementById("np-lin").value,precioBarra:Number(document.getElementById("np-pre").value)||0}}); await cargar(); pintarMateriales(); }catch(e){ alert(e.message); } }
async function addVidrio(){ try{ await api("/aluminio/vidrios",{body:{nombre:document.getElementById("nv-nom").value,precioPie:Number(document.getElementById("nv-pie").value)||0,precioM2:Number(document.getElementById("nv-pre").value)||0}}); await cargar(); pintarMateriales(); }catch(e){ alert(e.message); } }
async function addAcc(){ try{ await api("/aluminio/accesorios",{body:{nombre:document.getElementById("na-nom").value,unidad:document.getElementById("na-uni").value,precio:Number(document.getElementById("na-pre").value)||0}}); await cargar(); pintarMateriales(); }catch(e){ alert(e.message); } }
async function borrar(tipo,id){ if(!confirm("¿Quitar este elemento?"))return; try{ await api("/aluminio/"+tipo+"/"+id+"/borrar",{method:"POST"}); await cargar(); if(tipo==="productos")pintarProductos();else pintarMateriales(); }catch(e){ alert(e.message); } }

// ── Historial ──
async function pintarHistorial(){
  try{ var d=await api("/aluminio/cotizaciones"); var rows=(d.cotizaciones||[]).map(function(c){var f=new Date(c.createdAt).toLocaleDateString("es-BO");return '<tr><td>'+f+'</td><td>'+esc(c.cliente||"—")+'</td><td class="rt"><b>'+bs(c.total)+'</b></td></tr>';}).join("");
  document.getElementById("sec-hist").innerHTML='<div class="card"><h3>Cotizaciones guardadas</h3><table><tr><th>Fecha</th><th>Cliente</th><th class="rt">Total</th></tr>'+(rows||'<tr><td colspan=3 class="hint">Sin cotizaciones aún.</td></tr>')+'</table></div>';
  }catch(e){ document.getElementById("sec-hist").innerHTML='<div class="card"><div class="msg err">'+esc(e.message)+'</div></div>'; }
}

async function cargar(){ try{ CAT=await api("/aluminio/catalogo"); }catch(e){ document.getElementById("c-msg").className="msg err"; document.getElementById("c-msg").textContent=e.message+" (revisá el token)"; } }
(async function(){ await cargar(); if(!ITEMS.length&&CAT.productos.length) addItem(); else pintarItems(); })();
</script></body></html>`;
