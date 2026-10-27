// Pruebas de la API completa contra PostgreSQL en memoria.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { nuevaBase, llamar, proximoDiaHabil, proximoDomingo } from './apoyo.mjs';
import { ahoraGT, sumarDias, normalizarTelefono } from '../netlify/lib/utilidades.mjs';

let tokenAdmin;
const dia = proximoDiaHabil(2);

before(async () => {
  await nuevaBase();
});

test('normaliza telefonos de Guatemala', () => {
  assert.equal(normalizarTelefono('3004-6246'), '30046246');
  assert.equal(normalizarTelefono('+502 3004 6246'), '30046246');
  assert.equal(normalizarTelefono('1234567'), null);
  assert.equal(normalizarTelefono('12345678'), null);
});

test('info publica trae servicios y datos del negocio', async () => {
  const r = await llamar('GET', 'publico/info');
  assert.equal(r.estado, 200);
  assert.equal(r.datos.servicios.length, 2);
  assert.equal(r.datos.servicios[0].precio, 50);
  assert.equal(r.datos.config.barbero_nombre, 'Eduardo González');
  assert.equal(r.datos.config.anticipacion_min, undefined, 'no expone claves internas');
});

test('horarios: dia habil tiene bloques de 30 min y domingo esta cerrado', async () => {
  const r = await llamar('GET', `publico/horarios?fecha=${dia}&servicio=1`);
  assert.equal(r.estado, 200);
  assert.equal(r.datos.libres[0], 660);
  assert.equal(r.datos.libres.length, 20); // 11:00 a 20:30
  const largo = await llamar('GET', `publico/horarios?fecha=${dia}&servicio=2`);
  assert.equal(largo.datos.libres.at(-1), 1200); // el servicio de 1 h empieza a mas tardar 20:00
  const dom = await llamar('GET', `publico/horarios?fecha=${proximoDomingo()}&servicio=1`);
  assert.deepEqual(dom.datos.libres, []);
  const pasado = await llamar('GET', `publico/horarios?fecha=${sumarDias(ahoraGT().fecha, -1)}&servicio=1`);
  assert.deepEqual(pasado.datos.libres, []);
});

test('resumen de dias marca domingos cerrados', async () => {
  const r = await llamar('GET', 'publico/dias?servicio=1');
  assert.equal(r.estado, 200);
  assert.equal(r.datos.dias.length, 31);
  const domingo = r.datos.dias.find((d) => d.fecha === proximoDomingo());
  assert.equal(domingo.abierto, false);
});

test('reserva de invitado y bloqueo de horario doble', async () => {
  const r = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'Angel Martínez', telefono: '5555-1234', servicio_id: 1, fecha: dia, inicio: 720 },
  });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.cita.precio, 50);
  assert.equal(r.datos.token, null);

  const doble = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'Otro Cliente', telefono: '44445555', servicio_id: 1, fecha: dia, inicio: 720 },
  });
  assert.equal(doble.estado, 409);

  // El servicio de 1 hora a las 11:30 chocaria con la cita de las 12:00.
  const traslape = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'Otro Cliente', telefono: '44445555', servicio_id: 2, fecha: dia, inicio: 690 },
  });
  assert.equal(traslape.estado, 409);

  const libres = await llamar('GET', `publico/horarios?fecha=${dia}&servicio=1`);
  assert.ok(!libres.datos.libres.includes(720));
});

test('validaciones de la reserva', async () => {
  const sinNombre = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'A', telefono: '55551234', servicio_id: 1, fecha: dia, inicio: 780 },
  });
  assert.equal(sinNombre.estado, 400);
  const telMalo = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'Pedro Pérez', telefono: '123', servicio_id: 1, fecha: dia, inicio: 780 },
  });
  assert.equal(telMalo.estado, 400);
  const fueraHorario = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'Pedro Pérez', telefono: '33332222', servicio_id: 1, fecha: dia, inicio: 600 },
  });
  assert.equal(fueraHorario.estado, 409);
});

test('crear PIN al reservar, iniciar sesion y reservar rapido', async () => {
  const r = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'Carlos López', telefono: '42424242', servicio_id: 2, fecha: dia, inicio: 900, pin: '1234' },
  });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.ok(r.datos.token);

  const malo = await llamar('POST', 'cliente/login', { cuerpo: { telefono: '42424242', pin: '9999' } });
  assert.equal(malo.estado, 401);

  const ok = await llamar('POST', 'cliente/login', { cuerpo: { telefono: '4242-4242', pin: '1234' } });
  assert.equal(ok.estado, 200);
  const token = ok.datos.token;

  const rapida = await llamar('POST', 'publico/reservar', {
    token, cuerpo: { servicio_id: 1, fecha: proximoDiaHabil(9), inicio: 660 },
  });
  assert.equal(rapida.estado, 200, JSON.stringify(rapida.datos));

  const tercera = await llamar('POST', 'publico/reservar', {
    token, cuerpo: { servicio_id: 1, fecha: proximoDiaHabil(16), inicio: 660 },
  });
  assert.equal(tercera.estado, 409, 'limite de 2 citas pendientes por cliente');

  const mis = await llamar('GET', 'cliente/citas', { token });
  assert.equal(mis.estado, 200);
  assert.equal(mis.datos.proximas.length, 2);
  assert.equal(mis.datos.proximas[0].cancelable, true);

  const cancel = await llamar('POST', 'cliente/cancelar', { token, cuerpo: { cita_id: mis.datos.proximas[1].id } });
  assert.equal(cancel.estado, 200);
  const despues = await llamar('GET', 'cliente/citas', { token });
  assert.equal(despues.datos.proximas.length, 1);
});

test('registro solo si el numero no tiene PIN', async () => {
  const dup = await llamar('POST', 'cliente/registro', { cuerpo: { nombre: 'Carlos López', telefono: '42424242', pin: '5555' } });
  assert.equal(dup.estado, 409);
  const nuevo = await llamar('POST', 'cliente/registro', { cuerpo: { nombre: 'Luis Ruiz', telefono: '31313131', pin: '4321' } });
  assert.equal(nuevo.estado, 200);
  assert.ok(nuevo.datos.token);
});

test('login de administrador y limite de intentos', async () => {
  const malo = await llamar('POST', 'admin/login', { cuerpo: { password: 'incorrecta' } });
  assert.equal(malo.estado, 401);
  const ok = await llamar('POST', 'admin/login', { cuerpo: { password: 'clave-admin-123' } });
  assert.equal(ok.estado, 200);
  tokenAdmin = ok.datos.token;
  const sinToken = await llamar('GET', 'admin/agenda');
  assert.equal(sinToken.estado, 401);
});

test('agenda del dia muestra citas con nombre', async () => {
  const r = await llamar('GET', `admin/agenda?fecha=${dia}`, { token: tokenAdmin });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.citas.length, 2);
  assert.equal(r.datos.citas[0].cliente_nombre, 'Angel Martínez');
  assert.deepEqual(r.datos.rangos, [{ inicio: 660, fin: 1260 }]);
  const mes = await llamar('GET', `admin/mes?mes=${dia.slice(0, 7)}`, { token: tokenAdmin });
  assert.equal(mes.estado, 200);
  assert.ok(mes.datos.conteos.some((c) => c.fecha === dia && c.citas === 2));
});

test('cita VIP con precio ajustado, fuera de horario y cobro', async () => {
  const fuera = await llamar('POST', 'admin/citas', {
    token: tokenAdmin,
    cuerpo: { nombre: 'Cliente VIP', telefono: '50505050', servicio_id: 2, fecha: dia, inicio: '21:00', precio: 150, es_vip: true },
  });
  assert.equal(fuera.estado, 409, 'sin forzar no permite fuera de horario');
  const vip = await llamar('POST', 'admin/citas', {
    token: tokenAdmin,
    cuerpo: { nombre: 'Cliente VIP', telefono: '50505050', servicio_id: 2, fecha: dia, inicio: '21:00', precio: 150, es_vip: true, forzar: true },
  });
  assert.equal(vip.estado, 200, JSON.stringify(vip.datos));
  assert.equal(vip.datos.precio, 150);
  assert.equal(vip.datos.es_vip, true);

  const choque = await llamar('POST', 'admin/citas', {
    token: tokenAdmin,
    cuerpo: { nombre: 'Otro', telefono: '50505051', servicio_id: 1, fecha: dia, inicio: '21:30', forzar: true },
  });
  assert.equal(choque.estado, 409, 'forzar no permite traslapes');

  const cobro = await llamar('PATCH', `admin/citas/${vip.datos.id}`, {
    token: tokenAdmin, cuerpo: { accion: 'cobrar', metodo_pago: 'tarjeta' },
  });
  assert.equal(cobro.estado, 200);
  assert.equal(cobro.datos.estado, 'completada');

  const agenda = await llamar('GET', `admin/agenda?fecha=${dia}`, { token: tokenAdmin });
  const angel = agenda.datos.citas.find((c) => c.cliente_nombre === 'Angel Martínez');
  const efectivo = await llamar('PATCH', `admin/citas/${angel.id}`, {
    token: tokenAdmin, cuerpo: { accion: 'cobrar', metodo_pago: 'efectivo' },
  });
  assert.equal(efectivo.estado, 200);
  const rec = await llamar('PATCH', `admin/citas/${angel.id}`, { token: tokenAdmin, cuerpo: { accion: 'recordatorio' } });
  assert.equal(rec.datos.recordatorio_enviado, true);
  const carlos = agenda.datos.citas.find((c) => c.cliente_nombre === 'Carlos López');
  const ns = await llamar('PATCH', `admin/citas/${carlos.id}`, { token: tokenAdmin, cuerpo: { accion: 'no_asistio' } });
  assert.equal(ns.datos.estado, 'no_asistio');
});

test('registro de cliente atendido sin cita (walk-in) queda cobrado', async () => {
  const hoy = ahoraGT().fecha;
  const r = await llamar('POST', 'admin/citas', {
    token: tokenAdmin,
    cuerpo: { nombre: 'Walk In', telefono: '60606060', servicio_id: 1, fecha: hoy, inicio: '01:00', forzar: true, metodo_pago: 'efectivo' },
  });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.estado, 'completada');
});

test('finanzas del dia, mes actual y gastos', async () => {
  const gasto = await llamar('POST', 'admin/gastos', {
    token: tokenAdmin, cuerpo: { fecha: dia, concepto: 'Navajas', categoria: 'Insumos', monto: 30 },
  });
  assert.equal(gasto.estado, 200);
  const r = await llamar('GET', `admin/finanzas?fecha=${dia}`, { token: tokenAdmin });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.dia.ingresos, 200);
  assert.equal(r.datos.dia.efectivo, 50);
  assert.equal(r.datos.dia.tarjeta, 150);
  assert.equal(r.datos.dia.gastos, 30);
  assert.equal(r.datos.dia.neto, 170);
  assert.equal(r.datos.dia.caja_efectivo, 20);
  assert.equal(r.datos.dia.inasistencias, 1);
  assert.equal(r.datos.dia.citas.length, 2);
  assert.ok(r.datos.mes_actual.clave);
  assert.ok(r.datos.mes_pasado.clave);

  const csv = await llamar('GET', `admin/finanzas/exportar?mes=${dia.slice(0, 7)}`, { token: tokenAdmin });
  assert.equal(csv.estado, 200);
  assert.ok(csv.datos.includes('Cliente VIP'));
  assert.ok(csv.datos.includes('Insumos: Navajas'));
});

test('clientes: historial, bloqueo y restablecer PIN', async () => {
  const lista = await llamar('GET', 'admin/clientes?q=carlos', { token: tokenAdmin });
  assert.equal(lista.estado, 200);
  assert.equal(lista.datos.clientes.length, 1);
  const carlos = lista.datos.clientes[0];
  assert.equal(carlos.inasistencias, 1);

  const bloq = await llamar('PATCH', `admin/clientes/${carlos.id}`, {
    token: tokenAdmin, cuerpo: { bloqueado: true, motivo_bloqueo: 'No se presenta' },
  });
  assert.equal(bloq.estado, 200);
  assert.equal(bloq.datos.cliente.bloqueado, true);

  const intento = await llamar('POST', 'publico/reservar', {
    cuerpo: { nombre: 'Carlos López', telefono: '42424242', servicio_id: 1, fecha: proximoDiaHabil(23), inicio: 660 },
  });
  assert.equal(intento.estado, 403);
  const login = await llamar('POST', 'cliente/login', { cuerpo: { telefono: '42424242', pin: '1234' } });
  assert.equal(login.estado, 403);

  const reset = await llamar('PATCH', `admin/clientes/${carlos.id}`, {
    token: tokenAdmin, cuerpo: { bloqueado: false, restablecer_pin: true },
  });
  assert.equal(reset.datos.cliente.tiene_pin, false);
  const det = await llamar('GET', `admin/clientes/${carlos.id}`, { token: tokenAdmin });
  assert.ok(det.datos.citas.length >= 1);
});

test('horario: semana, dia especial y bloqueos', async () => {
  const h = await llamar('GET', 'admin/horario', { token: tokenAdmin });
  assert.equal(h.datos.semana.length, 7);
  const semana = h.datos.semana.map((d) => ({ dia: d.dia, rangos: d.rangos }));
  semana[0].rangos = [{ inicio: '09:00', fin: '13:00' }]; // abrir domingos por la manana
  const g = await llamar('PUT', 'admin/horario/semana', { token: tokenAdmin, cuerpo: { semana } });
  assert.equal(g.estado, 200, JSON.stringify(g.datos));
  const dom = await llamar('GET', `publico/horarios?fecha=${proximoDomingo()}&servicio=1`);
  assert.equal(dom.datos.libres[0], 540);

  const malo = await llamar('PUT', 'admin/horario/semana', {
    token: tokenAdmin,
    cuerpo: { semana: semana.map((d, i) => (i === 1 ? { ...d, rangos: [{ inicio: '10:00', fin: '12:00' }, { inicio: '11:00', fin: '13:00' }] } : d)) },
  });
  assert.equal(malo.estado, 400);

  const especialFecha = proximoDiaHabil(13);
  const esp = await llamar('PUT', 'admin/horario/especial', {
    token: tokenAdmin, cuerpo: { fecha: especialFecha, cerrado: true, nota: 'Feriado' },
  });
  assert.equal(esp.estado, 200);
  const cerrado = await llamar('GET', `publico/horarios?fecha=${especialFecha}&servicio=1`);
  assert.deepEqual(cerrado.datos.libres, []);

  const bloqueoChoque = await llamar('POST', 'admin/horario/bloqueos', {
    token: tokenAdmin, cuerpo: { fecha: dia, inicio: '21:00', fin: '22:00', motivo: 'x' },
  });
  assert.equal(bloqueoChoque.estado, 409, 'no permite bloquear sobre una cita');

  const bloq = await llamar('POST', 'admin/horario/bloqueos', {
    token: tokenAdmin, cuerpo: { fecha: dia, inicio: '13:00', fin: '14:00', motivo: 'Almuerzo' },
  });
  assert.equal(bloq.estado, 200, JSON.stringify(bloq.datos));
  const libres = await llamar('GET', `publico/horarios?fecha=${dia}&servicio=1`);
  assert.ok(!libres.datos.libres.includes(780));
  assert.ok(!libres.datos.libres.includes(810));
  assert.ok(libres.datos.libres.includes(840));
});

test('servicios y configuracion editables', async () => {
  const nuevo = await llamar('POST', 'admin/servicios', {
    token: tokenAdmin, cuerpo: { nombre: 'Tallado de barba', descripcion: 'Solo barba', duracion_min: 30, precio: 40, orden: 3 },
  });
  assert.equal(nuevo.estado, 200);
  assert.equal(nuevo.datos.servicios.length, 3);
  const id = nuevo.datos.servicios.find((s) => s.nombre === 'Tallado de barba').id;
  await llamar('PATCH', `admin/servicios/${id}`, { token: tokenAdmin, cuerpo: { activo: false } });
  const info = await llamar('GET', 'publico/info');
  assert.equal(info.datos.servicios.length, 2);

  const conf = await llamar('PUT', 'admin/config', { token: tokenAdmin, cuerpo: { horas_cancelacion: 3, whatsapp: '+502 3004-6246' } });
  assert.equal(conf.estado, 200);
  assert.equal(conf.datos.config.horas_cancelacion, 3);
  const malo = await llamar('PUT', 'admin/config', { token: tokenAdmin, cuerpo: { intervalo_min: 7 } });
  assert.equal(malo.estado, 400);
});
