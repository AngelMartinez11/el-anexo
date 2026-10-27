// Panel de administrador: agenda, clientes, finanzas, horario y ajustes.
(function () {
  'use strict';
  const A = window.Anexo;
  const CLAVE_TOKEN = 'anexo_admin_token';
  const $ = (id) => document.getElementById(id);
  const esc = A.esc;

  const estado = {
    token: A.leerToken(CLAVE_TOKEN),
    config: {},
    servicios: [],
    vista: 'agenda',
    fecha: A.hoyGT().fecha,
    mes: null,
    agenda: null,
    clienteElegido: null,
    modoCliente: 'buscar',
    citaEditando: null,
    clienteAbierto: null,
    mesReporte: null,
  };

  const NOMBRE_ESTADO = { pendiente: 'Pendiente', completada: 'Cobrada', cancelada: 'Cancelada', no_asistio: 'No asistió' };
  const NOMBRE_METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

  function mayuscula(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

  async function api(ruta, opciones = {}) {
    try {
      return await A.api(ruta, { ...opciones, token: estado.token });
    } catch (error) {
      if (error.estado === 401 && error.codigo === 'sesion') {
        salir();
        A.aviso('Tu sesión expiró. Vuelve a ingresar.');
      }
      throw error;
    }
  }

  function mostrarError(id, texto) {
    const el = $(id);
    if (!el) return;
    el.textContent = texto || '';
    el.classList.toggle('oculto', !texto);
  }

  // ---------- Acceso ----------

  function salir() {
    estado.token = null;
    A.guardarToken(CLAVE_TOKEN, null);
    $('vista-app').classList.add('oculto');
    $('vista-login').classList.remove('oculto');
  }

  $('form-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('error-login', '');
    try {
      const r = await A.api('admin/login', { metodo: 'POST', cuerpo: { password: $('l-password').value } });
      estado.token = r.token;
      A.guardarToken(CLAVE_TOKEN, r.token);
      $('l-password').value = '';
      iniciarApp();
    } catch (error) {
      mostrarError('error-login', error.message);
    }
  });

  $('btn-salir').addEventListener('click', salir);

  async function iniciarApp() {
    try {
      const [c, s] = await Promise.all([api('admin/config'), api('admin/servicios')]);
      estado.config = c.config;
      estado.servicios = s.servicios;
    } catch (error) {
      if (!estado.token) return;
      A.aviso(error.message);
      return;
    }
    $('vista-login').classList.add('oculto');
    $('vista-app').classList.remove('oculto');
    cambiarVista(estado.vista);
  }

  // ---------- Navegacion ----------

  document.querySelectorAll('[data-vista]').forEach((b) => b.addEventListener('click', () => cambiarVista(b.dataset.vista)));

  function cambiarVista(vista) {
    estado.vista = vista;
    document.querySelectorAll('[data-vista]').forEach((b) => {
      if (b.dataset.vista === vista) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-seccion]').forEach((s) => s.classList.toggle('oculto', s.id !== 'vista-' + vista));
    if (vista === 'agenda') cargarAgenda();
    if (vista === 'clientes') cargarClientes();
    if (vista === 'finanzas') cargarFinanzas();
    if (vista === 'horario') cargarHorario();
    if (vista === 'ajustes') pintarAjustes();
  }

  document.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ---------- WhatsApp ----------

  function mensajeRecordatorio(c) {
    const hoy = A.hoyGT().fecha;
    let dia;
    if (c.fecha === hoy) dia = 'Hoy';
    else if (c.fecha === A.sumarDias(hoy, 1)) dia = 'Mañana';
    else dia = mayuscula(A.DIAS[A.fechaUTC(c.fecha).getUTCDay()]);
    const lineas = [
      'Hola ' + c.cliente_nombre + '!',
      'Te queremos recordar tu cita de ' + c.servicio_nombre + ' Q ' + Number(c.precio).toFixed(2),
      '\u23F0\u00BFCuándo?: ' + dia + ' ' + A.fechaCorta(c.fecha) + ' a las ' + A.hora12(c.inicio_min),
      '\u{1F4CC} ¿Dónde?: ' + (estado.config.direccion || ''),
      '\u{1F60E} ¿Con quién?: ' + (estado.config.barbero_nombre || ''),
      '¡Te esperamos!',
      '¡Agradecemos mucho tu puntualidad para no tener inconvenientes y cumplir los tiempos de la agenda! En el Anexo el tiempo del cliente es una prioridad.',
    ];
    return lineas.join('\n');
  }

  function enlaceWhatsApp(telefono, texto) {
    // La pagina intermedia de wa.me / api.whatsapp.com corrompe los emojis del texto.
    // En celular se abre la app directo y en computadora WhatsApp Web directo.
    const movil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const base = movil ? 'whatsapp://send' : 'https://web.whatsapp.com/send';
    return base + '?phone=502' + telefono + (texto ? '&text=' + encodeURIComponent(texto) : '');
  }

  async function enviarRecordatorio(cita) {
    const texto = mensajeRecordatorio(cita);
    const enlace = enlaceWhatsApp(cita.cliente_telefono, texto);
    // Respaldo: el mensaje queda copiado por si el chat no lo muestra.
    if (navigator.clipboard) {
      navigator.clipboard.writeText(texto)
        .then(() => A.aviso('Mensaje copiado. Si no aparece en el chat, pégalo.'))
        .catch(() => {});
    }
    if (enlace.startsWith('whatsapp:')) window.location.href = enlace;
    else window.open(enlace, 'whatsapp-anexo', 'noopener');
    try {
      await api('admin/citas/' + cita.id, { metodo: 'PATCH', cuerpo: { accion: 'recordatorio' } });
      cita.recordatorio_enviado = true;
      pintarAgenda();
    } catch (error) {
      A.aviso(error.message);
    }
  }

  // ---------- Agenda ----------

  async function cargarAgenda() {
    $('linea-tiempo').innerHTML = '<p class="texto-suave" style="padding:16px 0">Cargando agenda...</p>';
    try {
      estado.agenda = await api('admin/agenda?fecha=' + estado.fecha);
    } catch (error) {
      $('linea-tiempo').innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
      return;
    }
    pintarAgenda();
    if (!$('calendario-mes').classList.contains('oculto')) cargarMes(estado.fecha.slice(0, 7));
  }

  function encabezadoDia() {
    const hoy = A.hoyGT().fecha;
    let titulo = mayuscula(A.fechaLarga(estado.fecha));
    if (estado.fecha === hoy) titulo = 'Hoy';
    else if (estado.fecha === A.sumarDias(hoy, 1)) titulo = 'Mañana';
    else if (estado.fecha === A.sumarDias(hoy, -1)) titulo = 'Ayer';
    $('titulo-dia').textContent = titulo;
    $('subtitulo-dia').textContent = titulo === mayuscula(A.fechaLarga(estado.fecha)) ? estado.fecha.slice(0, 4) : mayuscula(A.fechaLarga(estado.fecha));
  }

  function pintarAgenda() {
    const d = estado.agenda;
    if (!d) return;
    encabezadoDia();
    const activas = d.citas.filter((c) => c.estado !== 'cancelada');
    const canceladas = d.citas.filter((c) => c.estado === 'cancelada');
    const cobradas = activas.filter((c) => c.estado === 'completada');
    const pendientes = activas.filter((c) => c.estado === 'pendiente');
    const totalCobrado = cobradas.reduce((s, c) => s + Number(c.precio), 0);
    const porCobrar = pendientes.reduce((s, c) => s + Number(c.precio), 0);

    $('cifras-dia').innerHTML =
      '<div class="cifra"><span>Citas</span><strong>' + activas.length + '</strong></div>' +
      '<div class="cifra"><span>Atendidas</span><strong>' + cobradas.length + '</strong></div>' +
      '<div class="cifra destacada"><span>Cobrado</span><strong>' + A.quetzalesCorto(totalCobrado) + '</strong></div>' +
      '<div class="cifra"><span>Por cobrar</span><strong>' + A.quetzalesCorto(porCobrar) + '</strong></div>';

    // Recordatorios del dia de hoy.
    const hoy = A.hoyGT();
    const sinRecordar = d.fecha === hoy.fecha
      ? pendientes.filter((c) => !c.recordatorio_enviado && c.inicio_min > hoy.minutos)
      : [];
    if (sinRecordar.length) {
      $('recordatorios').innerHTML =
        '<div class="recordatorios"><div class="recordatorios-cabeza"><div><strong>' +
        (sinRecordar.length === 1 ? 'Falta 1 recordatorio por enviar' : 'Faltan ' + sinRecordar.length + ' recordatorios por enviar') +
        '</strong><p>Cada botón abre WhatsApp con el mensaje listo. Solo presiona enviar.</p></div>' +
        '<button type="button" class="boton boton-wa boton-chico" id="btn-siguiente-recordatorio">Enviar a ' +
        esc(sinRecordar[0].cliente_nombre.split(' ')[0]) + ' (' + A.hora12(sinRecordar[0].inicio_min) + ')</button></div></div>';
      $('btn-siguiente-recordatorio').addEventListener('click', () => enviarRecordatorio(sinRecordar[0]));
    } else {
      $('recordatorios').innerHTML = '';
    }

    $('linea-tiempo').innerHTML = construirLineaTiempo(d, activas);

    const det = $('canceladas');
    det.classList.toggle('oculto', !canceladas.length);
    det.querySelector('summary').textContent = 'Canceladas (' + canceladas.length + ')';
    $('lista-canceladas').innerHTML = canceladas.map((c) => tarjetaCita(c, false)).join('');
  }

  function construirLineaTiempo(d, activas) {
    const paso = d.intervalo || 30;
    const eventos = [
      ...activas.map((c) => ({ tipo: 'cita', inicio: c.inicio_min, fin: c.fin_min, cita: c })),
      ...d.bloqueos.map((b) => ({ tipo: 'bloqueo', inicio: b.inicio_min, fin: b.fin_min, bloqueo: b })),
    ];
    const libres = [];
    for (const r of d.rangos) {
      for (let s = r.inicio; s < r.fin; s += paso) {
        const fin = Math.min(s + paso, r.fin);
        if (!eventos.some((e) => s < e.fin && fin > e.inicio)) libres.push({ tipo: 'libre', inicio: s, fin });
      }
    }
    const todo = [...eventos, ...libres].sort((a, b) => a.inicio - b.inicio || (a.tipo === 'cita' ? -1 : 1));
    if (!todo.length) {
      const nota = d.especial && d.especial.nota ? ' (' + esc(d.especial.nota) + ')' : '';
      return '<div class="franja-cerrado">Cerrado este día' + nota + '. Puedes registrar una cita manual con "Nueva cita".</div>';
    }
    const ahora = A.hoyGT();
    return todo.map((e) => {
      let contenido;
      if (e.tipo === 'cita') {
        const fuera = !d.rangos.some((r) => e.inicio >= r.inicio && e.fin <= r.fin);
        contenido = tarjetaCita(e.cita, fuera);
      } else if (e.tipo === 'bloqueo') {
        contenido = '<div class="franja-bloqueo">Bloqueado hasta ' + A.hora12(e.fin) + (e.bloqueo.motivo ? ': ' + esc(e.bloqueo.motivo) : '') + '</div>';
      } else {
        const pasado = d.fecha < ahora.fecha || (d.fecha === ahora.fecha && e.inicio < ahora.minutos);
        contenido = '<div class="franja-libre"><span>' + (pasado ? 'Libre (ya pasó)' : 'Libre') + '</span>' +
          '<button type="button" class="boton boton-secundario boton-chico" data-agendar="' + e.inicio + '" data-pasado="' + pasado + '">' +
          (pasado ? 'Registrar' : 'Agendar') + '</button></div>';
      }
      return '<div class="franja"><div class="reloj">' + A.hora12(e.inicio) + '</div><div>' + contenido + '</div></div>';
    }).join('');
  }

  function tarjetaCita(c, fuera) {
    const etiquetas = [];
    if (c.es_vip) etiquetas.push('<span class="etiqueta vip">VIP</span>');
    if (c.estado !== 'pendiente') {
      etiquetas.push('<span class="etiqueta ' + c.estado + '">' + NOMBRE_ESTADO[c.estado] +
        (c.metodo_pago ? ': ' + NOMBRE_METODO[c.metodo_pago] : '') + '</span>');
    }
    if (c.cliente_bloqueado) etiquetas.push('<span class="etiqueta cancelada">Bloqueado</span>');
    const faltas = c.cliente_inasistencias
      ? '<div class="alerta-chica">' + c.cliente_inasistencias + (c.cliente_inasistencias === 1 ? ' inasistencia anterior' : ' inasistencias anteriores') + '</div>'
      : '';
    let acciones = '';
    if (c.estado === 'pendiente') {
      acciones =
        '<button type="button" class="boton boton-wa boton-chico' + (c.recordatorio_enviado ? ' enviado' : '') + '" data-wa="' + c.id + '">' +
        (c.recordatorio_enviado ? 'Recordado' : 'WhatsApp') + '</button>' +
        '<button type="button" class="boton boton-chico" data-cobrar="efectivo" data-id="' + c.id + '">Efectivo</button>' +
        '<button type="button" class="boton boton-chico" data-cobrar="tarjeta" data-id="' + c.id + '">Tarjeta</button>';
    }
    acciones += '<button type="button" class="boton boton-secundario boton-chico" data-editar="' + c.id + '">' +
      (c.estado === 'pendiente' ? 'Más' : 'Editar') + '</button>';
    return '<div class="tarjeta-cita ' + c.estado + (fuera ? ' fuera' : '') + '">' +
      '<div class="cita-info"><div class="cita-nombre"><button type="button" class="boton-texto" style="color:inherit;text-decoration:none;font-weight:600" data-ver-cliente="' + c.cliente_id + '">' + esc(c.cliente_nombre) + '</button>' + etiquetas.join('') + '</div>' +
      '<div class="cita-meta">' + esc(c.servicio_nombre) + ', ' + A.quetzalesCorto(c.precio) + ', hasta ' + A.hora12(c.fin_min) +
      (fuera ? ', fuera de horario' : '') + '</div>' +
      (c.notas ? '<div class="cita-meta">Nota: ' + esc(c.notas) + '</div>' : '') + faltas + '</div>' +
      '<div class="cita-acciones">' + acciones + '</div></div>';
  }

  function buscarCita(id) {
    return estado.agenda && estado.agenda.citas.find((c) => c.id === id);
  }

  document.getElementById('vista-agenda').addEventListener('click', async (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.wa) {
      const cita = buscarCita(Number(t.dataset.wa));
      if (cita) enviarRecordatorio(cita);
    } else if (t.dataset.cobrar) {
      t.disabled = true;
      try {
        await api('admin/citas/' + t.dataset.id, { metodo: 'PATCH', cuerpo: { accion: 'cobrar', metodo_pago: t.dataset.cobrar } });
        A.aviso('Cobro registrado en ' + NOMBRE_METODO[t.dataset.cobrar].toLowerCase() + '.');
        cargarAgenda();
      } catch (error) {
        A.aviso(error.message);
        t.disabled = false;
      }
    } else if (t.dataset.editar) {
      abrirEditar(buscarCita(Number(t.dataset.editar)));
    } else if (t.dataset.agendar) {
      abrirNuevaCita({ fecha: estado.fecha, inicio: Number(t.dataset.agendar), forzar: t.dataset.pasado === 'true' });
    } else if (t.dataset.verCliente) {
      abrirCliente(Number(t.dataset.verCliente));
    } else if (t.dataset.calDia) {
      estado.fecha = t.dataset.calDia;
      cargarAgenda();
    } else if (t.dataset.calMes) {
      cargarMes(t.dataset.calMes);
    }
  });

  $('dia-anterior').addEventListener('click', () => { estado.fecha = A.sumarDias(estado.fecha, -1); cargarAgenda(); });
  $('dia-siguiente').addEventListener('click', () => { estado.fecha = A.sumarDias(estado.fecha, 1); cargarAgenda(); });
  $('btn-hoy').addEventListener('click', () => { estado.fecha = A.hoyGT().fecha; cargarAgenda(); });
  $('btn-nueva-cita').addEventListener('click', () => abrirNuevaCita({ fecha: estado.fecha }));

  $('btn-mes').addEventListener('click', () => {
    const cal = $('calendario-mes');
    const abrir = cal.classList.contains('oculto');
    cal.classList.toggle('oculto', !abrir);
    $('btn-mes').setAttribute('aria-expanded', String(abrir));
    $('btn-mes').textContent = abrir ? 'Ocultar mes' : 'Ver mes';
    if (abrir) cargarMes(estado.fecha.slice(0, 7));
  });

  async function cargarMes(mes) {
    let d;
    try {
      d = await api('admin/mes?mes=' + mes);
    } catch (error) {
      $('calendario-mes').innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
      return;
    }
    const conteos = new Map(d.conteos.map((c) => [c.fecha, c]));
    const especiales = new Map(d.especiales.map((e) => [e.fecha, e]));
    const primero = A.fechaUTC(d.inicio).getUTCDay();
    const huecos = (primero + 6) % 7; // semana inicia en lunes
    const [a, m] = mes.split('-').map(Number);
    const anterior = m === 1 ? (a - 1) + '-12' : a + '-' + String(m - 1).padStart(2, '0');
    const siguiente = m === 12 ? (a + 1) + '-01' : a + '-' + String(m + 1).padStart(2, '0');
    let html = '<div class="cal-cabeza"><button type="button" class="flecha" data-cal-mes="' + anterior + '" aria-label="Mes anterior">&#8249;</button>' +
      '<strong>' + A.nombreMes(mes) + '</strong>' +
      '<button type="button" class="flecha" data-cal-mes="' + siguiente + '" aria-label="Mes siguiente">&#8250;</button></div>' +
      '<div class="cal-rejilla">' + ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((n) => '<div class="cal-nombre">' + n + '</div>').join('');
    for (let i = 0; i < huecos; i += 1) html += '<div></div>';
    for (let f = d.inicio; f <= d.fin; f = A.sumarDias(f, 1)) {
      const dow = A.fechaUTC(f).getUTCDay();
      const esp = especiales.get(f);
      const abierto = esp ? !esp.cerrado : d.dias_abiertos.includes(dow);
      const cuenta = conteos.get(f);
      const clases = ['cal-dia'];
      if (!abierto) clases.push('cerrado');
      if (f === d.hoy) clases.push('hoy');
      if (f === estado.fecha) clases.push('cal-elegido');
      html += '<button type="button" class="' + clases.join(' ') + '" data-cal-dia="' + f + '" aria-label="' + esc(A.fechaLarga(f)) + '">' +
        '<span class="num">' + Number(f.slice(8)) + '</span>' +
        '<span class="cuenta">' + (cuenta && cuenta.citas ? cuenta.citas + (cuenta.citas === 1 ? ' cita' : ' citas') : (abierto ? '' : 'Cerrado')) + '</span></button>';
    }
    html += '</div>';
    $('calendario-mes').innerHTML = html;
  }

  // ---------- Nueva cita ----------

  function opcionesServicios(soloActivos) {
    return estado.servicios
      .filter((s) => !soloActivos || s.activo)
      .map((s) => '<option value="' + s.id + '">' + esc(s.nombre) + ' (' + A.duracionTexto(s.duracion_min) + ', ' + A.quetzalesCorto(s.precio) + ')</option>')
      .join('');
  }

  function cambiarModoCliente(modo) {
    estado.modoCliente = modo;
    document.querySelectorAll('[data-modo-cliente]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.modoCliente === modo)));
    $('cliente-buscar').classList.toggle('oculto', modo !== 'buscar');
    $('cliente-nuevo').classList.toggle('oculto', modo !== 'nuevo');
  }
  document.querySelectorAll('[data-modo-cliente]').forEach((b) => b.addEventListener('click', () => cambiarModoCliente(b.dataset.modoCliente)));

  function elegirCliente(cliente) {
    estado.clienteElegido = cliente;
    $('n-resultados').innerHTML = '';
    $('n-buscar').closest('.campo').classList.toggle('oculto', Boolean(cliente));
    $('n-elegido').classList.toggle('oculto', !cliente);
    if (cliente) {
      $('n-elegido').innerHTML = '<div><strong>' + esc(cliente.nombre) + '</strong><br><span class="texto-suave">' +
        A.telefonoBonito(cliente.telefono) + (cliente.bloqueado ? ', bloqueado' : '') + '</span></div>' +
        '<button type="button" class="boton-texto" id="cambiar-cliente">Cambiar</button>';
      $('cambiar-cliente').addEventListener('click', () => { elegirCliente(null); $('n-buscar').focus(); });
    }
  }

  let temporizadorBusqueda = null;
  $('n-buscar').addEventListener('input', () => {
    clearTimeout(temporizadorBusqueda);
    const q = $('n-buscar').value.trim();
    if (q.length < 2) { $('n-resultados').innerHTML = ''; return; }
    temporizadorBusqueda = setTimeout(async () => {
      try {
        const r = await api('admin/clientes?q=' + encodeURIComponent(q));
        $('n-resultados').innerHTML = r.clientes.length
          ? r.clientes.slice(0, 8).map((c) => '<button type="button" class="resultado" data-cliente=\'' +
            esc(JSON.stringify({ id: c.id, nombre: c.nombre, telefono: c.telefono, bloqueado: c.bloqueado })) + '\'><strong>' +
            esc(c.nombre) + '</strong> <span class="texto-suave">' + A.telefonoBonito(c.telefono) + '</span></button>').join('')
          : '<p class="texto-suave" style="margin:0">Sin resultados. Usa "Cliente nuevo".</p>';
      } catch (error) {
        $('n-resultados').innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
      }
    }, 250);
  });

  $('n-resultados').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cliente]');
    if (b) elegirCliente(JSON.parse(b.dataset.cliente));
  });

  function servicioElegido() {
    return estado.servicios.find((s) => s.id === Number($('n-servicio').value));
  }

  async function cargarHorasLibres(preferida) {
    const s = servicioElegido();
    const fecha = $('n-fecha').value;
    const sel = $('n-hora');
    if (!s || !fecha) { sel.innerHTML = ''; return; }
    sel.innerHTML = '<option>Cargando...</option>';
    try {
      const r = await api('admin/libres?fecha=' + fecha + '&servicio=' + s.id);
      if (!r.libres.length) {
        sel.innerHTML = '<option value="">Sin horarios libres</option>';
      } else {
        sel.innerHTML = r.libres.map((m) => '<option value="' + m + '"' + (m === preferida ? ' selected' : '') + '>' + A.hora12(m) + '</option>').join('');
      }
    } catch (error) {
      sel.innerHTML = '<option value="">' + esc(error.message) + '</option>';
    }
  }

  function aplicarForzar() {
    const forzar = $('n-forzar').checked;
    $('campo-hora-lista').classList.toggle('oculto', forzar);
    $('campo-hora-libre').classList.toggle('oculto', !forzar);
  }

  $('n-forzar').addEventListener('change', aplicarForzar);
  $('n-servicio').addEventListener('change', () => {
    const s = servicioElegido();
    if (s) $('n-precio').value = Number(s.precio).toFixed(2);
    cargarHorasLibres(Number($('n-hora').value));
  });
  $('n-fecha').addEventListener('change', () => cargarHorasLibres());

  function abrirNuevaCita({ fecha, inicio = null, forzar = false, cliente = null } = {}) {
    $('form-cita').reset();
    mostrarError('error-cita', '');
    cambiarModoCliente('buscar');
    elegirCliente(cliente);
    $('n-servicio').innerHTML = opcionesServicios(true);
    const s = servicioElegido();
    $('n-precio').value = s ? Number(s.precio).toFixed(2) : '';
    $('n-fecha').value = fecha || A.hoyGT().fecha;
    $('n-forzar').checked = forzar;
    $('n-hora-libre').value = inicio !== null ? A.hora24(inicio) : '';
    aplicarForzar();
    cargarHorasLibres(inicio);
    $('dlg-cita').showModal();
    if (!cliente) $('n-buscar').focus();
  }

  $('form-cita').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('error-cita', '');
    const cuerpo = {
      servicio_id: Number($('n-servicio').value),
      fecha: $('n-fecha').value,
      precio: $('n-precio').value,
      es_vip: $('n-vip').checked,
      notas: $('n-notas').value,
      forzar: $('n-forzar').checked,
      metodo_pago: $('n-pago').value || undefined,
    };
    if (estado.modoCliente === 'buscar') {
      if (!estado.clienteElegido) return mostrarError('error-cita', 'Busca y elige un cliente, o usa "Cliente nuevo".');
      cuerpo.cliente_id = estado.clienteElegido.id;
    } else {
      cuerpo.nombre = $('n-nombre').value;
      cuerpo.telefono = $('n-telefono').value;
    }
    if (cuerpo.forzar) {
      cuerpo.inicio = $('n-hora-libre').value;
      if (!cuerpo.inicio) return mostrarError('error-cita', 'Escribe la hora de la cita.');
    } else {
      if (!$('n-hora').value) return mostrarError('error-cita', 'Elige una hora libre o marca "Fuera de horario".');
      cuerpo.inicio = Number($('n-hora').value);
    }
    try {
      await api('admin/citas', { metodo: 'POST', cuerpo });
      $('dlg-cita').close();
      A.aviso('Cita guardada.');
      if (estado.vista === 'agenda') {
        estado.fecha = cuerpo.fecha;
        cargarAgenda();
      } else if (estado.clienteAbierto) {
        abrirCliente(estado.clienteAbierto);
      }
    } catch (error) {
      mostrarError('error-cita', error.message);
    }
  });

  // ---------- Editar cita ----------

  function abrirEditar(c) {
    if (!c) return;
    estado.citaEditando = c;
    mostrarError('error-editar', '');
    $('dlg-editar-titulo').textContent = c.cliente_nombre;
    $('editar-detalle').textContent = c.servicio_nombre + ', ' + A.fechaLarga(c.fecha) + ' a las ' + A.hora12(c.inicio_min) +
      '. Estado: ' + NOMBRE_ESTADO[c.estado] + (c.metodo_pago ? ' (' + NOMBRE_METODO[c.metodo_pago] + ')' : '') + '.';
    $('ed-precio').value = Number(c.precio).toFixed(2);
    $('ed-vip').checked = c.es_vip;
    $('ed-notas').value = c.notas || '';
    $('campo-ed-metodo').classList.toggle('oculto', c.estado !== 'completada');
    if (c.metodo_pago) $('ed-metodo').value = c.metodo_pago;
    let acciones = '';
    if (c.estado === 'pendiente') {
      acciones += '<button type="button" class="boton boton-secundario boton-chico" data-accion="no_asistio">No asistió</button>' +
        '<button type="button" class="boton boton-secundario boton-chico" data-accion="cancelar">Cancelar cita</button>';
    } else {
      acciones += '<button type="button" class="boton boton-secundario boton-chico" data-accion="reabrir">' +
        (c.estado === 'cancelada' ? 'Reactivar cita' : 'Volver a pendiente') + '</button>';
    }
    acciones += '<a class="boton boton-secundario boton-chico" target="_blank" rel="noopener" href="' + enlaceWhatsApp(c.cliente_telefono) + '">Abrir chat</a>';
    $('editar-acciones').innerHTML = acciones;
    $('dlg-editar').showModal();
  }

  $('editar-acciones').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-accion]');
    if (!b) return;
    if (b.dataset.accion === 'cancelar' && b.dataset.confirmar !== 'si') {
      b.dataset.confirmar = 'si';
      b.textContent = 'Confirmar cancelación';
      return;
    }
    try {
      await api('admin/citas/' + estado.citaEditando.id, { metodo: 'PATCH', cuerpo: { accion: b.dataset.accion } });
      $('dlg-editar').close();
      A.aviso('Cita actualizada.');
      cargarAgenda();
    } catch (error) {
      mostrarError('error-editar', error.message);
    }
  });

  $('form-editar').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const c = estado.citaEditando;
    try {
      await api('admin/citas/' + c.id, {
        metodo: 'PATCH',
        cuerpo: {
          accion: 'editar', precio: $('ed-precio').value, es_vip: $('ed-vip').checked,
          notas: $('ed-notas').value, metodo_pago: c.estado === 'completada' ? $('ed-metodo').value : undefined,
        },
      });
      $('dlg-editar').close();
      A.aviso('Cambios guardados.');
      cargarAgenda();
    } catch (error) {
      mostrarError('error-editar', error.message);
    }
  });

  // ---------- Clientes ----------

  let temporizadorClientes = null;
  $('buscar-cliente').addEventListener('input', () => {
    clearTimeout(temporizadorClientes);
    temporizadorClientes = setTimeout(cargarClientes, 300);
  });
  $('filtro-cliente').addEventListener('change', cargarClientes);

  async function cargarClientes() {
    const q = $('buscar-cliente').value.trim();
    const filtro = $('filtro-cliente').value;
    let r;
    try {
      r = await api('admin/clientes?q=' + encodeURIComponent(q) + '&filtro=' + filtro);
    } catch (error) {
      $('lista-clientes').innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
      return;
    }
    if (!r.clientes.length) {
      $('lista-clientes').innerHTML = '<p class="texto-suave">' + (q ? 'No hay clientes que coincidan con la búsqueda.' : 'Todavía no hay clientes registrados.') + '</p>';
      return;
    }
    $('lista-clientes').innerHTML = '<table class="tabla"><thead><tr><th>Cliente</th><th>Teléfono</th><th class="num">Visitas</th>' +
      '<th class="num">Total gastado</th><th class="num">Faltas</th><th>Última visita</th></tr></thead><tbody>' +
      r.clientes.map((c) => '<tr class="clicable" data-cliente-id="' + c.id + '" tabindex="0"><td><strong>' + esc(c.nombre) + '</strong>' +
        (c.bloqueado ? ' <span class="etiqueta cancelada">Bloqueado</span>' : '') + '</td>' +
        '<td>' + A.telefonoBonito(c.telefono) + '</td><td class="num">' + c.visitas + '</td>' +
        '<td class="num">' + A.quetzales(c.total_gastado) + '</td>' +
        '<td class="num">' + (c.inasistencias ? '<span class="alerta-chica">' + c.inasistencias + '</span>' : '0') + '</td>' +
        '<td>' + (c.ultima_visita ? A.fechaCorta(c.ultima_visita) : '<span class="texto-suave">Sin visitas</span>') + '</td></tr>').join('') +
      '</tbody></table>';
  }

  function abrirDesdeTabla(ev) {
    const fila = ev.target.closest('[data-cliente-id]');
    if (fila) abrirCliente(Number(fila.dataset.clienteId));
  }
  $('lista-clientes').addEventListener('click', abrirDesdeTabla);
  $('lista-clientes').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') abrirDesdeTabla(ev); });

  async function abrirCliente(id) {
    estado.clienteAbierto = id;
    const zona = $('contenido-cliente');
    zona.innerHTML = '<p class="texto-suave">Cargando...</p>';
    if (!$('dlg-cliente').open) $('dlg-cliente').showModal();
    let r;
    try {
      r = await api('admin/clientes/' + id);
    } catch (error) {
      zona.innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
      return;
    }
    const c = r.cliente;
    $('dlg-cliente-titulo').textContent = c.nombre;
    zona.innerHTML =
      '<div class="estadisticas">' +
        '<div><span>Visitas</span><strong>' + c.visitas + '</strong></div>' +
        '<div><span>Total gastado</span><strong>' + A.quetzalesCorto(c.total_gastado) + '</strong></div>' +
        '<div><span>Inasistencias</span><strong>' + c.inasistencias + '</strong></div>' +
        '<div><span>Canceladas</span><strong>' + c.canceladas + '</strong></div>' +
      '</div>' +
      '<form id="form-cliente" novalidate>' +
        '<div class="fila-campos">' +
          '<div class="campo"><label for="cl-nombre">Nombre</label><input class="entrada" id="cl-nombre" value="' + esc(c.nombre) + '" maxlength="80"></div>' +
          '<div class="campo"><label for="cl-telefono">Teléfono</label><input class="entrada" id="cl-telefono" value="' + esc(c.telefono) + '" inputmode="tel"></div>' +
        '</div>' +
        '<div class="campo"><label for="cl-notas">Notas del barbero (preferencias, tipo de corte)</label><textarea class="entrada" id="cl-notas" maxlength="500">' + esc(c.notas) + '</textarea></div>' +
        '<label class="casilla" style="margin-bottom:10px"><input type="checkbox" id="cl-bloqueado"' + (c.bloqueado ? ' checked' : '') + '>' +
          '<span>Bloquear cliente<br><small class="texto-suave">No podrá agendar ni iniciar sesión en la página. Tú sí puedes agendarle desde el panel.</small></span></label>' +
        '<div class="campo' + (c.bloqueado ? '' : ' oculto') + '" id="campo-motivo"><label for="cl-motivo">Motivo del bloqueo</label><input class="entrada" id="cl-motivo" value="' + esc(c.motivo_bloqueo || '') + '" maxlength="200"></div>' +
        '<div id="error-cliente" class="mensaje oculto" role="alert"></div>' +
        '<div class="acciones-secundarias" style="border-top:0;padding-top:0">' +
          '<button class="boton" type="submit">Guardar cambios</button>' +
          '<button class="boton boton-secundario" type="button" id="cl-agendar">Agendar cita</button>' +
          '<a class="boton boton-secundario" target="_blank" rel="noopener" href="' + enlaceWhatsApp(c.telefono) + '">Abrir chat</a>' +
          (c.tiene_pin ? '<button class="boton boton-secundario" type="button" id="cl-pin">Restablecer PIN</button>' : '') +
        '</div>' +
      '</form>' +
      '<h3 style="margin:24px 0 10px">Historial</h3>' +
      (r.citas.length
        ? '<div class="tabla-contenedor"><table class="tabla"><thead><tr><th>Fecha</th><th>Servicio</th><th>Estado</th><th class="num">Monto</th></tr></thead><tbody>' +
          r.citas.map((h) => '<tr><td>' + A.fechaCorta(h.fecha) + ' ' + A.hora12(h.inicio_min) + '</td><td>' + esc(h.servicio_nombre) +
            (h.es_vip ? ' <span class="etiqueta vip">VIP</span>' : '') + '</td><td><span class="etiqueta ' + h.estado + '">' + NOMBRE_ESTADO[h.estado] +
            (h.metodo_pago ? ': ' + NOMBRE_METODO[h.metodo_pago] : '') + '</span></td><td class="num">' + A.quetzales(h.precio) + '</td></tr>').join('') +
          '</tbody></table></div>'
        : '<p class="texto-suave">Sin citas registradas.</p>');

    $('cl-bloqueado').addEventListener('change', (ev) => $('campo-motivo').classList.toggle('oculto', !ev.target.checked));
    $('cl-agendar').addEventListener('click', () => {
      $('dlg-cliente').close();
      abrirNuevaCita({ fecha: A.hoyGT().fecha, cliente: { id: c.id, nombre: c.nombre, telefono: c.telefono, bloqueado: c.bloqueado } });
    });
    if ($('cl-pin')) {
      $('cl-pin').addEventListener('click', async () => {
        try {
          await api('admin/clientes/' + id, { metodo: 'PATCH', cuerpo: { restablecer_pin: true } });
          A.aviso('PIN restablecido. El cliente puede crear uno nuevo desde "Crear cuenta".');
          abrirCliente(id);
        } catch (error) { mostrarError('error-cliente', error.message); }
      });
    }
    $('form-cliente').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('admin/clientes/' + id, {
          metodo: 'PATCH',
          cuerpo: {
            nombre: $('cl-nombre').value, telefono: $('cl-telefono').value, notas: $('cl-notas').value,
            bloqueado: $('cl-bloqueado').checked, motivo_bloqueo: $('cl-motivo').value,
          },
        });
        A.aviso('Cliente actualizado.');
        abrirCliente(id);
        if (estado.vista === 'clientes') cargarClientes();
        if (estado.vista === 'agenda') cargarAgenda();
      } catch (error) { mostrarError('error-cliente', error.message); }
    });
  }

  $('dlg-cliente').addEventListener('close', () => { estado.clienteAbierto = null; });

  // ---------- Finanzas ----------

  $('fecha-finanzas').addEventListener('change', () => cargarFinanzas());

  function tarjetaPeriodo(titulo, subtitulo, p, principal) {
    const total = Number(p.efectivo) + Number(p.tarjeta);
    const pct = total ? Math.round((Number(p.efectivo) / total) * 100) : 0;
    return '<div class="periodo' + (principal ? ' principal' : '') + '"><h3>' + esc(titulo) + '</h3>' +
      '<span class="texto-suave">' + esc(subtitulo) + '</span>' +
      '<div class="grande">' + A.quetzales(p.ingresos) + '</div>' +
      '<div class="barra-metodo" aria-hidden="true"><span style="width:' + pct + '%"></span><span style="width:' + (total ? 100 - pct : 0) + '%"></span></div>' +
      '<div class="leyenda"><span><i style="background:var(--cobre)"></i>Efectivo</span><span><i style="background:var(--azul-pole)"></i>Tarjeta</span></div>' +
      '<ul class="desglose">' +
        '<li><span>Servicios brindados</span><span>' + p.servicios + '</span></li>' +
        '<li><span>Efectivo</span><span>' + A.quetzales(p.efectivo) + '</span></li>' +
        '<li><span>Tarjeta</span><span>' + A.quetzales(p.tarjeta) + '</span></li>' +
        '<li><span>Gastos</span><span>' + A.quetzales(p.gastos) + '</span></li>' +
        (principal ? '<li><span>Efectivo en caja (efectivo menos gastos en efectivo)</span><span>' + A.quetzales(p.caja_efectivo) + '</span></li>' : '') +
        '<li><span>Inasistencias</span><span>' + p.inasistencias + '</span></li>' +
        '<li class="neto"><span>Ganancia neta</span><span>' + A.quetzales(p.neto) + '</span></li>' +
      '</ul></div>';
  }

  async function cargarFinanzas() {
    const fecha = $('fecha-finanzas').value || A.hoyGT().fecha;
    $('fecha-finanzas').value = fecha;
    const zona = $('contenido-finanzas');
    zona.innerHTML = '<p class="texto-suave">Cargando...</p>';
    let r;
    try {
      r = await api('admin/finanzas?fecha=' + fecha);
    } catch (error) {
      zona.innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
      return;
    }
    const hoy = A.hoyGT().fecha;
    let html = '';
    if (r.sin_cobrar.length) {
      html += '<div class="aviso-cobros"><strong>' + r.sin_cobrar.length + (r.sin_cobrar.length === 1 ? ' cita pasada sin registrar cobro' : ' citas pasadas sin registrar cobro') +
        '</strong><p class="texto-suave" style="margin:4px 0 8px">Márcalas como Efectivo, Tarjeta o No asistió para que las finanzas cuadren.</p>' +
        r.sin_cobrar.slice(0, 6).map((c) => '<button type="button" class="boton boton-secundario boton-chico" style="margin:0 6px 6px 0" data-ir-fecha="' + c.fecha + '">' +
          A.fechaCorta(c.fecha) + ' ' + A.hora12(c.inicio_min) + ', ' + esc(c.cliente_nombre.split(' ')[0]) + '</button>').join('') + '</div>';
    }
    html += '<div class="periodos">' +
      tarjetaPeriodo(fecha === hoy ? 'Hoy' : mayuscula(A.fechaLarga(fecha)), 'Día seleccionado', r.dia, true) +
      tarjetaPeriodo('Mes actual', A.nombreMes(r.mes_actual.clave), r.mes_actual, false) +
      tarjetaPeriodo('Mes pasado', A.nombreMes(r.mes_pasado.clave), r.mes_pasado, false) +
      '</div>';

    html += '<div class="bloque"><h2>Servicios brindados el ' + esc(A.fechaLarga(fecha)) + '</h2>';
    if (r.dia.citas.length) {
      html += '<div class="tabla-contenedor"><table class="tabla"><thead><tr><th>Hora</th><th>Cliente</th><th>Servicio</th><th>Método</th><th class="num">Monto</th></tr></thead><tbody>' +
        r.dia.citas.map((c) => '<tr><td>' + A.hora12(c.inicio_min) + '</td><td>' + esc(c.cliente_nombre) + '</td><td>' + esc(c.servicio_nombre) +
          (c.es_vip ? ' <span class="etiqueta vip">VIP</span>' : '') + '</td><td>' + NOMBRE_METODO[c.metodo_pago] + '</td><td class="num">' + A.quetzales(c.precio) + '</td></tr>').join('') +
        '<tr><td colspan="4"><strong>Total</strong></td><td class="num"><strong>' + A.quetzales(r.dia.ingresos) + '</strong></td></tr></tbody></table></div>';
    } else {
      html += '<p class="texto-suave">No hay servicios cobrados este día.</p>';
    }
    html += '</div>';

    html += '<div class="dos-columnas" style="margin-bottom:20px"><div class="bloque"><h2>Gastos del día</h2>' +
      (r.dia.gastos_lista.length
        ? '<div class="lista-simple" style="margin-top:8px">' + r.dia.gastos_lista.map((g) => '<div class="item-simple"><span>' + esc(g.concepto) +
          ' <span class="texto-suave">(' + esc(g.categoria) + ', ' + NOMBRE_METODO[g.metodo_pago].toLowerCase() + ')</span></span><span style="display:flex;gap:10px;align-items:center">' +
          A.quetzales(g.monto) + '<button type="button" class="quitar" data-borrar-gasto="' + g.id + '" aria-label="Eliminar gasto">&times;</button></span></div>').join('') + '</div>'
        : '<p class="texto-suave">Sin gastos registrados.</p>') +
      '<form id="form-gasto" novalidate style="margin-top:16px"><div class="fila-campos">' +
        '<div class="campo"><label for="g-concepto">Concepto</label><input class="entrada" id="g-concepto" maxlength="120" placeholder="Navajas, luz, alquiler..."></div>' +
        '<div class="campo"><label for="g-monto">Monto (Q)</label><input class="entrada" id="g-monto" type="number" min="0.01" step="0.01"></div></div>' +
        '<div class="fila-campos"><div class="campo"><label for="g-categoria">Categoría</label><select class="entrada" id="g-categoria">' +
          ['Insumos', 'Servicios', 'Alquiler', 'Equipo', 'Publicidad', 'Otros'].map((c) => '<option>' + c + '</option>').join('') + '</select></div>' +
        '<div class="campo"><label for="g-metodo">Pagado con</label><select class="entrada" id="g-metodo"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option></select></div></div>' +
        '<div id="error-gasto" class="mensaje oculto" role="alert"></div>' +
        '<button class="boton" type="submit">Registrar gasto</button></form></div>' +
      '<div class="bloque"><h2>Por servicio, mes actual</h2>' +
      (r.mes_actual.por_servicio.length
        ? '<table class="tabla"><thead><tr><th>Servicio</th><th class="num">Cantidad</th><th class="num">Total</th></tr></thead><tbody>' +
          r.mes_actual.por_servicio.map((s) => '<tr><td>' + esc(s.servicio) + '</td><td class="num">' + s.cantidad + '</td><td class="num">' + A.quetzales(s.total) + '</td></tr>').join('') +
          '</tbody></table>'
        : '<p class="texto-suave">Aún no hay servicios cobrados este mes.</p>') +
      '</div></div>';

    const meses = [];
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1 - i, 1));
      meses.push(d.toISOString().slice(0, 7));
    }
    estado.mesReporte = estado.mesReporte || meses[0];
    html += '<div class="bloque"><div class="seccion-titulo" style="margin-bottom:12px"><h2>Reporte mensual</h2><div class="filtros">' +
      '<select class="entrada" id="mes-reporte" aria-label="Mes del reporte">' +
      meses.map((m) => '<option value="' + m + '"' + (m === estado.mesReporte ? ' selected' : '') + '>' + A.nombreMes(m) + '</option>').join('') + '</select>' +
      '<button class="boton boton-secundario" type="button" id="btn-exportar">Descargar Excel (CSV)</button></div></div><div id="reporte-mes"></div></div>';

    zona.innerHTML = html;

    $('form-gasto').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('admin/gastos', {
          metodo: 'POST',
          cuerpo: { fecha, concepto: $('g-concepto').value, monto: $('g-monto').value, categoria: $('g-categoria').value, metodo_pago: $('g-metodo').value },
        });
        A.aviso('Gasto registrado.');
        cargarFinanzas();
      } catch (error) { mostrarError('error-gasto', error.message); }
    });
    $('mes-reporte').addEventListener('change', (ev) => { estado.mesReporte = ev.target.value; cargarReporteMes(); });
    $('btn-exportar').addEventListener('click', exportarMes);
    cargarReporteMes();
  }

  $('contenido-finanzas').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.borrarGasto) {
      if (b.dataset.confirmar !== 'si') { b.dataset.confirmar = 'si'; b.textContent = '?'; b.title = 'Presiona otra vez para eliminar'; return; }
      try {
        await api('admin/gastos/' + b.dataset.borrarGasto, { metodo: 'DELETE' });
        A.aviso('Gasto eliminado.');
        cargarFinanzas();
      } catch (error) { A.aviso(error.message); }
    } else if (b.dataset.irFecha) {
      estado.fecha = b.dataset.irFecha;
      cambiarVista('agenda');
    }
  });

  async function cargarReporteMes() {
    const zona = $('reporte-mes');
    if (!zona) return;
    zona.innerHTML = '<p class="texto-suave">Cargando...</p>';
    try {
      const r = await api('admin/finanzas/mes?mes=' + estado.mesReporte);
      if (!r.por_dia.length) {
        zona.innerHTML = '<p class="texto-suave">No hay ingresos registrados en ' + A.nombreMes(r.mes).toLowerCase() + '.</p>';
        return;
      }
      zona.innerHTML = '<div class="tabla-contenedor"><table class="tabla"><thead><tr><th>Día</th><th class="num">Servicios</th><th class="num">Efectivo</th><th class="num">Tarjeta</th><th class="num">Total</th></tr></thead><tbody>' +
        r.por_dia.map((d) => '<tr class="clicable" data-dia-reporte="' + d.fecha + '"><td>' + esc(mayuscula(A.fechaLarga(d.fecha))) + '</td><td class="num">' + d.servicios +
          '</td><td class="num">' + A.quetzales(d.efectivo) + '</td><td class="num">' + A.quetzales(d.tarjeta) + '</td><td class="num">' + A.quetzales(d.total) + '</td></tr>').join('') +
        '<tr><td><strong>Total del mes</strong></td><td class="num"><strong>' + r.resumen.servicios + '</strong></td><td class="num"><strong>' + A.quetzales(r.resumen.efectivo) +
        '</strong></td><td class="num"><strong>' + A.quetzales(r.resumen.tarjeta) + '</strong></td><td class="num"><strong>' + A.quetzales(r.resumen.ingresos) + '</strong></td></tr>' +
        '<tr><td colspan="4">Gastos del mes</td><td class="num">' + A.quetzales(r.resumen.gastos) + '</td></tr>' +
        '<tr><td colspan="4"><strong>Ganancia neta</strong></td><td class="num"><strong>' + A.quetzales(r.resumen.neto) + '</strong></td></tr>' +
        '</tbody></table></div>';
      zona.querySelectorAll('[data-dia-reporte]').forEach((fila) => fila.addEventListener('click', () => {
        $('fecha-finanzas').value = fila.dataset.diaReporte;
        cargarFinanzas();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }));
    } catch (error) {
      zona.innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
    }
  }

  async function exportarMes() {
    try {
      const res = await fetch('/api/admin/finanzas/exportar?mes=' + estado.mesReporte, { headers: { Authorization: 'Bearer ' + estado.token } });
      if (!res.ok) throw new Error('No se pudo generar el archivo.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'el-anexo-finanzas-' + estado.mesReporte + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (error) {
      A.aviso(error.message);
    }
  }

  // ---------- Horario ----------

  function filaTurno(r) {
    return '<div class="turno"><input class="entrada" type="time" step="900" value="' + (r ? A.hora24(r.inicio) : '09:00') + '" aria-label="Desde">' +
      '<span class="texto-suave">a</span><input class="entrada" type="time" step="900" value="' + (r ? A.hora24(r.fin) : '13:00') + '" aria-label="Hasta">' +
      '<button type="button" class="quitar" data-quitar-turno aria-label="Quitar turno">&times;</button></div>';
  }

  function pintarDiaSemana(dia, rangos) {
    const nombre = mayuscula(A.DIAS[dia]);
    return '<div class="dia-semana" data-dia="' + dia + '"><strong>' + nombre + '</strong><div><div class="turnos">' +
      (rangos.length ? rangos.map(filaTurno).join('') : '<span class="dia-cerrado">Cerrado</span>') + '</div>' +
      '<button type="button" class="boton-texto" data-agregar-turno style="margin-top:6px">Agregar turno</button></div></div>';
  }

  async function cargarHorario() {
    let r;
    try {
      r = await api('admin/horario');
    } catch (error) {
      $('editor-semana').innerHTML = '<div class="mensaje">' + esc(error.message) + '</div>';
      return;
    }
    const orden = [1, 2, 3, 4, 5, 6, 0];
    $('editor-semana').innerHTML = orden.map((d) => pintarDiaSemana(d, r.semana[d].rangos)).join('');
    pintarListasHorario(r);
    const hoy = A.hoyGT().fecha;
    if (!$('e-fecha').value) $('e-fecha').value = hoy;
    if (!$('b-fecha').value) $('b-fecha').value = hoy;
    $('e-fecha').min = hoy;
    $('b-fecha').min = hoy;
  }

  function pintarListasHorario(r) {
    $('lista-especiales').innerHTML = r.especiales.length
      ? r.especiales.map((e) => {
        const rangos = typeof e.rangos === 'string' ? JSON.parse(e.rangos) : e.rangos;
        const texto = e.cerrado ? 'Cerrado' : rangos.map((x) => A.hora12(x.inicio) + ' a ' + A.hora12(x.fin)).join(', ');
        return '<div class="item-simple"><span><strong>' + esc(mayuscula(A.fechaLarga(e.fecha))) + '</strong><br><span class="texto-suave">' + esc(texto) +
          (e.nota ? ', ' + esc(e.nota) : '') + '</span></span><button type="button" class="quitar" data-quitar-especial="' + e.fecha + '" aria-label="Quitar día especial">&times;</button></div>';
      }).join('')
      : '<p class="texto-suave" style="margin:0">No hay días especiales próximos.</p>';
    $('lista-bloqueos').innerHTML = r.bloqueos.length
      ? r.bloqueos.map((b) => '<div class="item-simple"><span><strong>' + esc(mayuscula(A.fechaLarga(b.fecha))) + '</strong><br><span class="texto-suave">' +
          A.hora12(b.inicio_min) + ' a ' + A.hora12(b.fin_min) + (b.motivo ? ', ' + esc(b.motivo) : '') + '</span></span>' +
          '<button type="button" class="quitar" data-quitar-bloqueo="' + b.id + '" aria-label="Quitar bloqueo">&times;</button></div>').join('')
      : '<p class="texto-suave" style="margin:0">No hay horas bloqueadas próximas.</p>';
  }

  $('editor-semana').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-agregar-turno')) {
      const turnos = b.closest('.dia-semana').querySelector('.turnos');
      const cerrado = turnos.querySelector('.dia-cerrado');
      if (cerrado) cerrado.remove();
      const ultimos = turnos.querySelectorAll('.turno');
      let nuevo = null;
      if (ultimos.length) {
        const fin = A.minutosDeHora(ultimos[ultimos.length - 1].querySelectorAll('input')[1].value) || 780;
        nuevo = { inicio: Math.min(fin + 60, 1380), fin: Math.min(fin + 300, 1440) };
      }
      turnos.insertAdjacentHTML('beforeend', filaTurno(nuevo));
    } else if (b.hasAttribute('data-quitar-turno')) {
      const turnos = b.closest('.turnos');
      b.closest('.turno').remove();
      if (!turnos.querySelector('.turno')) turnos.innerHTML = '<span class="dia-cerrado">Cerrado</span>';
    }
  });

  $('guardar-semana').addEventListener('click', async () => {
    const semana = Array.from({ length: 7 }, (_, dia) => ({ dia, rangos: [] }));
    document.querySelectorAll('#editor-semana .dia-semana').forEach((fila) => {
      const dia = Number(fila.dataset.dia);
      fila.querySelectorAll('.turno').forEach((t) => {
        const [i, f] = t.querySelectorAll('input');
        semana[dia].rangos.push({ inicio: i.value, fin: f.value === '00:00' ? '24:00' : f.value });
      });
    });
    try {
      const r = await api('admin/horario/semana', { metodo: 'PUT', cuerpo: { semana } });
      pintarListasHorario(r);
      A.aviso('Horario semanal guardado.');
    } catch (error) {
      A.aviso(error.message);
    }
  });

  $('e-cerrado').addEventListener('change', (ev) => {
    const rangos = $('e-rangos');
    rangos.classList.toggle('oculto', ev.target.checked);
    if (!ev.target.checked && !rangos.innerHTML) {
      rangos.innerHTML = '<div class="turnos" style="margin-bottom:8px">' + filaTurno({ inicio: 600, fin: 1080 }) + '</div>' +
        '<button type="button" class="boton-texto" id="e-agregar" style="margin-bottom:14px">Agregar turno</button>';
      $('e-agregar').addEventListener('click', () => rangos.querySelector('.turnos').insertAdjacentHTML('beforeend', filaTurno(null)));
    }
  });
  $('e-rangos').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-quitar-turno]');
    if (b && $('e-rangos').querySelectorAll('.turno').length > 1) b.closest('.turno').remove();
  });

  $('form-especial').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cerrado = $('e-cerrado').checked;
    const rangos = cerrado ? [] : Array.from($('e-rangos').querySelectorAll('.turno')).map((t) => {
      const [i, f] = t.querySelectorAll('input');
      return { inicio: i.value, fin: f.value };
    });
    try {
      const r = await api('admin/horario/especial', { metodo: 'PUT', cuerpo: { fecha: $('e-fecha').value, cerrado, rangos, nota: $('e-nota').value } });
      pintarListasHorario(r);
      $('e-nota').value = '';
      A.aviso(r.citas_en_fecha
        ? 'Día guardado. Ojo: ese día tiene ' + r.citas_en_fecha + ' cita(s) pendiente(s); revísalas en la agenda.'
        : 'Día especial guardado.');
    } catch (error) {
      A.aviso(error.message);
    }
  });

  $('form-bloqueo').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('admin/horario/bloqueos', {
        metodo: 'POST',
        cuerpo: { fecha: $('b-fecha').value, inicio: $('b-inicio').value, fin: $('b-fin').value, motivo: $('b-motivo').value },
      });
      pintarListasHorario(r);
      $('b-motivo').value = '';
      A.aviso('Horas bloqueadas.');
    } catch (error) {
      A.aviso(error.message);
    }
  });

  document.getElementById('vista-horario').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.quitarEspecial) {
        pintarListasHorario(await api('admin/horario/especial?fecha=' + b.dataset.quitarEspecial, { metodo: 'DELETE' }));
        A.aviso('Día especial quitado.');
      } else if (b.dataset.quitarBloqueo) {
        pintarListasHorario(await api('admin/horario/bloqueos/' + b.dataset.quitarBloqueo, { metodo: 'DELETE' }));
        A.aviso('Bloqueo quitado.');
      }
    } catch (error) {
      A.aviso(error.message);
    }
  });

  // ---------- Ajustes ----------

  function filaServicio(s) {
    const id = s ? s.id : 'nuevo';
    return '<form class="servicio-editor" data-servicio-id="' + id + '" novalidate>' +
      '<div class="campo"><label>Nombre</label><input class="entrada" name="nombre" value="' + esc(s ? s.nombre : '') + '" maxlength="80"></div>' +
      '<div class="campo"><label>Minutos</label><input class="entrada" name="duracion_min" type="number" min="5" max="480" step="5" value="' + (s ? s.duracion_min : 30) + '"></div>' +
      '<div class="campo"><label>Precio (Q)</label><input class="entrada" name="precio" type="number" min="0" step="0.01" value="' + (s ? Number(s.precio).toFixed(2) : '') + '"></div>' +
      '<div class="campo"><label>Orden</label><input class="entrada" name="orden" type="number" value="' + (s ? s.orden : estado.servicios.length + 1) + '"></div>' +
      '<div style="display:flex;gap:8px;align-items:center;padding-bottom:4px"><label class="casilla"><input type="checkbox" name="activo"' + (!s || s.activo ? ' checked' : '') + '><span>Activo</span></label>' +
      '<button class="boton boton-chico" type="submit">Guardar</button></div>' +
      '<div class="campo descripcion"><label>Descripción</label><textarea class="entrada" name="descripcion" maxlength="500">' + esc(s ? s.descripcion : '') + '</textarea></div>' +
      '</form>';
  }

  function pintarAjustes() {
    $('editor-servicios').innerHTML = estado.servicios.map(filaServicio).join('');
    for (const [clave, valor] of Object.entries(estado.config)) {
      const campo = $('c-' + clave);
      if (campo) campo.value = valor;
    }
  }

  $('agregar-servicio').addEventListener('click', () => {
    if (!document.querySelector('[data-servicio-id="nuevo"]')) {
      $('editor-servicios').insertAdjacentHTML('beforeend', filaServicio(null));
      document.querySelector('[data-servicio-id="nuevo"] input').focus();
    }
  });

  $('editor-servicios').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const cuerpo = {
      nombre: f.nombre.value, duracion_min: Number(f.duracion_min.value), precio: f.precio.value,
      orden: Number(f.orden.value), activo: f.activo.checked, descripcion: f.descripcion.value,
    };
    const id = f.dataset.servicioId;
    try {
      const r = id === 'nuevo'
        ? await api('admin/servicios', { metodo: 'POST', cuerpo })
        : await api('admin/servicios/' + id, { metodo: 'PATCH', cuerpo });
      estado.servicios = r.servicios;
      pintarAjustes();
      A.aviso('Servicio guardado.');
    } catch (error) {
      A.aviso(error.message);
    }
  });

  $('form-config').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('error-config', '');
    const cuerpo = {};
    ['negocio_nombre', 'barbero_nombre', 'direccion', 'whatsapp', 'intervalo_min', 'anticipacion_min',
      'dias_adelanto', 'horas_cancelacion', 'instagram', 'facebook'].forEach((c) => {
      const v = $('c-' + c).value.trim();
      if (v !== '') cuerpo[c] = v;
    });
    try {
      const r = await api('admin/config', { metodo: 'PUT', cuerpo });
      estado.config = r.config;
      pintarAjustes();
      A.aviso('Ajustes guardados.');
    } catch (error) {
      mostrarError('error-config', error.message);
    }
  });

  $('form-password').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('error-password', '');
    const cuerpo = { actual: $('p-actual').value, nueva: $('p-nueva').value, confirmacion: $('p-confirmacion').value };
    if (cuerpo.nueva.length < 8) return mostrarError('error-password', 'La nueva contraseña debe tener al menos 8 caracteres.');
    if (cuerpo.nueva !== cuerpo.confirmacion) return mostrarError('error-password', 'La confirmación no coincide con la nueva contraseña.');
    try {
      const r = await api('admin/password', { metodo: 'POST', cuerpo });
      estado.token = r.token;
      A.guardarToken(CLAVE_TOKEN, r.token);
      $('form-password').reset();
      A.aviso('Contraseña cambiada.');
    } catch (error) {
      mostrarError('error-password', error.message);
    }
  });

  // ---------- Inicio ----------

  if (estado.token) {
    iniciarApp();
  } else {
    $('vista-login').classList.remove('oculto');
  }
})();
