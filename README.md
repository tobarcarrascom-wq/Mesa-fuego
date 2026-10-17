# NEXORA BARBER

Código fuente del producto para crear páginas personalizadas para barberías, con recorridos para el cliente, el dueño y el barbero.

## Incluye

- Sitio comercial, configurador de pedidos y vista previa privada.
- Página pública de la barbería con catálogo, profesionales, información y formulario de reserva.
- Disponibilidad, solicitudes pendientes, confirmación/rechazo por el dueño y consulta/cancelación por el cliente.
- Panel administrativo y panel privado del barbero.
- Persistencia local de desarrollo y pruebas automatizadas.

## Ejecutar en Windows

Requiere Node.js 20 o posterior. No usa dependencias externas.

```powershell
$env:NEXORA_ADMIN_PASSWORD = 'usa-una-frase-privada-larga'
node server.mjs
```

Abre http://127.0.0.1:8765. El panel administrador está en `/admin` y el panel del barbero en `/barbero`.

## Pruebas

```powershell
node --test
```

## Datos y seguridad

Este código no incluye `data/store.json`, pedidos reales, contraseñas ni archivos `.env`. La base JSON local y las sesiones en memoria son solo para evaluación y pruebas. Antes de atender negocios reales se necesita base de datos administrada con respaldos, alojamiento HTTPS, almacenamiento de imágenes, recuperación de cuenta y revisión de seguridad. Los pagos se verifican manualmente; la app no procesa cobros.

La imagen `public/barber-working.jpg` es una ilustración fotográfica de muestra para la portada. Las fotos de la galería deben ser cargadas por cada negocio y no se presentan imágenes genéricas como trabajos de clientes.

Esta rama es una copia privada de revisión. No se ha desplegado ni fusionado en `main`.
