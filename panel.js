const SESSION_KEY='mtSellerSession';
const $=id=>document.getElementById(id);
let seller=null,clientLink='';
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(n)||0);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2200)}
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
  }catch{redirectToLogin()}
}
function orderItems(order){return (order.items||[]).map(i=>`${esc(i.qty)} × ${esc(i.desc)}`).join('<br>')||'Sin detalle';}
function orderStatus(order){if(order.paymentConfirmedAt)return'Pago confirmado';if(order.receiptUploadedAt)return'Comprobante recibido';if(order.shippingQuotedAt)return'Envío cotizado';if(order.shippingRequestedAt)return'Esperando cotización';return order.status||'Pedido recibido'}
async function quoteLink(order){
  try{const u='/quote-api?'+new URLSearchParams({action:'link',orderId:order.id,sellerId:seller.dni});const r=await fetch(u);const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'No se pudo abrir');location.href=j.quoteUrl}catch(e){toast(e.message)}
}
function renderOrders(orders){
  $('activeOrders').textContent=orders.length;$('quoteOrders').textContent=orders.filter(o=>!o.shippingQuotedAt).length;$('paidOrders').textContent=orders.filter(o=>o.paymentConfirmedAt).length;
  if(!orders.length){$('ordersList').innerHTML='<div class="empty-card">Todavía no tenés pedidos activos.</div>';return}
  $('ordersList').innerHTML=orders.map((o,idx)=>`<article class="order-card">
    <div class="order-top"><div><div class="order-id">Pedido ${esc(o.id)}</div><h3>${esc(o.customer||'Cliente')}</h3><div class="order-meta">${esc(o.createdAt||'')}</div></div><span class="order-status">${esc(orderStatus(o))}</span></div>
    <div class="order-body"><div class="order-items">${orderItems(o)}</div><div class="order-total"><span>Total</span><strong>${money(o.total)}</strong>${o.shippingQuotedAt?`<span>Envío ${money(o.shipping)}</span>`:''}</div></div>
    <div class="order-actions">
      ${!o.shippingQuotedAt?`<button class="primary" data-quote="${idx}">Cotizar envío</button>`:''}
      ${o.receiptUrl?`<a href="${esc(o.receiptUrl)}" target="_blank" rel="noopener">Ver comprobante</a>`:''}
      ${o.remitoUrl?`<a href="${esc(o.remitoUrl)}" target="_blank" rel="noopener">Ver remito</a>`:''}
    </div>
  </article>`).join('');
  document.querySelectorAll('[data-quote]').forEach(btn=>btn.addEventListener('click',()=>quoteLink(orders[Number(btn.dataset.quote)])));
}
async function loadOrders(){
  $('ordersList').innerHTML='<div class="empty-card">Cargando pedidos...</div>';
  try{const q=new URLSearchParams({action:'sellerOrders',sellerId:seller.dni,phone:seller.phone});const r=await fetch('/quote-api?'+q);const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'No se pudieron cargar los pedidos');renderOrders(j.orders||[])}catch(e){$('ordersList').innerHTML=`<div class="empty-card">${esc(e.message)}</div>`;$('activeOrders').textContent='—';$('quoteOrders').textContent='—';$('paidOrders').textContent='—'}
}
async function logout(){try{await fetch('/seller-auth',{method:'POST',headers:{'content-type':'application/json',...auth()},body:JSON.stringify({action:'logout'})})}catch{}sessionStorage.removeItem(SESSION_KEY);location.href='/#espacio'}
async function copyLink(){if(!clientLink)return;try{await navigator.clipboard.writeText(clientLink);toast('Enlace copiado.')}catch{toast('No se pudo copiar el enlace.')}
async function changePassword(){
  const cur=$('currentPassword').value,n1=$('newPassword').value,n2=$('newPassword2').value,status=$('passwordStatus');status.className='status';status.textContent='';
  if(!cur||!n1||!n2){status.classList.add('error');status.textContent='Completá las tres casillas.';return}if(n1!==n2){status.classList.add('error');status.textContent='Las nuevas contraseñas no coinciden.';return}if(n1.length<6){status.classList.add('error');status.textContent='La nueva contraseña debe tener al menos 6 caracteres.';return}
  const btn=$('changePasswordBtn'),old=btn.textContent;btn.disabled=true;btn.textContent='Guardando...';
  try{await accountApi({action:'changePassword',currentPassword:cur,newPassword:n1});$('currentPassword').value='';$('newPassword').value='';$('newPassword2').value='';status.classList.add('ok');status.textContent='Contraseña actualizada.';toast('Contraseña actualizada.')}catch(e){status.classList.add('error');status.textContent=e.message}finally{btn.disabled=false;btn.textContent=old}
}
$('copyLinkBtn').addEventListener('click',copyLink);$('logoutBtn').addEventListener('click',logout);$('refreshOrders').addEventListener('click',loadOrders);$('changePasswordBtn').addEventListener('click',changePassword);
loadSeller();
