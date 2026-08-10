// ChatGo Salud — Agenda: calcula los horarios disponibles de un médico
// cruzando su horario de atención configurado contra las citas ya
// confirmadas. Lo usan tanto la web (para armar una cita a mano) como la
// reserva conversacional por WhatsApp.
const { Medico, Cita } = require("../db/models");

function combinarFechaHora(fecha, horaStr) {
  const [h, m] = String(horaStr || "00:00").split(":").map(Number);
  const d = new Date(fecha);
  d.setHours(h, m, 0, 0);
  return d;
}

// [{ fecha: "2026-08-11", slots: [Date, ...] }, ...] — solo días con al
// menos un horario libre, solo horarios futuros.
async function obtenerHorariosDisponibles(medicoPhone, diasAdelante = 7) {
  const medico = await Medico.findOne({ phone: medicoPhone }).lean();
  if (!medico) return [];
  const duracion = medico.duracionConsultaMinutos || 30;
  const horario = medico.horarioAtencion || [];
  if (horario.length === 0) return [];

  const desde = new Date();
  const hasta = new Date();
  hasta.setDate(hasta.getDate() + diasAdelante);

  const citasOcupadas = await Cita.find({
    medicoPhone, estado: "confirmada", fecha: { $gte: desde, $lt: hasta },
  }).select("fecha duracionMinutos").lean();

  const dias = [];
  for (let i = 0; i < diasAdelante; i++) {
    const dia = new Date();
    dia.setDate(dia.getDate() + i);
    dia.setHours(0, 0, 0, 0);
    const bloques = horario.filter(h => h.diaSemana === dia.getDay());
    if (bloques.length === 0) continue;

    const slots = [];
    for (const bloque of bloques) {
      let cursor = combinarFechaHora(dia, bloque.horaInicio);
      const fin = combinarFechaHora(dia, bloque.horaFin);
      while (cursor.getTime() + duracion * 60000 <= fin.getTime()) {
        if (cursor.getTime() > Date.now()) {
          const inicioSlot = cursor.getTime();
          const finSlot = inicioSlot + duracion * 60000;
          const ocupado = citasOcupadas.some(c => {
            const inicioC = new Date(c.fecha).getTime();
            const finC = inicioC + (c.duracionMinutos || 30) * 60000;
            return inicioSlot < finC && finSlot > inicioC;
          });
          if (!ocupado) slots.push(new Date(cursor));
        }
        cursor = new Date(cursor.getTime() + duracion * 60000);
      }
    }
    if (slots.length) dias.push({ fecha: dia.toISOString().slice(0, 10), slots });
  }
  return dias;
}

// Un horario puntual sigue libre? (se revalida antes de confirmar una
// reserva, por si se ocupó entre que se mostró la lista y se eligió).
async function horarioSigueLibre(medicoPhone, fecha, duracionMinutos) {
  const inicio = new Date(fecha).getTime();
  const fin = inicio + (duracionMinutos || 30) * 60000;
  const citas = await Cita.find({
    medicoPhone, estado: "confirmada",
    fecha: { $gte: new Date(inicio - 6 * 3600000), $lte: new Date(fin) },
  }).select("fecha duracionMinutos").lean();
  return !citas.some(c => {
    const inicioC = new Date(c.fecha).getTime();
    const finC = inicioC + (c.duracionMinutos || 30) * 60000;
    return inicio < finC && fin > inicioC;
  });
}

module.exports = { obtenerHorariosDisponibles, horarioSigueLibre };
