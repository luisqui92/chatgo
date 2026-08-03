# Video en vivo del dashcam WY02 (JT1078) — guía de instalación y validación

> **Contexto importante (verificado en las fuentes oficiales):**
> El **ZLMediaKit open-source NO soporta JT1078**. En el `config.ini` oficial no
> existe ninguna sección `[jt1078]`, y el README lo lista bajo *"Closed-Source
> Professional Edition"* (edición comercial de pago). Por eso **no** usamos
> ZLMediaKit acá.
>
> En su lugar usamos un **gateway JT1078 open-source** que recibe el stream crudo
> del dashcam y lo sirve al navegador. Elegido para el piloto:
> **`glaciall/jtt1078-video-server`** (Java, servidor ejecutable llave-en-mano,
> con logs claros de conexión). Repo: https://github.com/glaciall/jtt1078-video-server
>
> El GPS (JT808) **no se toca**: sigue yendo a Traccar por su puerto (5015). Este
> gateway es un servicio aparte, en otro puerto.

---

## 1. Arquitectura

```
 Dashcam WY02
   │
   ├── GPS  (JT808)  ──────────────►  Traccar   (puerto 5015)   [YA FUNCIONA, no tocar]
   │
   └── Video (JT1078) ─────────────►  jtt1078-video-server  (puerto 10780)
                                        └── sirve HTTP-FLV al navegador (puerto 3333)
```

- **Puerto de video JT1078:** `10780` (TCP) — es a donde el dashcam abre el stream.
- **Puerto de visualización:** `3333` (HTTP, HTTP-FLV con flv.js en el navegador).
- Ambos son **distintos** de Traccar (5015): no hay interferencia con el GPS.

> ⚠️ **Confirmá el puerto 10780** en el `app.properties`/código del repo antes de
> abrir el firewall. En los ejemplos del repo el servidor de prueba usa
> `x.x.x.x:10780`, pero conviene verificarlo en la fuente por si tu versión lo
> cambió.

---

## 2. El punto CRÍTICO: el dashcam no transmite solo

En JT/T 1078 el terminal **solo abre el video cuando recibe el comando `0x9101`**
(*"audio/video real-time transmission request"*) por su canal JT808 — ese comando
le dice **a qué IP:puerto** conectarse para el video. El propio README del gateway
lo dice: *"the server does not initiate connections; vehicle terminals connect to
this server after receiving 0x9101"*.

Esto tiene una consecuencia práctica para tu stack:

- **Traccar maneja el GPS (JT808) pero normalmente NO envía `0x9101`.** Traccar no
  es una plataforma de video.
- Entonces, para que el WY02 empiece a mandar video, tiene que pasar **una** de estas:
  1. **El WY02 está configurado para auto-conectar** a un "servidor de medios"
     (IP:puerto) que se le carga en la config del equipo (por su app/herramienta del
     fabricante, SMS o comando). Muchos dashcams JT1078 tienen este campo.
  2. **Algo envía el `0x9101`** al equipo por el canal JT808. Traccar no lo hace de
     fábrica; haría falta una pieza extra que hable JT808 y mande ese comando.

👉 **Esto es lo primero que tenés que verificar con el WY02 en mano** (sección 7).
Determina si con el gateway alcanza, o si además necesitamos disparar el `0x9101`.

---

## 3. Requisitos en el servidor

- **JDK** (el proyecto es Java/Netty; usar **JDK 8**; si el build falla, probar 11).
- **Maven** (para compilar).
- **FFmpeg** — *opcional*: el README dice que solo se usa si querés además sacar una
  copia por RTMP (advierte de "degradación de rendimiento por transcodificar audio").
  Para ver en el navegador por HTTP-FLV **no es obligatorio**.
- `git`, y para diagnóstico: `tcpdump`.

---

## 4. Instalación — Opción A: Docker (recomendada para mantener)

Es lo más simple de mantener junto a tu stack. Usá el `Dockerfile` de esta carpeta.

```bash
# 1) Clonar el gateway
git clone https://github.com/glaciall/jtt1078-video-server.git
cd jtt1078-video-server

# 2) Copiar el Dockerfile y (opcional) tu app.properties de esta guía
cp /ruta/a/chatgo/docs/jt1078/Dockerfile .
#   (editá app.properties del repo si necesitás ffmpeg/rtmp; ver sección 6)

# 3) Construir
docker build -t jtt1078:pilot .

# 4) Correr (puertos: 10780 video, 3333 visor)
docker run -d --name jtt1078 --restart unless-stopped \
  -p 10780:10780 -p 3333:3333 \
  jtt1078:pilot

# 5) Ver logs en vivo (acá vas a confirmar la conexión del WY02)
docker logs -f jtt1078
```

## 4bis. Instalación — Opción B: systemd (sin Docker)

```bash
# 1) Compilar
git clone https://github.com/glaciall/jtt1078-video-server.git
cd jtt1078-video-server
mvn -DskipTests package
#   → genera target/jtt1078-video-server-1.0-SNAPSHOT.jar

# 2) Instalar
sudo useradd -r -s /usr/sbin/nologin jtt1078 || true
sudo mkdir -p /opt/jtt1078 /var/log/jtt1078
sudo cp target/jtt1078-video-server-1.0-SNAPSHOT.jar /opt/jtt1078/
sudo cp src/main/resources/app.properties /opt/jtt1078/   # si aplica
sudo chown -R jtt1078:jtt1078 /opt/jtt1078 /var/log/jtt1078

# 3) Servicio (unit de esta carpeta)
sudo cp /ruta/a/chatgo/docs/jt1078/jtt1078.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jtt1078

# 4) Logs
sudo journalctl -u jtt1078 -f
#   (o: tail -f /var/log/jtt1078/server.log)
```

---

## 5. Firewall (GCP) — abrir SOLO los puertos nuevos

No toques la regla del GPS (5015). Agregá una regla para el video:

```bash
gcloud compute firewall-rules create allow-jt1078 \
  --allow tcp:10780,tcp:3333 \
  --source-ranges 0.0.0.0/0 \
  --description "JT1078 video (WY02) + visor HTTP-FLV"
```

> Para el piloto podés dejar 3333 abierto; en producción es mejor **cerrarlo** y
> exponer el visor solo detrás de tu **nginx con SSL** (ver `nginx.conf.ejemplo`).

---

## 6. Configuración (app.properties)

El repo trae su propio `app.properties`. Los únicos ajustes que el README menciona
explícitamente son:

- **ruta de FFmpeg** (`ffmpeg path`) — solo si vas a sacar copia por RTMP.
- **RTMP url** — destino RTMP opcional.

> ⚠️ **No inventes claves de config.** Abrí el `app.properties` real del repo y
> ajustá lo que exista ahí (ruta ffmpeg, rtmp url, y el puerto si está parametrizado).
> Si el puerto 10780 está hardcodeado en el código, se cambia ahí. Dejá el resto
> por defecto para el piloto.

---

## 7. Validación con logs reales (con el WY02 en mano)

Hacé esto en orden. Cada paso te dice algo distinto:

### Paso 1 — ¿El dashcam siquiera intenta conectar al puerto de video?
```bash
sudo tcpdump -i any -n 'tcp port 10780' -X
```
- **Si NO ves ninguna conexión entrante** cuando esperás video → el equipo **no
  fue instruido** para transmitir. Revisá en la config del WY02 el campo de
  "servidor de video/medios" y ponelo en `IP_DEL_SERVIDOR:10780`. Si el WY02 solo
  transmite tras un `0x9101`, ahí confirmamos que hace falta la pieza que lo envía
  (sección 2, caso 2).
- **Si ves la conexión TCP entrante** → el equipo sí conecta; seguí al paso 2.

### Paso 2 — ¿Es JT1078 "puro" o una variante del fabricante?
En la salida `-X` de tcpdump, mirá los **primeros bytes** de la carga (payload) de
los paquetes de video. El estándar **JT/T 1078 define el identificador de trama
`0x30 0x31 0x63 0x64`** (aparece como `3031 6364` en el dump).
- Si ves `3031 6364` al inicio de las tramas → **es JT1078 estándar** ✅
- Si los primeros bytes son otros (o hay un encabezado propietario antes) → el WY02
  usa una **variante del fabricante**, y el gateway estándar puede no parsearla.

### Paso 3 — ¿El gateway entendió el stream?
En los logs del gateway buscá la línea:
```
start publishing: <SIM>-<CANAL>
```
(ej: `start publishing: 013800138999-1`)
- **Aparece** → el gateway parseó el JT1078 y está republicando el video ✅
- **NO aparece** (pero sí hubo conexión TCP en el paso 1) → el framing no se entendió
  → probablemente **variante propietaria** (coincide con el paso 2).

### Paso 4 — Ver el video en el navegador
Con el `SIM` (número del dispositivo, 12 dígitos con ceros a la izquierda) y el
`CANAL` (nº de cámara), abrí:
```
http://IP_DEL_SERVIDOR:3333/test/multimedia#<SIM>-<CANAL>
```
Ej: `http://IP_DEL_SERVIDOR:3333/test/multimedia#013800138999-1` y tocá "play".
- **Se ve el video** → decodificación OK, pipeline completo funcionando ✅
- Detrás de tu nginx+SSL sería `https://tu-dominio/jt1078/...` (ver `nginx.conf.ejemplo`).

---

## 8. Resumen de qué confirma cada señal

| Señal | Significa |
|---|---|
| tcpdump: sin conexión en 10780 | El WY02 no fue instruido (falta config del equipo o el `0x9101`) |
| tcpdump: conexión + payload arranca con `3031 6364` | JT1078 estándar ✅ |
| tcpdump: conexión pero payload con otro encabezado | Variante propietaria del fabricante |
| Log: `start publishing: SIM-CANAL` | El gateway parseó y republica el video ✅ |
| Visor 3333 muestra imagen | Pipeline completo OK ✅ |

## 9. Si resulta ser una variante propietaria
Si el paso 2/3 muestra que el WY02 no habla JT1078 puro, las opciones son:
1. Ver si el fabricante (Trackerking) tiene un modo "JT1078 estándar" en la config.
2. Probar otro gateway de la lista (`SmallChi/JT1078Gateway`, `vanjoge/RTVS`).
3. Escribir un pequeño adaptador que traduzca la variante → JT1078 estándar (más trabajo).

Con los logs del paso 2 sabremos exactamente contra qué estamos. **No asumas que
decodifica hasta ver `start publishing` y la imagen en el navegador.**
