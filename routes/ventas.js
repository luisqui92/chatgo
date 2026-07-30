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
const multer = require("multer");
const { CONFIG, log } = require("../config");
const { Vendedor, EvaluacionVenta, LineaVentas, ChatVentas } = require("../db/models");
const RUBRO = require("../config/rubro_ventas");
const { extraerTextoDeArchivo } = require("../services/ventas_extraer");
const { enviarInforme } = require("../services/ventas_mail");
const { evaluarChat, MAP } = require("../services/ventas_evaluar");
const wa = require("../services/ventas_wa");

const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

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
        return { id: v.id, nombre: v.nombre, email: v.email, whatsapp: v.whatsapp, telefono: v.telefono, cargo: v.cargo, zona: v.zona, foto: v.foto, fechaIngreso: v.fechaIngreso, activo: v.activo, evaluaciones: n, promedio: prom };
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
      let foto = null;
      if (typeof b.foto === "string" && b.foto.startsWith("data:image") && b.foto.length < 900000) foto = b.foto;
      const v = await Vendedor.create({ data: {
        nombre, email,
        whatsapp: b.whatsapp ? String(b.whatsapp).trim() : null,
        telefono: b.telefono ? String(b.telefono).trim() : null,
        cargo: b.cargo ? String(b.cargo).trim() : null,
        zona: b.zona ? String(b.zona).trim() : null,
        foto,
        fechaIngreso: b.fechaIngreso ? new Date(b.fechaIngreso) : null,
      } });
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
      const fecha = b.fechaConversacion ? new Date(b.fechaConversacion) : new Date();

      const { evaluacion, tipo } = await evaluarChat(vendedor, conversacion, b.nombreArchivo || "", fecha);
      res.json({ ok: true, evaluacion, tipo });
    } catch (e) {
      if (e.code === "REPETIDO" || e.code === "SIN_NUEVOS") return res.status(409).json({ error: e.message, code: e.code });
      log.error("[VENTAS_EVALUAR]", e.message);
      res.status(422).json({ error: e.message });
    }
  });

  // Evaluar desde un ARCHIVO subido (zip/rar/txt/audio) — sin copiar y pegar
  app.post("/ventas/evaluar-archivo", subir.single("archivo"), async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const vendedor = await Vendedor.findUnique({ where: { id: String((req.body && req.body.vendedorId) || "") } });
      if (!vendedor) return res.status(400).json({ error: "Elegí un vendedor válido." });
      if (!req.file) return res.status(400).json({ error: "Subí el archivo del chat (ZIP, RAR, TXT o audio)." });

      let conversacion = "";
      try {
        conversacion = await extraerTextoDeArchivo(req.file.buffer, req.file.originalname, req.file.mimetype);
      } catch (e) { return res.status(422).json({ error: e.message }); }
      if (!conversacion || conversacion.trim().length < 20) {
        return res.status(422).json({ error: "No pude leer una conversación válida del archivo. Revisá que sea el chat exportado (o un audio claro)." });
      }

      const { evaluacion, tipo } = await evaluarChat(vendedor, conversacion, req.file.originalname, new Date());
      res.json({ ok: true, evaluacion, tipo });
    } catch (e) {
      if (e.code === "REPETIDO" || e.code === "SIN_NUEVOS") return res.status(409).json({ error: e.message, code: e.code });
      log.error("[VENTAS_EVAL_ARCHIVO]", e.message);
      res.status(422).json({ error: e.message });
    }
  });

  // Enviar el informe de una evaluación por correo (desde el correo padre)
  app.post("/ventas/enviar-correo", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const destino = String(b.destino || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) return res.status(400).json({ error: "Email de destino inválido." });
      const ev = await EvaluacionVenta.findUnique({ where: { id: String(b.evaluacionId || "") } });
      if (!ev) return res.status(404).json({ error: "Evaluación no encontrada." });
      const vendedor = await Vendedor.findUnique({ where: { id: ev.vendedorId } });
      await enviarInforme(destino, ev, vendedor || { nombre: "Vendedor" });
      res.json({ ok: true });
    } catch (e) {
      log.error("[VENTAS_MAIL]", e.message);
      res.status(422).json({ error: e.message });
    }
  });

  // ─── Enlace de líneas de WhatsApp por Baileys (dispositivo vinculado) ──────
  // Si el cliente de Prisma no fue regenerado en el server, LineaVentas es undefined.
  function lineasListas(res) {
    if (!LineaVentas || !ChatVentas) {
      res.status(503).json({ error: "En el servidor falta regenerar Prisma (npx prisma generate) y reiniciar. Las tablas de líneas todavía no están disponibles." });
      return false;
    }
    return true;
  }

  // Listar líneas con su estado actual (conectado / esperando QR / desconectado)
  app.get("/ventas/lineas", async (req, res) => {
    if (!auth(req, res)) return;
    if (!lineasListas(res)) return;
    try {
      const lineas = await LineaVentas.findMany({ where: { activa: true }, orderBy: { createdAt: "asc" } });
      const vends = await Vendedor.findMany({ select: { id: true, nombre: true } });
      const nombre = Object.fromEntries(vends.map(v => [v.id, v.nombre]));
      const out = await Promise.all(lineas.map(async l => {
        const est = wa.estadoPublico(l.id);
        const chats = await ChatVentas.count({ where: { lineaId: l.id } });
        return { id: l.id, vendedorId: l.vendedorId, vendedor: nombre[l.vendedorId] || "—", numero: est.numero || l.numero, estado: est.estado, qr: est.qr, chats };
      }));
      res.json({ disponible: wa.disponible(), lineas: out });
    } catch (e) { res.status(500).json({ error: "Error al listar líneas." }); }
  });

  // Crear una línea para un vendedor e iniciar el enlace (genera el QR)
  app.post("/ventas/lineas", async (req, res) => {
    if (!auth(req, res)) return;
    if (!lineasListas(res)) return;
    try {
      const vendedorId = String((req.body && req.body.vendedorId) || "");
      const vendedor = await Vendedor.findUnique({ where: { id: vendedorId } });
      if (!vendedor) return res.status(400).json({ error: "Elegí un vendedor válido." });
      if (!wa.disponible()) return res.status(503).json({ error: "El enlace por WhatsApp no está instalado en el servidor todavía." });
      const linea = await LineaVentas.create({ data: { vendedorId, estado: "qr" } });
      await wa.iniciarLinea(linea.id);
      res.json({ ok: true, id: linea.id });
    } catch (e) { log.error("[VENTAS_LINEA]", e.message); res.status(422).json({ error: e.message }); }
  });

  // Estado + QR de una línea (para hacer polling desde el navegador)
  app.get("/ventas/lineas/:id/estado", async (req, res) => {
    if (!auth(req, res)) return;
    res.json(wa.estadoPublico(String(req.params.id)));
  });

  // Volver a generar el QR / reintentar el enlace
  app.post("/ventas/lineas/:id/reintentar", async (req, res) => {
    if (!auth(req, res)) return;
    try { await wa.iniciarLinea(String(req.params.id)); res.json(wa.estadoPublico(String(req.params.id))); }
    catch (e) { res.status(422).json({ error: e.message }); }
  });

  // Desconectar (logout) y desactivar la línea
  app.post("/ventas/lineas/:id/desconectar", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      await wa.desconectarLinea(String(req.params.id));
      await LineaVentas.update({ where: { id: String(req.params.id) }, data: { activa: false } }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { res.status(422).json({ error: e.message }); }
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
<meta name="theme-color" content="#17110d"><link rel="icon" href="/logo.png">
<title>Evaluación de Ventas</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--acc:#c26e3d;--acc2:#e2965a;--bg:#17110d;--card:#221a13;--card2:#1a130d;--bd:#3a2e22;--tx:#f1e8dd;--gr:#a8968a;--rojo:#d9705a;--amar:#d9a441;--verde:#7fa662;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Georgia,serif;background:var(--bg);color:var(--tx);min-height:100vh;padding-bottom:30px;}
  header{position:sticky;top:0;z-index:10;background:#17110de8;backdrop-filter:blur(6px);border-bottom:1px solid var(--bd);padding:13px 18px;display:flex;align-items:center;gap:11px;}
  header img{width:32px;height:32px;border-radius:8px;}
  .h-t{font-size:16px;font-weight:700;letter-spacing:.2px;} .h-t span{color:var(--acc2);}
  .wrap{max-width:1000px;margin:0 auto;padding:16px 18px;}
  .tabs{display:flex;gap:8px;margin-bottom:14px;}
  .tab{flex:1;background:var(--card);border:1px solid var(--bd);color:var(--gr);border-radius:10px;padding:11px;font-weight:700;font-size:14px;cursor:pointer;}
  .tab.act{background:linear-gradient(135deg,var(--acc2),var(--acc));color:#fff;border-color:transparent;}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;margin-bottom:12px;}
  .card h3{font-size:15px;font-weight:700;margin-bottom:6px;}
  .btn{background:var(--acc);color:#fff;border:none;border-radius:10px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:14px;}
  .btn.sec{background:transparent;border:1px solid var(--bd);color:var(--tx);}
  label{display:block;font-size:12.5px;color:var(--gr);margin:10px 0 4px;}
  input,select{width:100%;background:var(--card2);border:1px solid var(--bd);border-radius:9px;padding:10px 12px;color:var(--tx);font-size:14px;}
  .file{border:1.5px dashed var(--bd);border-radius:11px;padding:16px;text-align:center;background:var(--card2);cursor:pointer;}
  .file:hover{border-color:var(--acc);}
  .file input{display:none;}
  .file .ic{font-size:22px;} .file .t{font-weight:700;margin-top:6px;font-size:14px;} .file .s{font-size:12px;color:var(--gr);margin-top:3px;}
  .file .sel{color:var(--acc2);font-weight:700;margin-top:8px;font-size:13px;}
  .avup{width:72px;height:72px;border-radius:50%;border:2px dashed var(--bd);background:var(--card2);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--gr);font-size:20px;text-align:center;line-height:1.1;flex-shrink:0;overflow:hidden;}
  .avup:hover{border-color:var(--acc);}
  .prob{display:flex;align-items:center;gap:14px;background:linear-gradient(135deg,#2a1c12,#221812);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;margin:10px 0;}
  .prob .p{font-size:30px;font-weight:800;} .prob .lbl{font-size:12px;color:var(--gr);}
  .fac{font-size:12.5px;margin:3px 0;} .fac .ok{color:var(--verde);} .fac .rg{color:var(--amar);}
  .emo{display:inline-block;font-size:12px;background:#2a2015;border:1px solid var(--bd);border-radius:20px;padding:3px 11px;font-weight:600;}
  .rideal{background:#241a12;border:1px solid var(--bd);border-radius:10px;padding:11px;margin-top:10px;font-size:12.5px;}
  .rideal .lbl{color:var(--acc2);font-weight:700;} .rideal .cur{color:var(--gr);} .rideal .id{color:var(--verde);}
  .alerta{background:#331a12;border:1px solid #6b3a24;color:#f0b090;border-radius:9px;padding:8px 11px;margin-top:7px;font-size:12.5px;}
  .dinero{color:var(--rojo);font-weight:800;}
  .comp{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12.5px;} .comp .n{width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} .comp .b{flex:1;height:9px;background:#241a11;border-radius:5px;overflow:hidden;} .comp .b>div{height:100%;} .comp .v{width:34px;text-align:right;font-weight:700;}
  .vtabs{display:flex;gap:6px;margin-bottom:12px;} .vt{flex:1;background:var(--card2);border:1px solid var(--bd);color:var(--gr);border-radius:8px;padding:9px;font-weight:700;font-size:12.5px;cursor:pointer;} .vt.act{background:var(--acc);color:#fff;border-color:transparent;}
  .rr{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid #241a11;cursor:pointer;} .rr .f{flex:1;font-size:13.5px;} .rr .f small{color:var(--gr);display:block;margin-top:2px;font-size:11.5px;}
  .cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;} .cal .h{text-align:center;font-size:10px;color:var(--gr);padding:3px 0;}
  .cald{aspect-ratio:1;border-radius:8px;background:var(--card2);border:1px solid var(--bd);display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;color:var(--gr);}
  .cald.has{cursor:pointer;color:var(--tx);} .cald .sc{font-size:13px;font-weight:800;}
  .calnav{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;} .calnav button{background:var(--card2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:5px 13px;cursor:pointer;font-size:16px;}
  .modal{display:none;position:fixed;inset:0;background:rgba(10,6,3,.88);z-index:100;overflow:auto;padding:16px;} .modal.show{display:block;} .modal .inner{max-width:640px;margin:0 auto;}
  .mclose{display:flex;justify-content:flex-end;margin-bottom:6px;} .mclose button{background:var(--card);border:1px solid var(--bd);color:var(--tx);border-radius:9px;padding:8px 15px;cursor:pointer;}
  .mailbtn{display:block;width:100%;background:#2e6b4f;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:700;font-size:14px;cursor:pointer;margin-bottom:14px;}
  .vrow{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #241a11;cursor:pointer;}
  .vrow:hover{opacity:.9;}
  .vava{width:36px;height:36px;border-radius:50%;background:#2e2116;display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--acc2);flex-shrink:0;}
  .vn{flex:1;} .vn b{font-size:14px;} .vn div{font-size:11.5px;color:var(--gr);margin-top:1px;}
  .score-big{font-size:21px;font-weight:800;} .sc-hi{color:var(--verde);} .sc-mid{color:var(--amar);} .sc-lo{color:var(--rojo);}
  .dim{margin:9px 0;} .dim .top{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;} .dim .n{font-weight:600;}
  .bar{height:8px;border-radius:5px;background:#241a11;overflow:hidden;} .bar>div{height:100%;border-radius:5px;}
  .cita{font-size:12.5px;color:var(--gr);font-style:italic;border-left:2px solid var(--acc);padding-left:9px;margin-top:3px;}
  .pill{font-size:11px;padding:2px 9px;border-radius:6px;font-weight:700;}
  .pill.f{background:#2a2915;color:#c9d18a;} .pill.d{background:#2f1c15;color:#e5a690;}
  .msg{font-size:13px;margin-top:10px;} .msg.err{color:var(--rojo);} .msg.ok{color:var(--verde);} .msg.warn{color:#b45309;background:#fff6e8;border:1px solid #f0d8ad;padding:8px 10px;border-radius:8px;}
  .mejora{background:#2a2015;border:1px solid var(--bd);border-radius:10px;padding:11px 13px;margin-top:11px;font-size:13.5px;}
  .mejora b{color:var(--acc2);}
  .spark{display:flex;align-items:flex-end;gap:3px;height:46px;margin-top:10px;} .spark>div{flex:1;border-radius:3px 3px 0 0;min-height:3px;}
  footer{text-align:center;color:var(--gr);font-size:12px;margin-top:24px;display:flex;align-items:center;justify-content:center;gap:7px;}
  footer img{width:16px;height:16px;border-radius:4px;opacity:.9;}
</style></head><body>
<header><img src="/logo.png" alt="ChatGo"><div class="h-t">Evaluación de <span>Ventas</span></div></header>
<div class="wrap">
  <div class="tabs">
    <button class="tab act" id="t-eval" onclick="verTab('eval')">Evaluación</button>
    <button class="tab" id="t-vend" onclick="verTab('vend')">Vendedores</button>
    <button class="tab" id="t-enlace" onclick="verTab('enlace')">WhatsApp</button>
  </div>

  <div id="sec-eval">
    <div class="card">
      <h3>Nueva evaluación</h3>
      <label>Vendedor</label><select id="e-vend"></select>
      <label>Archivo del chat exportado</label>
      <label class="file" for="e-file" id="file-box">
        <div class="ic">📎</div>
        <div class="t">Subí el archivo</div>
        <div class="s">Formatos: ZIP · RAR · TXT · audio</div>
        <div class="sel" id="file-sel"></div>
        <input type="file" id="e-file" accept=".zip,.rar,.txt,audio/*,.opus,.ogg,.mp3,.m4a" onchange="mostrarArchivo()">
      </label>
      <div style="margin-top:12px"><button class="btn" onclick="evaluar()">Evaluar</button></div>
      <div class="msg" id="e-msg"></div>
    </div>
    <div id="e-resultado"></div>
  </div>

  <div id="sec-vend" style="display:none">
    <div class="card">
      <h3>Nuevo vendedor</h3>
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:4px">
        <label class="avup" for="v-foto">
          <span id="v-foto-ph">＋<br><span style="font-size:10px">Foto</span></span>
          <img id="v-foto-img" style="display:none;width:100%;height:100%;object-fit:cover">
          <input type="file" id="v-foto" accept="image/*" style="display:none" onchange="cargarFoto()">
        </label>
        <div style="flex:1"><label>Nombre completo</label><input id="v-nom"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label>Cargo</label><input id="v-cargo" placeholder="Ej: Asesor comercial"></div>
        <div><label>Zona</label><input id="v-zona" placeholder="Ej: Cochabamba"></div>
        <div><label>Email (con el que reenvía)</label><input id="v-email"></div>
        <div><label>WhatsApp</label><input id="v-wa"></div>
        <div><label>Teléfono</label><input id="v-tel"></div>
        <div><label>Fecha de ingreso</label><input id="v-fecha" type="date"></div>
      </div>
      <div style="margin-top:12px"><button class="btn" onclick="crearVend()">Agregar vendedor</button></div>
      <div class="msg" id="v-msg"></div>
    </div>
    <div id="lista-vend"></div>
    <div id="detalle-vend"></div>
  </div>

  <div id="sec-enlace" style="display:none">
    <div class="card">
      <h3>Enlazar WhatsApp de un vendedor</h3>
      <p style="color:var(--gr);font-size:13px;margin:2px 0 12px">Conectá la línea de WhatsApp (dispositivo vinculado, como WhatsApp Web). Los chats entran solos y se evalúan sin exportar nada. Usá un <b>número dedicado</b> de la empresa.</p>
      <label>Vendedor</label><select id="l-vend"></select>
      <div style="margin-top:12px"><button class="btn" onclick="crearLinea()">Generar QR para enlazar</button></div>
      <div class="msg" id="l-msg"></div>
      <div id="l-qr" style="text-align:center;margin-top:10px"></div>
    </div>
    <div id="lista-lineas"></div>
  </div>
</div>
<footer><img src="/logo.png" alt=""> Powered by ChatGo</footer>
<div class="modal" id="informe-modal"><div class="inner"><div class="mclose"><button onclick="cerrarInforme()">Cerrar ✕</button></div><div id="informe-body"></div></div></div>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||"";
let VENDS=[], FOTO_B64=null, EV_ACT=[], V_ACT=null, CAL_MES=null;
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(ruta,opts={}){const sep=ruta.includes("?")?"&":"?";const r=await fetch(ruta+sep+"token="+encodeURIComponent(TOKEN),{method:opts.method||(opts.body?"POST":"GET"),headers:{"Content-Type":"application/json"},body:opts.body?JSON.stringify(opts.body):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Error");return d;}
function colScore(s){return s>=7?"sc-hi":s>=5?"sc-mid":"sc-lo";}
function barColor(s){return s>=7?"#7fa662":s>=5?"#d9a441":"#d9705a";}
const DIMS=[["tiempoRespuesta","Tiempo de respuesta"],["descubrimiento","Descubrimiento de necesidad"],["objeciones","Manejo de objeciones"],["seguimiento","Seguimiento"],["cierre","Cierre"],["cumplimiento","Cumplimiento de promesas"]];

function verTab(t){
  ["eval","vend","enlace"].forEach(function(x){
    document.getElementById("t-"+x).classList.toggle("act",t===x);
    document.getElementById("sec-"+x).style.display=t===x?"block":"none";
  });
  if(t==="vend") cargarVends();
  if(t==="enlace"){ llenarSelectLineas(); cargarLineas(); }
}
async function cargar(){ try{ const d=await api("/ventas/vendedores"); VENDS=d.vendedores||[]; llenarSelect(); }catch(e){ const m=document.getElementById("e-msg"); m.className="msg err"; m.textContent=e.message+" (revisá el token)"; } }
function llenarSelect(){ document.getElementById("e-vend").innerHTML=VENDS.length?VENDS.map(v=>'<option value="'+v.id+'">'+esc(v.nombre)+'</option>').join(""):'<option value="">— agregá un vendedor primero —</option>'; }
function mostrarArchivo(){ const f=document.getElementById("e-file").files[0]; document.getElementById("file-sel").textContent=f?("Seleccionado: "+f.name):""; }

function cargarFoto(){
  const f=document.getElementById("v-foto").files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=e=>{ const img=new Image(); img.onload=()=>{ const c=document.createElement("canvas"); const S=256; c.width=S;c.height=S; const ctx=c.getContext("2d"); const m=Math.min(img.width,img.height); ctx.drawImage(img,(img.width-m)/2,(img.height-m)/2,m,m,0,0,S,S); FOTO_B64=c.toDataURL("image/jpeg",0.82); const im=document.getElementById("v-foto-img"); im.src=FOTO_B64; im.style.display="block"; document.getElementById("v-foto-ph").style.display="none"; }; img.src=e.target.result; };
  rd.readAsDataURL(f);
}
async function crearVend(){
  const g=id=>document.getElementById(id).value;
  const msg=document.getElementById("v-msg"); msg.className="msg"; msg.textContent="Guardando…";
  try{ await api("/ventas/vendedores",{body:{nombre:g("v-nom"),email:g("v-email"),whatsapp:g("v-wa"),telefono:g("v-tel"),cargo:g("v-cargo"),zona:g("v-zona"),fechaIngreso:g("v-fecha")||null,foto:FOTO_B64}});
    ["v-nom","v-email","v-wa","v-tel","v-cargo","v-zona","v-fecha"].forEach(i=>document.getElementById(i).value="");
    FOTO_B64=null; document.getElementById("v-foto-img").style.display="none"; document.getElementById("v-foto-ph").style.display="block";
    msg.className="msg ok"; msg.textContent="Vendedor agregado."; cargar(); cargarVends();
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
async function cargarVends(){
  try{ const d=await api("/ventas/vendedores"); VENDS=d.vendedores||[];
    document.getElementById("lista-vend").innerHTML='<div class="card"><h3>Vendedores</h3>'+(VENDS.length?VENDS.map(v=>
      '<div class="vrow" onclick="verDetalle(\\''+v.id+'\\')"><div class="vava">'+(v.foto?'<img src="'+v.foto+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':esc((v.nombre||"?")[0]))+'</div><div class="vn"><b>'+esc(v.nombre)+'</b><div>'+(v.cargo?esc(v.cargo)+' · ':'')+v.evaluaciones+' evaluaciones</div></div><div class="score-big '+(v.promedio!=null?colScore(v.promedio):"")+'">'+(v.promedio!=null?v.promedio:"—")+'</div></div>'
    ).join(""):'<div style="color:var(--gr);padding:10px 0">Todavía no hay vendedores.</div>')+'</div>';
  }catch(e){}
}
async function verDetalle(id){
  const v=VENDS.find(x=>x.id===id);
  try{
    const d=await api("/ventas/evaluaciones?vendedorId="+id);
    const t=await api("/ventas/tendencia?vendedorId="+id).catch(()=>({movil:[]}));
    const evals=d.evaluaciones||[];
    // Cabecera con foto y datos
    const av=v.foto?'<img src="'+v.foto+'" style="width:56px;height:56px;border-radius:50%;object-fit:cover">':'<div class="vava" style="width:56px;height:56px;font-size:22px">'+esc((v.nombre||"?")[0])+'</div>';
    const meta=[v.cargo,v.zona,v.email].filter(Boolean).map(esc).join(" · ");
    const header='<div class="card"><div style="display:flex;align-items:center;gap:14px">'+av+'<div style="flex:1"><h3 style="margin:0">'+esc(v.nombre)+'</h3><div style="color:var(--gr);font-size:12.5px;margin-top:2px">'+meta+'</div><div style="color:var(--gr);font-size:12px;margin-top:2px">'+evals.length+' evaluaciones</div></div><div class="score-big '+(v.promedio!=null?colScore(v.promedio):"")+'">'+(v.promedio!=null?v.promedio:"—")+'</div></div></div>';
    // Comparación con el equipo
    const conProm=VENDS.filter(x=>x.promedio!=null);
    let comp="";
    if(conProm.length>1 && v.promedio!=null){
      const avgEmp=Math.round((conProm.reduce((s,x)=>s+x.promedio,0)/conProm.length)*10)/10;
      const orden=[...conProm].sort((a,b)=>b.promedio-a.promedio); const mejor=orden[0];
      const barras=orden.slice(0,5).map(x=>'<div class="comp"><span class="n" style="'+(x.id===id?"color:var(--acc2);font-weight:700":"")+'">'+esc(x.nombre)+'</span><span class="b"><div style="width:'+(x.promedio/10*100)+'%;background:'+barColor(x.promedio)+'"></div></span><span class="v">'+x.promedio+'</span></div>').join("");
      let gap=""; if(mejor.id!==id){ const pct=Math.round((mejor.promedio-v.promedio)/mejor.promedio*100); gap='<div style="margin-top:8px;font-size:13px">Estás un <b class="sc-lo">'+pct+'% por debajo</b> del mejor vendedor ('+esc(mejor.nombre)+').</div>'; }
      else gap='<div style="margin-top:8px;font-size:13px"><b class="sc-hi">Sos el mejor vendedor del equipo.</b> 👏</div>';
      comp='<div class="card"><h3>Comparación con el equipo</h3><div style="font-size:12.5px;color:var(--gr);margin-bottom:8px">Promedio empresa: <b style="color:var(--tx)">'+avgEmp+'</b></div>'+barras+gap+'</div>';
    }
    let spark=""; if(t.movil&&t.movil.length>1){ spark='<div class="card"><h3>Evolución (promedio móvil)</h3><div class="spark">'+t.movil.map(m=>'<div style="height:'+(m/10*100)+'%;background:'+barColor(m)+'"></div>').join("")+'</div></div>'; }
    EV_ACT=evals; V_ACT=v; CAL_MES=null;
    document.getElementById("detalle-vend").innerHTML=header+comp+spark+'<div class="card"><div class="vtabs"><button class="vt act" id="vt-res" onclick="verVista(\\'res\\')">Resumen</button><button class="vt" id="vt-cal" onclick="verVista(\\'cal\\')">Calendario</button></div><div id="vista-cont"></div></div>';
    verVista("res");
    document.getElementById("detalle-vend").scrollIntoView({behavior:"smooth"});
  }catch(e){ document.getElementById("detalle-vend").innerHTML='<div class="card" style="color:var(--rojo)">'+esc(e.message)+'</div>'; }
}
function verVista(m){ document.getElementById("vt-res").classList.toggle("act",m==="res"); document.getElementById("vt-cal").classList.toggle("act",m==="cal"); if(m==="res") pintarResumen(); else pintarCalendario(); }
function pintarResumen(){
  document.getElementById("vista-cont").innerHTML = EV_ACT.length? EV_ACT.map(function(e,i){
    var a=e.analisis||{}; var prob=a.probabilidadCierre!=null?(" · "+a.probabilidadCierre+"% cierre"):"";
    return '<div class="rr" onclick="abrirInforme('+i+')"><div class="f"><b>'+new Date(e.createdAt).toLocaleDateString("es-BO")+'</b><small>Calificación '+e.promedio+'/10'+prob+' — tocá para ver el informe completo</small></div><div class="score-big '+colScore(e.promedio)+'">'+e.promedio+'</div></div>';
  }).join(""):'<div style="color:var(--gr)">Sin evaluaciones aún.</div>';
}
function pintarCalendario(){
  if(!CAL_MES) CAL_MES = EV_ACT.length? new Date(EV_ACT[0].createdAt) : new Date();
  var y=CAL_MES.getFullYear(), m=CAL_MES.getMonth();
  var byDay={}; EV_ACT.forEach(function(e){ var d=new Date(e.createdAt); if(d.getFullYear()===y&&d.getMonth()===m){ (byDay[d.getDate()]=byDay[d.getDate()]||[]).push(e); } });
  var first=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate();
  var nombreMes=CAL_MES.toLocaleDateString("es-BO",{month:"long",year:"numeric"});
  var cells=""; ["D","L","M","M","J","V","S"].forEach(function(h){cells+='<div class="h">'+h+'</div>';});
  for(var i=0;i<first;i++) cells+='<div class="cald"></div>';
  for(var d=1;d<=days;d++){ var ev=byDay[d]; if(ev){ var prom=Math.round(ev.reduce(function(s,x){return s+x.promedio;},0)/ev.length*10)/10; cells+='<div class="cald has" onclick="abrirDia('+y+','+m+','+d+')"><div>'+d+'</div><div class="sc" style="color:'+barColor(prom)+'">'+prom+'</div></div>'; } else cells+='<div class="cald">'+d+'</div>'; }
  document.getElementById("vista-cont").innerHTML='<div class="calnav"><button onclick="calMes(-1)">‹</button><b style="text-transform:capitalize">'+nombreMes+'</b><button onclick="calMes(1)">›</button></div><div class="cal">'+cells+'</div>';
}
function calMes(delta){ CAL_MES=new Date(CAL_MES.getFullYear(),CAL_MES.getMonth()+delta,1); pintarCalendario(); }
function reporteHTML(e){ return evalCard(e)+'<button class="mailbtn" onclick="pedirCorreo(\\''+e.id+'\\')">✉️ Enviar por correo</button>'; }
function abrirInforme(i){ document.getElementById("informe-body").innerHTML=reporteHTML(EV_ACT[i]); document.getElementById("informe-modal").classList.add("show"); window.scrollTo(0,0); }
function abrirDia(y,m,d){ var evs=EV_ACT.filter(function(e){var x=new Date(e.createdAt);return x.getFullYear()===y&&x.getMonth()===m&&x.getDate()===d;}); document.getElementById("informe-body").innerHTML=evs.map(reporteHTML).join(""); document.getElementById("informe-modal").classList.add("show"); window.scrollTo(0,0); }
function cerrarInforme(){ document.getElementById("informe-modal").classList.remove("show"); }
async function pedirCorreo(id){ var dest=prompt("¿A qué correo envío el informe?"); if(!dest) return; try{ await api("/ventas/enviar-correo",{body:{evaluacionId:id,destino:dest}}); alert("Informe enviado a "+dest+" ✅"); }catch(e){ alert("No se pudo enviar: "+e.message); } }
function evalCard(e){
  const dims=DIMS.map(function(p){var k=p[0],n=p[1];var s=e[k]||0;return '<div class="dim"><div class="top"><span class="n">'+n+'</span><span class="'+colScore(s)+'">'+s+'/10</span></div><div class="bar"><div style="width:'+(s*10)+'%;background:'+barColor(s)+'"></div></div></div>';}).join("");
  const forts=(e.fortalezas||[]).map(f=>'<div style="margin:7px 0"><span class="pill f">Fortaleza</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const debs=(e.debilidades||[]).map(f=>'<div style="margin:7px 0"><span class="pill d">A mejorar</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const fecha=new Date(e.createdAt).toLocaleDateString("es-BO");
  const a=e.analisis||{};
  const EMO={entusiasmado:"😊 Entusiasmado",indeciso:"😐 Indeciso",molesto:"😠 Molesto",perdido:"😴 Perdió interés",neutral:"🙂 Neutral"};
  let prob=""; if(a.probabilidadCierre!=null){ const c=a.probabilidadCierre>=66?"sc-hi":a.probabilidadCierre>=40?"sc-mid":"sc-lo"; const facs=(a.factores||[]).map(f=>'<div class="fac"><span class="'+(f.tipo==="riesgo"?"rg":"ok")+'">'+(f.tipo==="riesgo"?"⚠":"✓")+'</span> '+esc(f.texto)+'</div>').join(""); prob='<div class="prob"><div><div class="p '+c+'">'+a.probabilidadCierre+'%</div><div class="lbl">prob. de cierre</div></div><div style="flex:1">'+facs+'</div></div>'; }
  let emo=""; if(a.emocionCliente){ emo='<div style="margin:8px 0"><span class="emo">Cliente: '+(EMO[a.emocionCliente]||esc(a.emocionCliente))+'</span>'+((a.emocionEvolucion&&a.emocionEvolucion.length>1)?' <span style="color:var(--gr);font-size:11.5px">('+a.emocionEvolucion.map(x=>(EMO[x]||x).replace(/^\\S+\\s/,"")).join(" → ")+')</span>':'')+'</div>'; }
  let dinero=""; if(a.dineroPerdido){ dinero='<div style="margin-top:8px;font-size:13px">💸 Dinero potencial perdido: <span class="dinero">Bs '+Number(a.dineroPerdido).toLocaleString("es-BO")+'</span></div>'; }
  let ideal=""; if(a.respuestaIdeal&&a.respuestaIdeal.respuesta_ideal){ const r=a.respuestaIdeal; ideal='<div class="rideal"><div class="lbl">Respuesta recomendada'+(r.situacion?' — '+esc(r.situacion):'')+'</div>'+(r.respuesta_actual?'<div class="cur" style="margin-top:4px">Respondió: "'+esc(r.respuesta_actual)+'"</div>':'')+'<div class="id" style="margin-top:4px">Ideal: "'+esc(r.respuesta_ideal)+'"</div></div>'; }
  let alertas=(a.alertasRiesgo||[]).map(x=>'<div class="alerta">⚠️ '+esc(x)+'</div>').join("");
  let resumen=a.resumenEjecutivo?'<div class="mejora" style="background:#221a12"><b>Resumen ejecutivo:</b> '+esc(a.resumenEjecutivo)+'</div>':'';
  return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Evaluación · '+fecha+'</h3><span class="score-big '+colScore(e.promedio)+'">'+e.promedio+'</span></div>'+prob+emo+dims+forts+debs+dinero+ideal+alertas+(e.mejoraConcreta?'<div class="mejora"><b>Mejora concreta:</b> '+esc(e.mejoraConcreta)+'</div>':'')+resumen+'</div>';
}
async function evaluar(){
  const msg=document.getElementById("e-msg"); const vid=document.getElementById("e-vend").value; const file=document.getElementById("e-file").files[0];
  if(!vid){ msg.className="msg err"; msg.textContent="Agregá y elegí un vendedor primero."; return; }
  if(!file){ msg.className="msg err"; msg.textContent="Subí el archivo del chat (ZIP, RAR, TXT o audio)."; return; }
  msg.className="msg"; msg.textContent="Evaluando… (puede tardar unos segundos)";
  document.getElementById("e-resultado").innerHTML="";
  try{
    const fd=new FormData(); fd.append("vendedorId",vid); fd.append("archivo",file);
    const r=await fetch("/ventas/evaluar-archivo?token="+encodeURIComponent(TOKEN),{method:"POST",body:fd});
    let d={}; try{ d=await r.json(); }catch(_){}
    if(r.status===409){ msg.className="msg warn"; msg.textContent="🔁 "+(d.error||"Este chat ya lo revisé."); return; }
    if(!r.ok){ if(r.status===413) throw new Error("El archivo es muy grande para el servidor. Hay que subir el límite de nginx (client_max_body_size)."); throw new Error(d.error||("Error "+r.status)); }
    msg.className="msg ok"; msg.textContent=(d.tipo==="continuacion")?"Chat continuado: evalué solo los mensajes nuevos. ✅":"Evaluación lista y guardada.";
    document.getElementById("e-resultado").innerHTML=(d.tipo==="continuacion"?'<div class="msg warn" style="margin-bottom:10px">Detecté que es la continuación de un chat ya evaluado. Solo califiqué la parte nueva.</div>':"")+reporteHTML(d.evaluacion);
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}

// ── Enlace de líneas de WhatsApp ──────────────────────────────────────────
let POLL_QR=null;
function llenarSelectLineas(){ document.getElementById("l-vend").innerHTML=VENDS.length?VENDS.map(v=>'<option value="'+v.id+'">'+esc(v.nombre)+'</option>').join(""):'<option value="">— agregá un vendedor primero —</option>'; }
function estadoPill(e){ if(e==="conectado") return '<span class="pill f">● Conectado</span>'; if(e==="qr") return '<span class="pill" style="background:#fff6e8;color:#b45309">Esperando QR</span>'; if(e==="conectando") return '<span class="pill" style="background:#eef;color:#556">Conectando…</span>'; return '<span class="pill d">Desconectado</span>'; }
async function cargarLineas(){
  try{
    const d=await api("/ventas/lineas");
    if(!d.disponible){ document.getElementById("lista-lineas").innerHTML='<div class="msg warn">El enlace por WhatsApp aún no está instalado en el servidor. Hay que correr <b>npm install</b> y prender VENTAS_WA_ENABLED=1.</div>'; return; }
    const ls=d.lineas||[];
    document.getElementById("lista-lineas").innerHTML=ls.length?('<div class="card"><h3>Líneas enlazadas</h3>'+ls.map(l=>'<div class="vrow" style="cursor:default"><div class="vn"><b>'+esc(l.vendedor)+'</b><div>'+(l.numero?('+'+esc(l.numero)+' · '):'')+l.chats+' chats · '+estadoPill(l.estado)+'</div></div>'+(l.estado==="conectado"?'':'<button class="vt" style="flex:none;padding:6px 10px" onclick="reintentar(\\''+l.id+'\\')">Reintentar</button>')+'<button class="vt" style="flex:none;padding:6px 10px;color:var(--rojo)" onclick="desconectar(\\''+l.id+'\\')">Quitar</button></div>').join("")+'</div>'):'';
  }catch(e){}
}
async function crearLinea(){
  const vid=document.getElementById("l-vend").value; const msg=document.getElementById("l-msg");
  if(!vid){ msg.className="msg err"; msg.textContent="Elegí un vendedor."; return; }
  msg.className="msg"; msg.textContent="Generando QR…"; document.getElementById("l-qr").innerHTML="";
  try{
    const d=await api("/ventas/lineas",{body:{vendedorId:vid}});
    msg.textContent="Escaneá el QR con el WhatsApp del vendedor (Ajustes → Dispositivos vinculados).";
    seguirQR(d.id);
    cargarLineas();
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
function seguirQR(id){
  if(POLL_QR) clearInterval(POLL_QR);
  POLL_QR=setInterval(async function(){
    try{
      const s=await api("/ventas/lineas/"+id+"/estado");
      if(s.estado==="qr"&&s.qr){ document.getElementById("l-qr").innerHTML='<img src="'+s.qr+'" style="width:260px;max-width:80%;border-radius:12px;border:1px solid var(--bd)"><div style="color:var(--gr);font-size:12px;margin-top:6px">Esperando escaneo…</div>'; }
      else if(s.estado==="conectado"){ clearInterval(POLL_QR); document.getElementById("l-qr").innerHTML='<div class="msg ok" style="font-size:15px">✅ Línea conectada'+(s.numero?(' (+'+s.numero+')'):'')+'. Los chats se evaluarán solos.</div>'; document.getElementById("l-msg").textContent=""; cargarLineas(); }
    }catch(e){}
  },2500);
}
async function reintentar(id){ try{ await api("/ventas/lineas/"+id+"/reintentar",{method:"POST"}); seguirQR(id); document.getElementById("l-msg").className="msg"; document.getElementById("l-msg").textContent="Escaneá el QR nuevamente."; }catch(e){ alert(e.message); } }
async function desconectar(id){ if(!confirm("¿Quitar esta línea? Se cerrará la sesión y dejará de capturar chats.")) return; try{ await api("/ventas/lineas/"+id+"/desconectar",{method:"POST"}); if(POLL_QR)clearInterval(POLL_QR); document.getElementById("l-qr").innerHTML=""; cargarLineas(); }catch(e){ alert(e.message); } }
cargar();
</script></body></html>`;
