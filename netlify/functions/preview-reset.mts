import { getDeployStore } from '@netlify/blobs';

const COOKIE = 'mt_expert_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function cleanPhone(value: unknown) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('15')) d = d.slice(2);
  if (d.startsWith('54') && !d.startsWith('549')) d = '549' + d.slice(2);
  if (!d.startsWith('549')) d = '549' + d.replace(/^549/, '');
  return d.slice(0, 15);
}

function bytesToB64(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function derivePassword(password: string, saltB64: string) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, key, 256);
  return bytesToB64(new Uint8Array(bits));
}

async function makePassword(password: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltB64 = bytesToB64(salt);
  return { salt: saltB64, hash: await derivePassword(password, saltB64) };
}

function randomHex(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
}

function sessionCookie(token: string) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export default async (req: Request) => {
  if (Netlify.context?.deploy?.context !== 'deploy-preview') return Response.json({ ok: false, error: 'Disponible solo en pruebas.' }, { status: 404 });
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });

  const expected = Netlify.env.get('RECOVERY_PREVIEW_TOKEN') || '';
  const expires = Date.parse(Netlify.env.get('RECOVERY_PREVIEW_EXPIRES') || '');
  if (!expected || !expires || Date.now() > expires) return Response.json({ ok: false, error: 'Este enlace de recuperación venció.' }, { status: 410 });

  const body = await req.json().catch(() => ({}));
  const token = String(body.token || '');
  if (token !== expected) return Response.json({ ok: false, error: 'Enlace de recuperación inválido.' }, { status: 403 });

  const phone = cleanPhone(body.phone);
  const password = String(body.password || '');
  if (phone.length < 12) return Response.json({ ok: false, error: 'Completá tu WhatsApp.' }, { status: 400 });
  if (password.length < 6) return Response.json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' }, { status: 400 });

  const store = getDeployStore('mate-topp-expert-accounts');
  const account: any = await store.get(`account/${phone}`, { type: 'json' });
  if (!account) return Response.json({ ok: false, error: 'No encontramos esa cuenta en esta versión de prueba.' }, { status: 404 });

  const pwd = await makePassword(password);
  account.passwordSalt = pwd.salt;
  account.passwordHash = pwd.hash;
  account.passwordChangedAt = new Date().toISOString();
  await store.setJSON(`account/${phone}`, account);

  const listed: any = await store.list({ prefix: 'session/' });
  for (const item of listed?.blobs || []) {
    const s: any = await store.get(item.key, { type: 'json' });
    if (s?.phone === phone) await store.delete(item.key);
  }

  const sessionToken = randomHex(32);
  await store.setJSON(`session/${sessionToken}`, { phone: account.phone, sellerId: account.sellerId, expiresAt: Date.now() + SESSION_SECONDS * 1000 });

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': sessionCookie(sessionToken),
      'cache-control': 'no-store',
    },
  });
};

export const config = { path: '/preview-reset' };
