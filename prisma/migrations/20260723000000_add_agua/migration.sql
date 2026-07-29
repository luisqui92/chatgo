-- ChatGo Agua: guardar el último pedido para "pedí lo de siempre"
ALTER TABLE `usuarios` ADD COLUMN `ultimoPedidoAgua` JSON NULL;
