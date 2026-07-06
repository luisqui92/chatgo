-- CreateTable
CREATE TABLE `solicitudes` (
    `id` VARCHAR(191) NOT NULL,
    `tipo` VARCHAR(191) NOT NULL,
    `usuarioPhone` VARCHAR(191) NOT NULL,
    `estado` VARCHAR(191) NOT NULL DEFAULT 'nueva',
    `detalle` JSON NULL,
    `origenLat` DOUBLE NULL,
    `origenLng` DOUBLE NULL,
    `origenNombre` VARCHAR(191) NULL,
    `destinoLat` DOUBLE NULL,
    `destinoLng` DOUBLE NULL,
    `destinoNombre` VARCHAR(191) NULL,
    `precioBs` DOUBLE NULL,
    `asignadoPhone` VARCHAR(191) NULL,
    `viajeId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `solicitudes_tipo_estado_idx`(`tipo`, `estado`),
    INDEX `solicitudes_usuarioPhone_idx`(`usuarioPhone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
