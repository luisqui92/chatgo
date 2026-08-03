# Dockerfile para glaciall/jtt1078-video-server (gateway JT1078 → HTTP-FLV)
# Colocá este archivo en la raíz del repo clonado y: docker build -t jtt1078:pilot .
#
# NOTA: la versión de Java no está fijada por el proyecto. Empezamos con JDK 8
# (el proyecto es antiguo, Netty). Si el build falla, cambiá a temurin-11.

# ─── Etapa de build ───────────────────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-8 AS build
WORKDIR /src
COPY . .
RUN mvn -q -DskipTests package

# ─── Etapa de ejecución ───────────────────────────────────────────────────
FROM eclipse-temurin:8-jre
# FFmpeg es OPCIONAL (solo si vas a sacar copia por RTMP). Se incluye por comodidad.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/jtt1078-video-server-1.0-SNAPSHOT.jar /app/app.jar
# Si el repo trae app.properties y querés fijar ffmpeg/rtmp, descomentá y ajustá:
# COPY app.properties /app/app.properties

# 10780 = puerto JT1078 (video del dashcam) · 3333 = visor HTTP-FLV
EXPOSE 10780 3333
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
