const enc = new TextEncoder();

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
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

function findOrder(state: any, orderId: string) {
  const orders = Array.isArray(state?.orders) ? state.orders : [];
  return orders.find((o: any) => String(o?.id || '') === orderId) || null;
}

function subtotal(order: any) {
  return (Array.isArray(order?.items) ? order.items : []).reduce(
    (sum: number, i: any) => sum + (Number(i?.qty) || 0) * (Number(i?.price) || 0), 0
  );
}

function safeOrder(order: any) {
  const sub = subtotal(order);
  const shipping = Number(order?.shipping) || 0;
  return {
    id: String(order?.id || ''),
    customer: String(order?.cust || ''),
    customerPhone: String(order?.customerPhone || ''),
    address: String(order?.addr || ''),
    notes: String(order?.notes || ''),
    status: String(order?.status || ''),
    seller: String(order?.seller || ''),
    sellerId: String(order?.sellerId || ''),
    items: Array.isArray(order?.items) ? order.items.map((i: any) => ({
      desc: String(i?.desc || ''), qty: Number(i?.qty) || 0, price: Number(i?.price) || 0,
    })) : [],
    subtotal: sub,
    shipping,
    total: sub + shipping + (Number(order?.adj) || 0),
  };
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
      if (!orderId) return Response.json({ ok: false, error: 'Falta el pedido' }, { status: 400 });

      const data = await getState(scriptUrl, token);
      const order = findOrder(data.state, orderId);
      if (!order) return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });

      if (action === 'link') {
        const sellerId = (url.searchParams.get('sellerId') || '').trim();
        if (!sellerId || String(order.sellerId || '') !== sellerId) {
          return Response.json({ ok: false, error: 'No autorizado' }, { status: 403 });
        }
        const sig = await hmacHex(token, `quote:${orderId}`);
        const quote = new URL('/cotizar', req.url);
        quote.searchParams.set('pedido', orderId);
        quote.searchParams.set('firma', sig);
        return Response.json({ ok: true, quoteUrl: quote.toString() });
      }

      if (action === 'order') {
        const sig = url.searchParams.get('sig') || '';
        const expected = await hmacHex(token, `quote:${orderId}`);
        if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });
        return Response.json({ ok: true, order: safeOrder(order) });
      }

      return Response.json({ ok: false, error: 'Acción no permitida' }, { status: 400 });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (body.action !== 'quoteShipping') return Response.json({ ok: false, error: 'Acción no permitida' }, { status: 400 });
      const orderId = String(body.orderId || '').trim();
      const sig = String(body.sig || '');
      const shipping = Number(body.shipping);
      if (!orderId || !Number.isFinite(shipping) || shipping < 0) return Response.json({ ok: false, error: 'Datos inválidos' }, { status: 400 });
      const expected = await hmacHex(token, `quote:${orderId}`);
      if (!sig || sig !== expected) return Response.json({ ok: false, error: 'Enlace inválido' }, { status: 403 });

      for (let attempt = 0; attempt < 2; attempt++) {
        const data = await getState(scriptUrl, token);
        const order = findOrder(data.state, orderId);
        if (!order) return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });
        order.shipping = shipping;
        order.status = 'Envío cotizado';
        const saved = await saveState(scriptUrl, token, Number(data.revision), data.state);
        if (saved.response.ok && saved.json?.ok) {
          return Response.json({ ok: true, order: safeOrder(order) });
        }
        if (saved.json?.error !== 'conflict') throw new Error(saved.json?.error || 'No se pudo guardar la cotización');
      }
      return Response.json({ ok: false, error: 'El pedido cambió. Probá de nuevo.' }, { status: 409 });
    }

    return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
};

export const config = { path: '/quote-api' };
