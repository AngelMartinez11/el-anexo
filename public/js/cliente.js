// Sitio de clientes: servicios, reserva en tres pasos, sesion con PIN y mis citas.
(function () {
  'use strict';
  const A = window.Anexo;
  const CLAVE_TOKEN = 'anexo_cliente_token';
  const CLAVE_CLIENTE = 'anexo_cliente_datos';

  const estado = {
    info: null,
    servicio: null,
    dias: [],
    fecha: null,
    inicio: null,
    token: A.leerToken(CLAVE_TOKEN),
    cliente: null,
    modoSesion: 'ingresar',
  };
  try { estado.cliente = JSON.parse(A.leerToken(CLAVE_CLIENTE) || 'null'); } catch (e) { estado.cliente = null; }
  if (!estado.token) estado.cliente = null;

  const $ = (id) => document.getElementById(id);

  // ---------- Carga inicial ----------

  async function iniciar() {
    pintarSesion();
    try {
      estado.info = await A.api('publico/info');
    } catch (error) {
      $('lista-servicios').innerHTML = '<li class="mensaje">' + A.esc(error.message) + '</li>';
      return;
    }
    const c = estado.info.config;
    $('dato-barbero').textContent = c.barbero_nombre;
    $('res-barbero').textContent = c.barbero_nombre;
    $('direccion').textContent = c.direccion;
    $('enlace-whatsapp').href = 'https://wa.me/502' + c.whatsapp;
    if (c.instagram) $('enlace-instagram').href = c.instagram;
    if (c.facebook) $('enlace-facebook').href = c.facebook;
    pintarServicios();
    pintarOpciones();
  }

  function pintarServicios() {
    const lista = estado.info.servicios;
    if (!lista.length) {
      $('lista-servicios').innerHTML = '<li class="texto-suave">Pronto publicaremos nuestros servicios.</li>';
      return;
    }
    $('lista-servicios').innerHTML = lista.map((s) => (
      '<li>' +
        '<div class="renglon"><span class="nombre">' + A.esc(s.nombre) + '</span>' +
        '<span class="puntos" aria-hidden="true"></span>' +
        '<span class="precio">' + A.quetzalesCorto(s.precio) + '</span></div>' +
        '<div class="detalle"><p>' + A.esc(s.descripcion) + '</p>' +
        '<span class="duracion">' + A.duracionTexto(s.duracion_min) + '</span></div>' +
      '</li>'
    )).join('');
  }

  function pintarOpciones() {
    $('opciones-servicio').innerHTML = estado.info.servicios.map((s) => (
      '<button type="button" class="opcion" aria-pressed="false" data-servicio="' + s.id + '">' +
        '<span><strong>' + A.esc(s.nombre) + '</strong><small>' + A.duracionTexto(s.duracion_min) + '</small></span>' +
        '<span class="monto">' + A.quetzalesCorto(s.precio) + '</span>' +
      '</button>'
    )).join('');
  }

  // ---------- Paso 1: servicio ----------

  $('opciones-servicio').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-servicio]');
    if (!boton) return;
    const id = Number(boton.dataset.servicio);
    estado.servicio = estado.info.servicios.find((s) => s.id === id);
    document.querySelectorAll('#opciones-servicio .opcion').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.servicio) === id));
    });
    estado.inicio = null;
    $('paso-1').classList.add('completo');
    $('paso-2').classList.remove('bloqueado');
    actualizarResumen();
    cargarDias();
  });

  // ---------- Paso 2: dia y hora ----------

  async function cargarDias() {
    $('tira-dias').innerHTML = '<span class="texto-suave">Buscando días disponibles...</span>';
    $('zona-horas').innerHTML = '';
    try {
      const r = await A.api('publico/dias?servicio=' + estado.servicio.id);
      estado.dias = r.dias;
    } catch (error) {
      $('tira-dias').innerHTML = '<span class="mensaje">' + A.esc(error.message) + '</span>';
      return;
    }
    const sigueDisponible = estado.dias.find((d) => d.fecha === estado.fecha && d.libres > 0);
    if (!sigueDisponible) {
      const primero = estado.dias.find((d) => d.libres > 0);
      estado.fecha = primero ? primero.fecha : null;
    }
    pintarDias();
    if (estado.fecha) {
      cargarHoras();
    } else {
      $('zona-horas').innerHTML = '<div class="sin-horas">No hay horarios disponibles en los próximos días. Escríbenos por WhatsApp para buscarte un espacio.</div>';
    }
  }

  function pintarDias() {
    $('tira-dias').innerHTML = estado.dias.map((d) => {
      const f = A.fechaUTC(d.fecha);
      const sinEspacio = d.libres === 0;
      const etiqueta = A.fechaLarga(d.fecha) + (sinEspacio ? (d.abierto ? ', sin espacios' : ', cerrado') : '');
      return '<button type="button" class="dia" data-fecha="' + d.fecha + '" aria-pressed="' + (d.fecha === estado.fecha) + '"' +
        (sinEspacio ? ' disabled' : '') + ' aria-label="' + A.esc(etiqueta) + '">' +
        '<small>' + A.DIAS_CORTOS[f.getUTCDay()] + '</small><strong>' + f.getUTCDate() + '</strong></button>';
    }).join('');
    actualizarMesVisible();
    const elegido = $('tira-dias').querySelector('[aria-pressed="true"]');
    if (elegido) elegido.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function actualizarMesVisible() {
    const tira = $('tira-dias');
    const botones = Array.from(tira.querySelectorAll('.dia'));
    const visible = botones.find((b) => b.offsetLeft + b.offsetWidth > tira.scrollLeft) || botones[0];
    if (!visible) return;
    const f = A.fechaUTC(visible.dataset.fecha);
    const mes = A.MESES[f.getUTCMonth()];
    $('mes-visible').textContent = mes.charAt(0).toUpperCase() + mes.slice(1) + ' ' + f.getUTCFullYear();
    $('dias-atras').disabled = tira.scrollLeft <= 4;
    $('dias-adelante').disabled = tira.scrollLeft + tira.clientWidth >= tira.scrollWidth - 4;
  }

  $('tira-dias').addEventListener('scroll', actualizarMesVisible, { passive: true });
  $('dias-atras').addEventListener('click', () => $('tira-dias').scrollBy({ left: -280, behavior: 'smooth' }));
  $('dias-adelante').addEventListener('click', () => $('tira-dias').scrollBy({ left: 280, behavior: 'smooth' }));

  $('tira-dias').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-fecha]');
    if (!boton || boton.disabled) return;
    estado.fecha = boton.dataset.fecha;
    estado.inicio = null;
    $('tira-dias').querySelectorAll('.dia').forEach((b) => b.setAttribute('aria-pressed', String(b === boton)));
    actualizarResumen();
    cargarHoras();
  });

  async function cargarHoras() {
    const zona = $('zona-horas');
    zona.innerHTML = '<p class="texto-suave">Cargando horarios...</p>';
    let libres;
    try {
      const r = await A.api('publico/horarios?fecha=' + estado.fecha + '&servicio=' + estado.servicio.id);
      libres = r.libres;
    } catch (error) {
      zona.innerHTML = '<div class="mensaje">' + A.esc(error.message) + '</div>';
      return;
    }
    if (!libres.length) {
      zona.innerHTML = '<div class="sin-horas">Este día ya no tiene espacios. Elige otro día.</div>';
      return;
    }
    const grupos = [
      ['Mañana', libres.filter((m) => m < 720)],
      ['Tarde', libres.filter((m) => m >= 720 && m < 1080)],
      ['Noche', libres.filter((m) => m >= 1080)],
    ].filter((g) => g[1].length);
    zona.innerHTML = grupos.map(([titulo, horas]) => (
      '<div class="grupo-horas"><h4>' + titulo + '</h4><div class="horas">' +
      horas.map((m) => '<button type="button" class="hora" data-inicio="' + m + '" aria-pressed="' + (m === estado.inicio) + '">' + A.hora12(m) + '</button>').join('') +
      '</div></div>'
    )).join('');
  }

  $('zona-horas').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-inicio]');
    if (!boton) return;
    estado.inicio = Number(boton.dataset.inicio);
    $('zona-horas').querySelectorAll('.hora').forEach((b) => b.setAttribute('aria-pressed', String(b === boton)));
    $('paso-2').classList.add('completo');
    $('paso-3').classList.remove('bloqueado');
    actualizarResumen();
    if (window.matchMedia('(max-width: 860px)').matches) {
      $('paso-3').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  function actualizarResumen() {
    $('res-servicio').textContent = estado.servicio ? estado.servicio.nombre : 'Sin elegir';
    $('res-total').textContent = estado.servicio ? A.quetzalesCorto(estado.servicio.precio) : 'Q0';
    if (estado.fecha && estado.inicio !== null) {
      $('res-cuando').textContent = A.fechaLarga(estado.fecha) + ', ' + A.hora12(estado.inicio);
    } else if (estado.fecha) {
      $('res-cuando').textContent = A.fechaLarga(estado.fecha) + ', elige la hora';
    } else {
      $('res-cuando').textContent = 'Sin elegir';
    }
    if (estado.inicio === null) {
      $('paso-2').classList.remove('completo');
      $('paso-3').classList.add('bloqueado');
    }
  }

  // ---------- Paso 3: confirmar ----------

  $('r-crear-pin').addEventListener('change', (ev) => {
    $('campo-pin').classList.toggle('oculto', !ev.target.checked);
    if (ev.target.checked) $('r-pin').focus();
  });

  function mostrarError(id, texto) {
    const el = $(id);
    el.textContent = texto;
    el.classList.toggle('oculto', !texto);
  }

  $('form-datos').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('error-reserva', '');
    if (!estado.servicio || !estado.fecha || estado.inicio === null) {
      mostrarError('error-reserva', 'Elige servicio, día y hora antes de confirmar.');
      return;
    }
    const cuerpo = { servicio_id: estado.servicio.id, fecha: estado.fecha, inicio: estado.inicio };
    if (!estado.token) {
      cuerpo.nombre = $('r-nombre').value.trim();
      cuerpo.telefono = $('r-telefono').value.trim();
      if (cuerpo.nombre.length < 3) return mostrarError('error-reserva', 'Escribe tu nombre completo.');
      if (cuerpo.telefono.replace(/\D/g, '').length < 8) return mostrarError('error-reserva', 'Escribe tu número de WhatsApp de 8 dígitos.');
      if ($('r-crear-pin').checked) {
        cuerpo.pin = $('r-pin').value.trim();
        if (!/^\d{4,6}$/.test(cuerpo.pin)) return mostrarError('error-reserva', 'El PIN debe tener de 4 a 6 números.');
      }
    }
    const boton = $('btn-confirmar');
    boton.disabled = true;
    boton.textContent = 'Confirmando...';
    try {
      const r = await A.api('publico/reservar', { metodo: 'POST', cuerpo, token: estado.token });
      if (r.token) guardarSesion(r.token, r.cliente);
      mostrarConfirmacion(r);
    } catch (error) {
      if (error.estado === 401) {
        cerrarSesion();
        mostrarError('error-reserva', 'Tu sesión expiró. Ingresa tus datos o inicia sesión de nuevo.');
      } else {
        mostrarError('error-reserva', error.message);
      }
      if (error.codigo === 'ocupado') cargarHoras();
    } finally {
      boton.disabled = false;
      boton.textContent = 'Confirmar cita';
    }
  });

  function mostrarConfirmacion(r) {
    const c = r.cita;
    $('conf-detalle').textContent = c.servicio_nombre + ' el ' + A.fechaLarga(c.fecha) + ' a las ' +
      A.hora12(c.inicio_min) + ' con ' + estado.info.config.barbero_nombre + '. Total ' + A.quetzalesCorto(c.precio) + '.';
    let extra = 'El día de tu cita te enviaremos un recordatorio por WhatsApp.';
    if (r.aviso) extra = r.aviso;
    else if (r.token) extra = 'Listo, tu PIN quedó guardado. La próxima vez solo inicia sesión y elige día y hora.';
    $('conf-extra').textContent = extra;
    $('flujo-reserva').classList.add('oculto');
    $('confirmacion').classList.remove('oculto');
    $('confirmacion').focus();
    $('agendar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('btn-otra').addEventListener('click', () => {
    estado.inicio = null;
    $('confirmacion').classList.add('oculto');
    $('flujo-reserva').classList.remove('oculto');
    $('form-datos').reset();
    $('campo-pin').classList.add('oculto');
    actualizarResumen();
    if (estado.servicio) cargarDias();
  });

  // ---------- Sesion ----------

  function guardarSesion(token, cliente) {
    estado.token = token;
    estado.cliente = cliente;
    A.guardarToken(CLAVE_TOKEN, token);
    A.guardarToken(CLAVE_CLIENTE, JSON.stringify(cliente));
    pintarSesion();
  }

  function cerrarSesion() {
    estado.token = null;
    estado.cliente = null;
    A.guardarToken(CLAVE_TOKEN, null);
    A.guardarToken(CLAVE_CLIENTE, null);
    pintarSesion();
  }

  function pintarSesion() {
    const activa = Boolean(estado.token && estado.cliente);
    $('btn-ingresar').classList.toggle('oculto', activa);
    $('sesion-activa').classList.toggle('oculto', !activa);
    $('datos-invitado').classList.toggle('oculto', activa);
    $('datos-sesion').classList.toggle('oculto', !activa);
    $('titulo-paso-3').textContent = activa ? 'Confirmar' : 'Tus datos';
    if (activa) {
      $('nombre-sesion').textContent = estado.cliente.nombre;
      $('telefono-sesion').textContent = A.telefonoBonito(estado.cliente.telefono);
      $('texto-agendar').textContent = 'Hola, ' + estado.cliente.nombre.split(' ')[0] + '. Elige servicio, día y hora y listo.';
    } else {
      $('texto-agendar').textContent = 'Elige el servicio, el día y la hora. Te confirmamos al instante.';
    }
  }

  document.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  function cambiarPestana(modo) {
    estado.modoSesion = modo;
    document.querySelectorAll('[data-pestana]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pestana === modo)));
    $('campo-nombre-cuenta').classList.toggle('oculto', modo !== 'crear');
    $('s-pin-label').textContent = modo === 'crear' ? 'Crea un PIN de 4 a 6 números' : 'PIN';
    $('s-pin').autocomplete = modo === 'crear' ? 'new-password' : 'current-password';
    $('btn-sesion').textContent = modo === 'crear' ? 'Crear cuenta' : 'Iniciar sesión';
    mostrarError('error-sesion', '');
  }

  document.querySelectorAll('[data-pestana]').forEach((b) => b.addEventListener('click', () => cambiarPestana(b.dataset.pestana)));

  $('btn-ingresar').addEventListener('click', () => {
    cambiarPestana('ingresar');
    $('dlg-sesion').showModal();
    $('s-telefono').focus();
  });

  $('form-sesion').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('error-sesion', '');
    const cuerpo = { telefono: $('s-telefono').value.trim(), pin: $('s-pin').value.trim() };
    if (estado.modoSesion === 'crear') cuerpo.nombre = $('s-nombre').value.trim();
    if (!/^\d{4,6}$/.test(cuerpo.pin)) return mostrarError('error-sesion', 'El PIN debe tener de 4 a 6 números.');
    const boton = $('btn-sesion');
    boton.disabled = true;
    try {
      const ruta = estado.modoSesion === 'crear' ? 'cliente/registro' : 'cliente/login';
      const r = await A.api(ruta, { metodo: 'POST', cuerpo });
      guardarSesion(r.token, r.cliente);
      $('dlg-sesion').close();
      $('form-sesion').reset();
      A.aviso('Hola, ' + r.cliente.nombre.split(' ')[0] + '. Ya puedes agendar más rápido.');
    } catch (error) {
      mostrarError('error-sesion', error.message);
    } finally {
      boton.disabled = false;
    }
  });

  $('btn-salir').addEventListener('click', () => {
    cerrarSesion();
    A.aviso('Cerraste sesión.');
  });

  // ---------- Mis citas ----------

  const NOMBRE_ESTADO = { pendiente: 'Pendiente', completada: 'Atendida', cancelada: 'Cancelada', no_asistio: 'No asistió' };

  async function cargarMisCitas() {
    const zona = $('contenido-citas');
    zona.innerHTML = '<p class="texto-suave">Cargando...</p>';
    let r;
    try {
      r = await A.api('cliente/citas', { token: estado.token });
    } catch (error) {
      if (error.estado === 401 || error.estado === 403) {
        cerrarSesion();
        $('dlg-citas').close();
        A.aviso(error.message);
        return;
      }
      zona.innerHTML = '<div class="mensaje">' + A.esc(error.message) + '</div>';
      return;
    }
    const horas = estado.info ? estado.info.config.horas_cancelacion : 2;
    let html = '<h4 style="margin:0 0 10px">Próximas</h4>';
    if (!r.proximas.length) {
      html += '<p class="texto-suave">No tienes citas pendientes.</p>';
    } else {
      html += '<div class="lista-citas">' + r.proximas.map((c) => (
        '<div class="cita-cliente"><div><div class="cuando">' + A.esc(A.fechaLarga(c.fecha)) + ', ' + A.hora12(c.inicio_min) + '</div>' +
        '<span class="texto-suave">' + A.esc(c.servicio) + ', ' + A.quetzalesCorto(c.precio) + '</span></div>' +
        (c.cancelable
          ? '<button type="button" class="boton boton-secundario boton-chico" data-cancelar="' + c.id + '">Cancelar</button>'
          : '<small class="texto-suave">Para cancelar escríbenos por WhatsApp</small>') +
        '</div>'
      )).join('') + '</div>';
      html += '<p class="texto-suave" style="font-size:0.85rem">Puedes cancelar hasta ' + horas + ' horas antes de tu cita.</p>';
    }
    if (r.historial.length) {
      html += '<h4 style="margin:22px 0 10px">Historial</h4><div class="lista-citas">' + r.historial.slice(0, 10).map((c) => (
        '<div class="cita-cliente"><div><strong>' + A.esc(A.fechaLarga(c.fecha)) + '</strong><br>' +
        '<span class="texto-suave">' + A.esc(c.servicio) + '</span></div>' +
        '<span class="etiqueta ' + c.estado + '">' + NOMBRE_ESTADO[c.estado] + '</span></div>'
      )).join('') + '</div>';
    }
    zona.innerHTML = html;
  }

  $('btn-mis-citas').addEventListener('click', () => {
    $('dlg-citas').showModal();
    cargarMisCitas();
  });

  $('contenido-citas').addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-cancelar]');
    if (!boton) return;
    if (boton.dataset.confirmar !== 'si') {
      boton.dataset.confirmar = 'si';
      boton.textContent = 'Confirmar cancelación';
      return;
    }
    boton.disabled = true;
    try {
      await A.api('cliente/cancelar', { metodo: 'POST', cuerpo: { cita_id: Number(boton.dataset.cancelar) }, token: estado.token });
      A.aviso('Cita cancelada. El horario quedó libre.');
      cargarMisCitas();
      if (estado.servicio) cargarDias();
    } catch (error) {
      A.aviso(error.message);
      boton.disabled = false;
    }
  });

  iniciar();
})();
