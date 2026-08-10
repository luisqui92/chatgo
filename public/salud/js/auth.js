// Vitalis — Login y registro de médicos.

function renderLogin() {
  detenerPolling();
  app.innerHTML = `
    <div class="card">
      <label>Teléfono</label>
      <input id="lPhone" type="tel" placeholder="591XXXXXXXX">
      <label>Contraseña</label>
      <input id="lPass" type="password" placeholder="••••••••">
      <div id="lErr"></div>
      <button class="primary" id="lBtn">Ingresar</button>
      <button class="link" id="lGoReg">¿No tenés cuenta? Registrate</button>
    </div>`;
  document.getElementById("lGoReg").onclick = renderRegistro;
  document.getElementById("lBtn").onclick = async () => {
    const phone = document.getElementById("lPhone").value.trim();
    const password = document.getElementById("lPass").value;
    const errBox = document.getElementById("lErr");
    errBox.innerHTML = "";
    if (!phone || !password) { errBox.innerHTML = `<div class="error">Completá teléfono y contraseña</div>`; return; }
    try {
      const data = await api("/medico/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ phone, password }) });
      TOKEN = data.token; MEDICO_NOMBRE = data.nombre;
      localStorage.setItem("salud_token", TOKEN);
      localStorage.setItem("salud_nombre", MEDICO_NOMBRE);
      renderDashboard();
    } catch (e) {
      errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo iniciar sesión")}</div>`;
    }
  };
}

function renderRegistro() {
  detenerPolling();
  app.innerHTML = `
    <div class="card">
      <label>Teléfono</label>
      <input id="rPhone" type="tel" placeholder="591XXXXXXXX">
      <label>Nombre completo</label>
      <input id="rNombre" type="text" placeholder="Dra. Fulana Pérez">
      <label>Especialidad (opcional)</label>
      <input id="rEsp" type="text" placeholder="Medicina general">
      <label>Contraseña (mínimo 8 caracteres)</label>
      <input id="rPass" type="password" placeholder="••••••••">
      <div id="rErr"></div>
      <button class="primary" id="rBtn">Registrarme</button>
      <button class="link" id="rGoLogin">Ya tengo cuenta, ingresar</button>
    </div>`;
  document.getElementById("rGoLogin").onclick = renderLogin;
  document.getElementById("rBtn").onclick = async () => {
    const phone = document.getElementById("rPhone").value.trim();
    const nombre = document.getElementById("rNombre").value.trim();
    const especialidad = document.getElementById("rEsp").value.trim();
    const password = document.getElementById("rPass").value;
    const errBox = document.getElementById("rErr");
    errBox.innerHTML = "";
    if (!phone || !nombre || !password) { errBox.innerHTML = `<div class="error">Completá teléfono, nombre y contraseña</div>`; return; }
    try {
      await api("/medico/registro", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ phone, nombre, especialidad, password }) });
      errBox.innerHTML = `<div class="hint">✅ Cuenta creada. Ahora ingresá con tu teléfono y contraseña.</div>`;
      setTimeout(renderLogin, 1200);
    } catch (e) {
      errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo registrar")}</div>`;
    }
  };
}
