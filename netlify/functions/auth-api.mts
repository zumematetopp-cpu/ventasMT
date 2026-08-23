import { getStore, getDeployStore } from '@netlify/blobs';

const COOKIE = 'mt_expert_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function store() {
  const production = Netlify.context?.deploy?.context === 'production';
  return production
    ? getStore('mate-topp-expert-accounts', { consistency: 'strong' })
    : getDeployStore('mate-topp-expert-accounts');
}

function cleanPhone(value: unknown) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('15')) d = d.slice(2);
  if (d.startsWith('54') && !d.startsWith('549')) d = '549' + d.slice(2);
  if (!d.startsWith('549')) d = '549' + d.replace(/^549/, '');
  return d.slice(0, 15);
}

function cleanName(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function slugifyFirstName(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function randomHex(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes).map(b => alphabet[b % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeRecoveryCode(value: unknown) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function bytesToB64(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function derivePassword(password: string, saltB64: string) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 },
    key,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

async function makePassword(password: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltB64 = bytesToB64(salt);
  return { salt: saltB64, hash: await derivePassword(password, saltB64) };
}

function parseCookie(req: Request, name: string) {
  const raw = req.headers.get('cookie') || '';
  const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

function sessionCookie(token: string, maxAge = SESSION_SECONDS) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function publicProfile(account: any, req: Request) {
  const origin = new URL(req.url).origin;
  return {
    sellerId: account.sellerId || '',
    firstName: account.firstName || '',
    lastName: account.lastName || '',
    phone: account.phone || '',
    slug: account.slug || '',
    b2b: Boolean(account.b2b),
    clientLink: `${origin}/comprar?experto=${encodeURIComponent(account.slug || '')}`,
  };
}

async function callAppsScript(scriptUrl: string, token: string, body: any) {
  const r = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, token }),
    redirect: 'follow',
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || 'No se pudo conectar con Mate Topp®');
  return j;
}

async function findExistingSeller(scriptUrl: string, token: string, phone: string) {
  const target = new URL(scriptUrl);
  target.searchParams.set('action', 'seller');
  target.searchParams.set('phone', phone);
  target.searchParams.set('token', token);
  const r = await fetch(target, { redirect: 'follow' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) return null;
  return j.seller || null;
}

async function createSession(account: any, req: Request, extra: Record<string, unknown> = {}) {
  const token = randomHex(32);
  await store().setJSON(`session/${token}`, {
    phone: account.phone,
    sellerId: account.sellerId,
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  });
  return new Response(JSON.stringify({ ok: true, profile: publicProfile(account, req), ...extra }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': sessionCookie(token),
      'cache-control': 'no-store',
    },
  });
}

async function accountFromSession(req: Request) {
  const token = parseCookie(req, COOKIE);
  if (!token) return null;
  const session: any = await store().get(`session/${token}`, { type: 'json' });
  if (!session || Number(session.expiresAt) < Date.now()) {
    if (session) await store().delete(`session/${token}`);
    return null;
  }
  return await store().get(`account/${session.phone}`, { type: 'json' });
}

async function revokeSessions(phone: string) {
  const s = store();
  const listed: any = await s.list({ prefix: 'session/' });
  for (const item of listed?.blobs || []) {
    const session: any = await s.get(item.key, { type: 'json' });
    if (session?.phone === phone) await s.delete(item.key);
  }
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';
  const scriptUrl = Netlify.env.get('APPS_SCRIPT_URL');
  const appsToken = Netlify.env.get('APPS_SCRIPT_TOKEN');

  try {
    if (req.method === 'GET' && action === 'me') {
      const account = await accountFromSession(req);
      if (!account) return Response.json({ ok: false, authenticated: false }, { status: 401, headers: { 'cache-control': 'no-store' } });
      return Response.json({ ok: true, authenticated: true, profile: publicProfile(account, req) }, { headers: { 'cache-control': 'no-store' } });
    }

    if (req.method === 'GET' && action === 'publicSeller') {
      const slug = slugifyFirstName(url.searchParams.get('slug') || '');
      if (!slug) return Response.json({ ok: false, error: 'Falta el nombre del Experto' }, { status: 400 });
      const ref: any = await store().get(`slug/${slug}`, { type: 'json' });
      if (!ref?.phone) return Response.json({ ok: false, error: 'Experto no encontrado' }, { status: 404 });
      const account: any = await store().get(`account/${ref.phone}`, { type: 'json' });
      if (!account) return Response.json({ ok: false, error: 'Experto no encontrado' }, { status: 404 });
      return Response.json({
        ok: true,
        seller: {
          firstName: account.firstName,
          sellerId: account.sellerId,
          phone: account.phone,
          slug: account.slug,
        },
      }, { headers: { 'cache-control': 'public, max-age=60' } });
    }

    if (req.method !== 'POST') return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });
    const body = await req.json().catch(() => ({}));
    const postAction = String(body.action || action || '');

    if (postAction === 'register') {
      if (!scriptUrl || !appsToken) return Response.json({ ok: false, error: 'Backend no configurado' }, { status: 500 });
      const firstName = cleanName(body.firstName);
      const lastName = cleanName(body.lastName);
      const phone = cleanPhone(body.phone);
      const password = String(body.password || '');
      const slug = slugifyFirstName(firstName);
      if (!firstName || !lastName) return Response.json({ ok: false, error: 'Completá nombre y apellido.' }, { status: 400 });
      if (!slug) return Response.json({ ok: false, error: 'El nombre no es válido para crear el enlace.' }, { status: 400 });
      if (phone.length < 12) return Response.json({ ok: false, error: 'Completá un WhatsApp válido.' }, { status: 400 });
      if (password.length < 6) return Response.json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' }, { status: 400 });

      const existingAccount: any = await store().get(`account/${phone}`, { type: 'json' });
      if (existingAccount) return Response.json({ ok: false, error: 'Ese WhatsApp ya tiene una cuenta. Usá “Ya tengo una cuenta”.' }, { status: 409 });
      const existingSlug: any = await store().get(`slug/${slug}`, { type: 'json' });
      if (existingSlug?.phone && existingSlug.phone !== phone) {
        return Response.json({ ok: false, error: `El enlace “${slug}” ya está asignado. Contactá a Mate Topp® para crear tu acceso.` }, { status: 409 });
      }

      let seller = await findExistingSeller(scriptUrl, appsToken, phone);
      if (!seller) {
        const origin = new URL(req.url).origin;
        const sellerData = await callAppsScript(scriptUrl, appsToken, {
          action: 'upsertSeller',
          seller: {
            name: `${firstName} ${lastName}`,
            phone,
            clientLink: `${origin}/comprar?experto=${encodeURIComponent(slug)}`,
            b2c: true,
          },
        });
        seller = sellerData.seller || {};
      }

      const passwordData = await makePassword(password);
      const recoveryCode = randomRecoveryCode();
      const account = {
        firstName,
        lastName,
        phone,
        slug,
        sellerId: seller.id || seller.sellerId || '',
        b2b: Boolean(seller.b2b),
        passwordSalt: passwordData.salt,
        passwordHash: passwordData.hash,
        recoveryHash: await sha256Hex(normalizeRecoveryCode(recoveryCode)),
        createdAt: new Date().toISOString(),
      };
      if (!account.sellerId) return Response.json({ ok: false, error: 'No se pudo crear el identificador del Experto.' }, { status: 500 });
      await store().setJSON(`account/${phone}`, account);
      await store().setJSON(`slug/${slug}`, { phone });
      return await createSession(account, req, { recoveryCode });
    }

    if (postAction === 'login') {
      const phone = cleanPhone(body.phone);
      const password = String(body.password || '');
      const account: any = await store().get(`account/${phone}`, { type: 'json' });
      if (!account?.passwordSalt || !account?.passwordHash) return Response.json({ ok: false, error: 'WhatsApp o contraseña incorrectos.' }, { status: 401 });
      const candidate = await derivePassword(password, account.passwordSalt);
      if (candidate !== account.passwordHash) return Response.json({ ok: false, error: 'WhatsApp o contraseña incorrectos.' }, { status: 401 });
      return await createSession(account, req);
    }

    if (postAction === 'resetPassword') {
      const phone = cleanPhone(body.phone);
      const recoveryCode = normalizeRecoveryCode(body.recoveryCode);
      const newPassword = String(body.newPassword || '');
      if (phone.length < 12) return Response.json({ ok: false, error: 'Completá tu WhatsApp.' }, { status: 400 });
      if (newPassword.length < 6) return Response.json({ ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres.' }, { status: 400 });
      const account: any = await store().get(`account/${phone}`, { type: 'json' });
      if (!account) return Response.json({ ok: false, error: 'No encontramos una cuenta con ese WhatsApp.' }, { status: 404 });
      if (!account.recoveryHash) return Response.json({ ok: false, error: 'Esta cuenta necesita recuperación manual con Mate Topp®.' }, { status: 409 });
      if (!recoveryCode || await sha256Hex(recoveryCode) !== account.recoveryHash) {
        return Response.json({ ok: false, error: 'Código de recuperación incorrecto.' }, { status: 401 });
      }
      const passwordData = await makePassword(newPassword);
      account.passwordSalt = passwordData.salt;
      account.passwordHash = passwordData.hash;
      account.passwordChangedAt = new Date().toISOString();
      await store().setJSON(`account/${phone}`, account);
      await revokeSessions(phone);
      return await createSession(account, req);
    }

    if (postAction === 'logout') {
      const token = parseCookie(req, COOKIE);
      if (token) await store().delete(`session/${token}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': sessionCookie('', 0),
          'cache-control': 'no-store',
        },
      });
    }

    return Response.json({ ok: false, error: 'Acción no permitida' }, { status: 400 });
  } catch (error) {
    return Response.json({ ok: false, error: String(error instanceof Error ? error.message : error) }, { status: 500 });
  }
};

export const config = { path: '/auth-api' };
