// Sistema de Evaluación de Ventas por WhatsApp — panel + API.
// SEPARADO de ChatGo: solo reusa el servidor Express y la base MySQL.
//
//   GET  /ventas                         → panel HTML
//   GET  /ventas/rubro                   → rubro (auditable)
//   GET  /ventas/vendedores              → vendedores + promedio
//   POST /ventas/vendedores              → crear vendedor
//   GET  /ventas/evaluaciones?vendedorId → evaluaciones de un vendedor
//   POST /ventas/evaluar                 → evaluar una conversación con Claude (en vivo)
//   GET  /ventas/tendencia?vendedorId&n  → promedio móvil de las últimas N
//
// Protegido con VENTAS_ADMIN_TOKEN (token propio, separado de ChatGo).

const crypto = require("crypto");
const { CONFIG, log } = require("../config");
const { Vendedor, EvaluacionVenta } = require("../db/models");
const RUBRO = require("../config/rubro_ventas");
const { evaluarConversacion } = require("../services/ventas_scoring");

const MAP = { tiempo_respuesta: "tiempoRespuesta", descubrimiento: "descubrimiento", objeciones: "objeciones", seguimiento: "seguimiento", cierre: "cierre", cumplimiento: "cumplimiento" };

module.exports = function (app) {
  function auth(req, res) {
    const token = String(req.query.token || "");
    const esperado = CONFIG.VENTAS_ADMIN_TOKEN || "";
    let ok = false;
    if (esperado && token.length === esperado.length) {
      try { ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado)); } catch (_) {}
    }
    if (!ok) { res.status(401).json({ error: "No autorizado" }); return false; }
    return true;
  }

  app.get("/ventas/rubro", (req, res) => { if (!auth(req, res)) return; res.json(RUBRO); });

  app.get("/ventas/vendedores", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const vends = await Vendedor.findMany({ orderBy: { nombre: "asc" }, include: { evaluaciones: { select: { promedio: true } } } });
      const out = vends.map(v => {
        const n = v.evaluaciones.length;
        const prom = n ? Math.round((v.evaluaciones.reduce((s, e) => s + e.promedio, 0) / n) * 10) / 10 : null;
        return { id: v.id, nombre: v.nombre, email: v.email, whatsapp: v.whatsapp, activo: v.activo, evaluaciones: n, promedio: prom };
      });
      res.json({ vendedores: out });
    } catch (e) { log.error("[VENTAS_VEND]", e.message); res.status(500).json({ error: "Error al listar." }); }
  });

  app.post("/ventas/vendedores", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const nombre = String(b.nombre || "").trim();
      const email = String(b.email || "").trim().toLowerCase();
      if (!nombre) return res.status(400).json({ error: "El nombre es requerido." });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Email inválido." });
      const dup = await Vendedor.findUnique({ where: { email } });
      if (dup) return res.status(409).json({ error: "Ya existe un vendedor con ese email." });
      const v = await Vendedor.create({ data: { nombre, email, whatsapp: b.whatsapp ? String(b.whatsapp).trim() : null } });
      res.json({ ok: true, vendedor: v });
    } catch (e) { log.error("[VENTAS_VEND_CREATE]", e.message); res.status(500).json({ error: "Error al crear." }); }
  });

  app.get("/ventas/evaluaciones", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const where = req.query.vendedorId ? { vendedorId: String(req.query.vendedorId) } : {};
      const evals = await EvaluacionVenta.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
      res.json({ evaluaciones: evals });
    } catch (e) { res.status(500).json({ error: "Error al listar evaluaciones." }); }
  });

  // Evaluar una conversación pegada (scoring en vivo con Claude) — con evidencia
  app.post("/ventas/evaluar", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const vendedor = await Vendedor.findUnique({ where: { id: String(b.vendedorId || "") } });
      if (!vendedor) return res.status(400).json({ error: "Elegí un vendedor válido." });
      const conversacion = String(b.conversacion || "");

      const ev = await evaluarConversacion(conversacion, vendedor.id); // valida cita o lanza error

      const data = {
        vendedorId: vendedor.id,
        fechaConversacion: b.fechaConversacion ? new Date(b.fechaConversacion) : new Date(),
        promedio: ev.promedio,
        fortalezas: ev.fortalezas, debilidades: ev.debilidades,
        mejoraConcreta: ev.mejora_concreta, conversacion: conversacion.slice(0, 20000),
      };
      for (const k of Object.keys(MAP)) data[MAP[k]] = ev.scores[k];
      const guardada = await EvaluacionVenta.create({ data });
      res.json({ ok: true, evaluacion: guardada });
    } catch (e) {
      log.error("[VENTAS_EVALUAR]", e.message);
      res.status(422).json({ error: e.message });
    }
  });

  // Promedio móvil de las últimas N evaluaciones (tendencia)
  app.get("/ventas/tendencia", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const vendedorId = String(req.query.vendedorId || "");
      const n = Math.min(Math.max(parseInt(req.query.n) || 10, 2), 50);
      if (!vendedorId) return res.status(400).json({ error: "Falta vendedorId." });
      const evals = await EvaluacionVenta.findMany({ where: { vendedorId }, orderBy: { createdAt: "asc" }, take: 200 });
      const serie = evals.map(e => e.promedio);
      // promedio móvil simple de ventana n
      const movil = serie.map((_, i) => {
        const ini = Math.max(0, i - n + 1); const w = serie.slice(ini, i + 1);
        return Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10;
      });
      res.json({ serie, movil, ventana: n });
    } catch (e) { res.status(500).json({ error: "Error en la tendencia." }); }
  });

  app.get("/ventas", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(PANEL);
  });
};

const PANEL = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1020"><title>Evaluación de Ventas</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--acc:#6366f1;--acc2:#818cf8;--bg:#0b1020;--card:#141a2e;--card2:#0f1424;--bd:#26304d;--tx:#e7ecf7;--gr:#8592b3;--rojo:#f87171;--amar:#fbbf24;--verde:#34d399;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;padding-bottom:40px;}
  header{position:sticky;top:0;z-index:10;background:#0b1020ee;backdrop-filter:blur(6px);border-bottom:1px solid var(--bd);padding:13px 16px;display:flex;align-items:center;gap:10px;}
  .logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--acc2),var(--acc));display:flex;align-items:center;justify-content:center;font-size:16px;}
  .h-t{font-size:15px;font-weight:800;} .h-t span{color:var(--acc2);}
  .wrap{max-width:1050px;margin:0 auto;padding:14px 16px;}
  .tabs{display:flex;gap:8px;margin-bottom:12px;}
  .tab{flex:1;background:var(--card);border:1px solid var(--bd);color:var(--gr);border-radius:10px;padding:10px;font-weight:800;font-size:13px;cursor:pointer;}
  .tab.act{background:linear-gradient(135deg,var(--acc2),var(--acc));color:#0b1020;border-color:transparent;}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:14px;margin-bottom:10px;}
  .btn{background:var(--acc);color:#0b1020;border:none;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;font-size:13px;}
  .btn.sec{background:transparent;border:1px solid var(--bd);color:var(--tx);}
  label{display:block;font-size:12px;color:var(--gr);margin:8px 0 3px;}
  input,textarea,select{width:100%;background:var(--card2);border:1px solid var(--bd);border-radius:9px;padding:9px 11px;color:var(--tx);font-size:14px;}
  textarea{min-height:150px;resize:vertical;font-family:inherit;}
  .vrow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #0e1424;cursor:pointer;}
  .vrow:hover{background:#161d33;}
  .vava{width:34px;height:34px;border-radius:50%;background:#1a2340;display:flex;align-items:center;justify-content:center;font-weight:800;color:var(--acc2);flex-shrink:0;}
  .vn{flex:1;} .vn b{font-size:14px;} .vn div{font-size:11px;color:var(--gr);}
  .score-big{font-size:20px;font-weight:800;} .sc-hi{color:var(--verde);} .sc-mid{color:var(--amar);} .sc-lo{color:var(--rojo);}
  .dim{margin:8px 0;} .dim .top{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px;} .dim .n{font-weight:600;}
  .bar{height:8px;border-radius:5px;background:#0e1424;overflow:hidden;} .bar>div{height:100%;border-radius:5px;}
  .cita{font-size:12px;color:var(--gr);font-style:italic;border-left:2px solid var(--acc);padding-left:8px;margin-top:3px;}
  .pill{font-size:11px;padding:2px 8px;border-radius:6px;font-weight:700;}
  .pill.f{background:#0e2a1e;color:var(--verde);} .pill.d{background:#2a1520;color:#fca5a5;}
  .msg{font-size:12.5px;margin-top:8px;} .msg.err{color:var(--rojo);} .msg.ok{color:var(--verde);}
  .mejora{background:#131a30;border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin-top:10px;font-size:13px;}
  .mejora b{color:var(--acc2);}
  .spark{display:flex;align-items:flex-end;gap:3px;height:44px;margin-top:8px;} .spark>div{flex:1;background:var(--acc);border-radius:3px 3px 0 0;min-height:3px;}
</style></head><body>
<header><div class="logo">📊</div><div class="h-t">Evaluación de <span>Ventas</span></div></header>
<div class="wrap">
  <div class="tabs">
    <button class="tab act" id="t-eval" onclick="verTab('eval')">✍️ Evaluar</button>
    <button class="tab" id="t-vend" onclick="verTab('vend')">👥 Vendedores</button>
  </div>

  <div id="sec-eval">
    <div class="card">
      <b>Evaluar una conversación</b>
      <label>Vendedor</label><select id="e-vend"></select>
      <label>Pegá la conversación de WhatsApp (exportada)</label>
      <textarea id="e-conv" placeholder="[12/05, 10:30] Cliente: Hola, cuánto cuesta...&#10;[12/05, 10:45] Vendedor: ..."></textarea>
      <div style="margin-top:10px"><button class="btn" onclick="evaluar()">🤖 Evaluar con IA</button></div>
      <div class="msg" id="e-msg"></div>
    </div>
    <div id="e-resultado"></div>
  </div>

  <div id="sec-vend" style="display:none">
    <div class="card">
      <b>Agregar vendedor</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label>Nombre</label><input id="v-nom"></div>
        <div><label>Email (con el que reenvía)</label><input id="v-email"></div>
      </div>
      <label>WhatsApp (para el resultado, opcional)</label><input id="v-wa">
      <div style="margin-top:10px"><button class="btn" onclick="crearVend()">+ Agregar</button></div>
      <div class="msg" id="v-msg"></div>
    </div>
    <div id="lista-vend"></div>
    <div id="detalle-vend"></div>
  </div>
</div>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||"";
let VENDS=[];
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(ruta,opts={}){const sep=ruta.includes("?")?"&":"?";const r=await fetch(ruta+sep+"token="+encodeURIComponent(TOKEN),{method:opts.method||(opts.body?"POST":"GET"),headers:{"Content-Type":"application/json"},body:opts.body?JSON.stringify(opts.body):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Error");return d;}
function colScore(s){return s>=7?"sc-hi":s>=5?"sc-mid":"sc-lo";}
function barColor(s){return s>=7?"#34d399":s>=5?"#fbbf24":"#f87171";}
const DIMS=[["tiempoRespuesta","Tiempo de respuesta"],["descubrimiento","Descubrimiento"],["objeciones","Manejo de objeciones"],["seguimiento","Seguimiento"],["cierre","Cierre"],["cumplimiento","Cumplimiento"]];

function verTab(t){
  document.getElementById("t-eval").classList.toggle("act",t==="eval");
  document.getElementById("t-vend").classList.toggle("act",t==="vend");
  document.getElementById("sec-eval").style.display=t==="eval"?"block":"none";
  document.getElementById("sec-vend").style.display=t==="vend"?"block":"none";
  if(t==="vend") cargarVends();
}
async function cargar(){ try{ const d=await api("/ventas/vendedores"); VENDS=d.vendedores||[]; llenarSelect(); }catch(e){ document.getElementById("e-msg").className="msg err"; document.getElementById("e-msg").textContent=e.message+" (revisá el token)"; } }
function llenarSelect(){ document.getElementById("e-vend").innerHTML=VENDS.length?VENDS.map(v=>'<option value="'+v.id+'">'+esc(v.nombre)+'</option>').join(""):'<option value="">— agregá un vendedor primero —</option>'; }

async function crearVend(){
  const msg=document.getElementById("v-msg"); msg.className="msg"; msg.textContent="Guardando…";
  try{ await api("/ventas/vendedores",{body:{nombre:document.getElementById("v-nom").value,email:document.getElementById("v-email").value,whatsapp:document.getElementById("v-wa").value}});
    document.getElementById("v-nom").value=document.getElementById("v-email").value=document.getElementById("v-wa").value="";
    msg.className="msg ok"; msg.textContent="✅ Vendedor agregado."; cargar(); cargarVends();
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
async function cargarVends(){
  try{ const d=await api("/ventas/vendedores"); VENDS=d.vendedores||[];
    document.getElementById("lista-vend").innerHTML='<div class="card"><b>Vendedores</b>'+(VENDS.length?VENDS.map(v=>
      '<div class="vrow" onclick="verDetalle(\\''+v.id+'\\')"><div class="vava">'+esc((v.nombre||"?")[0])+'</div><div class="vn"><b>'+esc(v.nombre)+'</b><div>'+esc(v.email)+' · '+v.evaluaciones+' evaluaciones</div></div><div class="score-big '+(v.promedio!=null?colScore(v.promedio):"")+'">'+(v.promedio!=null?v.promedio:"—")+'</div></div>'
    ).join(""):'<div style="color:var(--gr);padding:10px 0">Todavía no hay vendedores.</div>')+'</div>';
  }catch(e){}
}
async function verDetalle(id){
  const v=VENDS.find(x=>x.id===id);
  try{
    const d=await api("/ventas/evaluaciones?vendedorId="+id);
    const t=await api("/ventas/tendencia?vendedorId="+id).catch(()=>({movil:[]}));
    const evals=d.evaluaciones||[];
    let spark=""; if(t.movil&&t.movil.length){ const mx=10; spark='<div class="card"><b>Tendencia (promedio móvil)</b><div class="spark">'+t.movil.map(m=>'<div style="height:'+(m/mx*100)+'%;background:'+barColor(m)+'"></div>').join("")+'</div></div>'; }
    document.getElementById("detalle-vend").innerHTML='<div class="card"><b>'+esc(v.nombre)+'</b> — '+evals.length+' evaluaciones</div>'+spark+
      evals.map(e=>evalCard(e)).join("");
    document.getElementById("detalle-vend").scrollIntoView({behavior:"smooth"});
  }catch(e){ document.getElementById("detalle-vend").innerHTML='<div class="card" style="color:var(--rojo)">'+esc(e.message)+'</div>'; }
}
function evalCard(e){
  const dims=DIMS.map(([k,n])=>{const s=e[k]||0;return '<div class="dim"><div class="top"><span class="n">'+n+'</span><span class="'+colScore(s)+'">'+s+'/10</span></div><div class="bar"><div style="width:'+(s*10)+'%;background:'+barColor(s)+'"></div></div></div>';}).join("");
  const forts=(e.fortalezas||[]).map(f=>'<div style="margin:6px 0"><span class="pill f">Fortaleza</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const debs=(e.debilidades||[]).map(f=>'<div style="margin:6px 0"><span class="pill d">A mejorar</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const fecha=new Date(e.createdAt).toLocaleDateString("es-BO");
  return '<div class="card"><div style="display:flex;justify-content:space-between"><b>Evaluación · '+fecha+'</b><span class="score-big '+colScore(e.promedio)+'">'+e.promedio+'</span></div>'+dims+forts+debs+(e.mejoraConcreta?'<div class="mejora"><b>🎯 Mejora concreta:</b> '+esc(e.mejoraConcreta)+'</div>':'')+'</div>';
}
async function evaluar(){
  const msg=document.getElementById("e-msg"); const vid=document.getElementById("e-vend").value; const conv=document.getElementById("e-conv").value;
  if(!vid){ msg.className="msg err"; msg.textContent="Agregá y elegí un vendedor primero."; return; }
  msg.className="msg"; msg.textContent="🤖 Evaluando con IA… (puede tardar unos segundos)";
  document.getElementById("e-resultado").innerHTML="";
  try{
    const d=await api("/ventas/evaluar",{body:{vendedorId:vid,conversacion:conv}});
    msg.className="msg ok"; msg.textContent="✅ Evaluación lista y guardada.";
    document.getElementById("e-resultado").innerHTML=evalCard(d.evaluacion);
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
cargar();
</script></body></html>`;
