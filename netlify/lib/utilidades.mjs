// Utilidades compartidas: fechas en hora de Guatemala, validaciones y errores HTTP.

// Guatemala usa UTC-6 todo el año (no tiene horario de verano).
const OFFSET_GT_MS = -6 * 60 * 60 * 1000;

export class ErrorHttp extends Error {
  constructor(estado, mensaje, codigo = null) {
    super(mensaje);
    this.estado = estado;
    this.codigo = codigo;
  }
}

export function ahoraGT(base = Date.now()) {
  const d = new Date(base + OFFSET_GT_MS);
  const fecha = d.toISOString().slice(0, 10);
  const minutos = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { fecha, minutos };
}

export function esFechaValida(texto) {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

export function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function diaSemana(fecha) {
  return new Date(`${fecha}T00:00:00Z`).getUTCDay();
}

export function diferenciaDias(desde, hasta) {
  const a = new Date(`${desde}T00:00:00Z`).getTime();
  const b = new Date(`${hasta}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

// Primer y ultimo dia del mes de una fecha YYYY-MM-DD, mas el mes anterior.
export function rangoMes(fecha) {
  const [a, m] = fecha.split('-').map(Number);
  const inicio = `${a}-${String(m).padStart(2, '0')}-01`;
  const siguiente = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
  const fin = sumarDias(siguiente, -1);
  return { inicio, fin, clave: inicio.slice(0, 7) };
}

export function mesAnterior(fecha) {
  const { inicio } = rangoMes(fecha);
  return rangoMes(sumarDias(inicio, -1));
}

export function minutosAHora(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function horaAMinutos(texto) {
  if (typeof texto === 'number' && Number.isInteger(texto)) return texto;
  if (typeof texto !== 'string' || !/^\d{1,2}:\d{2}$/.test(texto)) return null;
  const [h, m] = texto.split(':').map(Number);
  if (h > 24 || m > 59) return null;
  const total = h * 60 + m;
  return total <= 1440 ? total : null;
}

// Acepta 8 digitos, con espacios o guiones, o con prefijo +502 / 502.
export function normalizarTelefono(texto) {
  if (texto === undefined || texto === null) return null;
  let digitos = String(texto).replace(/\D/g, '');
  if (digitos.length === 11 && digitos.startsWith('502')) digitos = digitos.slice(3);
  if (!/^[2-7]\d{7}$/.test(digitos)) return null;
  return digitos;
}

export function limpiarTexto(texto, maximo = 120) {
  if (typeof texto !== 'string') return '';
  return texto.replace(/\s+/g, ' ').trim().slice(0, maximo);
}

export function validarNombre(texto) {
  const nombre = limpiarTexto(texto, 80);
  if (nombre.length < 3) {
    throw new ErrorHttp(400, 'Ingresa tu nombre completo.');
  }
  return nombre;
}

export function validarPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
    throw new ErrorHttp(400, 'El PIN debe tener de 4 a 6 números.');
  }
  return pin;
}

export function aEntero(valor) {
  const n = Number(valor);
  return Number.isInteger(n) ? n : null;
}

export function aMonto(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}
