-- Web Push: suscripción del navegador del pasajero (pedidos web)
ALTER TABLE `usuarios` ADD COLUMN `pushWeb` JSON NULL;
