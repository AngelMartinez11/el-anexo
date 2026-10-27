// Calculo de horarios disponibles a partir del horario semanal,
// los dias especiales, los bloqueos y las citas ya agendadas.
import { consulta } from './db.mjs';
import { ahoraGT, diaSemana, sumarDias, diferenciaDias } from './utilidades.mjs';

const NUMERICAS = ['intervalo_min', 'anticipacion_min', 'dias_adelanto', 'horas_cancelacion'];

export async function obtenerConfiguracion() {
  const filas = await consulta('SELECT clave, valor FROM configuracion');
  const config = {};
  for (const f of filas) {
    config[f.clave] = NUMERICAS.includes(f.clave) ? Number(f.valor) : f.valor;
  }
  return config;
}

// Carga en pocas consultas todo lo necesario para un rango de fechas.
async function cargarDatos(desde, hasta) {
  const [semanal, especiales, bloqueos, citas] = await Promise.all([
    consulta('SELECT dia, inicio_min, fin_min FROM horario_semanal ORDER BY dia, inicio_min'),
    consulta('SELECT fecha, cerrado, rangos, nota FROM dias_especiales WHERE fecha BETWEEN $1 AND $2', [desde, hasta]),
    consulta('SELECT id, fecha, inicio_min, fin_min, motivo FROM bloqueos WHERE fecha BETWEEN $1 AND $2', [desde, hasta]),
    consulta(
      `SELECT id, fecha, inicio_min, fin_min FROM citas
       WHERE fecha BETWEEN $1 AND $2 AND estado <> 'cancelada'`,
      [desde, hasta],
    ),
  ]);
  const porDia = new Map();
  for (const f of semanal) {
    if (!porDia.has(f.dia)) porDia.set(f.dia, []);
    porDia.get(f.dia).push({ inicio: f.inicio_min, fin: f.fin_min });
  }
  const mapaEspeciales = new Map(especiales.map((e) => [e.fecha, e]));
  const agrupar = (lista) => {
    const m = new Map();
    for (const x of lista) {
      if (!m.has(x.fecha)) m.set(x.fecha, []);
      m.get(x.fecha).push(x);
    }
    return m;
  };
  return { porDia, mapaEspeciales, bloqueos: agrupar(bloqueos), citas: agrupar(citas) };
}

function normalizarRangos(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((r) => ({ inicio: Number(r.inicio), fin: Number(r.fin) }))
    .filter((r) => Number.isInteger(r.inicio) && Number.isInteger(r.fin) && r.fin > r.inicio)
    .sort((a, b) => a.inicio - b.inicio);
}

export function rangosDeFecha(datos, fecha) {
  const especial = datos.mapaEspeciales.get(fecha);
  if (especial) {
    if (especial.cerrado) return { rangos: [], especial };
    const rangos = typeof especial.rangos === 'string' ? JSON.parse(especial.rangos) : especial.rangos;
    return { rangos: normalizarRangos(rangos), especial };
  }
  return { rangos: datos.porDia.get(diaSemana(fecha)) || [], especial: null };
}

function seTraslapa(inicio, fin, ocupados) {
  return ocupados.some((o) => inicio < o.fin_min && fin > o.inicio_min);
}

// Devuelve los minutos de inicio libres para una fecha y una duracion.
function calcularSlots(datos, config, fecha, duracion, opciones = {}) {
  const { excluirCitaId = null, publico = true } = opciones;
  const hoy = ahoraGT();
  if (publico) {
    const diff = diferenciaDias(hoy.fecha, fecha);
    if (diff < 0 || diff > config.dias_adelanto) return [];
  }
  const { rangos } = rangosDeFecha(datos, fecha);
  const ocupados = [
    ...(datos.citas.get(fecha) || []).filter((c) => c.id !== excluirCitaId),
    ...(datos.bloqueos.get(fecha) || []),
  ];
  const paso = config.intervalo_min || 30;
  const limiteHoy = fecha === hoy.fecha ? hoy.minutos + (publico ? config.anticipacion_min || 0 : 0) : -1;
  const libres = [];
  for (const r of rangos) {
    for (let s = r.inicio; s + duracion <= r.fin; s += paso) {
      if (s < limiteHoy) continue;
      if (fecha < hoy.fecha) continue;
      if (!seTraslapa(s, s + duracion, ocupados)) libres.push(s);
    }
  }
  return libres;
}

export async function slotsDeFecha(fecha, duracion, opciones = {}) {
  const config = opciones.config || (await obtenerConfiguracion());
  const datos = await cargarDatos(fecha, fecha);
  return calcularSlots(datos, config, fecha, duracion, opciones);
}

// Resumen de varios dias: cuantos horarios libres tiene cada uno.
export async function resumenDias(desde, cantidad, duracion, opciones = {}) {
  const config = opciones.config || (await obtenerConfiguracion());
  const hasta = sumarDias(desde, cantidad - 1);
  const datos = await cargarDatos(desde, hasta);
  const dias = [];
  for (let i = 0; i < cantidad; i += 1) {
    const fecha = sumarDias(desde, i);
    const { rangos } = rangosDeFecha(datos, fecha);
    const libres = calcularSlots(datos, config, fecha, duracion, opciones).length;
    dias.push({ fecha, abierto: rangos.length > 0, libres });
  }
  return dias;
}

export async function horarioDeFecha(fecha) {
  const datos = await cargarDatos(fecha, fecha);
  return rangosDeFecha(datos, fecha);
}

export async function estaDisponible(fecha, inicio, duracion, opciones = {}) {
  const libres = await slotsDeFecha(fecha, duracion, opciones);
  return libres.includes(inicio);
}
