// ChatGo Salud — MySQL (Cloud SQL) totalmente separado de la base de taxis/
// choferes/pasajeros, que sigue en MongoDB (db/models.js). Otro motor, otro
// servidor: cero datos compartidos entre los dos módulos.
const mysql = require("mysql2/promise");
const { CONFIG, log } = require("../config");

let pool = null;

async function asegurarTablas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS medicos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NOT NULL UNIQUE,
      nombre VARCHAR(150) NOT NULL,
      especialidad VARCHAR(150) DEFAULT '',
      password_hash VARCHAR(64) NOT NULL,
      activo TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consultas_medicas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      medico_phone VARCHAR(20) NOT NULL,
      paciente_nombre VARCHAR(150) DEFAULT '',
      estado ENUM('procesando','completado','error') DEFAULT 'procesando',
      duracion_segundos FLOAT NULL,
      transcripcion_completa LONGTEXT,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_medico_created (medico_phone, created_at)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consulta_segmentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      consulta_id INT NOT NULL,
      hablante VARCHAR(10),
      texto TEXT,
      inicio_seg FLOAT,
      fin_seg FLOAT,
      orden INT,
      FOREIGN KEY (consulta_id) REFERENCES consultas_medicas(id) ON DELETE CASCADE,
      INDEX idx_consulta (consulta_id)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

if (CONFIG.MYSQL_SALUD_URL) {
  pool = mysql.createPool(CONFIG.MYSQL_SALUD_URL);
  asegurarTablas()
    .then(() => log.info("✅ MySQL Salud conectado y tablas listas (cluster separado de taxis)"))
    .catch(e => log.error("❌ MySQL Salud (creando tablas):", e.message));
} else {
  log.warn("⚠️  MYSQL_SALUD_URL no configurado — el módulo de consultas médicas no va a funcionar hasta que lo configures.");
}

// ─── MÉDICOS ────────────────────────────────────────────────────────────────
async function medicoBuscarPorPhone(phone) {
  const [rows] = await pool.query("SELECT * FROM medicos WHERE phone = ? LIMIT 1", [phone]);
  return rows[0] || null;
}

async function medicoCrear({ phone, nombre, especialidad, passwordHash }) {
  await pool.query(
    "INSERT INTO medicos (phone, nombre, especialidad, password_hash) VALUES (?, ?, ?, ?)",
    [phone, nombre, especialidad, passwordHash]
  );
}

// ─── CONSULTAS ──────────────────────────────────────────────────────────────
async function consultaCrear({ medicoPhone, pacienteNombre }) {
  const [res] = await pool.query(
    "INSERT INTO consultas_medicas (medico_phone, paciente_nombre, estado) VALUES (?, ?, 'procesando')",
    [medicoPhone, pacienteNombre]
  );
  return res.insertId;
}

async function consultaMarcarCompletada(id, { transcripcionCompleta, duracionSegundos, segmentos }) {
  await pool.query(
    "UPDATE consultas_medicas SET estado='completado', transcripcion_completa=?, duracion_segundos=? WHERE id=?",
    [transcripcionCompleta, duracionSegundos, id]
  );
  if (segmentos && segmentos.length) {
    const valores = segmentos.map((s, i) => [id, s.hablante, s.texto, s.inicioSeg, s.finSeg, i]);
    await pool.query(
      "INSERT INTO consulta_segmentos (consulta_id, hablante, texto, inicio_seg, fin_seg, orden) VALUES ?",
      [valores]
    );
  }
}

async function consultaMarcarError(id, error) {
  await pool.query("UPDATE consultas_medicas SET estado='error', error=? WHERE id=?", [error, id]);
}

async function consultaListarPorMedico(medicoPhone) {
  const [rows] = await pool.query(
    `SELECT id, paciente_nombre AS pacienteNombre, estado, duracion_segundos AS duracionSegundos, created_at AS createdAt
     FROM consultas_medicas WHERE medico_phone = ? ORDER BY created_at DESC LIMIT 50`,
    [medicoPhone]
  );
  return rows;
}

async function consultaObtenerDetalle(id, medicoPhone) {
  const [rows] = await pool.query(
    `SELECT id, paciente_nombre AS pacienteNombre, estado, duracion_segundos AS duracionSegundos,
            transcripcion_completa AS transcripcionCompleta, error, created_at AS createdAt
     FROM consultas_medicas WHERE id = ? AND medico_phone = ? LIMIT 1`,
    [id, medicoPhone]
  );
  if (!rows[0]) return null;
  const [segmentos] = await pool.query(
    "SELECT hablante, texto, inicio_seg AS inicioSeg, fin_seg AS finSeg FROM consulta_segmentos WHERE consulta_id = ? ORDER BY orden ASC",
    [id]
  );
  return { ...rows[0], segmentos };
}

function estaConfigurado() {
  return pool !== null;
}

module.exports = {
  estaConfigurado,
  medicoBuscarPorPhone, medicoCrear,
  consultaCrear, consultaMarcarCompletada, consultaMarcarError,
  consultaListarPorMedico, consultaObtenerDetalle,
};
