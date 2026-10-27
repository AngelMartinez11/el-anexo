// Prepara una base PostgreSQL en memoria (PGlite) y un cliente HTTP simulado para las pruebas.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { usarAdaptador } from '../netlify/lib/db.mjs';
import { manejar } from '../netlify/functions/api.mjs';
import { ahoraGT, sumarDias, diaSemana } from '../netlify/lib/utilidades.mjs';

process.env.JWT_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres';
process.env.ADMIN_PASSWORD = 'clave-admin-123';

const parsers = { 1700: (v) => Number(v), 1082: (v) => v };

export async function nuevaBase() {
  const db = new PGlite({ extensions: { btree_gist } });
  usarAdaptador({
    query: (t, p) => db.query(t, p, { parsers }),
    exec: (t) => db.exec(t),
    transaccion: (fn) => db.transaction((tx) => fn({
      query: (t, p) => tx.query(t, p, { parsers }),
      exec: (t) => tx.exec(t),
    })),
  });
  return db;
}

export async function llamar(metodo, ruta, { cuerpo, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const req = new Request(`http://localhost/api/${ruta}`, {
    method: metodo,
    headers,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const res = await manejar(req);
  const tipo = res.headers.get('content-type') || '';
  const datos = tipo.includes('json') ? await res.json() : await res.text();
  return { estado: res.status, datos };
}

// Proxima fecha (desde manana) que cae en un dia de lunes a sabado.
export function proximoDiaHabil(desdeDias = 1) {
  let fecha = sumarDias(ahoraGT().fecha, desdeDias);
  while (diaSemana(fecha) === 0) fecha = sumarDias(fecha, 1);
  return fecha;
}

export function proximoDomingo() {
  let fecha = sumarDias(ahoraGT().fecha, 1);
  while (diaSemana(fecha) !== 0) fecha = sumarDias(fecha, 1);
  return fecha;
}
