import { getStore } from '@netlify/blobs';

const enc = new TextEncoder();
const SESSION_HOURS = 12;

function isProduction() {
  return Netlify.context?.deploy?.context === 'production';
}
function sellerStore() {
  return getStore(isProduction() ? 'mate-topp-sellers' : 'mate-topp-sellers-preview', { consistency: 'strong' });
}
function sessionStore() {
  return getStore(isProduction() ? 'mate-topp-seller-sessions' : 'mate-topp-seller-sessions-preview', { consistency: 'strong' });
}
function cleanDigits(value: unknown) {
  return String(value ?? '').replace(/\D/g, '');
}
function normalizePhone(value: unknown) {
  let digits = cleanDigits(value);
  if (digits.startsWith('549')) digits = digits.slice(3);
  else if (digits.startsWith('54')) digits = digits.slice(2);
  else if (digits.startsWith('9')) digits = digits.slice(1);
  digits = digits.replace(/^0+/, '').slice(0, 12);
  return '549' + digits;
}
function normalizeDni(value: unknown) {
  return cleanDigits(value).slice(0, 9);
}
function normalizeEmail(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}
function safeText(value: unknown, max = 90) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}
function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function hex(bytes: Uint8Array) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(value: string) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function sha256Hex(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
}
async function passwordHash(password: string, saltHex?: string) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 180000 }, key, 256);
  return { salt: hex(salt), hash: hex(new Uint8Array(bits)) };
}
function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return hex(new Uint8Array(sig));
}
function cookie(req: Request, name: string) {
  const raw = req.headers.get('cookie') || '';
  const part = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
function bearerToken(req: Request) {
  const header = req.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}
async function validAdmin(req: Request) {
  const secret = Netlify.env.get('APPS_SCRIPT_TOKEN');
  if (!secret) return false;
  const value = cookie(req, 'mt_admin');
  const [expRaw, sig] = value.split('.');
  const exp = Number(expRaw);
  if (!exp || exp < Date.now() || !sig) return false;
  const expected = await hmacHex(secret, `admin:${exp}`);
  return equal(sig, expected);
}
function publicSeller(s: any) {
  return {
    firstName: String(s.firstName || ''),
    lastName: String(s.lastName || ''),
    name: `${String(s.firstName || '')} ${String(s.lastName || '')}`.trim(),
    phone: String(s.phone || ''),
    dni: String(s.dni || ''),
    email: String(s.email || ''),
    channel: s.channel === 'b2b' ? 'b2b' : 'b2c',
    createdAt: String(s.createdAt || ''),
    updatedAt: String(s.updatedAt || '')
  };
}
function clientLink(req: Request, seller: any) {
  const origin = new URL(req.url).origin;
  const p = new URLSearchParams({
    asesora: `${seller.firstName} ${seller.lastName}`.trim(),
    wa: seller.phone,
    sid: seller.dni,
    canal: seller.channel === 'b2b' ? 'b2b' : 'b2c'
  });
  return `${origin}/comprar?${p.toString()}`;
}
async function createSession(dni: string) {
  const raw = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const key = await sha256Hex(raw);
  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  await sessionStore().setJSON(`session:${key}`, { dni, expiresAt });
  return { token: raw, expiresAt };
}
async function sellerFromSession(req: Request) {
  const token = bearerToken(req);
  if (!token) return null;
  const key = await sha256Hex(token);
  const session = await sessionStore().get(`session:${key}`, { type: 'json' });
  if (!session?.dni || Number(session.expiresAt) < Date.now()) {
    if (session) await sessionStore().delete(`session:${key}`);
    return null;
  }
  const seller = await sellerStore().get(`seller:${session.dni}`, { type: 'json' });
  return seller || null;
}
function json(data: any, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

export default async (req: Request) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  try {
    const body: any = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'register') {
      const firstName = safeText(body.firstName, 60);
      const lastName = safeText(body.lastName, 60);
      const phone = normalizePhone(body.phone);
      const dni = normalizeDni(body.dni);
      const email = normalizeEmail(body.email);
      if (!firstName || !lastName) return json({ ok: false, error: 'Completá nombre y apellido.' }, 400);
      if (phone.length < 12 || phone.length > 15) return json({ ok: false, error: 'Revisá el WhatsApp. Debe comenzar con 549.' }, 400);
      if (dni.length < 7 || dni.length > 9) return json({ ok: false, error: 'Revisá el DNI.' }, 400);
      if (!validateEmail(email)) return json({ ok: false, error: 'Revisá el correo electrónico.' }, 400);

      const store = sellerStore();
      const existing = await store.get(`seller:${dni}`, { type: 'json' });
      if (existing) return json({ ok: false, error: 'Ya existe un usuario con ese DNI. Usá “Ya tengo usuario”.' }, 409);

      const password = dni;
      const pass = await passwordHash(password);
      const now = new Date().toISOString();
      const seller = { firstName, lastName, phone, dni, email, channel: 'b2c', salt: pass.salt, passwordHash: pass.hash, createdAt: now, updatedAt: now };
      await store.setJSON(`seller:${dni}`, seller);
      const session = await createSession(dni);
      return json({ ok: true, seller: publicSeller(seller), clientLink: clientLink(req, seller), token: session.token, expiresAt: session.expiresAt, initialPassword: 'dni' });
    }

    if (action === 'login') {
      const dni = normalizeDni(body.dni);
      const password = String(body.password || '');
      if (!dni || !password) return json({ ok: false, error: 'Ingresá DNI y contraseña.' }, 400);
      const seller = await sellerStore().get(`seller:${dni}`, { type: 'json' });
      if (!seller) return json({ ok: false, error: 'DNI o contraseña incorrectos.' }, 401);
      const check = await passwordHash(password, seller.salt);
      if (!equal(check.hash, seller.passwordHash)) return json({ ok: false, error: 'DNI o contraseña incorrectos.' }, 401);
      const session = await createSession(dni);
      return json({ ok: true, seller: publicSeller(seller), clientLink: clientLink(req, seller), token: session.token, expiresAt: session.expiresAt });
    }

    if (action === 'logout') {
      const token = bearerToken(req);
      if (token) {
        const key = await sha256Hex(token);
        await sessionStore().delete(`session:${key}`);
      }
      return json({ ok: true });
    }

    if (action === 'me') {
      const seller = await sellerFromSession(req);
      if (!seller) return json({ ok: false, error: 'Sesión vencida.' }, 401);
      return json({ ok: true, seller: publicSeller(seller), clientLink: clientLink(req, seller) });
    }

    if (action === 'resetSelf') {
      const dni = normalizeDni(body.dni);
      const email = normalizeEmail(body.email);
      const phone = normalizePhone(body.phone);
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 6) return json({ ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres.' }, 400);
      const store = sellerStore();
      const seller = await store.get(`seller:${dni}`, { type: 'json' });
      if (!seller || normalizeEmail(seller.email) !== email || normalizePhone(seller.phone) !== phone) {
        return json({ ok: false, error: 'Los datos no coinciden con el usuario registrado.' }, 401);
      }
      const pass = await passwordHash(newPassword);
      seller.salt = pass.salt;
      seller.passwordHash = pass.hash;
      seller.updatedAt = new Date().toISOString();
      await store.setJSON(`seller:${dni}`, seller);
      return json({ ok: true });
    }

    if (action === 'setChannel') {
      const seller = await sellerFromSession(req);
      if (!seller) return json({ ok: false, error: 'Sesión vencida.' }, 401);
      seller.channel = body.channel === 'b2b' ? 'b2b' : 'b2c';
      seller.updatedAt = new Date().toISOString();
      await sellerStore().setJSON(`seller:${seller.dni}`, seller);
      return json({ ok: true, seller: publicSeller(seller), clientLink: clientLink(req, seller) });
    }

    if (action === 'adminReset') {
      if (!(await validAdmin(req))) return json({ ok: false, error: 'Ingresá primero al panel maestro.' }, 401);
      const dni = normalizeDni(body.dni);
      const store = sellerStore();
      const seller = await store.get(`seller:${dni}`, { type: 'json' });
      if (!seller) return json({ ok: false, error: 'No existe un vendedor con ese DNI.' }, 404);
      const pass = await passwordHash(dni);
      seller.salt = pass.salt;
      seller.passwordHash = pass.hash;
      seller.updatedAt = new Date().toISOString();
      await store.setJSON(`seller:${dni}`, seller);
      return json({ ok: true, seller: publicSeller(seller) });
    }

    return json({ ok: false, error: 'Acción no permitida.' }, 400);
  } catch (error) {
    return json({ ok: false, error: 'No se pudo completar la operación.' }, 500);
  }
};

export const config = { path: '/seller-auth' };
