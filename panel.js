const SESSION_KEY='mtSellerSession';
const PAYMENT_ALIAS='mate.topp.scc';
const PAYMENT_BANK='Banco BICA';
const $=id=>document.getElementById(id);
let seller=null,clientLink='',firstOrdersLoad=true,refreshTimer=null;
const orderSnapshots=new Map();
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(n)||0);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#039;'}[c]));
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2800)}
function token(){return sessionStorage.getItem(SESSION_KEY)||''}
function auth(){return {'authorization':'Bearer '+token()}}
async function sellerApi(payload){const r=await fetch('/seller-auth',{method:'POST',headers:{'content-type':'application/json',...auth()},body:JSON.stringify(payload)});const j=await r.json().catch(()=>({ok:false}));if(!r.ok||!j.ok)throw new Error(j.error||'No se pudo cargar');return j}
async function accountApi(payload){const r=await fetch('/seller-account',{method:'POST',headers:{'content-type':'application/json',...auth()},body:JSON.stringify(payload)});const j=await r.json().catch(()=>({ok:false}));if(!r.ok||!j.ok)throw new Error(j.error||'No se pudo guardar');return j}
function redirectToLogin(){sessionStorage.removeItem(SESSION_KEY);location.href='/#espacio'}
async function loadSeller(){
  if(!token()) return redirectToLogin();
  try{
    const data=await sellerApi({action:'me'});seller=data.seller;clientLink=data.clientLink||'';
    $('welcomeTitle').textContent=`Hola, ${seller.firstName}.`;$('clientLink').textContent=clientLink||'—';
    $('sellerName').textContent=seller.name||`${seller.firstName} ${seller.lastName}`;$('sellerPhone').textContent=seller.phone||'—';$('sellerEmail').textContent=seller.email||'—';$('sellerDni').textContent=seller.dni||'—';
    await loadOrders();
    startAutoRefresh();
  }catch{redirectToLogin()}
}
function orderItems(order){return (order.items||[]).map(i=>`${esc(i.qty)} × ${esc(i.desc)}`).join('<br>')||'Sin detalle';}
function orderStatus(order){if(order.cancelledAt)return'Cancelado';if(order.paymentConfirmedAt)return'Pago confirmado';if(order.receiptUploadedAt)return'Comprobante recibido';if(order.paymentSentAt)return'Esperando pago';if(order.shippingQuotedAt)return'Envío cotizado';if(order.shippingRequestedAt)return'Esperando cotización';return order.status||'Pedido recibido'}
function fingerprint(order){return [orderStatus(order),order.shippingRequestedAt,order.shippingQuotedAt,order.paymentSentAt,order.receiptUploadedAt,order.paymentConfirmedAt,order.cancelledAt,order.total].join('|')}
function notifyChanges(orders){
  for(const o of orders){
    const next=fingerprint(o),prev=orderSnapshots.get(String(o.id));
    if(!firstOrdersLoad&&prev&&prev!==next) toast(`Pedido ${o.id}: ${orderStatus(o)}`);
    orderSnapshots.set(String(o.id),next);
  }
  firstOrdersLoad=false;
}
async function orderAction(action,order,extra={}){
  const r=await fetch('/quote-api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,orderId:order.id,sellerId:seller.dni,...extra})});
  const j=await r.json().catch(()=>({ok:false}));
  if(!r.ok||!j.ok)throw new Error(j.error||'No se pudo actualizar el pedido');
  return j;
}
async function requestShipping(order){
  try{
    await orderAction('requestShipping',order);
    toast('Cotización solicitada a Mate Topp®.');
    await loadOrders(false);
  }catch(e){toast(e.message)}
}
function normalizeWhatsApp(value=''){
  let digits=String(value||'').replace(/\D/g,'');
  if(!digits)return'';
  if(digits.startsWith('549'))return digits;
  if(digits.startsWith('54'))return digits.startsWith('549')?digits:'549'+digits.slice(2).replace(/^0+/,'');
  return '549'+digits.replace(/^0+/,'');
}
async function sendQuoteToClient(order){
  if(!order.shippingQuotedAt){toast('Todavía falta cotizar el envío.');return}
  try{
    await orderAction('markAwaitingPayment',order);
    const phone=normalizeWhatsApp(order.customerPhone);
    const text=[
      `Hola${order.customer?' '+order.customer:''}, tu pedido de Mate Topp® ya está cotizado.`,
      '',
      `Productos: ${money(order.subtotal)}`,
      `Envío: ${money(order.shipping)}`,
      `Total: ${money(order.total)}`,
      `Estado: esperando pago`,
      '',
      `Alias: ${PAYMENT_ALIAS}`,
      `${PAYMENT_BANK}`,
      '',
      'Cuando realices el pago, enviame el comprobante por este medio.'
    ].join('\n');
    if(phone) window.open('https://wa.me/'+phone+'?text='+encodeURIComponent(text),'_blank','noopener');
    else if(navigator.share) await navigator.share({title:'Pedido Mate Topp®',text});
    else await navigator.clipboard.writeText(text);
    toast('Total y datos de pago listos para el cliente.');
    await loadOrders(false);
  }catch(e){toast(e.message)}
}
function renderOrders(orders){
  $('activeOrders').textContent=orders.length;
  $('quoteOrders').textContent=orders.filter(o=>o.shippingRequestedAt&&!o.shippingQuotedAt).length;
  $('paidOrders').textContent=orders.filter(o=>o.paymentConfirmedAt).length;
  if(!orders.length){$('ordersList').innerHTML='<div class="empty-card">Todavía no tenés pedidos activos.</div>';return}
  $('ordersList').innerHTML=orders.map((o,idx)=>{
    const quoted=Boolean(o.shippingQuotedAt),requested=Boolean(o.shippingRequestedAt),waitingPay=Boolean(o.paymentSentAt);
    return `<article class="order-card">
      <div class="order-top"><div><div class="order-id">Pedido ${esc(o.id)}</div><h3>${esc(o.customer||'Cliente')}</h3><div class="order-meta">${esc(o.createdAt||'')}</div></div><span class="order-status">${esc(orderStatus(o))}</span></div>
      <div class="order-body"><div class="order-items">${orderItems(o)}</div><div class="order-total"><span>Productos</span><strong>${money(o.subtotal)}</strong>${quoted?`<span>Envío ${money(o.shipping)}</span><span class="final-total">Total ${money(o.total)}</span>`:''}</div></div>
      ${quoted?`<div class="quote-ready"><strong>Cotización lista</strong><span>Alias de pago: <b>${PAYMENT_ALIAS}</b> · ${PAYMENT_BANK}</span><span>Total final: <b>${money(o.total)}</b></span></div>`:''}
      <div class="order-actions">
        ${!requested&&!quoted?`<button class="primary" data-request="${idx}">Solicitar cotización de envío</button>`:''}
        ${requested&&!quoted?`<button class="waiting" type="button" disabled>Esperando cotización de Mate Topp®</button>`:''}
        ${quoted&&!o.paymentConfirmedAt?`<button class="primary" data-send="${idx}">${waitingPay?'Reenviar total al cliente':'Enviar total al cliente'}</button>`:''}
        ${o.receiptUrl?`<a href="${esc(o.receiptUrl)}" target="_blank" rel="noopener">Ver comprobante</a>`:''}
        ${o.remitoUrl?`<a href="${esc(o.remitoUrl)}" target="_blank" rel="noopener">Ver remito</a>`:''}
      </div>
    </article>`
  }).join('');
  document.querySelectorAll('[data-request]').forEach(btn=>btn.addEventListener('click',()=>requestShipping(orders[Number(btn.dataset.request)])));
  document.querySelectorAll('[data-send]').forEach(btn=>btn.addEventListener('click',()=>sendQuoteToClient(orders[Number(btn.dataset.send)])));
}
async function loadOrders(showLoading=true){
  if(showLoading)$('ordersList').innerHTML='<div class="empty-card">Cargando pedidos...</div>';
  try{
    const q=new URLSearchParams({action:'sellerOrders',sellerId:seller.dni,phone:seller.phone});
    const r=await fetch('/quote-api?'+q,{cache:'no-store'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'No se pudieron cargar los pedidos');
    notifyChanges(j.orders||[]);renderOrders(j.orders||[]);
  }catch(e){if(showLoading)$('ordersList').innerHTML=`<div class="empty-card">${esc(e.message)}</div>`;$('activeOrders').textContent='—';$('quoteOrders').textContent='—';$('paidOrders').textContent='—'}
}
function startAutoRefresh(){
  clearInterval(refreshTimer);
  refreshTimer=setInterval(()=>{if(document.visibilityState==='visible'&&seller)loadOrders(false)},20000);
}
async function logout(){try{await fetch('/seller-auth',{method:'POST',headers:{'content-type':'application/json',...auth()},body:JSON.stringify({action:'logout'})})}catch{}clearInterval(refreshTimer);sessionStorage.removeItem(SESSION_KEY);location.href='/#espacio'}
async function copyLink(){if(!clientLink)return;try{await navigator.clipboard.writeText(clientLink);toast('Enlace copiado.')}catch{toast('No se pudo copiar el enlace.')}
async function changePassword(){
  const cur=$('currentPassword').value,n1=$('newPassword').value,n2=$('newPassword2').value,status=$('passwordStatus');status.className='status';status.textContent='';
  if(!cur||!n1||!n2){status.classList.add('error');status.textContent='Completá las tres casillas.';return}if(n1!==n2){status.classList.add('error');status.textContent='Las nuevas contraseñas no coinciden.';return}if(n1.length<6){status.classList.add('error');status.textContent='La nueva contraseña debe tener al menos 6 caracteres.';return}
  const btn=$('changePasswordBtn'),old=btn.textContent;btn.disabled=true;btn.textContent='Guardando...';
  try{await accountApi({action:'changePassword',currentPassword:cur,newPassword:n1});$('currentPassword').value='';$('newPassword').value='';$('newPassword2').value='';status.classList.add('ok');status.textContent='Contraseña actualizada.';toast('Contraseña actualizada.')}catch(e){status.classList.add('error');status.textContent=e.message}finally{btn.disabled=false;btn.textContent=old}
}
$('copyLinkBtn').addEventListener('click',copyLink);$('logoutBtn').addEventListener('click',logout);$('refreshOrders').addEventListener('click',()=>loadOrders(true));$('changePasswordBtn').addEventListener('click',changePassword);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&seller)loadOrders(false)});
loadSeller();
