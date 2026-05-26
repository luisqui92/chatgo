// ChatGo — Autenticación JWT para panel admin
const crypto = require("crypto");
const url = require("url");
const os = require("os");
const { CONFIG, log } = require("../config");


// JWT_SECRET es obligatorio para evitar tokens predecibles
if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET no está definido en variables de entorno. El panel admin no funcionará de forma segura.");
  console.error("   Generá uno con: openssl rand -hex 32   y agregalo a Railway.");
}

// Usuarios definidos via variables de entorno
// Formato: ADMIN_USERS=luis:hash:superadmin,maria:hash:admin
function getUsuarios() {
  const raw = process.env.ADMIN_USERS || "";
  if (!raw) {
    // Usuario por defecto si no hay variable configurada
    return [{
      usuario: "admin",
      hashPass: hashPassword(process.env.ADMIN_PASSWORD || "chatgo2026"),
      rol: "superadmin",
      nombre: "Admin"
    }];
  }
  return raw.split(",").map(u => {
    const [usuario, hashPass, rol, nombre] = u.split(":");
    return { usuario, hashPass, rol: rol || "viewer", nombre: nombre || usuario };
  });
}

function hashPassword(pwd) {
  return crypto.createHash("sha256").update(pwd).digest("hex");
}

function generarToken(usuario, rol) {
  const payload = {
    usuario,
    rol,
    exp: Date.now() + 8 * 60 * 60 * 1000, // 8 horas
    iat: Date.now(),
  };
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(b64)
    .digest("hex")
    .slice(0, 32);
  return `${b64}.${sig}`;
}

function verificarToken(token) {
  if (!token) return null;
  try {
    const [b64, sig] = token.split(".");
    const expectedSig = crypto
      .createHmac("sha256", process.env.JWT_SECRET)
      .update(b64)
      .digest("hex")
      .slice(0, 32);
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (Date.now() > payload.exp) return null; // expirado
    return payload;
  } catch {
    return null;
  }
}

// Middleware para proteger endpoints admin
function requireAuth(rolesPermitidos = ["superadmin", "admin", "viewer"]) {
  return (req, res, next) => {
    const token = req.headers["authorization"]?.replace("Bearer ", "") ||
                  req.query.token;
    const payload = verificarToken(token);
    if (!payload) {
      return res.status(401).json({ error: "No autorizado — iniciá sesión en el panel" });
    }
    if (!rolesPermitidos.includes(payload.rol)) {
      return res.status(403).json({ error: "No tenés permiso para esta acción" });
    }
    req.adminUser = payload;
    next();
  };
}

// Permisos por rol
const PERMISOS = {
  superadmin: ["ver", "aprobar_chofer", "rechazar_chofer", "editar_config", "ver_tokens"],
  admin:      ["ver", "aprobar_chofer", "rechazar_chofer"],
  viewer:     ["ver"],
};

function tienePermiso(rol, permiso) {
  return (PERMISOS[rol] || []).includes(permiso);
}

// ─── RATE LIMITER simple ─────────────────────────────────────────────────────
// Mapa: key -> { count, resetAt }
const rateLimitStore = new Map();

function rateLimit({ windowMs = 60000, max = 60, keyFn = (req) => req.ip } = {}) {
  return (req, res, next) => {
    try {
      const key = keyFn(req);
      const now = Date.now();
      const entry = rateLimitStore.get(key);
      
      if (!entry || now > entry.resetAt) {
        rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
        return next();
      }
      
      entry.count++;
      if (entry.count > max) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        res.setHeader("Retry-After", retryAfter);
        return res.status(429).json({ 
          error: "Demasiadas peticiones. Intentá de nuevo en " + retryAfter + "s." 
        });
      }
      next();
    } catch (e) {
      next();
    }
  };
}

// Limpieza periódica para no acumular memoria
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt + 60000) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);


module.exports = { getUsuarios, hashPassword, generarToken, verificarToken, requireAuth, tienePermiso, rateLimit };
