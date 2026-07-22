# ChatGo — Documentación técnica

**Plataforma multiservicio de movilidad sobre WhatsApp con IA · Cochabamba, Bolivia**

| Campo | Valor |
|---|---|
| Inicio del repositorio | 2026-06-07 |
| Última actualización | 2026-07-22 |
| Cambios registrados | 196 commits |
| Tamaño del código | ~16.925 líneas (JavaScript) |
| Estado | En producción — api.chatgo.ia.bo |
| Rama de desarrollo | claude/code-review-feedback-uzrrhn |

## Arquitectura
- **Servidor:** Google Compute Engine + Node.js + PM2 + Nginx (SSL).
- **Base de datos:** Cloud SQL (MySQL) + Prisma.
- **Mensajería:** WhatsApp Cloud API (Meta).
- **Mapas:** Google Maps Platform (Routes, Geocoding, Places, Maps JS, Map ID vectorial).
- **IA:** OpenAI (Whisper + GPT + TTS).
- **GPS:** Traccar / ChatgoTrack.
- **Push:** Web Push (VAPID) + Service Worker.

## Módulos de servicio
taxi (núcleo), ambulancia, bus, delivery, favor, captura/util. Modo adulto mayor y billetera familiar.

## Rutas HTTP (routes/)
webhook, admin, pagoNotificacion, mapa, web (/pedir + /api/web/*), bus, flota, trufis, panel, links.

## Modelo de datos (Prisma, 20 modelos)
Usuario, Chofer, Viaje, CodigoPromo, SessionState, ListaEspera, RateLimit, LocationReference, Demanda, EventoChofer, AlertaSeg, Surge, ViajeDemo, EsquinaMapeada, PreRegistroFlota, Flota, NotificacionPago, Solicitud, Restaurante, Plato.

## Despliegue
```bash
git pull origin claude/code-review-feedback-uzrrhn
npx prisma migrate deploy && npx prisma generate
pm2 restart chatgo --update-env
```

## Historial de cambios completo (por fecha)

### 2026-06-07
- feat: script aprobación masiva de 25 choferes pendientes
- feat: script aprobación masiva con envío WhatsApp via GreenAPI
- feat: script notificación masiva cambio WiaTag→ChatgoTrack

### 2026-06-08
- feat: actualizar tarifas escalonadas con tarifa nocturna +15%
- fix: corregir retorno de calcularPrecio con nueva estructura escalonada
- fix: importar enviarMensaje en utils.js para enviarCodigoDescuento
- fix: consultar posiciones Traccar una por una en lugar de bulk (404)
- fix: lazy load traccar para evitar dependencia circular
- fix: obtener todas las posiciones en una sola llamada a Traccar

### 2026-06-10
- perf: snapshot global de posiciones con refresco en background + timeouts 3s

### 2026-06-11
- Mejora reconocimiento de voz: prompt con lugares de Cochabamba + regla Plaza/Mercado en interpretacion
- Geocodificacion: priorizar lugar real (plaza/parque/mercado) sobre calle del mismo nombre
- Transcripcion: usar gpt-4o-transcribe (menos errores) con fallback automatico a whisper-1
- Memoria de voz: match por interseccion de calles (reconoce mismo cruce aunque se diga distinto, sin confundir cruces diferentes)

### 2026-06-12
- limpieza: eliminar carpeta chatgo/ obsoleta, unificar Surge schema, reemplazar URLs Railway hardcodeadas por CONFIG.APP_URL
- limpieza: eliminar import y servicio Wialon obsoletos
- fix: limpiar sesión del chofer al terminar viaje para evitar routing incorrecto a flujo pasajero
- fix: chofer registrado nunca se clasifica como pasajero por sesión residual + log de routing
- fix: zombie cleanup para viajes en_camino/esperando_pasajero/en_curso sin actividad por más de 90 min
- feat: zombie cleanup inteligente con límites dinámicos por estado y verificación de tráfico Google antes de cerrar
- feat: Copiloto IA - motor de seguridad multinivel (verde/amarillo/naranja/rojo)
- feat: Copiloto de Habitos - sugerencia inteligente de viajes por hora del dia

### 2026-06-13
- feat: Modo Adulto Mayor - base de TTS (respuestas por voz) + billetera familiar
- feat: Opcion C voz - espejo (audio->audio) + confirmacion hablada tras pedido por voz
- fix: routing - steps de pasajero con prefijo chofer_ ya no se confunden con registro de chofer
- fix: limpiar sesion de pasajero y chofer al cerrar viaje zombie
- fix: TTS robusto + UMSS y lugares grandes piden pin en vez de adivinar
- fix: pin de destino ya no se guarda como origen + comando /voz para diagnosticar TTS
- fix: TTS usa MP3 (audio/mpeg) en vez de opus - formato mas confiable para WhatsApp
- fix: TTS replica metodo exacto del bot parroquial que funcionaba
- feat: voz global automatica - si el usuario habla, TODO el flujo responde por voz
- fix: enviarVoz usa archivo temporal + axios stream (resuelve 'source.on is not a function')
- feat: flujo rapido por voz - viaje en 2 pasos sin botones para adultos mayores
- fix: flujo rapido voz - texto visual minimo (no repetir lo que dice el audio)
- feat: flujo voz puro sin botones cuando la IA entiende con claridad
- fix: quitar redundancia en flujo voz - sin Procesando/Escuche/responde-si

### 2026-06-14
- feat: MODO_DEMO para presentaciones - ignora distancia y pago diario
- feat: script para precargar lugares conocidos geocodificando con Google
- fix CRITICO: flujo de audio ignoraba la ciudad del usuario (asumia Cochabamba)

### 2026-06-16
- feat: script de pre-carga masiva con Places API por categorias
- fix: timeout TTS (acortar audio) + guardar referencias en ciudad correcta
- fix: limpiar referencias mal etiquetadas + Calculando sin voz
- fix: omitir advertencias largas de precision en modo voz + limite voz 280
- feat: comandos admin por WhatsApp para cargar/limpiar lugares (sin terminal)

### 2026-06-17
- feat: foto combinada unica para demo (FOTO_DEMO_COMBINADA)
- fix: evitar que un pedido nuevo se confunda con confirmacion de viaje viejo
- fix URGENTE: no pedir mas referencias si el lugar ya esta en memoria
- fix URGENTE: ciudadParaAudio se usaba antes de definirse (crash en audio)
- fix URGENTE: no agarrar lugar homonimo de otra ciudad
- perf: paralelizar calculos del flujo de voz (era ~1 min, ahora mucho mas rapido)
- Revert "perf: paralelizar calculos del flujo de voz (era ~1 min, ahora mucho mas rapido)"
- feat: comando 'limpiar referencias' borra datos basura por coordenadas

### 2026-06-18
- feat: Capa 1 flotas - campo flota en chofer + comando admin para asignar/listar
- feat: asignacion masiva de choferes a flota (opcion C)
- feat: reporte de flota por WhatsApp (global + detalle por chofer)
- feat: panel web de flota para duenos de radiotaxi (pagina independiente)
- feat: endpoint JSON /admin/flota-data para consumir desde Netlify
- feat: codigo de radiotaxi antes del registro (vinculacion a flota)
- Agregar modelo Flota (radiotaxis aliados) escalable en Mongo
- Endpoint flota-data: validar token desde colección flotas en Mongo (escalable, sin variables)
- Agregar tarifa van (8-14 pasajeros) a calcularPrecio
- Agregar opcion Van en viajes urbanos (boton, precio, eleccion)
- Texto de busqueda incluye van
- Chofer de prueba ffjj (comodin): recibe todos los tipos de viaje (auto/moto/van) para testing
- Chofer prueba ffjj: eximir tambien del pago diario (recibe todo siempre para testing)
- Van: mostrar '(8 a 14 personas)' en el mensaje de opciones

### 2026-06-23
- fix: completar propagacion de ciudad en memoria de voz (geocode + crowdsourcing)
- fix: timeouts agresivos en conexion Mongo para evitar esperas de 30s
- fix: bloquear matching de chofer entre ciudades distintas
- feat: chofer de pruebas con asignacion forzada sin filtros

### 2026-06-24
- feat: corte diario proactivo de pago a choferes a las 4am Bolivia
- feat: agregar QR de cobro y exigir pago real al chofer de prueba
- Merge branch 'claude/code-review-feedback-uzrrhn'

### 2026-06-25
- fix: choferPagoAlDia no validaba pagoDiario.aprobado, dejaba pasar pago sin aprobación del admin
- feat: webhook de auto-aprobacion de pago via notificacion bancaria (Yape + MacroDroid)
- feat: agrega endpoint para resetear pago del chofer de prueba
- fix: aprobar pago cuando la notificacion bancaria llega antes que el comprobante

### 2026-06-26
- wip: arranca migracion de MongoDB/Mongoose a MySQL/Prisma
- wip: migra services/session.js de Mongoose a Prisma
- Reescribe todas las queries Mongoose a Prisma en el resto del codebase
- Ignorar .env para no commitear credenciales
- fix: importar calcularPrecio en flows/chofer.js (ReferenceError pre-existente)

### 2026-06-27
- Agregar script de migración real MongoDB Atlas → Cloud SQL MySQL
- Agregar fallbacks defensivos en transform de demandas para datos legacy incompletos

### 2026-06-30
- feat: página de mapa propia para choferes con tráfico en tiempo real
- feat: lugares favoritos para adultos mayores configurados por familiar
- add GET /webhook handler for Meta verification challenge
- auto-add Bolivia country code (591) in familiar flow — users type short number
- support contact sharing (vCard) in familiar flow for linking accounts
- fix familiar vincular: use wa.me link instead of direct push to avoid 24h window
- Integrar plantilla WhatsApp vincular_cuenta_familiar
- Fix: enviarPlantillaVincular envía 1 parámetro ({{2}} cuenta como 1 variable)
- Usar nombre de perfil WhatsApp (waName) en plantilla vincular_cuenta_familiar
- Mostrar nombre real de WhatsApp (waName) en menú familiar y confirmación de adulto
- Agregar salida del flujo familiar con botón 'Pedir viaje' y texto 'salir'
- Fix: eliminar const t duplicado que causaba SyntaxError
- agregarLugarFamiliar: detectar casa/trabajo y guardar en campo correcto

### 2026-07-01
- Normalizar acentos en obtenerLugarOtros para matching de alias por voz
- Fix: usar coords del alias personal sin pasar por resolverUbicacionVoz
- Familiar: timeout 5min + limpiar todos los alias casa/trabajo de otros[]
- Optimizar velocidad: paralelizar geocoding y reducir timeout OpenAI
- TTS: cambiar voz a nova (femenina) y speed 1.15 (más fluida)
- Fix: precio null en oferta de chofer para flujo de voz
- Simplificar mensaje de taxi disponible: origen → destino → precio
- feat: mejora mapa de rastreo con icono ChatGo y ruta roja
- feat: usar logo oficial ChatGo como ícono del taxi en mapa de rastreo

### 2026-07-05
- Mapa de rastreo: poll cada 5s + animación suave del marcador

### 2026-07-06
- Plataforma modular en las sombras: router de servicios + multi-número + módulo Favor
- Módulo ChatGo Ambulancias: emergencias médicas con despacho automático
- Plataforma modular: soporte de voz en todos los módulos
- Multi-número: todos los números atienden todo; choferes y admin solo por el padre
- Panel admin: perfil completo de chofer con fotos, rating e historial

### 2026-07-08
- Blindar notificación de comprobantes al admin y aceptar fotos como documento
- Modo familiar: nadie queda atrapado en el fallback
- Mapa del chofer: copiloto con voz, rutas alternativas y análisis de tráfico
- Modo familiar: 'mis cuentas' ya no cae al flujo de vincular
- Migrar cálculo de rutas a Routes API (fix REQUEST_DENIED)
- Migrar cálculo de distancias y precios a Routes API
- Voz: 'casa de Ana' ya no se confunde con la casa del usuario

### 2026-07-09
- Fix: 'Iniciar viaje' quedaba mudo — rutaPolilinea no cabía en VARCHAR(191)
- Esquinas: match difuso por distancia de edición (fix punto a 4 km)
- Flujo rápido por voz: el resumen muestra origen y destino, no solo el precio
- Geocoding: rechazar resultados a nivel ciudad/barrio

### 2026-07-10
- Canal WEB Premium Etapa 1: pedir taxi desde el navegador
- Web: código de verificación sin ventana de 24h (plantilla de autenticación)

### 2026-07-13
- Web: verificación en 1 TOQUE — sin escribir número ni copiar código
- Web: botón Cancelar viaje + fix del doble CANCELAR en WhatsApp
- Web: destino por VOZ — hablá y el pin va solo al lugar
- Web: la fila de búsqueda ya no corta los botones en celulares angostos
- Delivery inteligente: catálogo de restaurantes + presupuesto + despacho real
- Superchofer: tipoVehiculo 'todo' recibe cualquier solicitud

### 2026-07-14
- Web: el código por WhatsApp pasa a ser el camino principal de verificación
- Web: verificación del código sin escribir ni memorizar
- Delivery: entrada por lenguaje natural — 'tengo 30 bs y quiero pollo'
- Web y rastreo: ruta REAL por calles en todos los mapas + responsive
- Cargar .env desde la app: PM2 no lo lee y MODULOS_ACTIVOS nunca llegaba
- Router: intención de comida/ambulancia intercepta en pasos tempranos del taxi

### 2026-07-16
- Delivery: mensajes propios en todo el ciclo — el cliente pidió comida, no un taxi
- Delivery: el LOCAL recibe el pedido por WhatsApp en los dos momentos clave
- Web OTP: la plantilla de autenticación va PRIMERO en la cascada
- Webhook: loguear estados de entrega de Meta (failed + código de error)
- Rastreo: botones 🚕/📍, arrastre con un dedo y aviso de GPS pendiente
- Demo ChatGo Bus servida en /bus-demo
- Demo Bus: 25 líneas por toda Cochabamba con 20 micros cada una (500 en vivo)
- Demo Bus: una línea a la vez — 500 micros ya no arrastran el celular

### 2026-07-17
- ChatGo Bus por WhatsApp: qué línea me lleva + SOLO el micro que viene
- ChatGo Ambulancias: servicio comunitario GRATUITO completo
- Router: clasificador IA como última capa — la IA sabe qué servicio es
- Cross-sell taxi ↔ bus: la cotización ofrece el transporte público
- Ambulancias: EL PIN DESPACHA, los detalles después — máxima velocidad
- Ambulancias: audio original a la unidad + verificación de dirección contra el mapa
- Ambulancias: la orden llega también al superchofer y sin exigir pago

### 2026-07-18
- Bus aprende de los pines + respuestas por voz solo para adultos mayores registrados

### 2026-07-19
- Soporte para varios superchoferes de prueba forzados (secuencia de trabajos)
- Script para marcar numeros como superchoferes (tipoVehiculo=todo)

### 2026-07-20
- Alta de superchoferes de prueba desde el VM (chofer + GPS Traccar sin app)
- alta_superchofer: reutiliza el GPS real si ya tienen la app reportando
- Ambulancia: avisar a TODA la red como respaldo, no solo al mas cercano
- Mapa del chofer: icono del auto en vivo que se mueve con el GPS + boton Aqui estoy

### 2026-07-21
- Asignacion: la oferta llega a TODOS los choferes en orden de distancia
- Fix urgente: cascada duplicada (viajes de golpe) + spam al pasajero
- Oferta al chofer: distancia con antiguedad real del GPS (no fija en 0)
- Mapa de flota en vivo (/flota): choferes con ubicacion real y estado
- Bus cross-sell: subir radio de cobertura de 800m a 1200m
- ChatGo Bus con 141 lineas REALES de Cochabamba (buscador por destino)
- ChatGo Bus: simulacion de trufis moviendose hacia destinos REALES
- Trufis: dibujar las rutas por calles + micro moviendose por la ruta
- Geocodificar lineas con geocoder crudo (no el estricto del taxi)
- Trufis: numero de linea visible sobre cada micro + buscador
- Importador de rutas reales desde los HTML de lineas
- ChatGo Bus: 140 RUTAS REALES de Cochabamba (importadas de los HTML)
- Trufis: icono ChatGo en los micros + lista de lineas para ver una sola
- Mapa chofer: pantalla siempre encendida (Wake Lock) + GPS fresco para que el auto siga
- Mapa chofer: auto siempre centrado + logo ChatGo + link expira al terminar
- Mapa chofer: recorte de ruta (borra lo ya recorrido) + boton Centrar
- Navegacion turn-by-turn propia de ChatGo (maniobras + voz)
- Pedidos web: todo el seguimiento por la web, WhatsApp solo el gracias final
- Web: notificaciones al celular en cada cambio de estado del viaje
- Push real al celular: Web Push (VAPID + Service Worker) para pedidos web
- Mapa chofer: botón de navegación propio (no Google Maps) + push más robusto
- Pedidos web: botón "Compartir viaje" con link que se apaga al terminar
- Mapa chofer: modo navegación 3D estilo Waze/Google con paleta ChatGo
- Nav chofer: paleta verde ChatGo, ruta que sigue calles + recalcula, casing
- Nav chofer: un fallo de recálculo ya no borra la ruta buena + log de pasos

### 2026-07-22
- Panel de operaciones por ciudad (/panel): simulación determinista
- Panel: selector de ciudad + mapa en vivo con autos + feed de viajes
- Panel: descargas ATT (KMZ + CSV), ausencias por ciudad, sin "simulación"
- Panel/bitácora: rutas reales por calles + KMZ por chofer + CSV completo
- Índice de enlaces /links: tablero central con botones a todas las páginas
- docs: documento para inversores (Word)
- docs: escenario de operación y plan financiero (80 taxis, may-jul)
- docs: costos reales, comparativa de migración y punto de equilibrio
- docs: dossier unificado para inversores (3 documentos en uno)
- docs: comparativa costos vs ingresos (curva de rentabilidad)
- docs: corregir tipo de cambio a 9,50 Bs/USD en documentos financieros
- docs: dossier completo en un solo PDF (todo unido, tipo de cambio 9,50)
