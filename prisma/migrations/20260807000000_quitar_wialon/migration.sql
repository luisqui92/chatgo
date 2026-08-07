-- Limpieza: eliminar rastros de Wialon (GPS viejo, reemplazado por Traccar).
-- Campos muertos:
ALTER TABLE `choferes` DROP COLUMN `wialonId`;
ALTER TABLE `viajes`   DROP COLUMN `choferWialonId`;

-- Campo vivo mal nombrado (guarda el traccarId de la oferta activa): renombrar.
DROP INDEX `listaesperas_ofertaActivaWialonId_timestamp_idx` ON `listaesperas`;
ALTER TABLE `listaesperas` CHANGE `ofertaActivaWialonId` `ofertaActivaChoferId` VARCHAR(191) NULL;
CREATE INDEX `listaesperas_ofertaActivaChoferId_timestamp_idx` ON `listaesperas`(`ofertaActivaChoferId`, `timestamp`);
