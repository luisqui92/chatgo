-- AlterTable
ALTER TABLE `choferes` ADD COLUMN `ultimaAlertaZona` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `usuarios` ADD COLUMN `promoReactivacionEnviada` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `ultimoViajeAt` DATETIME(3) NULL;
