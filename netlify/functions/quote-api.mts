const enc = new TextEncoder();

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
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
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, revision, state }),
    redirect: 'follow',
  });
  const j = await r.json().catch(() => null);
  return { response: r, json: j };
}

function ordersOf(state: any) {
  return Array.isArray(state?.orders) ? state.orders : [];
}
function findOrder(state: any, orderId: string) {
  return ordersOf(state).find((o: any) => String(o?.id || '') === orderId) || null;
}
function subtotal(order: any) {
  return (Array.isArray(order?.items) ? order.items : []).reduce(
    (sum: number, i: any) => sum + (Number(i?.qty) || 0) * (Number(i?.price) || 0), 0
  );
}
function remitoNumber(order: any) {
  if (order?.remitoNumber) return String(order.remitoNumber);
  const raw = String(order?.id || '').replace(/[^0-9]/g, '');
  const tail = raw.slice(-6) || String(Date.now()).slice(-6);
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `REM-${date}-${tail}`;
}

async function signedUrl(req: Request, secret: string, path: string, orderId: string, kind: string) {
  const sig = await hmacHex(secret, `${kind}:${orderId}`);
  const url = new URL(path, req.url);
  url.searchParams.set('pedido', orderId);
  url.searchParams.set('firma', sig);
  return url.toString();
}

async function safeOrder(order: any, req?: Request, secret?: string) {
  const sub = subtotal(order);
  const shipping = Number(order?.shipping) || 0;
  const result: any = {
    id: String(order?.id || ''),
    customer: String(order?.cust || order?.customer || order?.customerName || ''),
    customerPhone: String(order?.customerPhone || ''),
    address: String(order?.addr || order?.address || ''),
    notes: String(order?.notes || ''),
    status: String(order?.status || ''),
    seller: String(order?.seller || ''),
    sellerId: String(order?.sellerId || ''),
    sellerPhone: String(order?.sellerPhone || ''),
    createdAt: String(order?.date || order?.createdAt || ''),
    items: Array.isArray(order?.items) ? order.items.map((i: any) => ({
      desc: String(i?.desc || ''), qty: Number(i?.qty) || 0, price: Number(i?.price) || 0,
    })) : [],
    subtotal: sub,
    shipping,
    total: sub + shipping + (Number(order?.adj) || 0),
    paymentSentAt: String(order?.paymentSentAt || ''),
    receiptUploadedAt: String(order?.receiptUploadedAt || ''),
    receiptName: String(order?.receiptName || ''),
    receiptType: String(order?.receiptType || ''),
    paymentConfirmedAt: String(order?.paymentConfirmedAt || ''),
    paymentMethod: String(order?.paymentMethod || ''),
    remitoNumber: String(order?.remitoNumber || ''),
    remitoGeneratedAt: String(order?.remitoGeneratedAt || ''),
  };
  if (req && secret && order?.receiptKey) result.receiptUrl = await signedUrl(req, secret, '/receipt-api', result.id, 'receipt');
  if (req && secret && (order?.paymentConfirmedAt || String(order?.status || '').toLowerCase().includes('remito'))) {
    result.remitoUrl = await signedUrl(req, secret, '/remito', result.id, 'remito');
  }
  return result;
}

async function mutateOrder(scriptUrl: string, token: string, orderId: string, mutate: (o: any) => void) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await getState(scriptUrl, token);
    const order = findOrder(data.state, orderId);
    if (!order) return { ok: false, status: 404, error: 'Pedido no encontrado' };
    mutate(order);
    const saved = await saveState(scriptUrl, token, Number(data.revision), data.state);
    if (saved.response.ok && saved.json?.ok) return { ok: true, order };
    if (saved.json?.error !== 'conflict') throw new Error(saved.json?.error || 'No se pudo guardar el pedido');
  }
  return { ok: false, status: 409, error: 'El pedido cambió. Probá de nuevo.' };
}

export default async (req: Request) => {
  const scriptUrl = Netlify.env.get('APPS_SCRIPT_URL');
  const token = Netlify.env.get('APPS_SCRIPT_TOKEN');
  if (!scriptUrl || !token) return Response.json({ ok: false, error: 'Backend no configurado' }, { status: 500 });

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const action = url.searchParams.get('action') || '';
      const orderId = (url.searchParams.get('orderId') || '').trim();

      if (action === 'sellerOrders') {
        const sellerId = (url.searchParams.get('sellerId') || '').trim();
        const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '');
        if (!sellerId && !phone) return Response.json({ ok: false, error: 'Falta el acceso' }, { status: 400 });
        const data = await getState(scriptUrl, token);
        const matches = ordersOf(data.state).filter((o: any) => {
          if (sellerId && String(o?.sellerId || '') === sellerId) return true;
          if (phone && String(o?.sellerPhone || '').replace(/\D/g, '') === phone) return true;
          return false;
        });
        const orders = await Promise.all(matches.map((o: any) => safeOrder(o, req, token)));
        return Response.json({ ok: true, orders });
      }

      if (!orderId) return Response.json({ ok: false, error: 'Falta el pedido' }, { status: 400 });
      const data = await getState(scriptUrl, token);
      const order = findOrder(data.state, orderId);
      if (!order) return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });

      if (action === 'link') {
        const sellerId = (url.searchParams.get('sellerId') || '').trim();
        if (!sellerId || String(order.sellerId || '') !== sellerId) return Response.json({ ok: false, error: 'No autorizado' }, { status: 403 });
        const quoteUrl = await signedUrl(req, token, '/cotizar', orderId, 'quote');
        return Response.json({ ok: true, quoteUrl });
      }

      if (action === 'order') {
        const sig = url.searchParams.get('sig') || '';
        const expected = await hmacHex(token, `quote:${orderId}`);
        if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });
        return Response.json({ ok: true, order: await safeOrder(order, req, token) });
      }

      if (action === 'adminOrder') {
        const sig = url.searchParams.get('sig') || '';
        const expected = await hmacHex(token, `confirm:${orderId}`);
        if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });
        return Response.json({ ok: true, order: await safeOrder(order, req, token) });
      }

      if (action === 'remito') {
        const sig = url.searchParams.get('sig') || '';
        const expected = await hmacHex(token, `remito:${orderId}`);
        if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });
        if (!order.paymentConfirmedAt && !String(order.status || '').toLowerCase().includes('remito')) return Response.json({ ok: false, error: 'El pago todavía no está confirmado' }, { status: 409 });
        return Response.json({ ok: true, order: await safeOrder(order, req, token) });
      }

      return Response.json({ ok: false, error: 'Acción no permitida' }, { status: 400 });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const action = String(body.action || '');
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return Response.json({ ok: false, error: 'Falta el pedido' }, { status: 400 });

      if (action === 'quoteShipping') {
        const sig = String(body.sig || '');
        const shipping = Number(body.shipping);
        if (!Number.isFinite(shipping) || shipping < 0) return Response.json({ ok: false, error: 'Datos inválidos' }, { status: 400 });
        const expected = await hmacHex(token, `quote:${orderId}`);
        if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });
        const result = await mutateOrder(scriptUrl, token, orderId, order => {
          order.shipping = shipping;
          order.status = 'Envío cotizado';
          order.shippingQuotedAt = new Date().toISOString();
        });
        if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
        return Response.json({ ok: true, order: await safeOrder(result.order, req, token) });
      }

      if (action === 'markAwaitingPayment') {
        const sellerId = String(body.sellerId || '').trim();
        const data = await getState(scriptUrl, token);
        const existing = findOrder(data.state, orderId);
        if (!existing) return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });
        if (!sellerId || String(existing.sellerId || '') !== sellerId) return Response.json({ ok: false, error: 'No autorizado' }, { status: 403 });
        const result = await mutateOrder(scriptUrl, token, orderId, order => {
          order.status = 'Esperando pago';
          order.paymentSentAt = new Date().toISOString();
        });
        if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
        return Response.json({ ok: true, order: await safeOrder(result.order, req, token) });
      }

      if (action === 'confirmPayment') {
        const sig = String(body.sig || '');
        const expected = await hmacHex(token, `confirm:${orderId}`);
        if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });
        const paymentMethod = String(body.paymentMethod || 'Transferencia BICA').trim();
        const result = await mutateOrder(scriptUrl, token, orderId, order => {
          order.paymentConfirmedAt = new Date().toISOString();
          order.paymentMethod = paymentMethod;
          order.remitoNumber = remitoNumber(order);
          order.remitoGeneratedAt = new Date().toISOString();
          order.status = 'Remito generado';
        });
        if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
        const remitoUrl = await signedUrl(req, token, '/remito', orderId, 'remito');
        return Response.json({ ok: true, order: await safeOrder(result.order, req, token), remitoUrl });
      }

      return Response.json({ ok: false, error: 'Acción no permitida' }, { status: 400 });
    }

    return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
};

export const config = { path: '/quote-api' };
