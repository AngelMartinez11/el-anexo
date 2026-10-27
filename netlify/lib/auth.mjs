// Autenticacion: tokens firmados (HMAC), hash de PIN y limite de intentos.
import crypto from 'node:crypto';
import { consulta, una } from './db.mjs';
import { ErrorHttp } from './utilidades.mjs';

const DURACION_ADMIN_S = 60 * 60 * 12; // 12 horas
const DURACION_CLIENTE_S = 60 * 60 * 24 * 60; // 60 dias
const MAX_INTENTOS = 5;
const VENTANA_MIN = 15;

function secreto() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET debe existir y tener al menos 32 caracteres');
  }
  return s;
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function firmar(datos) {
  return crypto.createHmac('sha256', secreto()).update(datos).digest('base64url');
}

export function crearToken(carga, duracionSegundos) {
  const cuerpo = b64url(JSON.stringify({ ...carga, exp: Math.floor(Date.now() / 1000) + duracionSegundos }));
  return `${cuerpo}.${firmar(cuerpo)}`;
}

export function verificarToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [cuerpo, firma] = token.split('.');
  const esperada = firmar(cuerpo);
  const a = Buffer.from(firma || '');
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const carga = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (!carga.exp || carga.exp < Math.floor(Date.now() / 1000)) return null;
    return carga;
  } catch {
    return null;
  }
}

function tokenDeSolicitud(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// La version cambia cada vez que se cambia la contrasena: invalida las sesiones anteriores.
async function versionAdmin() {
  const fila = await una("SELECT valor FROM configuracion WHERE clave = 'admin_version'");
  return fila ? Number(fila.valor) : 0;
}

export async function tokenAdmin() {
  return crearToken({ rol: 'admin', v: await versionAdmin() }, DURACION_ADMIN_S);
}

// Verifica la contrasena del panel: primero la guardada desde el panel, si no la de ADMIN_PASSWORD.
export async function verificarPasswordAdmin(password) {
  const fila = await una("SELECT valor FROM configuracion WHERE clave = 'admin_password_hash'");
  if (fila) return verificarPin(String(password), fila.valor);
  const esperado = process.env.ADMIN_PASSWORD;
  if (!esperado || esperado.length < 8) {
    throw new ErrorHttp(500, 'Falta configurar ADMIN_PASSWORD en Netlify (mínimo 8 caracteres).');
  }
  return compararSeguro(String(password), esperado);
}

export async function guardarPasswordAdmin(nueva) {
  const version = (await versionAdmin()) + 1;
  await consulta(
    `INSERT INTO configuracion (clave, valor) VALUES ('admin_password_hash', $1), ('admin_version', $2)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [hashPin(nueva), String(version)],
  );
}

export function tokenCliente(clienteId) {
  return crearToken({ rol: 'cliente', id: clienteId }, DURACION_CLIENTE_S);
}

export async function exigirAdmin(req) {
  const carga = verificarToken(tokenDeSolicitud(req));
  if (!carga || carga.rol !== 'admin' || Number(carga.v || 0) !== (await versionAdmin())) {
    throw new ErrorHttp(401, 'Tu sesión expiró. Vuelve a ingresar.', 'sesion');
  }
  return carga;
}

export async function clienteOpcional(req) {
  const carga = verificarToken(tokenDeSolicitud(req));
  if (!carga || carga.rol !== 'cliente') return null;
  return una('SELECT id, nombre, telefono, bloqueado FROM clientes WHERE id = $1', [carga.id]);
}

export async function exigirCliente(req) {
  const cliente = await clienteOpcional(req);
  if (!cliente) {
    throw new ErrorHttp(401, 'Tu sesión expiró. Vuelve a ingresar.', 'sesion');
  }
  if (cliente.bloqueado) {
    throw new ErrorHttp(403, 'Tu cuenta no puede agendar en línea. Comunícate con la barbería.', 'bloqueado');
  }
  return cliente;
}

// PIN: scrypt con sal aleatoria. Formato guardado: sal:hash (hex).
export function hashPin(pin) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, sal, 32);
  return `${sal.toString('hex')}:${hash.toString('hex')}`;
}

export function verificarPin(pin, guardado) {
  if (!guardado || !guardado.includes(':')) return false;
  const [salHex, hashHex] = guardado.split(':');
  const calculado = crypto.scryptSync(pin, Buffer.from(salHex, 'hex'), 32);
  const esperado = Buffer.from(hashHex, 'hex');
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

export function compararSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Limite de intentos fallidos por clave (telefono o "admin").
export async function revisarIntentos(clave) {
  const fila = await una(
    `SELECT COUNT(*)::int AS n FROM intentos_login
     WHERE clave = $1 AND creado > NOW() - ($2 || ' minutes')::interval`,
    [clave, String(VENTANA_MIN)],
  );
  if (fila.n >= MAX_INTENTOS) {
    throw new ErrorHttp(429, `Demasiados intentos. Espera ${VENTANA_MIN} minutos e inténtalo de nuevo.`);
  }
}

export async function registrarIntentoFallido(clave) {
  await consulta('INSERT INTO intentos_login (clave) VALUES ($1)', [clave]);
  // Limpieza ocasional de registros viejos.
  if (Math.random() < 0.1) {
    await consulta("DELETE FROM intentos_login WHERE creado < NOW() - INTERVAL '1 day'");
  }
}

export async function limpiarIntentos(clave) {
  await consulta('DELETE FROM intentos_login WHERE clave = $1', [clave]);
}
