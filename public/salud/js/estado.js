// Vitalis — estado compartido, helpers de formato, y el wrapper de fetch.
// Se carga primero: el resto de los módulos usan estas funciones/variables.
const API = ""; // mismo dominio que la API — se sirve desde /salud
let TOKEN = localStorage.getItem("salud_token") || null;
let MEDICO_NOMBRE = localStorage.getItem("salud_nombre") || "";
const app = document.getElementById("app");
const headerSub = document.getElementById("headerSub");
const btnLogout = document.getElementById("btnLogout");

// La transcripción y la nota clínica de consultas largas corren en segundo
// plano en el servidor; mientras no terminan, la pantalla se refresca sola.
let pollTimeout = null;
function detenerPolling() { if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; } }

function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function edadDesde(fechaNacimiento) {
  if (!fechaNacimiento) return null;
  const nac = new Date(fechaNacimiento);
  const hoy = new Date();
  let edad = hoy.getFullYear() - nac.getFullYear();
  const m = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) edad--;
  return edad;
}

function iniciales(nombre) {
  const partes = String(nombre || "").trim().split(/\s+/);
  return ((partes[0]?.[0] || "") + (partes[1]?.[0] || "")).toUpperCase();
}

function fmt(s){ const m=String(Math.floor(s/60)).padStart(2,"0"); const r=String(s%60).padStart(2,"0"); return m+":"+r; }

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  const res = await fetch(API + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw { status: res.status, error: (data && data.error) || "Error de conexión" };
  return data;
}

function logout() {
  TOKEN = null; MEDICO_NOMBRE = "";
  localStorage.removeItem("salud_token");
  localStorage.removeItem("salud_nombre");
  btnLogout.style.display = "none";
  headerSub.textContent = "Kardex inteligente";
  renderLogin();
}
