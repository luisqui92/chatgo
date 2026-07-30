-- Enlace de líneas de WhatsApp por Baileys para Evaluación de Ventas
CREATE TABLE `lineas_ventas` (
  `id`         VARCHAR(191) NOT NULL,
  `vendedorId` VARCHAR(191) NOT NULL,
  `numero`     VARCHAR(191) NULL,
  `estado`     VARCHAR(191) NOT NULL DEFAULT 'desconectado',
  `activa`     BOOLEAN NOT NULL DEFAULT true,
  `createdAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `lineas_ventas_vendedorId_idx` (`vendedorId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chats_ventas` (
  `id`            VARCHAR(191) NOT NULL,
  `lineaId`       VARCHAR(191) NOT NULL,
  `clienteJid`    VARCHAR(191) NOT NULL,
  `clienteNombre` VARCHAR(191) NULL,
  `texto`         TEXT NULL,
  `ultimoMsgAt`   DATETIME(3) NULL,
  `pendiente`     BOOLEAN NOT NULL DEFAULT false,
  `createdAt`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`     DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `chats_ventas_lineaId_clienteJid_key` (`lineaId`, `clienteJid`),
  INDEX `chats_ventas_lineaId_idx` (`lineaId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
