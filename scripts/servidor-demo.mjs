// Servidor local de demostracion: sirve public/ y la API con una base PostgreSQL
// en memoria (PGlite) con datos de ejemplo. No necesita Supabase ni Netlify.
// Uso: npm run demo  (abre http://localhost:8888)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { usarAdaptador, consulta } from '../netlify/lib/db.mjs';
import { manejar } from '../netlify/functions/api.mjs';
import { ahoraGT, sumarDias, diaSemana } from '../netlify/lib/utilidades.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUERTO = Number(process.env.PORT || 8888);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-local-de-demostracion-no-usar-en-produccion';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'anexo-demo';

const parsers = { 1700: (v) => Number(v), 1082: (v) => v };
const db = new PGlite({ extensions: { btree_gist } });
usarAdaptador({
  query: (t, p) => db.query(t, p, { parsers }),
  exec: (t) => db.exec(t),
  transaccion: (fn) => db.transaction((tx) => fn({
    query: (t, p) => tx.query(t, p, { parsers }),
    exec: (t) => tx.exec(t),
  })),
});

async function sembrar() {
  const nombres = [
    ['Angel Martínez', '55551234'], ['Carlos López', '42424242'], ['Luis Ruiz', '31313131'],
    ['Diego Cúmez', '47891234'], ['Kevin Ajcú', '52223344'], ['José Patzán', '40001122'],
    ['Mario Sirín', '33445566'], ['Fernando Boj', '58887766'],
  ];
  for (const [n, t] of nombres) {
    await consulta('INSERT INTO clientes (nombre, telefono) VALUES ($1, $2) ON CONFLICT DO NOTHING', [n, t]);
  }
  const hoy = ahoraGT();
  const metodos = ['efectivo', 'tarjeta'];
  let k = 0;
  for (let d = -40; d <= 6; d += 1) {
    const fecha = sumarDias(hoy.fecha, d);
    if (diaSemana(fecha) === 0) continue;
    const horas = d === 0 ? [660, 720, 780, 900, 1020, 1140] : [660, 750, 840, 960, 1080];
    for (const h of horas) {
      k += 1;
      if (d !== 0 && k % 3 === 0) continue;
      const cliente = (k % nombres.length) + 1;
      const servicio = k % 4 === 0 ? 2 : 1;
      const dur = servicio === 2 ? 60 : 30;
      const precio = servicio === 2 ? 80 : 50;
      const pasada = d < 0 || (d === 0 && h + dur <= hoy.minutos);
      let estado = 'pendiente';
      let metodo = null;
      if (pasada) {
        if (k % 11 === 0) estado = 'no_asistio';
        else { estado = 'completada'; metodo = metodos[k % 2]; }
      }
      await consulta(
        `INSERT INTO citas (cliente_id, servicio_id, servicio_nombre, fecha, inicio_min, fin_min, precio, estado, metodo_pago, origen)
         SELECT $1, $2, nombre, $3, $4, $5, $6, $7, $8, 'web' FROM servicios WHERE id = $2`,
        [cliente, servicio, fecha, h, h + dur, precio, estado, metodo],
      );
    }
  }
  await consulta("INSERT INTO gastos (fecha, concepto, categoria, monto) VALUES ($1, 'Navajas y talco', 'Insumos', 85)", [hoy.fecha]);
  await consulta("INSERT INTO gastos (fecha, concepto, categoria, monto) VALUES ($1, 'Energía eléctrica', 'Servicios', 320)", [sumarDias(hoy.fecha, -5)]);
  await consulta("INSERT INTO bloqueos (fecha, inicio_min, fin_min, motivo) VALUES ($1, 840, 900, 'Almuerzo')", [hoy.fecha]);
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PUERTO}`);
  if (url.pathname.startsWith('/api/')) {
    const cuerpo = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((ok) => {
      let datos = '';
      req.on('data', (c) => { datos += c; });
      req.on('end', () => ok(datos));
    });
    const respuesta = await manejar(new Request(url, { method: req.method, headers: req.headers, body: cuerpo || undefined }));
    res.writeHead(respuesta.status, Object.fromEntries(respuesta.headers));
    res.end(Buffer.from(await respuesta.arrayBuffer()));
    return;
  }
  let ruta = decodeURIComponent(url.pathname);
  if (ruta.endsWith('/')) ruta += 'index.html';
  const archivo = path.join(RAIZ, path.normalize(ruta));
  if (!archivo.startsWith(RAIZ)) { res.writeHead(403); res.end(); return; }
  try {
    const contenido = await readFile(archivo);
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
    res.end(contenido);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
});

await sembrar();
servidor.listen(PUERTO, () => {
  console.log(`Demo de El Anexo en http://localhost:${PUERTO}`);
  console.log(`Panel: http://localhost:${PUERTO}/admin/  (contraseña: ${process.env.ADMIN_PASSWORD})`);
});
