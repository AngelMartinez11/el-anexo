// Funciones compartidas entre el sitio de clientes y el panel de administrador.
(function () {
  'use strict';

  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];

  function leerToken(clave) {
    try { return localStorage.getItem(clave); } catch (e) { return null; }
  }
  function guardarToken(clave, valor) {
    try {
      if (valor) localStorage.setItem(clave, valor); else localStorage.removeItem(clave);
    } catch (e) { /* almacenamiento no disponible */ }
  }

  // Envuelve fetch: agrega el token, convierte JSON y lanza errores legibles.
  async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
    const headers = {};
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch('/api/' + ruta, {
        method: metodo,
        headers,
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      });
    } catch (e) {
      const error = new Error('No hay conexión. Revisa tu internet e inténtalo de nuevo.');
      error.estado = 0;
      throw error;
    }
    let datos = null;
    try { datos = await res.json(); } catch (e) { datos = null; }
    if (!res.ok) {
      const error = new Error((datos && datos.error) || 'Ocurrió un error. Inténtalo de nuevo.');
      error.estado = res.status;
      error.codigo = datos && datos.codigo;
      throw error;
    }
    return datos;
  }

  function fechaUTC(fecha) { return new Date(fecha + 'T00:00:00Z'); }

  function sumarDias(fecha, dias) {
    const d = fechaUTC(fecha);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  function hoyGT() {
    const d = new Date(Date.now() - 6 * 3600 * 1000);
    return { fecha: d.toISOString().slice(0, 10), minutos: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }

  function hora12(min) {
    const h = Math.floor(min / 60);
    const m = String(min % 60).padStart(2, '0');
    const sufijo = h >= 12 && h < 24 ? 'pm' : 'am';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + m + ' ' + sufijo;
  }

  function hora24(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }

  function minutosDeHora(texto) {
    const p = /^(\d{1,2}):(\d{2})$/.exec(texto || '');
    return p ? Number(p[1]) * 60 + Number(p[2]) : null;
  }

  function fechaLarga(fecha) {
    const d = fechaUTC(fecha);
    return DIAS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' de ' + MESES[d.getUTCMonth()];
  }

  function fechaCorta(fecha) {
    const [a, m, d] = fecha.split('-');
    return d + '-' + m + '-' + a.slice(2);
  }

  function nombreMes(clave) {
    const [a, m] = clave.split('-').map(Number);
    return MESES[m - 1].charAt(0).toUpperCase() + MESES[m - 1].slice(1) + ' ' + a;
  }

  function quetzales(monto) {
    return 'Q' + Number(monto || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function quetzalesCorto(monto) {
    const n = Number(monto || 0);
    return 'Q' + (Number.isInteger(n) ? n.toLocaleString('es-GT') : n.toLocaleString('es-GT', { minimumFractionDigits: 2 }));
  }

  function duracionTexto(min) {
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    const r = min % 60;
    return h + (h === 1 ? ' hora' : ' horas') + (r ? ' ' + r + ' min' : '');
  }

  function telefonoBonito(tel) {
    return tel && tel.length === 8 ? tel.slice(0, 4) + '-' + tel.slice(4) : tel || '';
  }

  // Escapa texto antes de insertarlo como HTML.
  function esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let temporizadorAviso = null;
  function aviso(texto) {
    let el = document.getElementById('aviso-flotante');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aviso-flotante';
      el.className = 'aviso-flotante';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = texto;
    el.classList.remove('oculto');
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => el.classList.add('oculto'), 3200);
  }

  window.Anexo = {
    DIAS, DIAS_CORTOS, MESES,
    api, leerToken, guardarToken, sumarDias, hoyGT, fechaUTC,
    hora12, hora24, minutosDeHora, fechaLarga, fechaCorta, nombreMes,
    quetzales, quetzalesCorto, duracionTexto, telefonoBonito, esc, aviso,
  };
})();
