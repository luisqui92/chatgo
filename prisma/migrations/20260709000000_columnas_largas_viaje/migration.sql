-- La polilínea de Routes API mide miles de caracteres; VARCHAR(191) explotaba
-- en "Iniciar viaje" (P2000: value too long for column rutaPolilinea).
-- observaciones acepta 200-320 chars (notas + módulo favor) y comentarioPasajero
-- es texto libre: mismo riesgo.
ALTER TABLE `viajes` MODIFY `rutaPolilinea` TEXT NULL;
ALTER TABLE `viajes` MODIFY `observaciones` TEXT NULL;
ALTER TABLE `viajes` MODIFY `comentarioPasajero` TEXT NULL;
