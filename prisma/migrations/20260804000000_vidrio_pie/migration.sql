-- Precio de vidrio por pie² (venta de vidriería), además del precioM2 (aluminio)
ALTER TABLE `carp_vidrios` ADD COLUMN `precioPie` DOUBLE NOT NULL DEFAULT 0;
