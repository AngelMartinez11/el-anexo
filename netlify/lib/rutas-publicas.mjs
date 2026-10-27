// Rutas para clientes: informacion, disponibilidad, reservas, sesion con PIN y mis citas.
import { consulta, una } from './db.mjs';
import {
  hashPin, verificarPin, tokenCliente, exigirCliente, clienteOpcional,
  revisarIntentos, registrarIntentoFallido, limpiarIntentos,
} from './auth.mjs';
import { obtenerConfiguracion, slotsDeFecha, resumenDias } from './disponibilidad.mjs';
import { crearCita, obtenerServicio, clientePorTelefono, SELECT_CITA } from './citas.mjs';
import {
  ErrorHttp, ahoraGT, esFechaValida, normalizarTelefono, validarNombre, validarPin,
  aEntero, diferenciaDias,
} from './utilidades.mjs';

const CLAVES_PUBLICAS = [
  'negocio_nombre', 'barbero_nombre', 'direccion', 'whatsapp', 'intervalo_min',
  'dias_adelanto', 'horas_cancelacion', 'instagram', 'facebook',
];

async function info() {
  const config = await obtenerConfiguracion();
  const publica = {};
  for (const c of CLAVES_PUBLICAS) publica[c] = config[c];
  const servicios = await consulta(
    'SELECT id, nombre, descripcion, duracion_min, precio FROM servicios WHERE activo ORDER BY orden, id',
  );
  return { config: publica, servicios, hoy: ahoraGT().fecha };
}

async function dias(url) {
  const servicio = await obtenerServicio(aEntero(url.searchParams.get('servicio')));
  const config = await obtenerConfiguracion();
  const hoy = ahoraGT().fecha;
  const cantidad = Math.min((config.dias_adelanto || 30) + 1, 62);
  return { dias: await resumenDias(hoy, cantidad, servicio.duracion_min, { config }) };
}

async function horarios(url) {
  const fecha = url.searchParams.get('fecha');
  if (!esFechaValida(fecha)) throw new ErrorHttp(400, 'La fecha no es válida.');
  const servicio = await obtenerServicio(aEntero(url.searchParams.get('servicio')));
  const libres = await slotsDeFecha(fecha, servicio.duracion_min, { publico: true });
  return { fecha, libres };
}

function datosCliente(cliente) {
  return { id: cliente.id, nombre: cliente.nombre, telefono: cliente.telefono };
}

// Reserva como invitado (nombre + telefono), con opcion de crear PIN en el mismo paso.
async function reservarInvitado(req, cuerpo) {
  const sesion = await clienteOpcional(req);
  if (sesion) return reservarConSesion(req, cuerpo);

  const nombre = validarNombre(cuerpo.nombre);
  const telefono = normalizarTelefono(cuerpo.telefono);
  if (!telefono) throw new ErrorHttp(400, 'Ingresa un número de teléfono válido de 8 dígitos.');
  const servicio = await obtenerServicio(aEntero(cuerpo.servicio_id));
  const pinNuevo = cuerpo.pin ? validarPin(String(cuerpo.pin)) : null;

  const cliente = await clientePorTelefono(telefono, nombre);
  const cita = await crearCita({
    cliente, servicio, fecha: cuerpo.fecha, inicio: aEntero(cuerpo.inicio), origen: 'web',
  });

  let token = null;
  let aviso = null;
  if (pinNuevo) {
    if (cliente.pin_hash) {
      aviso = 'Este número ya tiene un PIN. Usa "Iniciar sesión" la próxima vez.';
    } else {
      await consulta('UPDATE clientes SET pin_hash = $1 WHERE id = $2', [hashPin(pinNuevo), cliente.id]);
      token = tokenCliente(cliente.id);
    }
  }
  return { cita, token, aviso, cliente: token ? datosCliente(cliente) : null };
}

async function reservarConSesion(req, cuerpo) {
  const sesion = await exigirCliente(req);
  const cliente = await una('SELECT * FROM clientes WHERE id = $1', [sesion.id]);
  const servicio = await obtenerServicio(aEntero(cuerpo.servicio_id));
  const cita = await crearCita({
    cliente, servicio, fecha: cuerpo.fecha, inicio: aEntero(cuerpo.inicio), origen: 'web',
  });
  return { cita };
}

async function login(cuerpo) {
  const telefono = normalizarTelefono(cuerpo.telefono);
  if (!telefono) throw new ErrorHttp(400, 'Ingresa un número de teléfono válido de 8 dígitos.');
  const pin = validarPin(String(cuerpo.pin || ''));
  const clave = `cliente:${telefono}`;
  await revisarIntentos(clave);
  const cliente = await una('SELECT * FROM clientes WHERE telefono = $1', [telefono]);
  if (!cliente || !cliente.pin_hash || !verificarPin(pin, cliente.pin_hash)) {
    await registrarIntentoFallido(clave);
    throw new ErrorHttp(401, 'Teléfono o PIN incorrectos.');
  }
  if (cliente.bloqueado) {
    throw new ErrorHttp(403, 'Tu cuenta no puede agendar en línea. Comunícate con la barbería.', 'bloqueado');
  }
  await limpiarIntentos(clave);
  return { token: tokenCliente(cliente.id), cliente: datosCliente(cliente) };
}

// Crear cuenta: solo si el numero no tiene PIN todavia.
async function registro(cuerpo) {
  const nombre = validarNombre(cuerpo.nombre);
  const telefono = normalizarTelefono(cuerpo.telefono);
  if (!telefono) throw new ErrorHttp(400, 'Ingresa un número de teléfono válido de 8 dígitos.');
  const pin = validarPin(String(cuerpo.pin || ''));
  const clave = `registro:${telefono}`;
  await revisarIntentos(clave);
  const existente = await una('SELECT * FROM clientes WHERE telefono = $1', [telefono]);
  if (existente && existente.pin_hash) {
    await registrarIntentoFallido(clave);
    throw new ErrorHttp(409, 'Este número ya tiene cuenta. Inicia sesión con tu PIN o pide a la barbería que lo restablezca.');
  }
  if (existente && existente.bloqueado) {
    throw new ErrorHttp(403, 'Este número no puede agendar en línea. Comunícate con la barbería.', 'bloqueado');
  }
  const cliente = existente
    ? await una('UPDATE clientes SET nombre = $1, pin_hash = $2 WHERE id = $3 RETURNING *', [nombre, hashPin(pin), existente.id])
    : await una('INSERT INTO clientes (nombre, telefono, pin_hash) VALUES ($1, $2, $3) RETURNING *', [nombre, telefono, hashPin(pin)]);
  return { token: tokenCliente(cliente.id), cliente: datosCliente(cliente) };
}

async function misCitas(req) {
  const sesion = await exigirCliente(req);
  const config = await obtenerConfiguracion();
  const hoy = ahoraGT();
  const citas = await consulta(
    `${SELECT_CITA} WHERE c.cliente_id = $1 ORDER BY c.fecha DESC, c.inicio_min DESC LIMIT 40`,
    [sesion.id],
  );
  const proximas = [];
  const historial = [];
  for (const c of citas) {
    const futura = c.fecha > hoy.fecha || (c.fecha === hoy.fecha && c.fin_min > hoy.minutos);
    const item = {
      id: c.id, servicio: c.servicio_nombre, fecha: c.fecha, inicio_min: c.inicio_min,
      fin_min: c.fin_min, precio: c.precio, estado: c.estado,
    };
    if (c.estado === 'pendiente' && futura) {
      const minutosFaltan = diferenciaDias(hoy.fecha, c.fecha) * 1440 + c.inicio_min - hoy.minutos;
      item.cancelable = minutosFaltan >= (config.horas_cancelacion || 0) * 60;
      proximas.push(item);
    } else {
      historial.push(item);
    }
  }
  proximas.reverse();
  return { cliente: datosCliente(sesion), proximas, historial };
}

async function cancelar(req, cuerpo) {
  const sesion = await exigirCliente(req);
  const id = aEntero(cuerpo.cita_id);
  const cita = await una('SELECT * FROM citas WHERE id = $1 AND cliente_id = $2', [id, sesion.id]);
  if (!cita) throw new ErrorHttp(404, 'No encontramos esa cita.');
  if (cita.estado !== 'pendiente') throw new ErrorHttp(409, 'Esta cita ya no se puede cancelar.');
  const config = await obtenerConfiguracion();
  const hoy = ahoraGT();
  const minutosFaltan = diferenciaDias(hoy.fecha, cita.fecha) * 1440 + cita.inicio_min - hoy.minutos;
  const limite = (config.horas_cancelacion || 0) * 60;
  if (minutosFaltan < limite) {
    throw new ErrorHttp(409, `Solo puedes cancelar con al menos ${config.horas_cancelacion} horas de anticipación. Escríbenos por WhatsApp.`);
  }
  await consulta(
    "UPDATE citas SET estado = 'cancelada', cancelada_por = 'cliente', actualizado = NOW() WHERE id = $1",
    [id],
  );
  return { ok: true };
}

export const rutasPublicas = [
  ['GET', /^publico\/info$/, () => info()],
  ['GET', /^publico\/dias$/, (req, url) => dias(url)],
  ['GET', /^publico\/horarios$/, (req, url) => horarios(url)],
  ['POST', /^publico\/reservar$/, (req, url, cuerpo) => reservarInvitado(req, cuerpo)],
  ['POST', /^cliente\/login$/, (req, url, cuerpo) => login(cuerpo)],
  ['POST', /^cliente\/registro$/, (req, url, cuerpo) => registro(cuerpo)],
  ['GET', /^cliente\/citas$/, (req) => misCitas(req)],
  ['POST', /^cliente\/cancelar$/, (req, url, cuerpo) => cancelar(req, cuerpo)],
];
