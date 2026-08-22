const enc = new TextEncoder();
const ADMIN_PIN_SHA256 = 'f10b2dc6e8c0095bc99fb4c2293c050f2253a105ae13c4fb23bf1860a1637e1e';

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0; for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i); return out === 0;
}
function cookie(req: Request, name: string) {
  const raw = req.headers.get('cookie') || '';
  const part = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
async function validSession(req: Request, token: string) {
  const value = cookie(req, 'mt_admin');
  const [expRaw, sig] = value.split('.');
  const exp = Number(expRaw);
  if (!exp || exp < Date.now() || !sig) return false;
  const expected = await hmacHex(token, `admin:${exp}`);
  return equal(sig, expected);
}
async function sessionCookie(token: string) {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const sig = await hmacHex(token, `admin:${exp}`);
  return `mt_admin=${encodeURIComponent(`${exp}.${sig}`)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`;
}
async function getState(scriptUrl: string, token: string) {
  const target = new URL(scriptUrl); target.searchParams.set('token', token);
  const r = await fetch(target, { redirect: 'follow' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok || !j?.state) throw new Error(j?.error || 'No se pudo leer el sistema');
  return j;
}
async function saveState(scriptUrl: string, token: string, revision: number, state: any) {
  const r = await fetch(scriptUrl, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({token,revision,state}), redirect:'follow' });
  const j = await r.json().catch(() => null); return { response:r, json:j };
}
function ordersOf(state:any){ return Array.isArray(state?.orders) ? state.orders : []; }
function findOrder(state:any,id:string){ return ordersOf(state).find((o:any)=>String(o?.id||'')===id)||null; }
function subtotal(o:any){ return (Array.isArray(o?.items)?o.items:[]).reduce((s:number,i:any)=>s+(Number(i?.qty)||0)*(Number(i?.price)||0),0); }
function isCancelled(o:any){ return Boolean(o?.cancelledAt)||String(o?.status||'').toLowerCase()==='cancelado'; }
function remitoNumber(order:any){ if(order?.remitoNumber)return String(order.remitoNumber);const raw=String(order?.id||'').replace(/[^0-9]/g,'');const tail=raw.slice(-6)||String(Date.now()).slice(-6);const date=new Date().toISOString().slice(0,10).replaceAll('-','');return `REM-${date}-${tail}`; }
async function signedUrl(req:Request,secret:string,path:string,orderId:string,kind:string){const sig=await hmacHex(secret,`${kind}:${orderId}`);const u=new URL(path,req.url);u.searchParams.set('pedido',orderId);u.searchParams.set('firma',sig);return u.toString();}
async function safeOrder(o:any,req:Request,secret:string){const sub=subtotal(o),shipping=Number(o?.shipping)||0;const out:any={id:String(o?.id||''),customer:String(o?.cust||o?.customer||o?.customerName||''),customerPhone:String(o?.customerPhone||''),address:String(o?.addr||o?.address||''),notes:String(o?.notes||''),status:String(o?.status||''),seller:String(o?.seller||o?.sellerName||''),sellerId:String(o?.sellerId||''),sellerPhone:String(o?.sellerPhone||''),createdAt:String(o?.date||o?.createdAt||''),items:Array.isArray(o?.items)?o.items.map((i:any)=>({desc:String(i?.desc||''),qty:Number(i?.qty)||0,price:Number(i?.price)||0})):[],subtotal:sub,shipping,total:sub+shipping+(Number(o?.adj)||0),shippingRequestedAt:String(o?.shippingRequestedAt||''),shippingQuotedAt:String(o?.shippingQuotedAt||''),paymentSentAt:String(o?.paymentSentAt||''),paymentLinkRequestedAt:String(o?.paymentLinkRequestedAt||''),paymentLink:String(o?.paymentLink||''),paymentLinkReadyAt:String(o?.paymentLinkReadyAt||''),paymentLinkSentAt:String(o?.paymentLinkSentAt||''),receiptUploadedAt:String(o?.receiptUploadedAt||''),receiptName:String(o?.receiptName||''),receiptType:String(o?.receiptType||''),paymentConfirmedAt:String(o?.paymentConfirmedAt||''),paymentMethod:String(o?.paymentMethod||''),remitoNumber:String(o?.remitoNumber||''),remitoGeneratedAt:String(o?.remitoGeneratedAt||''),cancelledAt:String(o?.cancelledAt||''),cancelReason:String(o?.cancelReason||''),cancelledBy:String(o?.cancelledBy||'')};if(o?.receiptKey)out.receiptUrl=await signedUrl(req,secret,'/receipt-api',out.id,'receipt');if(o?.paymentConfirmedAt&&o?.receiptUploadedAt&&o?.receiptKey)out.remitoUrl=await signedUrl(req,secret,'/remito',out.id,'remito');return out;}
async function mutate(scriptUrl:string,token:string,id:string,fn:(o:any)=>void){for(let a=0;a<3;a++){const data=await getState(scriptUrl,token);const o=findOrder(data.state,id);if(!o)return{ok:false,status:404,error:'Pedido no encontrado'};fn(o);const saved=await saveState(scriptUrl,token,Number(data.revision),data.state);if(saved.response.ok&&saved.json?.ok)return{ok:true,order:o};if(saved.json?.error!=='conflict')throw new Error(saved.json?.error||'No se pudo guardar');}return{ok:false,status:409,error:'El pedido cambió. Probá de nuevo.'};}

export default async (req: Request) => {
  const scriptUrl = Netlify.env.get('APPS_SCRIPT_URL');
  const token = Netlify.env.get('APPS_SCRIPT_TOKEN');
  if (!scriptUrl || !token) return Response.json({ok:false,error:'Panel administrativo no configurado'},{status:500});
  try {
    if (req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const action = String(body.action||'');
      if (action === 'login') {
        const enteredHash = await sha256Hex(String(body.pin||''));
        if (!equal(enteredHash, ADMIN_PIN_SHA256)) return Response.json({ok:false,error:'Clave incorrecta'},{status:401});
        return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json; charset=utf-8','set-cookie':await sessionCookie(token)}});
      }
      if (!(await validSession(req,token))) return Response.json({ok:false,error:'Sesión vencida'},{status:401});
      if (action === 'logout') return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json; charset=utf-8','set-cookie':'mt_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}});
      const id=String(body.orderId||'').trim(); if(!id)return Response.json({ok:false,error:'Falta el pedido'},{status:400});

      if(action==='setShipping'){
        const shipping=Number(body.shipping);if(!Number.isFinite(shipping)||shipping<0)return Response.json({ok:false,error:'Costo de envío inválido'},{status:400});
        const result=await mutate(scriptUrl,token,id,o=>{if(isCancelled(o))throw new Error('El pedido está cancelado');o.shipping=shipping;o.shippingQuotedAt=new Date().toISOString();o.status='Envío cotizado';});
        if(!result.ok)return Response.json({ok:false,error:result.error},{status:result.status});return Response.json({ok:true,order:await safeOrder(result.order,req,token)});
      }
      if(action==='setPaymentLink'){
        const paymentLink=String(body.paymentLink||'').trim();if(!/^https?:\/\//i.test(paymentLink))return Response.json({ok:false,error:'Pegá un link válido de Mercado Pago'},{status:400});
        const result=await mutate(scriptUrl,token,id,o=>{if(isCancelled(o))throw new Error('El pedido está cancelado');o.paymentLink=paymentLink;o.paymentLinkReadyAt=new Date().toISOString();if(!o.paymentLinkRequestedAt)o.paymentLinkRequestedAt=new Date().toISOString();if(!o.paymentSentAt)o.paymentSentAt=new Date().toISOString();o.status='Esperando pago';});
        if(!result.ok)return Response.json({ok:false,error:result.error},{status:result.status});return Response.json({ok:true,order:await safeOrder(result.order,req,token)});
      }
      if(action==='confirmPayment'){
        const method=String(body.paymentMethod||'Transferencia BICA').trim();
        const first=await getState(scriptUrl,token);const existing=findOrder(first.state,id);if(!existing)return Response.json({ok:false,error:'Pedido no encontrado'},{status:404});if(!existing.receiptUploadedAt||!existing.receiptKey)return Response.json({ok:false,error:'No se puede confirmar: falta el comprobante cargado'},{status:409});if(isCancelled(existing))return Response.json({ok:false,error:'El pedido está cancelado'},{status:409});
        const result=await mutate(scriptUrl,token,id,o=>{if(!o.receiptUploadedAt||!o.receiptKey)throw new Error('Falta el comprobante cargado');o.paymentConfirmedAt=new Date().toISOString();o.paymentMethod=method;o.remitoNumber=remitoNumber(o);o.remitoGeneratedAt=new Date().toISOString();o.status='Remito generado';});
        if(!result.ok)return Response.json({ok:false,error:result.error},{status:result.status});return Response.json({ok:true,order:await safeOrder(result.order,req,token)});
      }
      if(action==='cancelOrder'){
        const reason=String(body.reason||'').trim()||'Sin motivo informado';const result=await mutate(scriptUrl,token,id,o=>{if(o.paymentConfirmedAt)throw new Error('Un pedido con pago confirmado no puede cancelarse');o.cancelledAt=new Date().toISOString();o.cancelReason=reason;o.cancelledBy='Mate Topp';o.status='Cancelado';});
        if(!result.ok)return Response.json({ok:false,error:result.error},{status:result.status});return Response.json({ok:true,order:await safeOrder(result.order,req,token)});
      }
      return Response.json({ok:false,error:'Acción no permitida'},{status:400});
    }

    if (req.method === 'GET') {
      if (!(await validSession(req,token))) return Response.json({ok:false,error:'No autorizado'},{status:401});
      const url=new URL(req.url),action=url.searchParams.get('action')||'orders';
      if(action==='status')return Response.json({ok:true,authenticated:true});
      if(action==='orders'){
        const data=await getState(scriptUrl,token);const raw=ordersOf(data.state);const orders=await Promise.all(raw.map((o:any)=>safeOrder(o,req,token)));
        const counts={total:orders.length,cancelled:orders.filter(isCancelled).length,shipping:orders.filter((o:any)=>!isCancelled(o)&&o.shippingRequestedAt&&!o.shippingQuotedAt).length,paymentLinks:orders.filter((o:any)=>!isCancelled(o)&&o.paymentLinkRequestedAt&&!o.paymentLink).length,receipts:orders.filter((o:any)=>!isCancelled(o)&&o.receiptUploadedAt&&!o.paymentConfirmedAt).length,confirmed:orders.filter((o:any)=>Boolean(o.paymentConfirmedAt)).length};
        return Response.json({ok:true,orders,counts});
      }
      return Response.json({ok:false,error:'Acción no permitida'},{status:400});
    }
    return Response.json({ok:false,error:'Método no permitido'},{status:405});
  } catch(error){return Response.json({ok:false,error:String(error)},{status:500});}
};

export const config = { path: '/admin-api' };
