// Migraciones del esquema de la base de datos.
// Se aplican automaticamente en orden la primera vez que una funcion
// arranca y detecta que la version guardada es menor a la ultima.
// Nunca modificar una migracion ya publicada: agregar una nueva al final.

export const MIGRACIONES = [
  {
    version: 1,
    nombre: 'esquema_inicial',
    sql: `
      CREATE EXTENSION IF NOT EXISTS btree_gist;

      CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS servicios (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        descripcion TEXT NOT NULL DEFAULT '',
        duracion_min INTEGER NOT NULL CHECK (duracion_min > 0 AND duracion_min <= 480),
        precio NUMERIC(10,2) NOT NULL CHECK (precio >= 0),
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        orden INTEGER NOT NULL DEFAULT 0,
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        telefono CHAR(8) NOT NULL UNIQUE,
        pin_hash TEXT,
        bloqueado BOOLEAN NOT NULL DEFAULT FALSE,
        motivo_bloqueo TEXT NOT NULL DEFAULT '',
        notas TEXT NOT NULL DEFAULT '',
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Horario semanal: un dia puede tener varios rangos (por ejemplo 10:00-13:00 y 15:00-21:00).
      -- dia: 0 = domingo ... 6 = sabado. inicio/fin en minutos desde las 00:00.
      CREATE TABLE IF NOT EXISTS horario_semanal (
        id SERIAL PRIMARY KEY,
        dia SMALLINT NOT NULL CHECK (dia BETWEEN 0 AND 6),
        inicio_min INTEGER NOT NULL CHECK (inicio_min BETWEEN 0 AND 1440),
        fin_min INTEGER NOT NULL CHECK (fin_min BETWEEN 0 AND 1440),
        CHECK (fin_min > inicio_min)
      );

      -- Excepciones por fecha: cerrar un dia o abrir con otro horario.
      -- rangos: arreglo JSON [{"inicio":600,"fin":780}, ...]. Vacio y cerrado = sin atencion.
      CREATE TABLE IF NOT EXISTS dias_especiales (
        fecha DATE PRIMARY KEY,
        cerrado BOOLEAN NOT NULL DEFAULT FALSE,
        rangos JSONB NOT NULL DEFAULT '[]'::jsonb,
        nota TEXT NOT NULL DEFAULT ''
      );

      -- Bloqueos puntuales de horas (almuerzo, diligencias, etc.).
      CREATE TABLE IF NOT EXISTS bloqueos (
        id SERIAL PRIMARY KEY,
        fecha DATE NOT NULL,
        inicio_min INTEGER NOT NULL,
        fin_min INTEGER NOT NULL,
        motivo TEXT NOT NULL DEFAULT '',
        CHECK (fin_min > inicio_min)
      );
      CREATE INDEX IF NOT EXISTS idx_bloqueos_fecha ON bloqueos (fecha);

      CREATE TABLE IF NOT EXISTS citas (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        servicio_id INTEGER REFERENCES servicios(id),
        servicio_nombre TEXT NOT NULL,
        fecha DATE NOT NULL,
        inicio_min INTEGER NOT NULL CHECK (inicio_min BETWEEN 0 AND 1440),
        fin_min INTEGER NOT NULL CHECK (fin_min BETWEEN 0 AND 1440),
        precio NUMERIC(10,2) NOT NULL CHECK (precio >= 0),
        es_vip BOOLEAN NOT NULL DEFAULT FALSE,
        estado TEXT NOT NULL DEFAULT 'pendiente'
          CHECK (estado IN ('pendiente', 'completada', 'cancelada', 'no_asistio')),
        metodo_pago TEXT CHECK (metodo_pago IN ('efectivo', 'tarjeta')),
        origen TEXT NOT NULL DEFAULT 'web' CHECK (origen IN ('web', 'admin')),
        recordatorio_enviado BOOLEAN NOT NULL DEFAULT FALSE,
        notas TEXT NOT NULL DEFAULT '',
        cancelada_por TEXT,
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (fin_min > inicio_min),
        CHECK (estado <> 'completada' OR metodo_pago IS NOT NULL),
        -- Evita dos citas activas que se traslapen en la misma fecha,
        -- incluso si dos personas reservan al mismo tiempo.
        CONSTRAINT citas_sin_traslape EXCLUDE USING gist (
          fecha WITH =,
          int4range(inicio_min, fin_min) WITH &&
        ) WHERE (estado <> 'cancelada')
      );
      CREATE INDEX IF NOT EXISTS idx_citas_fecha ON citas (fecha);
      CREATE INDEX IF NOT EXISTS idx_citas_cliente ON citas (cliente_id);

      CREATE TABLE IF NOT EXISTS gastos (
        id SERIAL PRIMARY KEY,
        fecha DATE NOT NULL,
        concepto TEXT NOT NULL,
        categoria TEXT NOT NULL DEFAULT 'General',
        monto NUMERIC(10,2) NOT NULL CHECK (monto > 0),
        metodo_pago TEXT NOT NULL DEFAULT 'efectivo' CHECK (metodo_pago IN ('efectivo', 'tarjeta', 'transferencia')),
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos (fecha);

      -- Registro de intentos de inicio de sesion fallidos (limite anti fuerza bruta).
      CREATE TABLE IF NOT EXISTS intentos_login (
        id SERIAL PRIMARY KEY,
        clave TEXT NOT NULL,
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_intentos_clave ON intentos_login (clave, creado);

      -- Datos iniciales tomados de la agenda actual de El Anexo.
      INSERT INTO configuracion (clave, valor) VALUES
        ('negocio_nombre', 'El Anexo'),
        ('barbero_nombre', 'Eduardo González'),
        ('direccion', '11 Calle 4-04, San Juan Sacatepéquez a un costado de Espartanos Barbería'),
        ('whatsapp', '30046246'),
        ('intervalo_min', '30'),
        ('anticipacion_min', '60'),
        ('dias_adelanto', '30'),
        ('horas_cancelacion', '2'),
        ('instagram', 'https://www.instagram.com/el_anexosj'),
        ('facebook', 'https://www.facebook.com/people/El-Anexo-SJ/61571937273104/')
      ON CONFLICT (clave) DO NOTHING;

      INSERT INTO servicios (nombre, descripcion, duracion_min, precio, orden)
      SELECT * FROM (VALUES
        ('Corte de cabello',
         'Corte de cabello clásico, fade desde 0 o rasurado, peinado y perfilado de cejas. Un servicio personalizado que se ajusta a tu estilo y a tu gusto.',
         30, 50.00::numeric, 1),
        ('Corte de cabello + tallado de barba',
         'Corte de cabello, tallado y alineado de barba, afeitado con vapor para ablandar el vello facial, relajar los músculos de la cara y purificar la piel, con aplicación de pigmento para resaltar y poblar tu barba.',
         60, 80.00::numeric, 2)
      ) AS s(nombre, descripcion, duracion_min, precio, orden)
      WHERE NOT EXISTS (SELECT 1 FROM servicios);

      -- Horario inicial de lunes a sabado, 11:00 a 21:00. Se ajusta desde el panel.
      INSERT INTO horario_semanal (dia, inicio_min, fin_min)
      SELECT d, 660, 1260 FROM generate_series(1, 6) AS d
      WHERE NOT EXISTS (SELECT 1 FROM horario_semanal);
    `,
  },
];

export const VERSION_ACTUAL = MIGRACIONES[MIGRACIONES.length - 1].version;
