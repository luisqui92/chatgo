-- CreateTable
CREATE TABLE `usuarios` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(191) NULL,
    `aceptoTerminos` BOOLEAN NOT NULL DEFAULT false,
    `fechaRegistro` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `audioOnboardingHecho` BOOLEAN NOT NULL DEFAULT false,
    `modoAdultoMayor` BOOLEAN NOT NULL DEFAULT false,
    `respuestasPorVoz` BOOLEAN NOT NULL DEFAULT false,
    `saldo` DOUBLE NOT NULL DEFAULT 0,
    `familiaresVinculados` JSON NULL,
    `recargas` JSON NULL,
    `ciudad` VARCHAR(191) NULL,
    `ciudadDetectada` BOOLEAN NOT NULL DEFAULT false,
    `viajesTotal` INTEGER NOT NULL DEFAULT 0,
    `rutasFrecuentes` JSON NULL,
    `lugaresFrecuentes` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `usuarios_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `choferes` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `wialonId` VARCHAR(191) NULL,
    `traccarId` VARCHAR(191) NULL,
    `fotoChofer` VARCHAR(191) NULL,
    `fotoVehiculo` VARCHAR(191) NULL,
    `placa` VARCHAR(191) NULL,
    `nombre` VARCHAR(191) NULL,
    `tipoVehiculo` VARCHAR(191) NOT NULL DEFAULT 'auto',
    `colorVehiculo` VARCHAR(191) NOT NULL DEFAULT '',
    `estado` VARCHAR(191) NOT NULL DEFAULT 'offline',
    `pagoDiarioFecha` DATETIME(3) NULL,
    `pagoDiarioFechaStr` VARCHAR(191) NULL,
    `pagoDiarioPagado` BOOLEAN NOT NULL DEFAULT false,
    `pagoDiarioAprobado` BOOLEAN NOT NULL DEFAULT false,
    `pagoDiarioComprobanteValidado` BOOLEAN NOT NULL DEFAULT false,
    `viajesTotal` INTEGER NOT NULL DEFAULT 0,
    `aceptoTerminos` BOOLEAN NOT NULL DEFAULT false,
    `fechaRegistro` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `viajeReservado` VARCHAR(191) NULL,
    `reservadoHasta` DATETIME(3) NULL,
    `ratingPromedio` DOUBLE NOT NULL DEFAULT 0,
    `ratingCantidad` INTEGER NOT NULL DEFAULT 0,
    `flota` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `choferes_phone_key`(`phone`),
    UNIQUE INDEX `choferes_wialonId_key`(`wialonId`),
    UNIQUE INDEX `choferes_traccarId_key`(`traccarId`),
    INDEX `choferes_estado_idx`(`estado`),
    INDEX `choferes_flota_idx`(`flota`),
    INDEX `choferes_pagoDiarioFechaStr_pagoDiarioAprobado_pagoDiarioPag_idx`(`pagoDiarioFechaStr`, `pagoDiarioAprobado`, `pagoDiarioPagado`, `pagoDiarioComprobanteValidado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `viajes` (
    `id` VARCHAR(191) NOT NULL,
    `usuarioPhone` VARCHAR(191) NULL,
    `choferPhone` VARCHAR(191) NULL,
    `choferWialonId` VARCHAR(191) NULL,
    `choferTraccarId` VARCHAR(191) NULL,
    `choferNombre` VARCHAR(191) NULL,
    `choferPlaca` VARCHAR(191) NULL,
    `ciudad` VARCHAR(191) NULL,
    `origenLat` DOUBLE NULL,
    `origenLng` DOUBLE NULL,
    `origenNombre` VARCHAR(191) NULL,
    `destinoLat` DOUBLE NULL,
    `destinoLng` DOUBLE NULL,
    `destinoNombre` VARCHAR(191) NULL,
    `paradas` JSON NULL,
    `observaciones` VARCHAR(191) NULL,
    `distanciaKm` DOUBLE NULL,
    `precioBase` DOUBLE NULL,
    `descuentoBs` DOUBLE NOT NULL DEFAULT 0,
    `codigoPromoUsado` VARCHAR(191) NULL,
    `precioTotal` DOUBLE NULL,
    `precioPorKm` DOUBLE NULL,
    `tipoVehiculo` VARCHAR(191) NOT NULL DEFAULT 'auto',
    `estado` VARCHAR(191) NOT NULL DEFAULT 'pendiente',
    `fechaInicio` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `fechaAsignacion` DATETIME(3) NULL,
    `fechaAceptacion` DATETIME(3) NULL,
    `fechaInicioViaje` DATETIME(3) NULL,
    `tiempoEstimadoMin` DOUBLE NULL,
    `fechaFin` DATETIME(3) NULL,
    `llegadaNotificada` BOOLEAN NOT NULL DEFAULT false,
    `llegadaOrigenNotificada` BOOLEAN NOT NULL DEFAULT false,
    `cancelacionMotivo` VARCHAR(191) NULL,
    `ratingPasajero` DOUBLE NULL,
    `comentarioPasajero` VARCHAR(191) NULL,
    `ratingSolicitado` BOOLEAN NOT NULL DEFAULT false,
    `codigoPromoGenerado` VARCHAR(191) NULL,
    `rutaPolilinea` VARCHAR(191) NULL,
    `rutaPuntos` JSON NULL,
    `nivelAlerta` VARCHAR(191) NOT NULL DEFAULT 'verde',
    `eventosSeguridad` JSON NULL,
    `detenidoDesde` DATETIME(3) NULL,
    `ultimaPosicionLat` DOUBLE NULL,
    `ultimaPosicionLng` DOUBLE NULL,
    `ultimaPosicionAt` DATETIME(3) NULL,
    `panicoActivado` BOOLEAN NOT NULL DEFAULT false,
    `panicoAt` DATETIME(3) NULL,
    `extendidoPorTrafico` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `viajes_estado_fechaAsignacion_idx`(`estado`, `fechaAsignacion`),
    INDEX `viajes_usuarioPhone_estado_idx`(`usuarioPhone`, `estado`),
    INDEX `viajes_choferPhone_estado_idx`(`choferPhone`, `estado`),
    INDEX `viajes_ciudad_idx`(`ciudad`),
    INDEX `viajes_nivelAlerta_idx`(`nivelAlerta`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `codigospromo` (
    `id` VARCHAR(191) NOT NULL,
    `codigo` VARCHAR(191) NOT NULL,
    `descuentoPorcentaje` INTEGER NOT NULL DEFAULT 40,
    `generadoPor` VARCHAR(191) NULL,
    `tipoOrigen` VARCHAR(191) NOT NULL DEFAULT 'post_viaje',
    `fechaCreacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `fechaVencimiento` DATETIME(3) NULL,
    `usado` BOOLEAN NOT NULL DEFAULT false,
    `usadoPor` VARCHAR(191) NULL,
    `fechaUso` DATETIME(3) NULL,
    `viajeIdAsociado` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `codigospromo_codigo_key`(`codigo`),
    INDEX `codigospromo_generadoPor_idx`(`generadoPor`),
    INDEX `codigospromo_fechaVencimiento_idx`(`fechaVencimiento`),
    INDEX `codigospromo_usado_idx`(`usado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessionstates` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `data` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sessionstates_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `listaesperas` (
    `id` VARCHAR(191) NOT NULL,
    `userPhone` VARCHAR(191) NOT NULL,
    `ciudad` VARCHAR(191) NULL,
    `origenLat` DOUBLE NULL,
    `origenLng` DOUBLE NULL,
    `origenNombre` VARCHAR(191) NULL,
    `destinoLat` DOUBLE NULL,
    `destinoLng` DOUBLE NULL,
    `destinoNombre` VARCHAR(191) NULL,
    `distancia` DOUBLE NULL,
    `precio` DOUBLE NULL,
    `precioPorKm` DOUBLE NULL,
    `tipoVehiculoSolicitado` VARCHAR(191) NULL,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `notificado` BOOLEAN NOT NULL DEFAULT false,
    `ofertaActivaWialonId` VARCHAR(191) NULL,
    `ofertaActivaHasta` DATETIME(3) NULL,
    `ofertasRechazadas` JSON NULL,
    `ultimoMensajeAt` DATETIME(3) NULL,
    `cancelando` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `listaesperas_userPhone_key`(`userPhone`),
    INDEX `listaesperas_ciudad_idx`(`ciudad`),
    INDEX `listaesperas_timestamp_idx`(`timestamp`),
    INDEX `listaesperas_ofertaActivaWialonId_timestamp_idx`(`ofertaActivaWialonId`, `timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ratelimits` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `horaStr` VARCHAR(191) NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ratelimits_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `locationreferences` (
    `id` VARCHAR(191) NOT NULL,
    `referencia` VARCHAR(191) NOT NULL,
    `referenciaOriginal` VARCHAR(191) NULL,
    `lat` DOUBLE NULL,
    `lng` DOUBLE NULL,
    `nombreResuelto` VARCHAR(191) NULL,
    `contador` INTEGER NOT NULL DEFAULT 1,
    `ciudad` VARCHAR(191) NOT NULL DEFAULT 'Cochabamba',
    `precargado` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `locationreferences_referencia_ciudad_key`(`referencia`, `ciudad`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `demandas` (
    `id` VARCHAR(191) NOT NULL,
    `zona` VARCHAR(191) NOT NULL,
    `hora` INTEGER NOT NULL,
    `diaSemana` INTEGER NOT NULL,
    `cantidad` INTEGER NOT NULL DEFAULT 1,
    `ultimaActualizacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `demandas_zona_hora_diaSemana_idx`(`zona`, `hora`, `diaSemana`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `eventochofers` (
    `id` VARCHAR(191) NOT NULL,
    `choferPhone` VARCHAR(191) NOT NULL,
    `tipo` VARCHAR(191) NULL,
    `viajeId` VARCHAR(191) NULL,
    `zona` VARCHAR(191) NULL,
    `tiempoRespuesta` DOUBLE NULL,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `eventochofers_choferPhone_idx`(`choferPhone`),
    INDEX `eventochofers_timestamp_idx`(`timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `alertasegs` (
    `id` VARCHAR(191) NOT NULL,
    `viajeId` VARCHAR(191) NULL,
    `tipo` VARCHAR(191) NULL,
    `descripcion` VARCHAR(191) NULL,
    `posicionLat` DOUBLE NULL,
    `posicionLng` DOUBLE NULL,
    `notificadoPasajero` BOOLEAN NOT NULL DEFAULT false,
    `notificadoAdmin` BOOLEAN NOT NULL DEFAULT false,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `alertasegs_viajeId_idx`(`viajeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `surges` (
    `id` VARCHAR(191) NOT NULL,
    `zona` VARCHAR(191) NOT NULL DEFAULT 'general',
    `multiplier` DOUBLE NOT NULL DEFAULT 1.0,
    `motivo` VARCHAR(191) NULL,
    `viajesAfectados` INTEGER NOT NULL DEFAULT 0,
    `vigenteHasta` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `surges_zona_vigenteHasta_idx`(`zona`, `vigenteHasta`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `viajedemos` (
    `id` VARCHAR(191) NOT NULL,
    `diaId` INTEGER NOT NULL,
    `choferIdx` INTEGER NULL,
    `choferNombre` VARCHAR(191) NULL,
    `choferPlaca` VARCHAR(191) NULL,
    `choferTipo` VARCHAR(191) NULL,
    `usuarioNombre` VARCHAR(191) NULL,
    `usuarioPhone` VARCHAR(191) NULL,
    `origenNombre` VARCHAR(191) NULL,
    `origenLat` DOUBLE NULL,
    `origenLng` DOUBLE NULL,
    `destinoNombre` VARCHAR(191) NULL,
    `destinoLat` DOUBLE NULL,
    `destinoLng` DOUBLE NULL,
    `distanciaKm` DOUBLE NULL,
    `precioTotal` DOUBLE NULL,
    `estado` VARCHAR(191) NULL,
    `rating` DOUBLE NULL,
    `tInicio` DOUBLE NULL,
    `tAceptado` DOUBLE NULL,
    `tLlegoOrigen` DOUBLE NULL,
    `tSubioPasajero` DOUBLE NULL,
    `tCompletado` DOUBLE NULL,
    `choferPosLat` DOUBLE NULL,
    `choferPosLng` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `viajedemos_diaId_estado_idx`(`diaId`, `estado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `esquinamapeadas` (
    `id` VARCHAR(191) NOT NULL,
    `llave` VARCHAR(191) NOT NULL,
    `calle1` VARCHAR(191) NULL,
    `calle2` VARCHAR(191) NULL,
    `zona` VARCHAR(191) NULL,
    `ciudad` VARCHAR(191) NOT NULL DEFAULT 'Cochabamba',
    `lat` DOUBLE NULL,
    `lng` DOUBLE NULL,
    `usos` INTEGER NOT NULL DEFAULT 1,
    `primerUsuario` VARCHAR(191) NULL,
    `ultimoUso` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `esquinamapeadas_llave_key`(`llave`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preregistroflotas` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `flota` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `preregistroflotas_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flotas` (
    `id` VARCHAR(191) NOT NULL,
    `codigo` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `activa` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `flotas_codigo_key`(`codigo`),
    UNIQUE INDEX `flotas_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notificacionespago` (
    `id` VARCHAR(191) NOT NULL,
    `texto` TEXT NULL,
    `monto` DOUBLE NULL,
    `usado` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `notificacionespago_usado_createdAt_idx`(`usado`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
