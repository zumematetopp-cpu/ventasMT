import { getStore } from '@netlify/blobs';

function isProduction() {
  return Netlify.context?.deploy?.context === 'production';
}
function sellerStore() {
  return getStore(isProduction() ? 'mate-topp-sellers' : 'mate-topp-sellers-preview', { consistency: 'strong' });
}
function cleanDigits(value: unknown) {
  return String(value ?? '').replace(/\D/g, '');
}
function safeText(value: unknown, max = 180) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}
function normalizePhone(value: unknown) {
  let digits = cleanDigits(value);
  if (digits.startsWith('549')) return digits.slice(0, 15);
  if (digits.startsWith('54')) return ('549' + digits.slice(2).replace(/^0+/, '')).slice(0, 15);
  return ('549' + digits.replace(/^0+/, '')).slice(0, 15);
}
async function getState(scriptUrl: string, token: string) {
  const target = new URL(scriptUrl);
  target.searchParams.set('token', token);
  const r = await fetch(target, { redirect: 'follow' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok || !j?.state) throw new Error(j?.error || 'No se pudo leer el sistema');
  return j;
}
async function saveState(scriptUrl: string, token: string, revision: number, state: any) {
  const r = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, revision, state }),
    redirect: 'follow',
  });
  const j = await r.json().catch(() => null);
  return { response: r, json: j };
}
function ordersOf(state: any) {
  if (!Array.isArray(state.orders)) state.orders = [];
  return state.orders;
}
async function findSeller(sellerId: string, phone: string) {
  const store = sellerStore();
  const dni = cleanDigits(sellerId).slice(0, 9);
  if (dni) {
    const seller = await store.get(`seller:${dni}`, { type: 'json' });
    if (seller) return seller;
  }
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 12) return null;
  const { blobs } = await store.list({ prefix: 'seller:' });
  for (const blob of blobs) {
    const seller = await store.get(blob.key, { type: 'json' });
    if (seller && normalizePhone(seller.phone) === normalizedPhone) return seller;
  }
  return null;
}
function publicSeller(seller: any) {
  return {
    id: String(seller?.dni || ''),
    name: `${String(seller?.firstName || '')} ${String(seller?.lastName || '')}`.trim(),
    phone: String(seller?.phone || ''),
    channel: seller?.channel === 'b2b' ? 'b2b' : 'b2c',
  };
}
function sanitizeItems(value: any) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item: any) => ({
    sku: safeText(item?.sku, 30),
    desc: safeText(item?.desc, 140),
    qty: Math.max(0, Math.floor(Number(item?.qty) || 0)),
    price: Math.max(0, Number(item?.price) || 0),
  })).filter((item: any) => item.qty > 0 && item.desc);
}
async function createOrder(scriptUrl: string, token: string, rawOrder: any) {
  const id = safeText(rawOrder?.id, 80);
  const sellerId = cleanDigits(rawOrder?.sellerId).slice(0, 9);
  const sellerPhone = normalizePhone(rawOrder?.sellerPhone);
  const customerName = safeText(rawOrder?.customerName || rawOrder?.cust, 120);
  const customerPhone = normalizePhone(rawOrder?.customerPhone);
  const address = safeText(rawOrder?.address || rawOrder?.addr, 300);
  const notes = String(rawOrder?.notes || '').slice(0, 1500);
  const seller = safeText(rawOrder?.seller, 120);
  const items = sanitizeItems(rawOrder?.items);
  if (!id || !sellerId || sellerPhone.length < 12 || !customerName || customerPhone.length < 12 || !address || !items.length) {
    return { ok: false, status: 400, error: 'Faltan datos del pedido.' };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await getState(scriptUrl, token);
    const orders = ordersOf(data.state);
    const existing = orders.find((o: any) => String(o?.id || '') === id);
    if (existing) return { ok: true, status: 200, order: existing };

    const now = new Date().toISOString();
    const order = {
      id,
      sellerId,
      sellerPhone,
      seller,
      customerName,
      customerPhone,
      address,
      notes,
      items,
      status: 'Pedido recibido',
      createdAt: now,
      date: now,
    };
    orders.push(order);
    const saved = await saveState(scriptUrl, token, Number(data.revision), data.state);
    if (saved.response.ok && saved.json?.ok) return { ok: true, status: 200, order };
    if (saved.json?.error !== 'conflict') throw new Error(saved.json?.error || 'No se pudo guardar el pedido');
  }
  return { ok: false, status: 409, error: 'El sistema cambió mientras guardábamos el pedido. Reintentá.' };
}

export default async (req: Request) => {
  const scriptUrl = Netlify.env.get('APPS_SCRIPT_URL');
  const token = Netlify.env.get('APPS_SCRIPT_TOKEN');
  if (!scriptUrl || !token) return Response.json({ ok: false, error: 'Backend no configurado' }, { status: 500 });

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const action = url.searchParams.get('action') || '';

      if (action === 'health') {
        const data = await getState(scriptUrl, token);
        return Response.json({ ok: true, revision: Number(data.revision) || 0 }, { headers: { 'cache-control': 'no-store' } });
      }

      if (action === 'seller') {
        const seller = await findSeller(url.searchParams.get('sellerId') || '', url.searchParams.get('phone') || '');
        if (!seller) return Response.json({ ok: false, error: 'Vendedor no encontrado' }, { status: 404 });
        return Response.json({ ok: true, seller: publicSeller(seller) }, { headers: { 'cache-control': 'no-store' } });
      }

      if (action === 'orders') {
        const sellerId = cleanDigits(url.searchParams.get('sellerId') || '').slice(0, 9);
        const phone = normalizePhone(url.searchParams.get('phone') || '');
        if (!sellerId && phone.length < 12) return Response.json({ ok: false, error: 'Falta el vendedor' }, { status: 400 });
        const data = await getState(scriptUrl, token);
        const orders = ordersOf(data.state).filter((o: any) =>
          (sellerId && cleanDigits(o?.sellerId) === sellerId) || (phone.length >= 12 && normalizePhone(o?.sellerPhone) === phone)
        );
        return Response.json({ ok: true, orders }, { headers: { 'cache-control': 'no-store' } });
      }

      return Response.json({ ok: false, error: 'Acción no permitida' }, { status: 400 });
    }

    if (req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      const action = String(body.action || '');
      if (action === 'createOrder') {
        const result = await createOrder(scriptUrl, token, body.order || {});
        return Response.json(result.ok ? { ok: true, order: result.order } : { ok: false, error: result.error }, { status: result.status });
      }
      return Response.json({ ok: false, error: 'Acción no permitida' }, { status: 400 });
    }

    return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });
  } catch (error) {
    return Response.json({ ok: false, error: String(error instanceof Error ? error.message : error) }, { status: 500 });
  }
};

export const config = { path: '/api' };
