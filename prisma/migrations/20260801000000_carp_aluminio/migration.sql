-- Panel de Corte de Aluminio (despiece + optimización), separado. Reusa el servidor.
CREATE TABLE `carp_perfiles` (
  `id`           VARCHAR(191) NOT NULL,
  `codigo`       VARCHAR(191) NULL,
  `nombre`       VARCHAR(191) NOT NULL,
  `linea`        VARCHAR(191) NULL,
  `color`        VARCHAR(191) NULL DEFAULT 'natural',
  `largoBarraMm` INT NOT NULL DEFAULT 6000,
  `precioBarra`  DOUBLE NOT NULL DEFAULT 0,
  `activo`       BOOLEAN NOT NULL DEFAULT true,
  `createdAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`    DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `carp_vidrios` (
  `id`        VARCHAR(191) NOT NULL,
  `nombre`    VARCHAR(191) NOT NULL,
  `precioM2`  DOUBLE NOT NULL DEFAULT 0,
  `activo`    BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `carp_accesorios` (
  `id`        VARCHAR(191) NOT NULL,
  `nombre`    VARCHAR(191) NOT NULL,
  `unidad`    VARCHAR(191) NOT NULL DEFAULT 'u',
  `precio`    DOUBLE NOT NULL DEFAULT 0,
  `activo`    BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `carp_productos` (
  `id`          VARCHAR(191) NOT NULL,
  `nombre`      VARCHAR(191) NOT NULL,
  `descripcion` VARCHAR(191) NULL,
  `piezas`      JSON NOT NULL,
  `vidrios`     JSON NOT NULL,
  `accesorios`  JSON NOT NULL,
  `activo`      BOOLEAN NOT NULL DEFAULT true,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `carp_cotizaciones` (
  `id`        VARCHAR(191) NOT NULL,
  `cliente`   VARCHAR(191) NULL,
  `telefono`  VARCHAR(191) NULL,
  `items`     JSON NOT NULL,
  `resultado` JSON NULL,
  `descuento` DOUBLE NOT NULL DEFAULT 0,
  `manoObra`  DOUBLE NOT NULL DEFAULT 0,
  `total`     DOUBLE NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `carp_cotizaciones_createdAt_idx` (`createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
