import { getStore } from '@netlify/blobs';

const enc = new TextEncoder();

function isProduction() {
  return Netlify.context?.deploy?.context === 'production';
}
function sellerStore() {
  return getStore(isProduction() ? 'mate-topp-sellers' : 'mate-topp-sellers-preview', { consistency: 'strong' });
}
function sessionStore() {
  return getStore(isProduction() ? 'mate-topp-seller-sessions' : 'mate-topp-seller-sessions-preview', { consistency: 'strong' });
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
function bearerToken(req: Request) {
  const header = req.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}
async function sellerFromSession(req: Request) {
  const token = bearerToken(req);
  if (!token) return null;
  const key = await sha256Hex(token);
  const session = await sessionStore().get(`session:${key}`, { type: 'json' });
  if (!session?.dni || Number(session.expiresAt) < Date.now()) return null;
  return await sellerStore().get(`seller:${session.dni}`, { type: 'json' });
}
function json(data: any, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

export default async (req: Request) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);
  try {
    const seller = await sellerFromSession(req);
    if (!seller) return json({ ok: false, error: 'Sesión vencida.' }, 401);
    const body: any = await req.json().catch(() => ({}));
    if (String(body.action || '') !== 'changePassword') return json({ ok: false, error: 'Acción no permitida.' }, 400);

    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!currentPassword || newPassword.length < 6) return json({ ok: false, error: 'Completá la contraseña actual y una nueva de al menos 6 caracteres.' }, 400);

    const check = await passwordHash(currentPassword, seller.salt);
    if (!equal(check.hash, seller.passwordHash)) return json({ ok: false, error: 'La contraseña actual no es correcta.' }, 401);

    const pass = await passwordHash(newPassword);
    seller.salt = pass.salt;
    seller.passwordHash = pass.hash;
    seller.updatedAt = new Date().toISOString();
    await sellerStore().setJSON(`seller:${seller.dni}`, seller);
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: 'No se pudo cambiar la contraseña.' }, 500);
  }
};

export const config = { path: '/seller-account' };
