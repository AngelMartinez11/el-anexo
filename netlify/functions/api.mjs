// Funcion unica de Netlify que atiende todas las rutas /api/*.
// Usar una sola funcion reduce los arranques en frio y el consumo de creditos.
import { rutasPublicas } from '../lib/rutas-publicas.mjs';
import { rutasAdmin } from '../lib/rutas-admin.mjs';
import { ErrorHttp } from '../lib/utilidades.mjs';

const RUTAS = [...rutasPublicas, ...rutasAdmin];
const MAX_CUERPO = 20000;

function json(estado, datos) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function leerCuerpo(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const texto = await req.text();
  if (!texto) return {};
  if (texto.length > MAX_CUERPO) throw new ErrorHttp(413, 'Solicitud demasiado grande.');
  try {
    const datos = JSON.parse(texto);
    return datos && typeof datos === 'object' ? datos : {};
  } catch {
    throw new ErrorHttp(400, 'Formato de datos no válido.');
  }
}

export async function manejar(req) {
  const url = new URL(req.url);
  const ruta = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)\/?/, '').replace(/\/$/, '');
  try {
    for (const [metodo, patron, manejador] of RUTAS) {
      if (metodo !== req.method) continue;
      const coincidencia = ruta.match(patron);
      if (!coincidencia) continue;
      const cuerpo = await leerCuerpo(req);
      const resultado = await manejador(req, url, cuerpo, coincidencia);
      return resultado instanceof Response ? resultado : json(200, resultado);
    }
    return json(404, { error: 'Ruta no encontrada.' });
  } catch (error) {
    if (error instanceof ErrorHttp) {
      return json(error.estado, { error: error.message, codigo: error.codigo });
    }
    console.error('Error no controlado:', error);
    return json(500, { error: 'Ocurrió un error inesperado. Inténtalo de nuevo en un momento.' });
  }
}

export default manejar;

export const config = {
  path: '/api/*',
};
