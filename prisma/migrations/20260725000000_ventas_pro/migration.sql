-- Ventas PRO: datos+foto del vendedor y análisis extendido de la evaluación
ALTER TABLE `vendedores`
  ADD COLUMN `telefono` VARCHAR(191) NULL,
  ADD COLUMN `cargo` VARCHAR(191) NULL,
  ADD COLUMN `zona` VARCHAR(191) NULL,
  ADD COLUMN `foto` TEXT NULL,
  ADD COLUMN `fechaIngreso` DATETIME(3) NULL;

ALTER TABLE `evaluaciones_venta` ADD COLUMN `analisis` JSON NULL;
