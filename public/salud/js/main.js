// Vitalis — arranque. Se carga último, después de que todos los módulos
// definieron sus funciones.
btnLogout.onclick = logout;

if (TOKEN) renderDashboard(); else renderLogin();
