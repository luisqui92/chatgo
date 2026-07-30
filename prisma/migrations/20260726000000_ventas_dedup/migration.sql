-- Dedup + continuación de chats en evaluaciones de ventas
ALTER TABLE `evaluaciones_venta`
  ADD COLUMN `convId`   VARCHAR(191) NULL,
  ADD COLUMN `convHash` VARCHAR(191) NULL;

CREATE INDEX `evaluaciones_venta_convId_idx` ON `evaluaciones_venta`(`convId`);
