// ChatGo — Autenticación JWT para panel admin
const crypto = require("crypto");
const url = require("url");
const os = require("os");
const { CONFIG, log } = require("../config");

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
    .createHmac("sha256", process.env.JWT_SECRET || "chatgo_jwt_secret_cambiar")
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
      .createHmac("sha256", process.env.JWT_SECRET || "chatgo_jwt_secret_cambiar")
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

module.exports = { getUsuarios, hashPassword, generarToken, verificarToken, requireAuth, tienePermiso };
