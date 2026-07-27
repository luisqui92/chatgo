-- ChatGo Auxilio Mecánico (Etapa 1): mecánicos afiliados y auxilios solicitados

CREATE TABLE `mecanicos` (
  `id` VARCHAR(191) NOT NULL,
  `nombre` VARCHAR(191) NOT NULL,
  `telefono` VARCHAR(191) NOT NULL,
  `zona` VARCHAR(191) NULL,
  `ubicacionBase` JSON NULL,
  `tiposServicio` JSON NULL,
  `atiende24h` BOOLEAN NOT NULL DEFAULT false,
  `documentos` JSON NULL,
  `suscripcion` JSON NULL,
  `calificacionPromedio` DOUBLE NULL,
  `totalAuxilios` INTEGER NOT NULL DEFAULT 0,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `mecanicos_telefono_key`(`telefono`),
  INDEX `mecanicos_zona_idx`(`zona`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `auxilios` (
  `id` VARCHAR(191) NOT NULL,
  `telefonoVarado` VARCHAR(191) NOT NULL,
  `ubicacion` JSON NULL,
  `tipoProblema` VARCHAR(191) NULL,
  `estado` VARCHAR(191) NOT NULL DEFAULT 'pendiente',
  `mecanicoId` VARCHAR(191) NULL,
  `calificacion` INTEGER NULL,
  `comentarioCalificacion` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `auxilios_estado_idx`(`estado`),
  INDEX `auxilios_mecanicoId_idx`(`mecanicoId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `auxilios` ADD CONSTRAINT `auxilios_mecanicoId_fkey` FOREIGN KEY (`mecanicoId`) REFERENCES `mecanicos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
