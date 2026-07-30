-- Sistema de Evaluación de Ventas (separado de ChatGo)
CREATE TABLE `vendedores` (
  `id` VARCHAR(191) NOT NULL,
  `nombre` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `whatsapp` VARCHAR(191) NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `vendedores_email_key`(`email`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `evaluaciones_venta` (
  `id` VARCHAR(191) NOT NULL,
  `vendedorId` VARCHAR(191) NOT NULL,
  `fechaConversacion` DATETIME(3) NULL,
  `tiempoRespuesta` INTEGER NOT NULL DEFAULT 0,
  `descubrimiento` INTEGER NOT NULL DEFAULT 0,
  `objeciones` INTEGER NOT NULL DEFAULT 0,
  `seguimiento` INTEGER NOT NULL DEFAULT 0,
  `cierre` INTEGER NOT NULL DEFAULT 0,
  `cumplimiento` INTEGER NOT NULL DEFAULT 0,
  `promedio` DOUBLE NOT NULL DEFAULT 0,
  `fortalezas` JSON NULL,
  `debilidades` JSON NULL,
  `mejoraConcreta` TEXT NULL,
  `conversacion` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `evaluaciones_venta_vendedorId_idx`(`vendedorId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `evaluaciones_venta` ADD CONSTRAINT `evaluaciones_venta_vendedorId_fkey` FOREIGN KEY (`vendedorId`) REFERENCES `vendedores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
