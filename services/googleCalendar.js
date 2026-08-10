// ChatGo Salud — Google Calendar: refleja las citas de Vitalis en el
// calendario del médico. Usa una cuenta de servicio (no OAuth por médico):
// el médico comparte SU calendario con el email de la cuenta de servicio
// ("hacer cambios en eventos") y listo — mucho más simple que un flujo de
// autorización por usuario, razonable para un prototipo con pocos médicos.
//
// Si GOOGLE_SERVICE_ACCOUNT_JSON no está configurado, o el médico no cargó
// su googleCalendarId, todas las funciones no hacen nada (no rompen la
// creación de la cita en Vitalis — el calendario es un espejo, no la fuente
// de verdad).
const crypto = require("crypto");
const axios = require("axios");
const { CONFIG, log } = require("../config");

let credencial = null;
function cargarCredencial() {
  if (credencial !== null) return credencial; // cache (incluye el caso "no configurado" = false)
  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) { credencial = false; return credencial; }
  try {
    credencial = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    log.error("[GOOGLE_CALENDAR] GOOGLE_SERVICE_ACCOUNT_JSON inválido:", e.message);
    credencial = false;
  }
  return credencial;
}

let tokenCache = { valor: null, expiraEn: 0 };
async function obtenerAccessToken() {
  const cred = cargarCredencial();
  if (!cred) return null;
  if (tokenCache.valor && Date.now() < tokenCache.expiraEn) return tokenCache.valor;

  const ahora = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: cred.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: ahora,
    exp: ahora + 3600,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const paraFirmar = `${b64(header)}.${b64(claims)}`;
  const firma = crypto.createSign("RSA-SHA256").update(paraFirmar).sign(cred.private_key, "base64url");
  const jwt = `${paraFirmar}.${firma}`;

  const res = await axios.post("https://oauth2.googleapis.com/token", new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  }));
  tokenCache = { valor: res.data.access_token, expiraEn: Date.now() + (res.data.expires_in - 60) * 1000 };
  return tokenCache.valor;
}

function eventoDesdeCita(cita) {
  const fin = new Date(new Date(cita.fecha).getTime() + (cita.duracionMinutos || 30) * 60000);
  return {
    summary: `Consulta — ${cita.pacienteNombre}`,
    description: cita.motivo || "",
    start: { dateTime: new Date(cita.fecha).toISOString() },
    end: { dateTime: fin.toISOString() },
  };
}

// Devuelve el eventId creado, o null si no hay credencial/calendario configurados.
async function crearEvento(calendarId, cita) {
  if (!calendarId) return null;
  try {
    const token = await obtenerAccessToken();
    if (!token) return null;
    const res = await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      eventoDesdeCita(cita),
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data.id;
  } catch (e) {
    log.error("[GOOGLE_CALENDAR] crearEvento:", e.response?.data || e.message);
    return null;
  }
}

async function actualizarEvento(calendarId, eventId, cita) {
  if (!calendarId || !eventId) return;
  try {
    const token = await obtenerAccessToken();
    if (!token) return;
    await axios.patch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      eventoDesdeCita(cita),
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    log.error("[GOOGLE_CALENDAR] actualizarEvento:", e.response?.data || e.message);
  }
}

async function eliminarEvento(calendarId, eventId) {
  if (!calendarId || !eventId) return;
  try {
    const token = await obtenerAccessToken();
    if (!token) return;
    await axios.delete(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    log.error("[GOOGLE_CALENDAR] eliminarEvento:", e.response?.data || e.message);
  }
}

module.exports = { crearEvento, actualizarEvento, eliminarEvento };
