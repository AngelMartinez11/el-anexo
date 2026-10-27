// Conexion a PostgreSQL (Supabase) y aplicacion automatica de migraciones.
import pg from 'pg';
import { MIGRACIONES, VERSION_ACTUAL } from './migraciones.mjs';

// Los campos NUMERIC llegan como texto; se convierten a numero.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// Los DATE se dejan como texto YYYY-MM-DD para no sufrir cambios de zona horaria.
pg.types.setTypeParser(1082, (v) => v);

let pool = null;
let adaptador = null; // Permite inyectar otra base de datos en las pruebas.
let esquemaListo = null;

function obtenerPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('Falta la variable de entorno DATABASE_URL');
    }
    pool = new pg.Pool({
      connectionString: url,
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

function motor() {
  if (adaptador) return adaptador;
  const p = obtenerPool();
  return {
    query: (texto, params) => p.query(texto, params),
    exec: (texto) => p.query(texto),
    transaccion: async (fn) => {
      const cliente = await p.connect();
      try {
        await cliente.query('BEGIN');
        const resultado = await fn({
          query: (t, pr) => cliente.query(t, pr),
          exec: (t) => cliente.query(t),
        });
        await cliente.query('COMMIT');
        return resultado;
      } catch (error) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        cliente.release();
      }
    },
  };
}

// Solo para pruebas: reemplaza la conexion real por otra (por ejemplo PGlite).
export function usarAdaptador(nuevo) {
  adaptador = nuevo;
  esquemaListo = null;
}

async function aplicarMigraciones() {
  const m = motor();
  await m.exec(`CREATE TABLE IF NOT EXISTS esquema_version (
    version INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    aplicada TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const { rows } = await m.query('SELECT COALESCE(MAX(version), 0) AS v FROM esquema_version');
  if (Number(rows[0].v) >= VERSION_ACTUAL) return;

  await m.transaccion(async (tx) => {
    // Evita que dos funciones apliquen la misma migracion a la vez.
    await tx.query('SELECT pg_advisory_xact_lock(724519)');
    const actual = await tx.query('SELECT COALESCE(MAX(version), 0) AS v FROM esquema_version');
    const desde = Number(actual.rows[0].v);
    for (const mig of MIGRACIONES) {
      if (mig.version <= desde) continue;
      await tx.exec(mig.sql);
      await tx.query('INSERT INTO esquema_version (version, nombre) VALUES ($1, $2)', [mig.version, mig.nombre]);
    }
  });
}

export async function asegurarEsquema() {
  if (!esquemaListo) {
    esquemaListo = aplicarMigraciones().catch((error) => {
      esquemaListo = null;
      throw error;
    });
  }
  return esquemaListo;
}

// Ejecuta una consulta parametrizada y devuelve las filas.
export async function consulta(texto, params = []) {
  await asegurarEsquema();
  const { rows } = await motor().query(texto, params);
  return rows;
}

export async function una(texto, params = []) {
  const filas = await consulta(texto, params);
  return filas[0] || null;
}

export async function transaccion(fn) {
  await asegurarEsquema();
  return motor().transaccion(async (tx) => {
    const ayudante = {
      consulta: async (t, p = []) => (await tx.query(t, p)).rows,
      una: async (t, p = []) => (await tx.query(t, p)).rows[0] || null,
    };
    return fn(ayudante);
  });
}
