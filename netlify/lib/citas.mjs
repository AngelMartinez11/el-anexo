// Logica central de citas: creacion validada y consultas comunes.
import { consulta, una } from './db.mjs';
import { estaDisponible, obtenerConfiguracion } from './disponibilidad.mjs';
import { ErrorHttp, ahoraGT, esFechaValida } from './utilidades.mjs';

const MAX_PENDIENTES_WEB = 2;

export async function obtenerServicio(id, { soloActivos = true } = {}) {
  const servicio = await una('SELECT * FROM servicios WHERE id = $1', [id]);
  if (!servicio || (soloActivos && !servicio.activo)) {
    throw new ErrorHttp(404, 'El servicio seleccionado no está disponible.');
  }
  return servicio;
}

// Busca un cliente por telefono o lo crea. No cambia el nombre de quien ya tiene PIN.
export async function clientePorTelefono(telefono, nombre) {
  const existente = await una('SELECT * FROM clientes WHERE telefono = $1', [telefono]);
  if (existente) {
    if (!existente.pin_hash && nombre && nombre !== existente.nombre) {
      await consulta('UPDATE clientes SET nombre = $1 WHERE id = $2', [nombre, existente.id]);
      existente.nombre = nombre;
    }
    return existente;
  }
  return una('INSERT INTO clientes (nombre, telefono) VALUES ($1, $2) RETURNING *', [nombre, telefono]);
}

export async function crearCita({
  cliente,
  servicio,
  fecha,
  inicio,
  precio = null,
  esVip = false,
  origen = 'web',
  notas = '',
  forzar = false,
}) {
  if (!esFechaValida(fecha)) throw new ErrorHttp(400, 'La fecha no es válida.');
  if (!Number.isInteger(inicio) || inicio < 0 || inicio > 1440) {
    throw new ErrorHttp(400, 'La hora no es válida.');
  }
  if (cliente.bloqueado && origen === 'web') {
    throw new ErrorHttp(403, 'No es posible agendar en línea con este número. Comunícate con la barbería.', 'bloqueado');
  }

  const duracion = servicio.duracion_min;
  const fin = inicio + duracion;
  if (fin > 1440) throw new ErrorHttp(400, 'El servicio termina después de medianoche.');

  if (origen === 'web') {
    const config = await obtenerConfiguracion();
    const hoy = ahoraGT();
    const pendientes = await una(
      `SELECT COUNT(*)::int AS n FROM citas
       WHERE cliente_id = $1 AND estado = 'pendiente'
         AND (fecha > $2 OR (fecha = $2 AND fin_min > $3))`,
      [cliente.id, hoy.fecha, hoy.minutos],
    );
    if (pendientes.n >= MAX_PENDIENTES_WEB) {
      throw new ErrorHttp(409, `Ya tienes ${MAX_PENDIENTES_WEB} citas pendientes. Para agendar otra comunícate con la barbería.`);
    }
    const libre = await estaDisponible(fecha, inicio, duracion, { config, publico: true });
    if (!libre) throw new ErrorHttp(409, 'Ese horario ya no está disponible. Elige otro.', 'ocupado');
  } else if (!forzar) {
    const libre = await estaDisponible(fecha, inicio, duracion, { publico: false });
    if (!libre) {
      throw new ErrorHttp(
        409,
        'Ese horario no está libre dentro del horario de atención. Si quieres registrarlo igual, marca "Fuera de horario".',
        'ocupado',
      );
    }
  }

  const precioFinal = precio === null ? servicio.precio : precio;
  try {
    return await una(
      `INSERT INTO citas (cliente_id, servicio_id, servicio_nombre, fecha, inicio_min, fin_min,
                          precio, es_vip, origen, notas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [cliente.id, servicio.id, servicio.nombre, fecha, inicio, fin, precioFinal, esVip, origen, notas],
    );
  } catch (error) {
    if (error.code === '23P01') {
      throw new ErrorHttp(409, 'Ese horario se acaba de ocupar. Elige otro.', 'ocupado');
    }
    throw error;
  }
}

export const SELECT_CITA = `
  SELECT c.id, c.cliente_id, c.servicio_id, c.servicio_nombre, c.fecha, c.inicio_min, c.fin_min,
         c.precio, c.es_vip, c.estado, c.metodo_pago, c.origen, c.recordatorio_enviado, c.notas,
         c.cancelada_por, c.creado,
         cl.nombre AS cliente_nombre, cl.telefono AS cliente_telefono, cl.bloqueado AS cliente_bloqueado
  FROM citas c JOIN clientes cl ON cl.id = c.cliente_id`;
