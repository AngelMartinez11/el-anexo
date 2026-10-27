// Rutas del panel de administrador.
import { consulta, una, transaccion } from './db.mjs';
import {
  exigirAdmin, tokenAdmin, compararSeguro, revisarIntentos, registrarIntentoFallido, limpiarIntentos,
} from './auth.mjs';
import { obtenerConfiguracion, horarioDeFecha, slotsDeFecha } from './disponibilidad.mjs';
import { crearCita, obtenerServicio, clientePorTelefono, SELECT_CITA } from './citas.mjs';
import {
  ErrorHttp, ahoraGT, esFechaValida, rangoMes, mesAnterior, normalizarTelefono, validarNombre,
  limpiarTexto, aEntero, aMonto, horaAMinutos, minutosAHora,
} from './utilidades.mjs';

// ---------- Sesion ----------

async function login(cuerpo) {
  const esperado = process.env.ADMIN_PASSWORD;
  if (!esperado || esperado.length < 8) {
    throw new ErrorHttp(500, 'Falta configurar ADMIN_PASSWORD en Netlify (mínimo 8 caracteres).');
  }
  await revisarIntentos('admin');
  if (!compararSeguro(String(cuerpo.password || ''), esperado)) {
    await registrarIntentoFallido('admin');
    throw new ErrorHttp(401, 'Contraseña incorrecta.');
  }
  await limpiarIntentos('admin');
  return { token: tokenAdmin() };
}

// ---------- Agenda ----------

async function agendaDia(url) {
  const fecha = url.searchParams.get('fecha') || ahoraGT().fecha;
  if (!esFechaValida(fecha)) throw new ErrorHttp(400, 'Fecha no válida.');
  const config = await obtenerConfiguracion();
  const [{ rangos, especial }, bloqueos, citas] = await Promise.all([
    horarioDeFecha(fecha),
    consulta('SELECT id, inicio_min, fin_min, motivo FROM bloqueos WHERE fecha = $1 ORDER BY inicio_min', [fecha]),
    consulta(
      `${SELECT_CITA}
       WHERE c.fecha = $1
       ORDER BY c.inicio_min, c.id`,
      [fecha],
    ),
  ]);
  const ids = [...new Set(citas.map((c) => c.cliente_id))];
  let inasistencias = [];
  if (ids.length) {
    inasistencias = await consulta(
      `SELECT cliente_id, COUNT(*)::int AS n FROM citas
       WHERE cliente_id = ANY($1::int[]) AND estado = 'no_asistio' GROUP BY cliente_id`,
      [ids],
    );
  }
  const mapa = new Map(inasistencias.map((i) => [i.cliente_id, i.n]));
  for (const c of citas) c.cliente_inasistencias = mapa.get(c.cliente_id) || 0;
  return { fecha, hoy: ahoraGT(), intervalo: config.intervalo_min, rangos, especial, bloqueos, citas };
}

async function agendaMes(url) {
  const mes = url.searchParams.get('mes') || ahoraGT().fecha.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new ErrorHttp(400, 'Mes no válido.');
  const { inicio, fin } = rangoMes(`${mes}-01`);
  const [conteos, especiales, semanal] = await Promise.all([
    consulta(
      `SELECT fecha, COUNT(*) FILTER (WHERE estado <> 'cancelada')::int AS citas,
              COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes
       FROM citas WHERE fecha BETWEEN $1 AND $2 GROUP BY fecha`,
      [inicio, fin],
    ),
    consulta('SELECT fecha, cerrado, rangos FROM dias_especiales WHERE fecha BETWEEN $1 AND $2', [inicio, fin]),
    consulta('SELECT DISTINCT dia FROM horario_semanal'),
  ]);
  return {
    mes, inicio, fin, hoy: ahoraGT().fecha,
    dias_abiertos: semanal.map((s) => s.dia),
    conteos, especiales,
  };
}

async function horariosLibres(url) {
  const fecha = url.searchParams.get('fecha');
  if (!esFechaValida(fecha)) throw new ErrorHttp(400, 'Fecha no válida.');
  const servicio = await obtenerServicio(aEntero(url.searchParams.get('servicio')), { soloActivos: false });
  return { libres: await slotsDeFecha(fecha, servicio.duracion_min, { publico: false }) };
}

async function crearCitaAdmin(cuerpo) {
  const servicio = await obtenerServicio(aEntero(cuerpo.servicio_id), { soloActivos: false });
  let cliente;
  if (cuerpo.cliente_id) {
    cliente = await una('SELECT * FROM clientes WHERE id = $1', [aEntero(cuerpo.cliente_id)]);
    if (!cliente) throw new ErrorHttp(404, 'Cliente no encontrado.');
  } else {
    const nombre = validarNombre(cuerpo.nombre);
    const telefono = normalizarTelefono(cuerpo.telefono);
    if (!telefono) throw new ErrorHttp(400, 'Teléfono no válido (8 dígitos).');
    cliente = await clientePorTelefono(telefono, nombre);
  }
  let precio = null;
  if (cuerpo.precio !== undefined && cuerpo.precio !== null && cuerpo.precio !== '') {
    precio = aMonto(cuerpo.precio);
    if (precio === null) throw new ErrorHttp(400, 'Precio no válido.');
  }
  const inicio = typeof cuerpo.inicio === 'string' ? horaAMinutos(cuerpo.inicio) : aEntero(cuerpo.inicio);
  const cita = await crearCita({
    cliente,
    servicio,
    fecha: cuerpo.fecha,
    inicio,
    precio,
    esVip: Boolean(cuerpo.es_vip),
    origen: 'admin',
    notas: limpiarTexto(cuerpo.notas || '', 300),
    forzar: Boolean(cuerpo.forzar),
  });
  // Registro directo de un cliente ya atendido (por ejemplo, sin cita previa).
  if (cuerpo.metodo_pago === 'efectivo' || cuerpo.metodo_pago === 'tarjeta') {
    return una(
      "UPDATE citas SET estado = 'completada', metodo_pago = $1, actualizado = NOW() WHERE id = $2 RETURNING *",
      [cuerpo.metodo_pago, cita.id],
    );
  }
  return cita;
}

async function actualizarCita(id, cuerpo) {
  const cita = await una('SELECT * FROM citas WHERE id = $1', [id]);
  if (!cita) throw new ErrorHttp(404, 'Cita no encontrada.');
  const accion = cuerpo.accion;

  if (accion === 'cobrar') {
    if (!['efectivo', 'tarjeta'].includes(cuerpo.metodo_pago)) {
      throw new ErrorHttp(400, 'Elige Efectivo o Tarjeta.');
    }
    if (cita.estado === 'cancelada') throw new ErrorHttp(409, 'No se puede cobrar una cita cancelada.');
    let precio = cita.precio;
    if (cuerpo.precio !== undefined && cuerpo.precio !== null && cuerpo.precio !== '') {
      precio = aMonto(cuerpo.precio);
      if (precio === null) throw new ErrorHttp(400, 'Precio no válido.');
    }
    return una(
      `UPDATE citas SET estado = 'completada', metodo_pago = $1, precio = $2, actualizado = NOW()
       WHERE id = $3 RETURNING *`,
      [cuerpo.metodo_pago, precio, id],
    );
  }
  if (accion === 'no_asistio') {
    return una(
      "UPDATE citas SET estado = 'no_asistio', metodo_pago = NULL, actualizado = NOW() WHERE id = $1 RETURNING *",
      [id],
    );
  }
  if (accion === 'cancelar') {
    return una(
      `UPDATE citas SET estado = 'cancelada', metodo_pago = NULL, cancelada_por = 'admin', actualizado = NOW()
       WHERE id = $1 RETURNING *`,
      [id],
    );
  }
  if (accion === 'reabrir') {
    // Vuelve a pendiente; si era cancelada puede chocar con otra cita.
    try {
      return await una(
        `UPDATE citas SET estado = 'pendiente', metodo_pago = NULL, cancelada_por = NULL, actualizado = NOW()
         WHERE id = $1 RETURNING *`,
        [id],
      );
    } catch (error) {
      if (error.code === '23P01') throw new ErrorHttp(409, 'Ese horario ya está ocupado por otra cita.');
      throw error;
    }
  }
  if (accion === 'recordatorio') {
    return una('UPDATE citas SET recordatorio_enviado = TRUE, actualizado = NOW() WHERE id = $1 RETURNING *', [id]);
  }
  if (accion === 'editar') {
    const precio = cuerpo.precio === undefined ? cita.precio : aMonto(cuerpo.precio);
    if (precio === null) throw new ErrorHttp(400, 'Precio no válido.');
    const notas = cuerpo.notas === undefined ? cita.notas : limpiarTexto(cuerpo.notas, 300);
    const esVip = cuerpo.es_vip === undefined ? cita.es_vip : Boolean(cuerpo.es_vip);
    let metodo = cita.metodo_pago;
    if (cita.estado === 'completada' && ['efectivo', 'tarjeta'].includes(cuerpo.metodo_pago)) {
      metodo = cuerpo.metodo_pago;
    }
    return una(
      `UPDATE citas SET precio = $1, notas = $2, es_vip = $3, metodo_pago = $4, actualizado = NOW()
       WHERE id = $5 RETURNING *`,
      [precio, notas, esVip, metodo, id],
    );
  }
  throw new ErrorHttp(400, 'Acción no reconocida.');
}

// ---------- Clientes ----------

const ESTADISTICAS_CLIENTE = `
  COUNT(ci.id) FILTER (WHERE ci.estado = 'completada')::int AS visitas,
  COALESCE(SUM(ci.precio) FILTER (WHERE ci.estado = 'completada'), 0)::numeric AS total_gastado,
  COUNT(ci.id) FILTER (WHERE ci.estado = 'no_asistio')::int AS inasistencias,
  COUNT(ci.id) FILTER (WHERE ci.estado = 'cancelada')::int AS canceladas,
  MAX(ci.fecha) FILTER (WHERE ci.estado = 'completada') AS ultima_visita`;

async function listarClientes(url) {
  const q = limpiarTexto(url.searchParams.get('q') || '', 60);
  const filtro = url.searchParams.get('filtro') || 'todos';
  const condiciones = [];
  const params = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    params.push(`%${q.replace(/\D/g, '') || '~'}%`);
    condiciones.push(`(LOWER(cl.nombre) LIKE $${params.length - 1} OR cl.telefono LIKE $${params.length})`);
  }
  if (filtro === 'bloqueados') condiciones.push('cl.bloqueado');
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const filas = await consulta(
    `SELECT cl.id, cl.nombre, cl.telefono, cl.bloqueado, (cl.pin_hash IS NOT NULL) AS tiene_pin, cl.creado,
            ${ESTADISTICAS_CLIENTE}
     FROM clientes cl LEFT JOIN citas ci ON ci.cliente_id = cl.id
     ${where}
     GROUP BY cl.id
     ORDER BY MAX(ci.fecha) DESC NULLS LAST, cl.nombre
     LIMIT 100`,
    params,
  );
  return { clientes: filas };
}

async function detalleCliente(id) {
  const cliente = await una(
    `SELECT cl.id, cl.nombre, cl.telefono, cl.bloqueado, cl.motivo_bloqueo, cl.notas,
            (cl.pin_hash IS NOT NULL) AS tiene_pin, cl.creado, ${ESTADISTICAS_CLIENTE}
     FROM clientes cl LEFT JOIN citas ci ON ci.cliente_id = cl.id
     WHERE cl.id = $1 GROUP BY cl.id`,
    [id],
  );
  if (!cliente) throw new ErrorHttp(404, 'Cliente no encontrado.');
  const citas = await consulta(
    `SELECT id, servicio_nombre, fecha, inicio_min, precio, estado, metodo_pago, es_vip, notas
     FROM citas WHERE cliente_id = $1 ORDER BY fecha DESC, inicio_min DESC LIMIT 100`,
    [id],
  );
  return { cliente, citas };
}

async function actualizarCliente(id, cuerpo) {
  const cliente = await una('SELECT * FROM clientes WHERE id = $1', [id]);
  if (!cliente) throw new ErrorHttp(404, 'Cliente no encontrado.');
  const nombre = cuerpo.nombre !== undefined ? validarNombre(cuerpo.nombre) : cliente.nombre;
  let telefono = cliente.telefono;
  if (cuerpo.telefono !== undefined) {
    telefono = normalizarTelefono(cuerpo.telefono);
    if (!telefono) throw new ErrorHttp(400, 'Teléfono no válido (8 dígitos).');
  }
  const notas = cuerpo.notas !== undefined ? limpiarTexto(cuerpo.notas, 500) : cliente.notas;
  const bloqueado = cuerpo.bloqueado !== undefined ? Boolean(cuerpo.bloqueado) : cliente.bloqueado;
  const motivo = cuerpo.motivo_bloqueo !== undefined ? limpiarTexto(cuerpo.motivo_bloqueo, 200) : cliente.motivo_bloqueo;
  const pinHash = cuerpo.restablecer_pin ? null : cliente.pin_hash;
  try {
    await consulta(
      `UPDATE clientes SET nombre = $1, telefono = $2, notas = $3, bloqueado = $4, motivo_bloqueo = $5, pin_hash = $6
       WHERE id = $7`,
      [nombre, telefono, notas, bloqueado, bloqueado ? motivo : '', pinHash, id],
    );
  } catch (error) {
    if (error.code === '23505') throw new ErrorHttp(409, 'Ya existe otro cliente con ese teléfono.');
    throw error;
  }
  return detalleCliente(id);
}

// ---------- Finanzas ----------

async function resumenPeriodo(desde, hasta) {
  const [ingresos, gastos, porServicio, otros] = await Promise.all([
    una(
      `SELECT COUNT(*)::int AS servicios,
              COALESCE(SUM(precio), 0)::numeric AS total,
              COALESCE(SUM(precio) FILTER (WHERE metodo_pago = 'efectivo'), 0)::numeric AS efectivo,
              COALESCE(SUM(precio) FILTER (WHERE metodo_pago = 'tarjeta'), 0)::numeric AS tarjeta,
              COUNT(*) FILTER (WHERE es_vip)::int AS vip
       FROM citas WHERE estado = 'completada' AND fecha BETWEEN $1 AND $2`,
      [desde, hasta],
    ),
    una(
      `SELECT COALESCE(SUM(monto), 0)::numeric AS total,
              COALESCE(SUM(monto) FILTER (WHERE metodo_pago = 'efectivo'), 0)::numeric AS efectivo
       FROM gastos WHERE fecha BETWEEN $1 AND $2`,
      [desde, hasta],
    ),
    consulta(
      `SELECT servicio_nombre AS servicio, COUNT(*)::int AS cantidad, SUM(precio)::numeric AS total
       FROM citas WHERE estado = 'completada' AND fecha BETWEEN $1 AND $2
       GROUP BY servicio_nombre ORDER BY total DESC`,
      [desde, hasta],
    ),
    una(
      `SELECT COUNT(*) FILTER (WHERE estado = 'no_asistio')::int AS inasistencias,
              COUNT(*) FILTER (WHERE estado = 'cancelada')::int AS canceladas
       FROM citas WHERE fecha BETWEEN $1 AND $2`,
      [desde, hasta],
    ),
  ]);
  return {
    desde, hasta,
    servicios: ingresos.servicios,
    ingresos: ingresos.total,
    efectivo: ingresos.efectivo,
    tarjeta: ingresos.tarjeta,
    vip: ingresos.vip,
    gastos: gastos.total,
    gastos_efectivo: gastos.efectivo,
    neto: Math.round((ingresos.total - gastos.total) * 100) / 100,
    caja_efectivo: Math.round((ingresos.efectivo - gastos.efectivo) * 100) / 100,
    por_servicio: porServicio,
    inasistencias: otros.inasistencias,
    canceladas: otros.canceladas,
  };
}

async function finanzas(url) {
  const hoy = ahoraGT();
  const fecha = url.searchParams.get('fecha') || hoy.fecha;
  if (!esFechaValida(fecha)) throw new ErrorHttp(400, 'Fecha no válida.');
  const mesActual = rangoMes(hoy.fecha);
  const mesPasado = mesAnterior(hoy.fecha);
  const [dia, actual, pasado, detalle, gastosDia, sinCobrar] = await Promise.all([
    resumenPeriodo(fecha, fecha),
    resumenPeriodo(mesActual.inicio, mesActual.fin),
    resumenPeriodo(mesPasado.inicio, mesPasado.fin),
    consulta(
      `${SELECT_CITA} WHERE c.fecha = $1 AND c.estado = 'completada' ORDER BY c.inicio_min`,
      [fecha],
    ),
    consulta('SELECT * FROM gastos WHERE fecha = $1 ORDER BY id', [fecha]),
    consulta(
      `${SELECT_CITA}
       WHERE c.estado = 'pendiente' AND (c.fecha < $1 OR (c.fecha = $1 AND c.fin_min <= $2))
       ORDER BY c.fecha DESC, c.inicio_min DESC LIMIT 50`,
      [hoy.fecha, hoy.minutos],
    ),
  ]);
  return {
    fecha,
    dia: { ...dia, citas: detalle, gastos_lista: gastosDia },
    mes_actual: { ...actual, clave: mesActual.clave },
    mes_pasado: { ...pasado, clave: mesPasado.clave },
    sin_cobrar: sinCobrar,
  };
}

async function finanzasMes(url) {
  const mes = url.searchParams.get('mes');
  if (!/^\d{4}-\d{2}$/.test(mes || '')) throw new ErrorHttp(400, 'Mes no válido.');
  const { inicio, fin } = rangoMes(`${mes}-01`);
  const resumen = await resumenPeriodo(inicio, fin);
  const porDia = await consulta(
    `SELECT fecha, COUNT(*)::int AS servicios, SUM(precio)::numeric AS total,
            COALESCE(SUM(precio) FILTER (WHERE metodo_pago = 'efectivo'), 0)::numeric AS efectivo,
            COALESCE(SUM(precio) FILTER (WHERE metodo_pago = 'tarjeta'), 0)::numeric AS tarjeta
     FROM citas WHERE estado = 'completada' AND fecha BETWEEN $1 AND $2
     GROUP BY fecha ORDER BY fecha`,
    [inicio, fin],
  );
  const gastos = await consulta('SELECT * FROM gastos WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha, id', [inicio, fin]);
  return { mes, resumen, por_dia: porDia, gastos };
}

function csvCelda(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  return /[",\n;]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

async function exportarMes(url) {
  const mes = url.searchParams.get('mes');
  if (!/^\d{4}-\d{2}$/.test(mes || '')) throw new ErrorHttp(400, 'Mes no válido.');
  const { inicio, fin } = rangoMes(`${mes}-01`);
  const citas = await consulta(
    `${SELECT_CITA} WHERE c.fecha BETWEEN $1 AND $2 AND c.estado = 'completada' ORDER BY c.fecha, c.inicio_min`,
    [inicio, fin],
  );
  const gastos = await consulta('SELECT * FROM gastos WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha, id', [inicio, fin]);
  const lineas = ['Tipo,Fecha,Hora,Cliente,Telefono,Concepto,Metodo,VIP,Monto'];
  for (const c of citas) {
    lineas.push([
      'Ingreso', c.fecha, minutosAHora(c.inicio_min), c.cliente_nombre, c.cliente_telefono,
      c.servicio_nombre, c.metodo_pago, c.es_vip ? 'Si' : 'No', c.precio.toFixed(2),
    ].map(csvCelda).join(','));
  }
  for (const g of gastos) {
    lineas.push([
      'Gasto', g.fecha, '', '', '', `${g.categoria}: ${g.concepto}`, g.metodo_pago, '', (-g.monto).toFixed(2),
    ].map(csvCelda).join(','));
  }
  return new Response(`﻿${lineas.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="el-anexo-finanzas-${mes}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ---------- Gastos ----------

async function crearGasto(cuerpo) {
  const fecha = cuerpo.fecha || ahoraGT().fecha;
  if (!esFechaValida(fecha)) throw new ErrorHttp(400, 'Fecha no válida.');
  const concepto = limpiarTexto(cuerpo.concepto, 120);
  if (concepto.length < 2) throw new ErrorHttp(400, 'Describe el gasto.');
  const monto = aMonto(cuerpo.monto);
  if (!monto || monto <= 0) throw new ErrorHttp(400, 'Monto no válido.');
  const metodo = ['efectivo', 'tarjeta', 'transferencia'].includes(cuerpo.metodo_pago) ? cuerpo.metodo_pago : 'efectivo';
  const categoria = limpiarTexto(cuerpo.categoria || 'General', 40) || 'General';
  return una(
    'INSERT INTO gastos (fecha, concepto, categoria, monto, metodo_pago) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [fecha, concepto, categoria, monto, metodo],
  );
}

async function eliminarGasto(id) {
  await consulta('DELETE FROM gastos WHERE id = $1', [id]);
  return { ok: true };
}

// ---------- Horario ----------

function validarRangos(lista) {
  if (!Array.isArray(lista)) throw new ErrorHttp(400, 'Rangos no válidos.');
  const rangos = lista.map((r) => ({
    inicio: typeof r.inicio === 'string' ? horaAMinutos(r.inicio) : aEntero(r.inicio),
    fin: typeof r.fin === 'string' ? horaAMinutos(r.fin) : aEntero(r.fin),
  }));
  for (const r of rangos) {
    if (r.inicio === null || r.fin === null || r.fin <= r.inicio) {
      throw new ErrorHttp(400, 'Cada rango necesita una hora de inicio menor a la de fin.');
    }
  }
  rangos.sort((a, b) => a.inicio - b.inicio);
  for (let i = 1; i < rangos.length; i += 1) {
    if (rangos[i].inicio < rangos[i - 1].fin) throw new ErrorHttp(400, 'Hay rangos que se traslapan.');
  }
  return rangos;
}

async function obtenerHorario() {
  const hoy = ahoraGT().fecha;
  const [semanal, especiales, bloqueos] = await Promise.all([
    consulta('SELECT dia, inicio_min, fin_min FROM horario_semanal ORDER BY dia, inicio_min'),
    consulta('SELECT fecha, cerrado, rangos, nota FROM dias_especiales WHERE fecha >= $1 ORDER BY fecha', [hoy]),
    consulta('SELECT id, fecha, inicio_min, fin_min, motivo FROM bloqueos WHERE fecha >= $1 ORDER BY fecha, inicio_min', [hoy]),
  ]);
  const semana = Array.from({ length: 7 }, (_, dia) => ({
    dia,
    rangos: semanal.filter((s) => s.dia === dia).map((s) => ({ inicio: s.inicio_min, fin: s.fin_min })),
  }));
  return { semana, especiales, bloqueos };
}

async function guardarSemana(cuerpo) {
  if (!Array.isArray(cuerpo.semana) || cuerpo.semana.length !== 7) {
    throw new ErrorHttp(400, 'Envía los 7 días de la semana.');
  }
  const limpios = cuerpo.semana.map((d, i) => ({ dia: i, rangos: validarRangos(d.rangos || []) }));
  await transaccion(async (tx) => {
    await tx.consulta('DELETE FROM horario_semanal');
    for (const d of limpios) {
      for (const r of d.rangos) {
        await tx.consulta('INSERT INTO horario_semanal (dia, inicio_min, fin_min) VALUES ($1, $2, $3)', [d.dia, r.inicio, r.fin]);
      }
    }
  });
  return obtenerHorario();
}

async function guardarDiaEspecial(cuerpo) {
  if (!esFechaValida(cuerpo.fecha)) throw new ErrorHttp(400, 'Fecha no válida.');
  const cerrado = Boolean(cuerpo.cerrado);
  const rangos = cerrado ? [] : validarRangos(cuerpo.rangos || []);
  if (!cerrado && rangos.length === 0) throw new ErrorHttp(400, 'Agrega al menos un rango o marca el día como cerrado.');
  const nota = limpiarTexto(cuerpo.nota || '', 120);
  await consulta(
    `INSERT INTO dias_especiales (fecha, cerrado, rangos, nota) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (fecha) DO UPDATE SET cerrado = EXCLUDED.cerrado, rangos = EXCLUDED.rangos, nota = EXCLUDED.nota`,
    [cuerpo.fecha, cerrado, JSON.stringify(rangos), nota],
  );
  const conflictos = await consulta(
    "SELECT COUNT(*)::int AS n FROM citas WHERE fecha = $1 AND estado = 'pendiente'",
    [cuerpo.fecha],
  );
  return { ...(await obtenerHorario()), citas_en_fecha: conflictos[0].n };
}

async function eliminarDiaEspecial(url) {
  const fecha = url.searchParams.get('fecha');
  if (!esFechaValida(fecha)) throw new ErrorHttp(400, 'Fecha no válida.');
  await consulta('DELETE FROM dias_especiales WHERE fecha = $1', [fecha]);
  return obtenerHorario();
}

async function crearBloqueo(cuerpo) {
  if (!esFechaValida(cuerpo.fecha)) throw new ErrorHttp(400, 'Fecha no válida.');
  const [r] = validarRangos([{ inicio: cuerpo.inicio, fin: cuerpo.fin }]);
  const choques = await consulta(
    `${SELECT_CITA} WHERE c.fecha = $1 AND c.estado <> 'cancelada' AND c.inicio_min < $3 AND c.fin_min > $2`,
    [cuerpo.fecha, r.inicio, r.fin],
  );
  if (choques.length) {
    const nombres = choques.map((c) => `${minutosAHora(c.inicio_min)} ${c.cliente_nombre}`).join(', ');
    throw new ErrorHttp(409, `Ese rango tiene citas agendadas (${nombres}). Muévelas o cancélalas primero.`);
  }
  await consulta(
    'INSERT INTO bloqueos (fecha, inicio_min, fin_min, motivo) VALUES ($1, $2, $3, $4)',
    [cuerpo.fecha, r.inicio, r.fin, limpiarTexto(cuerpo.motivo || '', 80)],
  );
  return obtenerHorario();
}

async function eliminarBloqueo(id) {
  await consulta('DELETE FROM bloqueos WHERE id = $1', [id]);
  return obtenerHorario();
}

// ---------- Servicios ----------

async function listarServicios() {
  return { servicios: await consulta('SELECT * FROM servicios ORDER BY orden, id') };
}

function validarServicio(cuerpo, actual = {}) {
  const nombre = cuerpo.nombre !== undefined ? limpiarTexto(cuerpo.nombre, 80) : actual.nombre;
  if (!nombre || nombre.length < 3) throw new ErrorHttp(400, 'El servicio necesita un nombre.');
  const descripcion = cuerpo.descripcion !== undefined ? limpiarTexto(cuerpo.descripcion, 500) : actual.descripcion || '';
  const duracion = cuerpo.duracion_min !== undefined ? aEntero(cuerpo.duracion_min) : actual.duracion_min;
  if (!duracion || duracion < 5 || duracion > 480) throw new ErrorHttp(400, 'Duración no válida (5 a 480 minutos).');
  const precio = cuerpo.precio !== undefined ? aMonto(cuerpo.precio) : actual.precio;
  if (precio === null || precio === undefined) throw new ErrorHttp(400, 'Precio no válido.');
  const activo = cuerpo.activo !== undefined ? Boolean(cuerpo.activo) : actual.activo !== false;
  const orden = cuerpo.orden !== undefined ? aEntero(cuerpo.orden) || 0 : actual.orden || 0;
  return { nombre, descripcion, duracion, precio, activo, orden };
}

async function crearServicio(cuerpo) {
  const s = validarServicio(cuerpo);
  await consulta(
    'INSERT INTO servicios (nombre, descripcion, duracion_min, precio, activo, orden) VALUES ($1, $2, $3, $4, $5, $6)',
    [s.nombre, s.descripcion, s.duracion, s.precio, s.activo, s.orden],
  );
  return listarServicios();
}

async function actualizarServicio(id, cuerpo) {
  const actual = await una('SELECT * FROM servicios WHERE id = $1', [id]);
  if (!actual) throw new ErrorHttp(404, 'Servicio no encontrado.');
  const s = validarServicio(cuerpo, actual);
  await consulta(
    `UPDATE servicios SET nombre = $1, descripcion = $2, duracion_min = $3, precio = $4, activo = $5, orden = $6
     WHERE id = $7`,
    [s.nombre, s.descripcion, s.duracion, s.precio, s.activo, s.orden, id],
  );
  return listarServicios();
}

// ---------- Configuracion ----------

const CLAVES_EDITABLES = {
  negocio_nombre: (v) => limpiarTexto(v, 60),
  barbero_nombre: (v) => limpiarTexto(v, 60),
  direccion: (v) => limpiarTexto(v, 160),
  whatsapp: (v) => normalizarTelefono(v),
  intervalo_min: (v) => ([10, 15, 20, 30, 45, 60].includes(aEntero(v)) ? String(aEntero(v)) : null),
  anticipacion_min: (v) => (aEntero(v) >= 0 && aEntero(v) <= 1440 ? String(aEntero(v)) : null),
  dias_adelanto: (v) => (aEntero(v) >= 1 && aEntero(v) <= 60 ? String(aEntero(v)) : null),
  horas_cancelacion: (v) => (aEntero(v) >= 0 && aEntero(v) <= 72 ? String(aEntero(v)) : null),
  instagram: (v) => (/^https:\/\/\S+$/.test(String(v)) ? String(v) : null),
  facebook: (v) => (/^https:\/\/\S+$/.test(String(v)) ? String(v) : null),
};

async function guardarConfiguracion(cuerpo) {
  for (const [clave, valor] of Object.entries(cuerpo || {})) {
    const validar = CLAVES_EDITABLES[clave];
    if (!validar) continue;
    const limpio = validar(valor);
    if (limpio === null || limpio === '') throw new ErrorHttp(400, `Valor no válido para ${clave}.`);
    await consulta(
      'INSERT INTO configuracion (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor',
      [clave, limpio],
    );
  }
  return { config: await obtenerConfiguracion() };
}

// ---------- Tabla de rutas ----------

const admin = (fn) => async (req, url, cuerpo, params) => {
  exigirAdmin(req);
  return fn(req, url, cuerpo, params);
};

export const rutasAdmin = [
  ['POST', /^admin\/login$/, (req, url, cuerpo) => login(cuerpo)],
  ['GET', /^admin\/agenda$/, admin((req, url) => agendaDia(url))],
  ['GET', /^admin\/mes$/, admin((req, url) => agendaMes(url))],
  ['GET', /^admin\/libres$/, admin((req, url) => horariosLibres(url))],
  ['POST', /^admin\/citas$/, admin((req, url, cuerpo) => crearCitaAdmin(cuerpo))],
  ['PATCH', /^admin\/citas\/(\d+)$/, admin((req, url, cuerpo, p) => actualizarCita(Number(p[1]), cuerpo))],
  ['GET', /^admin\/clientes$/, admin((req, url) => listarClientes(url))],
  ['GET', /^admin\/clientes\/(\d+)$/, admin((req, url, cuerpo, p) => detalleCliente(Number(p[1])))],
  ['PATCH', /^admin\/clientes\/(\d+)$/, admin((req, url, cuerpo, p) => actualizarCliente(Number(p[1]), cuerpo))],
  ['GET', /^admin\/finanzas$/, admin((req, url) => finanzas(url))],
  ['GET', /^admin\/finanzas\/mes$/, admin((req, url) => finanzasMes(url))],
  ['GET', /^admin\/finanzas\/exportar$/, admin((req, url) => exportarMes(url))],
  ['POST', /^admin\/gastos$/, admin((req, url, cuerpo) => crearGasto(cuerpo))],
  ['DELETE', /^admin\/gastos\/(\d+)$/, admin((req, url, cuerpo, p) => eliminarGasto(Number(p[1])))],
  ['GET', /^admin\/horario$/, admin(() => obtenerHorario())],
  ['PUT', /^admin\/horario\/semana$/, admin((req, url, cuerpo) => guardarSemana(cuerpo))],
  ['PUT', /^admin\/horario\/especial$/, admin((req, url, cuerpo) => guardarDiaEspecial(cuerpo))],
  ['DELETE', /^admin\/horario\/especial$/, admin((req, url) => eliminarDiaEspecial(url))],
  ['POST', /^admin\/horario\/bloqueos$/, admin((req, url, cuerpo) => crearBloqueo(cuerpo))],
  ['DELETE', /^admin\/horario\/bloqueos\/(\d+)$/, admin((req, url, cuerpo, p) => eliminarBloqueo(Number(p[1])))],
  ['GET', /^admin\/servicios$/, admin(() => listarServicios())],
  ['POST', /^admin\/servicios$/, admin((req, url, cuerpo) => crearServicio(cuerpo))],
  ['PATCH', /^admin\/servicios\/(\d+)$/, admin((req, url, cuerpo, p) => actualizarServicio(Number(p[1]), cuerpo))],
  ['GET', /^admin\/config$/, admin(async () => ({ config: await obtenerConfiguracion() }))],
  ['PUT', /^admin\/config$/, admin((req, url, cuerpo) => guardarConfiguracion(cuerpo))],
];
