-- ChatGo Agua: "lo de siempre" + pedidos de agua para despacho y rutas
ALTER TABLE `usuarios` ADD COLUMN `ultimoPedidoAgua` JSON NULL;

CREATE TABLE `pedidos_agua` (
  `id` VARCHAR(191) NOT NULL,
  `telefono` VARCHAR(191) NOT NULL,
  `producto` VARCHAR(191) NOT NULL,
  `productoNombre` VARCHAR(191) NOT NULL,
  `cantidad` INTEGER NOT NULL DEFAULT 1,
  `total` DOUBLE NOT NULL DEFAULT 0,
  `lat` DOUBLE NULL,
  `lng` DOUBLE NULL,
  `direccion` VARCHAR(191) NULL,
  `metodoPago` VARCHAR(191) NULL,
  `estado` VARCHAR(191) NOT NULL DEFAULT 'nuevo',
  `repartidor` VARCHAR(191) NULL,
  `programadoPara` DATETIME(3) NULL,
  `calendarEventId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `pedidos_agua_estado_idx`(`estado`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
