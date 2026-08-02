-- Esquinas mapeadas ahora se identifican por (llave, ciudad) para no cruzar
-- calles con el mismo nombre entre Cochabamba, La Paz y Santa Cruz.
DROP INDEX `esquinamapeadas_llave_key` ON `esquinamapeadas`;
CREATE UNIQUE INDEX `esquinamapeadas_llave_ciudad_key` ON `esquinamapeadas`(`llave`, `ciudad`);
CREATE INDEX `esquinamapeadas_ciudad_idx` ON `esquinamapeadas`(`ciudad`);
