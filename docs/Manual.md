# El Anexo: sistema de citas, agenda y finanzas

Página de reservas para clientes y panel de administración para la barbería El Anexo (San Juan Sacatepéquez). Reemplaza a AgendaPro y corre en planes gratuitos.

## Contenido

1. Qué incluye
2. Arquitectura
3. Costos
4. Despliegue paso a paso
5. Uso diario del panel
6. Desarrollo local y pruebas
7. Estructura del proyecto
8. Mantenimiento

## 1. Qué incluye

### Página de clientes (`/`)

- Lista de servicios con precio y duración.
- Reserva en tres pasos: servicio, día y hora (agrupada en Mañana, Tarde y Noche), datos de contacto.
- Reserva como invitado con nombre y número de WhatsApp.
- Opción de crear un PIN de 4 a 6 números al reservar o desde "Crear cuenta". Con sesión iniciada solo se elige servicio, día y hora.
- "Mis citas": próximas citas, historial y cancelación hasta X horas antes (configurable).
- Límite de 2 citas pendientes por cliente para evitar reservas falsas.
- Ubicación con mapa, WhatsApp, Instagram y Facebook.

### Panel de administrador (`/admin/`)

| Sección | Funciones |
|---|---|
| Agenda | Vista por día con horarios libres, ocupados (con nombre) y bloqueados; calendario mensual con cantidad de citas; citas nuevas y VIP con precio ajustable; registro de clientes atendidos sin cita; cobro con un clic en Efectivo o Tarjeta; recordatorio por WhatsApp con mensaje armado; marcar "No asistió"; cancelar y reactivar citas |
| Clientes | Búsqueda, historial, visitas, total gastado, inasistencias, notas del barbero, bloqueo con motivo, restablecer PIN |
| Finanzas | Ingresos del día, mes actual y mes pasado, separados por efectivo y tarjeta; gastos y ganancia neta; efectivo en caja; servicios brindados del día; desglose por servicio; reporte mensual por día; descarga a Excel (CSV); aviso de citas pasadas sin cobrar |
| Horario | Horario semanal con uno o varios turnos por día, días especiales (cerrar o abrir con otro horario) y bloqueo de horas |
| Ajustes | Servicios (crear, editar, desactivar), datos del negocio y reglas de la agenda |

### Recordatorio por WhatsApp

El botón "WhatsApp" de cada cita abre el chat del cliente con este mensaje ya escrito; solo hay que presionar enviar:

```
Hola Angel Martínez!
Te queremos recordar tu cita de Corte de cabello Q 50.00
[reloj]¿Cuándo?: Hoy 13-03-26 a las 12:00 pm
[pin] ¿Dónde?: 11 Calle 4-04, San Juan Sacatepéquez a un costado de Espartanos Barbería
[lentes] ¿Con quién?: Eduardo González
¡Te esperamos!
¡Agradecemos mucho tu puntualidad para no tener inconvenientes y cumplir los tiempos de la agenda! En el Anexo el tiempo del cliente es una prioridad.
```

Los emojis se insertan con secuencias de escape en `public/js/admin.js` (función `mensajeRecordatorio`). La dirección y el nombre del barbero salen de Ajustes. En la agenda de hoy aparece un aviso con los recordatorios pendientes y un botón para enviar el siguiente.

## 2. Arquitectura

```
Navegador (cliente / administrador)
        |
        v
Netlify: public/ (HTML, CSS, JS estáticos)
        |  /api/*
        v
Netlify Function: netlify/functions/api.mjs (una sola función, Node 20+)
        |  PostgreSQL (pooler de transacciones, puerto 6543)
        v
Supabase: base de datos PostgreSQL gratuita
```

- **Una sola función** atiende todas las rutas `/api/*`; menos arranques en frío y menos créditos.
- **Supabase** en lugar de Netlify Database: la base de Netlify cobra 10 créditos por hora de cómputo y se apaga a los 5 minutos sin uso, lo que agotaría los 300 créditos gratuitos. Supabase no consume créditos de Netlify.
- **Migraciones automáticas**: la primera vez que la función arranca crea las tablas y carga los servicios y el horario inicial (`netlify/lib/migraciones.mjs`).
- **Sin reservas dobles**: la tabla `citas` tiene una restricción de exclusión (`btree_gist`) que impide dos citas activas traslapadas aunque dos personas reserven al mismo tiempo.
- **Sesiones**: tokens firmados con HMAC (`JWT_SECRET`). PIN guardado con `scrypt` y sal. Límite de 5 intentos fallidos cada 15 minutos por número y para el administrador.
- **Hora de Guatemala**: UTC-6 fija (Guatemala no tiene horario de verano).

## 3. Costos

| Concepto | Plan | Costo |
|---|---|---|
| Netlify (página y función) | Free, 300 créditos/mes | Q0 |
| Supabase (base de datos 500 MB) | Free | Q0 |
| Recordatorios WhatsApp (botón `wa.me`) | No usa API | Q0 |

Consumo estimado de Netlify: unos 25 créditos al mes de tráfico y funciones, más 15 créditos por cada deploy a producción. Con 3 o 4 deploys al mes el total ronda 70 de 300 créditos, compartidos con las páginas de Quinta San Jorge y She'Jun.

Puntos a vigilar:

- **Deploys**: cada deploy a producción cuesta 15 créditos. Probar con `npm run demo` antes de subir cambios.
- **Pausa de Supabase**: un proyecto gratuito se pausa tras 7 días sin actividad. Con citas diarias no ocurre. Si se pausa, se reactiva desde el panel de Supabase y los datos se conservan.
- **Respaldos**: el plan gratuito de Supabase no incluye respaldos diarios descargables. Descargar cada mes el CSV de Finanzas.

## 4. Despliegue paso a paso

### 4.1 Base de datos en Supabase

1. Crear cuenta en https://supabase.com y un proyecto nuevo (región `us-east-1` o la más cercana). Guardar la contraseña de la base de datos.
2. En el proyecto, abrir **Connect** y copiar la cadena **Transaction pooler** (puerto `6543`). Se ve así:
   `postgresql://postgres.xxxxxxxx:[CONTRASENA]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
3. Reemplazar `[CONTRASENA]` por la contraseña del paso 1.

La conexión directa (puerto 5432) usa IPv6 y no funciona desde Netlify Functions; usar siempre el pooler.

No hace falta crear tablas: se crean solas en la primera solicitud.

### 4.2 Repositorio en GitHub

```bash
cd el-anexo
git remote add origin https://github.com/AngelMartinez11/el-anexo.git
git push -u origin main
```

### 4.3 Proyecto en Netlify

1. En Netlify: **Add new project > Import an existing project > GitHub** y elegir el repositorio.
2. Netlify lee `netlify.toml`: no hace falta comando de build; la carpeta publicada es `public`.
3. Antes del primer deploy, en **Project configuration > Environment variables** agregar:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | Cadena del pooler de Supabase |
| `JWT_SECRET` | Texto aleatorio de 32 caracteres o más |
| `ADMIN_PASSWORD` | Contraseña del panel (mínimo 8 caracteres) |

   Para generar `JWT_SECRET`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. Ejecutar el deploy. Al terminar, abrir `https://<proyecto>.netlify.app/admin/`, entrar con la contraseña y revisar Horario y Ajustes.

Cambiar una variable de entorno requiere un nuevo deploy (**Deploys > Trigger deploy**).

### 4.4 Logo

Guardar el logo de El Anexo como `public/img/logo.png` (cuadrado, mínimo 256 x 256 px). Si no existe, el sitio muestra las iniciales "EA".

### 4.5 Primeros ajustes

1. **Horario**: definir los turnos reales de cada día. El horario inicial es de lunes a sábado de 11:00 a 21:00.
2. **Ajustes**: confirmar dirección, WhatsApp, anticipación mínima (60 min), días por adelantado (30) y horas para cancelar (2).
3. Compartir el enlace de la página en Instagram y Facebook en lugar del de AgendaPro.

## 5. Uso diario del panel

- **Al abrir el día**: en Agenda aparece el aviso de recordatorios pendientes. "Enviar a ..." abre WhatsApp con el mensaje; se envía y se pasa al siguiente. Las citas recordadas quedan marcadas como "Recordado".
- **Al terminar cada corte**: presionar **Efectivo** o **Tarjeta** en la cita. Si el precio cambió, usar **Más** para editarlo antes o después.
- **Cliente sin cita**: en un horario libre presionar **Agendar** (o **Registrar** si la hora ya pasó) y elegir en "Cobro" el método con el que pagó.
- **Cliente VIP**: **Nueva cita**, ajustar el precio y marcar "Cliente VIP". Con "Fuera de horario" se puede agendar a cualquier hora, incluso con el negocio cerrado.
- **No llegó**: **Más > No asistió**. Las inasistencias se muestran en la agenda y en el perfil del cliente.
- **Bloquear un cliente**: Clientes > abrir cliente > "Bloquear cliente". No podrá reservar ni iniciar sesión en la página.
- **Cliente olvidó su PIN**: Clientes > abrir cliente > **Restablecer PIN**. El cliente crea uno nuevo desde "Crear cuenta".
- **Cierre de mes**: Finanzas > Reporte mensual > **Descargar Excel (CSV)**.

## 6. Desarrollo local y pruebas

Requisitos: Node.js 20 o superior.

```bash
npm install
npm test
npm run demo
```

- `npm test` ejecuta 16 pruebas de la API contra PostgreSQL en memoria (PGlite): reservas, traslapes, PIN, cancelación, cobros, finanzas, bloqueos, horario y ajustes.
- `npm run demo` levanta `http://localhost:8888` con datos de ejemplo, sin Supabase ni Netlify. Panel en `/admin/` con la contraseña `anexo-demo`. Los datos se pierden al detener el servidor.

Para probar contra la base real de Supabase:

```bash
npm install -g netlify-cli
netlify link
netlify dev
```

`netlify dev` toma las variables de entorno del proyecto en Netlify (o de un archivo `.env` basado en `.env.example`).

## 7. Estructura del proyecto

```
el-anexo/
  netlify.toml              Configuración de Netlify (carpeta publicada, función, cabeceras)
  package.json
  .env.example              Variables de entorno necesarias
  public/
    index.html              Página de clientes
    admin/index.html        Panel de administrador
    css/estilos.css         Estilos compartidos
    css/admin.css           Estilos del panel
    js/comun.js             Utilidades del navegador (API, fechas, formatos)
    js/cliente.js           Lógica de la página de clientes
    js/admin.js             Lógica del panel
    img/                    Logo (logo.png)
  netlify/
    functions/api.mjs       Función única: enrutador de /api/*
    lib/db.mjs              Conexión a PostgreSQL y migraciones automáticas
    lib/migraciones.mjs     Esquema y datos iniciales
    lib/auth.mjs            Tokens, PIN y límite de intentos
    lib/disponibilidad.mjs  Cálculo de horarios libres
    lib/citas.mjs           Creación y validación de citas
    lib/rutas-publicas.mjs  Rutas de clientes
    lib/rutas-admin.mjs     Rutas del panel
    lib/utilidades.mjs      Fechas en hora de Guatemala y validaciones
  scripts/servidor-demo.mjs Servidor local con datos de ejemplo
  tests/                    Pruebas de la API
  docs/Manual.md            Este documento
```

### Modelo de datos

| Tabla | Contenido |
|---|---|
| `servicios` | Nombre, descripción, duración, precio, activo, orden |
| `clientes` | Nombre, teléfono (8 dígitos, único), hash del PIN, bloqueo, notas |
| `citas` | Cliente, servicio, fecha, inicio y fin en minutos, precio, VIP, estado (`pendiente`, `completada`, `cancelada`, `no_asistio`), método de pago, recordatorio enviado |
| `horario_semanal` | Turnos por día de la semana |
| `dias_especiales` | Fechas cerradas o con horario distinto |
| `bloqueos` | Rangos de horas bloqueados en una fecha |
| `gastos` | Fecha, concepto, categoría, monto, método |
| `configuracion` | Datos del negocio y reglas de la agenda |
| `intentos_login` | Intentos fallidos de inicio de sesión |
| `esquema_version` | Migraciones aplicadas |

### API

Rutas públicas: `GET /api/publico/info`, `GET /api/publico/dias`, `GET /api/publico/horarios`, `POST /api/publico/reservar`, `POST /api/cliente/login`, `POST /api/cliente/registro`, `GET /api/cliente/citas`, `POST /api/cliente/cancelar`.

Rutas del panel (requieren token de administrador): `admin/login`, `admin/agenda`, `admin/mes`, `admin/libres`, `admin/citas`, `admin/clientes`, `admin/finanzas`, `admin/finanzas/mes`, `admin/finanzas/exportar`, `admin/gastos`, `admin/horario`, `admin/servicios`, `admin/config`. El detalle está en `netlify/lib/rutas-admin.mjs`.

## 8. Mantenimiento

- **Cambios en la base de datos**: agregar una migración nueva al final de `MIGRACIONES` en `netlify/lib/migraciones.mjs` con el siguiente número de versión. No modificar migraciones ya publicadas.
- **Cambiar la contraseña del panel**: editar `ADMIN_PASSWORD` en Netlify y volver a desplegar.
- **Cerrar todas las sesiones**: cambiar `JWT_SECRET` y volver a desplegar.
- **Ver los datos directamente**: Supabase > Table Editor.
