import { getStore, getDeployStore } from '@netlify/blobs';

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function store() {
  const production = Netlify.context?.deploy?.context === 'production';
  return production ? getStore('mate-topp-receipts', { consistency: 'strong' }) : getDeployStore('mate-topp-receipts');
}

async function getState(scriptUrl: string, token: string) {
  const target = new URL(scriptUrl);
  target.searchParams.set('token', token);
  const r = await fetch(target, { redirect: 'follow' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok || !j?.state) throw new Error(j?.error || 'No se pudo leer el pedido');
  return j;
}
async function saveState(scriptUrl: string, token: string, revision: number, state: any) {
  const r = await fetch(scriptUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, revision, state }), redirect: 'follow',
  });
  const j = await r.json().catch(() => null);
  return { response: r, json: j };
}
function findOrder(state: any, orderId: string) {
  const orders = Array.isArray(state?.orders) ? state.orders : [];
  return orders.find((o: any) => String(o?.id || '') === orderId) || null;
}
function subtotal(order: any) {
  return (Array.isArray(order?.items) ? order.items : []).reduce((sum: number, i: any) => sum + (Number(i?.qty) || 0) * (Number(i?.price) || 0), 0);
}
function safeName(name: string) {
  return (name || 'comprobante').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 100);
}
async function signedUrl(req: Request, secret: string, path: string, orderId: string, kind: string) {
  const sig = await hmacHex(secret, `${kind}:${orderId}`);
  const u = new URL(path, req.url);u.searchParams.set('pedido', orderId);u.searchParams.set('firma', sig);return u.toString();
}

export default async (req: Request) => {
  const scriptUrl = Netlify.env.get('APPS_SCRIPT_URL');
  const token = Netlify.env.get('APPS_SCRIPT_TOKEN');
  if (!scriptUrl || !token) return Response.json({ ok: false, error: 'Backend no configurado' }, { status: 500 });

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const orderId = (url.searchParams.get('pedido') || url.searchParams.get('orderId') || '').trim();
      const sig = url.searchParams.get('firma') || url.searchParams.get('sig') || '';
      if (!orderId) return Response.json({ ok: false, error: 'Falta el pedido' }, { status: 400 });
      const expected = await hmacHex(token, `receipt:${orderId}`);
      if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });
      const data = await getState(scriptUrl, token);
      const order = findOrder(data.state, orderId);
      if (!order?.receiptKey) return Response.json({ ok: false, error: 'No hay comprobante cargado' }, { status: 404 });
      const bytes = await store().get(String(order.receiptKey), { type: 'arrayBuffer' });
      if (!bytes) return Response.json({ ok: false, error: 'Comprobante no encontrado' }, { status: 404 });
      const filename = safeName(String(order.receiptName || 'comprobante'));
      return new Response(bytes, {
        headers: {
          'content-type': String(order.receiptType || 'application/octet-stream'),
          'content-disposition': `inline; filename="${filename}"`,
          'cache-control': 'private, max-age=60',
        },
      });
    }

    if (req.method === 'POST') {
      const form = await req.formData();
      const orderId = String(form.get('orderId') || '').trim();
      const sellerId = String(form.get('sellerId') || '').trim();
      const file = form.get('file');
      if (!orderId || !sellerId || !(file instanceof File)) return Response.json({ ok: false, error: 'Faltan datos del comprobante' }, { status: 400 });
      if (file.size > 10 * 1024 * 1024) return Response.json({ ok: false, error: 'El archivo supera 10 MB' }, { status: 413 });
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      if (!allowed.includes(file.type)) return Response.json({ ok: false, error: 'Usá JPG, PNG, WEBP o PDF' }, { status: 415 });

      const first = await getState(scriptUrl, token);
      const existing = findOrder(first.state, orderId);
      if (!existing) return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });
      if (String(existing.sellerId || '') !== sellerId) return Response.json({ ok: false, error: 'No autorizado' }, { status: 403 });

      const key = `receipts/${orderId}/${Date.now()}-${safeName(file.name)}`;
      await store().set(key, await file.arrayBuffer());

      let updated: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const data = attempt === 0 ? first : await getState(scriptUrl, token);
        const order = findOrder(data.state, orderId);
        if (!order) return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });
        if (String(order.sellerId || '') !== sellerId) return Response.json({ ok: false, error: 'No autorizado' }, { status: 403 });
        order.receiptKey = key;
        order.receiptName = file.name;
        order.receiptType = file.type;
        order.receiptUploadedAt = new Date().toISOString();
        order.status = 'Comprobante cargado';
        const saved = await saveState(scriptUrl, token, Number(data.revision), data.state);
        if (saved.response.ok && saved.json?.ok) { updated = order; break; }
        if (saved.json?.error !== 'conflict') throw new Error(saved.json?.error || 'No se pudo registrar el comprobante');
      }
      if (!updated) return Response.json({ ok: false, error: 'El pedido cambió. Probá de nuevo.' }, { status: 409 });

      const confirmUrl = await signedUrl(req, token, '/confirmar', orderId, 'confirm');
      const receiptUrl = await signedUrl(req, token, '/receipt-api', orderId, 'receipt');
      const sub = subtotal(updated), shipping = Number(updated.shipping) || 0;
      return Response.json({
        ok: true,
        confirmUrl,
        receiptUrl,
        order: {
          id: orderId,
          status: updated.status,
          receiptUploadedAt: updated.receiptUploadedAt,
          receiptName: updated.receiptName,
          receiptType: updated.receiptType,
          receiptUrl,
          subtotal: sub,
          shipping,
          total: sub + shipping + (Number(updated.adj) || 0),
        },
      });
    }

    return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
};

export const config = { path: '/receipt-api' };
