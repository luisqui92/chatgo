// ChatGo — Rate Limiting en memoria (sin dependencias externas)
const { log } = require("../config");

const stores = {
  login: new Map(),    // IP → { count, resetAt }
  webhook: new Map(),
  admin: new Map(),
  medico: new Map(),
};

// Limpieza periódica para no acumular IPs
setInterval(() => {
  const now = Date.now();
  for (const store of Object.values(stores)) {
    for (const [ip, data] of store.entries()) {
      if (data.resetAt < now) store.delete(ip);
    }
  }
}, 5 * 60 * 1000); // cada 5 min

function getIP(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0].trim()) || 
         req.headers["x-real-ip"] || 
         req.socket?.remoteAddress || 
         "unknown";
}

function rateLimit(storeName, max, windowMs, message) {
  return (req, res, next) => {
    const ip = getIP(req);
    const store = stores[storeName];
    const now = Date.now();
    const data = store.get(ip);
    
    if (!data || data.resetAt < now) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    
    if (data.count >= max) {
      const waitSec = Math.ceil((data.resetAt - now) / 1000);
      res.setHeader("Retry-After", waitSec);
      log.warn(`[RATE_LIMIT] IP ${ip} bloqueada en ${storeName} (${data.count}/${max})`);
      return res.status(429).json({ 
        error: message || "Demasiadas peticiones. Esperá un momento.", 
        retryAfter: waitSec 
      });
    }
    
    data.count++;
    next();
  };
}

// Presets
const limitLogin = rateLimit("login", 10, 60 * 1000, "Demasiados intentos de login. Esperá 1 minuto.");
const limitWebhook = rateLimit("webhook", 1000, 60 * 1000, "Demasiadas peticiones al webhook");
const limitAdmin = rateLimit("admin", 200, 60 * 1000, "Demasiadas peticiones al panel admin");
const limitMedico = rateLimit("medico", 30, 60 * 1000, "Demasiadas peticiones. Esperá un momento.");

module.exports = { rateLimit, limitLogin, limitWebhook, limitAdmin, limitMedico, getIP };
