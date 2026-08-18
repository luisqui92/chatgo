// Crea 10 pacientes de prueba con dolencias distintas (y una consulta ya
// "completada" cada uno, con transcripción + nota clínica) para mostrar el
// Kardex en una demo sin tener que grabar audio real en vivo.
// No pasa por AssemblyAI ni OpenAI — los datos ya vienen armados a mano.
//
// Uso: node scripts/seed_pacientes_demo.js <telefono_del_medico>
// Ej:  node scripts/seed_pacientes_demo.js 59176496075
//
// Es idempotente: si un paciente con ese nombre ya existe para ese médico,
// lo salta en vez de duplicarlo.

const mongoose = require("mongoose");
const { CONFIG } = require("../config");
const { Medico, Paciente, ConsultaMedica } = require("../db/models");

const PACIENTES_DEMO = [
  {
    nombre: "María Elena Rojas", fechaNacimiento: "1967-03-12", sexo: "Femenino", telefono: "59170011223",
    motivoConsulta: "Control de presión arterial, dolor de cabeza ocasional",
    sintomas: ["cefalea leve", "mareos esporádicos"],
    antecedentesRelevantes: "Hipertensión diagnosticada hace 5 años, madre con antecedente de hipertensión",
    diagnostico: "Hipertensión arterial no controlada",
    diagnosticosDiferenciales: ["cefalea tensional"],
    plan: "Ajuste de dosis de antihipertensivo, control de sal en la dieta, control en 2 semanas",
    medicamentosRecetados: [{ nombre: "Losartán", dosis: "50mg", frecuencia: "1 vez al día" }],
    examenesSolicitados: ["perfil lipídico", "creatinina"],
    proximoControl: "En 2 semanas",
    transcripcionCompleta: "Doctor, vengo por el control de presión de siempre, últimamente me duele un poco la cabeza. Bien, vamos a tomarle la presión ahora mismo. Está un poco alta, 150 sobre 95. Vamos a ajustar la dosis del Losartán y que controle la sal en las comidas.",
    duracionSegundos: 420,
  },
  {
    nombre: "Carlos Mamani Choque", fechaNacimiento: "1979-07-02", sexo: "Masculino", telefono: "59170022334",
    motivoConsulta: "Control de diabetes, sed excesiva últimos días",
    sintomas: ["poliuria", "polidipsia", "cansancio"],
    antecedentesRelevantes: "Diabetes tipo 2 diagnosticada hace 3 años",
    diagnostico: "Diabetes tipo 2 con control glucémico subóptimo",
    diagnosticosDiferenciales: [],
    plan: "Ajuste de metformina, reforzar dieta baja en azúcares, control de glucosa en ayunas",
    medicamentosRecetados: [{ nombre: "Metformina", dosis: "850mg", frecuencia: "2 veces al día" }],
    examenesSolicitados: ["glucosa en ayunas", "hemoglobina glicosilada"],
    proximoControl: "En 1 mes",
    transcripcionCompleta: "Doctor, he estado tomando mucha agua y yendo mucho al baño estos días, y me siento cansado. Vamos a revisar sus últimos análisis. La glucosa está un poco elevada, vamos a subir la dosis de metformina y pedirle una hemoglobina glicosilada.",
    duracionSegundos: 380,
  },
  {
    nombre: "Sofía Fernández Rivas", fechaNacimiento: "2017-11-20", sexo: "Femenino", telefono: "59170033445",
    motivoConsulta: "Tos y dificultad para respirar en las noches",
    sintomas: ["tos nocturna", "sibilancias", "dificultad respiratoria leve"],
    antecedentesRelevantes: "Episodios similares en invierno, padre con asma",
    diagnostico: "Crisis asmática leve",
    diagnosticosDiferenciales: ["bronquitis"],
    plan: "Salbutamol de rescate, control ambiental (evitar polvo/humo), control en 1 semana",
    medicamentosRecetados: [{ nombre: "Salbutamol", dosis: "inhalador", frecuencia: "según necesidad" }],
    examenesSolicitados: [],
    proximoControl: "En 1 semana",
    transcripcionCompleta: "Doctora, mi hija ha estado tosiendo mucho de noche y como que le cuesta respirar. Vamos a auscultarla. Sí, tiene sibilancias, es una crisis asmática leve, le voy a recetar salbutamol para cuando le pase esto.",
    duracionSegundos: 300,
  },
  {
    nombre: "Juan Condori Apaza", fechaNacimiento: "1962-01-15", sexo: "Masculino", telefono: "59170044556",
    motivoConsulta: "Ardor de estómago después de comer",
    sintomas: ["ardor epigástrico", "acidez", "distensión abdominal"],
    antecedentesRelevantes: "Consumo frecuente de café y comida picante",
    diagnostico: "Gastritis crónica",
    diagnosticosDiferenciales: ["reflujo gastroesofágico"],
    plan: "Omeprazol, evitar comidas irritantes y café, control en 3 semanas",
    medicamentosRecetados: [{ nombre: "Omeprazol", dosis: "20mg", frecuencia: "1 vez al día, en ayunas" }],
    examenesSolicitados: ["endoscopía si no mejora"],
    proximoControl: "En 3 semanas",
    transcripcionCompleta: "Doctor, después de comer me arde el estómago, sobre todo con el café. Eso suena a gastritis, vamos a darle omeprazol y que evite el café y la comida picante por un tiempo.",
    duracionSegundos: 340,
  },
  {
    nombre: "Ana Paola Vargas", fechaNacimiento: "1995-05-30", sexo: "Femenino", telefono: "59170055667",
    motivoConsulta: "Dolor de cabeza intenso de un lado, con náuseas",
    sintomas: ["cefalea pulsátil unilateral", "náuseas", "sensibilidad a la luz"],
    antecedentesRelevantes: "Episodios similares desde la adolescencia, madre con migraña",
    diagnostico: "Migraña sin aura",
    diagnosticosDiferenciales: ["cefalea tensional"],
    plan: "Analgésico para las crisis, identificar y evitar desencadenantes, control en 1 mes",
    medicamentosRecetados: [{ nombre: "Ibuprofeno", dosis: "400mg", frecuencia: "al inicio del dolor" }],
    examenesSolicitados: [],
    proximoControl: "En 1 mes",
    transcripcionCompleta: "Doctor, me da un dolor de cabeza fuerte de un solo lado, con ganas de vomitar y me molesta la luz. Eso es una migraña. Le voy a recetar ibuprofeno para cuando empiece el dolor, y vamos a ver qué es lo que se lo dispara.",
    duracionSegundos: 360,
  },
  {
    nombre: "Roberto Quispe Ticona", fechaNacimiento: "1974-09-08", sexo: "Masculino", telefono: "59170066778",
    motivoConsulta: "Dolor en la parte baja de la espalda hace una semana",
    sintomas: ["dolor lumbar", "rigidez matutina"],
    antecedentesRelevantes: "Trabajo que implica cargar peso",
    diagnostico: "Lumbalgia mecánica",
    diagnosticosDiferenciales: ["contractura muscular"],
    plan: "Antiinflamatorio, reposo relativo, ejercicios de fortalecimiento, control en 2 semanas",
    medicamentosRecetados: [{ nombre: "Diclofenaco", dosis: "50mg", frecuencia: "2 veces al día por 5 días" }],
    examenesSolicitados: ["radiografía de columna lumbar si no mejora"],
    proximoControl: "En 2 semanas",
    transcripcionCompleta: "Doctor, me duele la espalda baja desde hace una semana, sobre todo cuando cargo cosas en el trabajo. Vamos a revisar. Es una lumbalgia mecánica, le voy a dar un antiinflamatorio y que evite cargar peso por unos días.",
    duracionSegundos: 310,
  },
  {
    nombre: "Lucía Torres Mendoza", fechaNacimiento: "1990-02-18", sexo: "Femenino", telefono: "59170077889",
    motivoConsulta: "Estornudos y congestión nasal frecuentes",
    sintomas: ["estornudos", "congestión nasal", "picazón en los ojos"],
    antecedentesRelevantes: "Síntomas peores en época de polvo/polen",
    diagnostico: "Rinitis alérgica",
    diagnosticosDiferenciales: ["resfrío común"],
    plan: "Antihistamínico, evitar el alérgeno si se identifica, control en 1 mes",
    medicamentosRecetados: [{ nombre: "Loratadina", dosis: "10mg", frecuencia: "1 vez al día" }],
    examenesSolicitados: [],
    proximoControl: "En 1 mes",
    transcripcionCompleta: "Doctora, estornudo mucho y tengo la nariz tapada, sobre todo cuando hay polvo. Eso parece una rinitis alérgica, le voy a dar loratadina y trate de evitar el polvo lo más que pueda.",
    duracionSegundos: 290,
  },
  {
    nombre: "Fernando Aguilar Paz", fechaNacimiento: "1998-12-01", sexo: "Masculino", telefono: "59170088990",
    motivoConsulta: "Ardor al orinar desde hace 2 días",
    sintomas: ["disuria", "aumento de frecuencia urinaria"],
    antecedentesRelevantes: "Sin antecedentes relevantes",
    diagnostico: "Infección urinaria (sospecha)",
    diagnosticosDiferenciales: ["uretritis"],
    plan: "Antibiótico, aumentar ingesta de líquidos, control con resultado de examen de orina",
    medicamentosRecetados: [{ nombre: "Ciprofloxacino", dosis: "500mg", frecuencia: "2 veces al día por 5 días" }],
    examenesSolicitados: ["examen general de orina", "urocultivo"],
    proximoControl: "Con resultados de laboratorio",
    transcripcionCompleta: "Doctor, me arde cuando orino desde hace dos días y voy más seguido al baño. Suena a una infección urinaria, le voy a pedir un examen de orina y mientras tanto le doy un antibiótico.",
    duracionSegundos: 270,
  },
  {
    nombre: "Patricia Salazar Nina", fechaNacimiento: "1985-06-25", sexo: "Femenino", telefono: "59170099001",
    motivoConsulta: "Nerviosismo constante y problemas para dormir",
    sintomas: ["ansiedad", "insomnio", "palpitaciones ocasionales"],
    antecedentesRelevantes: "Aumento de estrés laboral en los últimos meses",
    diagnostico: "Trastorno de ansiedad",
    diagnosticosDiferenciales: ["hipertiroidismo"],
    plan: "Técnicas de manejo de estrés, evaluar apoyo psicológico, control en 3 semanas",
    medicamentosRecetados: [],
    examenesSolicitados: ["perfil tiroideo"],
    proximoControl: "En 3 semanas",
    transcripcionCompleta: "Doctor, últimamente estoy muy nerviosa, no puedo dormir bien y a veces siento que el corazón se me acelera. Vamos a pedir un perfil tiroideo para descartar otras causas, y le recomiendo buscar apoyo psicológico también.",
    duracionSegundos: 400,
  },
  {
    nombre: "Diego Choque Flores", fechaNacimiento: "2019-04-10", sexo: "Masculino", telefono: "59170100112",
    motivoConsulta: "Fiebre y dolor de garganta desde ayer",
    sintomas: ["fiebre", "dolor de garganta", "malestar general"],
    antecedentesRelevantes: "Sin antecedentes relevantes",
    diagnostico: "Faringitis viral probable",
    diagnosticosDiferenciales: ["faringitis bacteriana"],
    plan: "Paracetamol para la fiebre, líquidos abundantes, control si no mejora en 48 horas",
    medicamentosRecetados: [{ nombre: "Paracetamol", dosis: "según peso", frecuencia: "cada 6-8 horas si hay fiebre" }],
    examenesSolicitados: [],
    proximoControl: "En 48 horas si no mejora",
    transcripcionCompleta: "Doctora, mi hijo amaneció con fiebre y dice que le duele la garganta. Vamos a revisarlo. Tiene la garganta un poco roja, parece viral, le doy paracetamol para la fiebre y que tome bastante líquido.",
    duracionSegundos: 250,
  },
];

function generarSegmentos(transcripcion, duracionSegundos) {
  // Corta el texto en 2-4 "turnos" alternados médico/paciente, con tiempos aproximados.
  const partes = transcripcion.split(". ").filter(Boolean);
  const paso = duracionSegundos / partes.length;
  return partes.map((texto, i) => ({
    hablante: i % 2 === 0 ? "A" : "B",
    texto: texto.trim().endsWith(".") ? texto.trim() : texto.trim() + ".",
    inicioSeg: Math.round(i * paso),
    finSeg: Math.round((i + 1) * paso),
  }));
}

async function main() {
  const medicoPhone = String(process.argv[2] || "").trim();
  if (!medicoPhone) {
    console.error("Uso: node scripts/seed_pacientes_demo.js <telefono_del_medico>");
    process.exit(1);
  }

  await mongoose.connect(CONFIG.MONGODB_URI);
  console.log("✅ Conectado a MongoDB\n");

  const medico = await Medico.findOne({ phone: medicoPhone });
  if (!medico) {
    console.error(`❌ No existe ningún médico registrado con el teléfono ${medicoPhone}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Creando pacientes de demo para: ${medico.nombre} (+${medico.phone})\n`);

  let creados = 0, saltados = 0;
  for (const d of PACIENTES_DEMO) {
    const yaExiste = await Paciente.findOne({ medicoPhone, nombre: d.nombre });
    if (yaExiste) {
      console.log(`⏭️  Ya existe: ${d.nombre} — salteado`);
      saltados++;
      continue;
    }

    const paciente = await Paciente.create({
      medicoPhone,
      nombre: d.nombre,
      fechaNacimiento: new Date(d.fechaNacimiento),
      sexo: d.sexo,
      telefono: d.telefono,
      notas: "",
    });

    await ConsultaMedica.create({
      medicoPhone,
      pacienteId: paciente._id,
      pacienteNombre: paciente.nombre,
      estado: "completado",
      duracionSegundos: d.duracionSegundos,
      transcripcionCompleta: d.transcripcionCompleta,
      segmentos: generarSegmentos(d.transcripcionCompleta, d.duracionSegundos),
      notaClinicaEstado: "completado",
      notaClinica: {
        motivoConsulta: d.motivoConsulta,
        sintomas: d.sintomas,
        antecedentesRelevantes: d.antecedentesRelevantes,
        diagnostico: d.diagnostico,
        diagnosticosDiferenciales: d.diagnosticosDiferenciales,
        plan: d.plan,
        medicamentosRecetados: d.medicamentosRecetados,
        examenesSolicitados: d.examenesSolicitados,
        proximoControl: d.proximoControl,
      },
    });

    console.log(`✅ Creado: ${d.nombre} — ${d.diagnostico}`);
    creados++;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏁 Listo. Creados: ${creados} · Ya existían: ${saltados}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
