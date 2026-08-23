import { getStore, getDeployStore } from '@netlify/blobs';

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
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
async function validAdmin(req: Request, token: string) {
  const value = cookie(req, 'mt_admin');
  const [expRaw, sig] = value.split('.');
  const exp = Number(expRaw);
  if (!exp || exp < Date.now() || !sig) return false;
  const expected = await hmacHex(token, `admin:${exp}`);
  return equal(sig, expected);
}
function expertStore() {
  const production = Netlify.context?.deploy?.context === 'production';
  return production
    ? getStore('mate-topp-expert-accounts', { consistency: 'strong' })
    : getDeployStore('mate-topp-expert-accounts');
}
async function getState(scriptUrl: string, token: string) {
  const target = new URL(scriptUrl); target.searchParams.set('token', token);
  const r = await fetch(target, { redirect: 'follow' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok || !j?.state) throw new Error(j?.error || 'No se pudo leer el sistema');
  return j;
}
async function saveState(scriptUrl: string, token: string, revision: number, state: any) {
  const r = await fetch(scriptUrl, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({token, revision, state}), redirect:'follow' });
  const j = await r.json().catch(() => null);
  return { response:r, json:j };
}
function ordersOf(state:any){ return Array.isArray(state?.orders) ? state.orders : []; }
function findOrder(state:any,id:string){ return ordersOf(state).find((o:any)=>String(o?.id||'')===id)||null; }
async function mutate(scriptUrl:string,token:string,id:string,fn:(o:any)=>void){
  for(let attempt=0;attempt<3;attempt++){
    const data=await getState(scriptUrl,token); const order=findOrder(data.state,id);
    if(!order)return{ok:false,status:404,error:'Pedido no encontrado'};
    fn(order);
    const saved=await saveState(scriptUrl,token,Number(data.revision),data.state);
    if(saved.response.ok&&saved.json?.ok)return{ok:true,order};
    if(saved.json?.error!=='conflict')throw new Error(saved.json?.error||'No se pudo guardar');
  }
  return{ok:false,status:409,error:'El pedido cambió. Probá de nuevo.'};
}
async function trackingPage(req:Request,token:string,orderId:string){
  const sig=await hmacHex(token,`tracking:${orderId}`); const u=new URL('/seguimiento',req.url);
  u.searchParams.set('pedido',orderId); u.searchParams.set('firma',sig); return u.toString();
}
function trackingRecord(order:any){
  return {
    id:String(order?.id||''), status:String(order?.status||''), sellerId:String(order?.sellerId||''), sellerPhone:String(order?.sellerPhone||''),
    customer:String(order?.cust||order?.customer||order?.customerName||''), customerPhone:String(order?.customerPhone||''),
    paymentConfirmedAt:String(order?.paymentConfirmedAt||''), remitoNumber:String(order?.remitoNumber||''),
    carrier:String(order?.carrier||order?.transportista||''), trackingCode:String(order?.trackingCode||order?.codigoSeguimiento||''),
    trackingLink:String(order?.trackingLink||order?.linkSeguimiento||''), dispatchedAt:String(order?.dispatchedAt||order?.fechaDespacho||''),
    finalizedAt:String(order?.finalizedAt||'')
  };
}
async function listExperts(){
  const s=expertStore(); const listed:any=await s.list({prefix:'account/'}); const blobs=listed?.blobs||[]; const out:any[]=[];
  for(const item of blobs.slice(0,500)){
    const a:any=await s.get(item.key,{type:'json'}); if(!a?.phone)continue;
    out.push({phone:a.phone,firstName:a.firstName||'',lastName:a.lastName||'',slug:a.slug||'',sellerId:a.sellerId||'',zone:a.zone||'Argentina',publicPriority:Number(a.publicPriority)||0,b2b:Boolean(a.b2b),createdAt:a.createdAt||''});
  }
  return out.sort((a,b)=>(b.publicPriority-a.publicPriority)||String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function updateExpert(phone:string,zone:string,priority:number){
  const s=expertStore(); const key=`account/${phone}`; const a:any=await s.get(key,{type:'json'});
  if(!a)throw new Error('Experto no encontrado');
  a.zone=zone.trim()||'Argentina'; a.publicPriority=Math.max(-999,Math.min(999,Math.trunc(priority||0)));
  await s.setJSON(key,a); return a;
}

export default async(req:Request)=>{
  const scriptUrl=Netlify.env.get('APPS_SCRIPT_URL'); const token=Netlify.env.get('APPS_SCRIPT_TOKEN');
  if(!scriptUrl||!token)return Response.json({ok:false,error:'Backend no configurado'},{status:500});
  try{
    const url=new URL(req.url);
    if(req.method==='GET'){
      const action=url.searchParams.get('action')||'';
      if(action==='trackingPublic'){
        const orderId=(url.searchParams.get('orderId')||url.searchParams.get('pedido')||'').trim(); const sig=url.searchParams.get('sig')||url.searchParams.get('firma')||'';
        if(!orderId)return Response.json({ok:false,error:'Falta el pedido'},{status:400});
        const expected=await hmacHex(token,`tracking:${orderId}`); if(!sig||sig!==expected)return Response.json({ok:false,error:'Enlace inválido'},{status:403});
        const data=await getState(scriptUrl,token); const order=findOrder(data.state,orderId); if(!order)return Response.json({ok:false,error:'Pedido no encontrado'},{status:404});
        const t=trackingRecord(order);
        return Response.json({ok:true,tracking:{id:t.id,status:t.status,carrier:t.carrier,trackingCode:t.trackingCode,trackingLink:t.trackingLink,dispatchedAt:t.dispatchedAt,finalizedAt:t.finalizedAt}});
      }
      if(action==='sellerTracking'){
        const sellerId=(url.searchParams.get('sellerId')||'').trim(); const phone=(url.searchParams.get('phone')||'').replace(/\D/g,'');
        if(!sellerId&&!phone)return Response.json({ok:false,error:'Falta el acceso'},{status:400});
        const data=await getState(scriptUrl,token); const matches=ordersOf(data.state).filter((o:any)=>sellerId?String(o?.sellerId||'')===sellerId:String(o?.sellerPhone||'').replace(/\D/g,'')===phone);
        const tracking=await Promise.all(matches.map(async(o:any)=>({...trackingRecord(o),publicTrackingUrl:o?.dispatchedAt?await trackingPage(req,token,String(o.id||'')):''})));
        return Response.json({ok:true,tracking},{headers:{'cache-control':'no-store'}});
      }
      if(!(await validAdmin(req,token)))return Response.json({ok:false,error:'No autorizado'},{status:401});
      if(action==='adminTracking'){
        const data=await getState(scriptUrl,token); const tracking=await Promise.all(ordersOf(data.state).map(async(o:any)=>({...trackingRecord(o),publicTrackingUrl:o?.dispatchedAt?await trackingPage(req,token,String(o.id||'')):''})));
        return Response.json({ok:true,tracking},{headers:{'cache-control':'no-store'}});
      }
      if(action==='experts')return Response.json({ok:true,experts:await listExperts()},{headers:{'cache-control':'no-store'}});
      return Response.json({ok:false,error:'Acción no permitida'},{status:400});
    }
    if(req.method==='POST'){
      const body=await req.json().catch(()=>({})); const action=String(body.action||'');
      if(!(await validAdmin(req,token)))return Response.json({ok:false,error:'No autorizado'},{status:401});
      if(action==='dispatchOrder'){
        const id=String(body.orderId||'').trim(),carrier=String(body.carrier||'').trim(),trackingCode=String(body.trackingCode||'').trim(),trackingLink=String(body.trackingLink||'').trim();
        if(!id||!carrier)return Response.json({ok:false,error:'Completá pedido y transportista'},{status:400});
        if(trackingLink&&!/^https?:\/\//i.test(trackingLink))return Response.json({ok:false,error:'El link de seguimiento no es válido'},{status:400});
        const result=await mutate(scriptUrl,token,id,o=>{if(!o.paymentConfirmedAt)throw new Error('Primero confirmá el pago');o.carrier=carrier;o.trackingCode=trackingCode;o.trackingLink=trackingLink;o.dispatchedAt=new Date().toISOString();o.status='Pedido despachado';});
        if(!result.ok)return Response.json({ok:false,error:result.error},{status:result.status});
        return Response.json({ok:true,tracking:{...trackingRecord(result.order),publicTrackingUrl:await trackingPage(req,token,id)}});
      }
      if(action==='finalizeOrder'){
        const id=String(body.orderId||'').trim(); if(!id)return Response.json({ok:false,error:'Falta el pedido'},{status:400});
        const result=await mutate(scriptUrl,token,id,o=>{if(!o.dispatchedAt)throw new Error('Primero marcá el pedido como despachado');o.finalizedAt=new Date().toISOString();o.status='Pedido finalizado';});
        if(!result.ok)return Response.json({ok:false,error:result.error},{status:result.status});
        return Response.json({ok:true,tracking:{...trackingRecord(result.order),publicTrackingUrl:await trackingPage(req,token,id)}});
      }
      if(action==='updateExpert'){
        const phone=String(body.phone||'').replace(/\D/g,''),zone=String(body.zone||'').trim()||'Argentina',priority=Number(body.publicPriority)||0;
        if(!phone)return Response.json({ok:false,error:'Falta el Experto'},{status:400}); const a=await updateExpert(phone,zone,priority);
        return Response.json({ok:true,expert:{phone:a.phone,firstName:a.firstName||'',lastName:a.lastName||'',slug:a.slug||'',zone:a.zone||'Argentina',publicPriority:Number(a.publicPriority)||0}});
      }
      return Response.json({ok:false,error:'Acción no permitida'},{status:400});
    }
    return Response.json({ok:false,error:'Método no permitido'},{status:405});
  }catch(error){return Response.json({ok:false,error:String(error instanceof Error?error.message:error)},{status:500});}
};

export const config={path:'/workflow-api'};
