const SESSION_KEY = 'mtSellerSession';
const PHONE_PREFIX = '549';
let currentSeller = null;
let currentClientLink = '';
let activeChannel = 'b2c';

const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(n)||0);

function normalizePhone(raw=''){
  let digits = String(raw||'').replace(/\D/g,'');
  if(digits.startsWith('549')) digits=digits.slice(3);
  else if(digits.startsWith('54')) digits=digits.slice(2);
  else if(digits.startsWith('9')) digits=digits.slice(1);
  digits=digits.replace(/^0+/,'').slice(0,12);
  return PHONE_PREFIX+digits;
}
function normalizeDni(raw=''){return String(raw||'').replace(/\D/g,'').slice(0,9)}
function bindPhone(input){
  if(!input) return;
  input.value=normalizePhone(input.value||PHONE_PREFIX);
  input.addEventListener('focus',()=>{input.value=normalizePhone(input.value);requestAnimationFrame(()=>input.setSelectionRange(input.value.length,input.value.length))});
  input.addEventListener('input',()=>{input.value=normalizePhone(input.value)});
  input.addEventListener('keydown',e=>{const start=input.selectionStart||0;if((e.key==='Backspace'&&start<=3)||(e.key==='Delete'&&start<3))e.preventDefault()});
}
function bindDni(input){if(!input)return;input.addEventListener('input',()=>input.value=normalizeDni(input.value))}
function toast(message){
  const el=$('portalToast'); if(!el)return;
  el.textContent=message;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2600);
}
function setStatus(id,message,type=''){
  const el=$(id);if(!el)return;el.textContent=message||'';el.className='portal-status'+(type?' '+type:'');
}
function openModal(id){const el=$(id);if(el){el.classList.add('open');el.setAttribute('aria-hidden','false');document.body.style.overflow='hidden'}}
function closeModal(id){const el=$(id);if(el){el.classList.remove('open');el.setAttribute('aria-hidden','true');document.body.style.overflow=''}}
function authHeaders(){const token=sessionStorage.getItem(SESSION_KEY)||'';return token?{'authorization':'Bearer '+token}:{}}
async function sellerApi(payload,useAuth=false){
  const r=await fetch('/seller-auth',{method:'POST',headers:{'content-type':'application/json',...(useAuth?authHeaders():{})},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({ok:false,error:'Respuesta inválida'}));
  if(!r.ok||!j.ok)throw new Error(j.error||'No se pudo completar la operación.');
  return j;
}
function ensureAccessUi(){
  const fields=$('greenDni')?.closest('.private-login-fields');
  const middle=fields?.parentElement;
  if(middle&&!$('greenSessionEntry')){
    const session=document.createElement('div');
    session.id='greenSessionEntry';
    session.className='private-session-entry';
    session.hidden=true;
    middle.appendChild(session);
  }
}
function showLoggedOutView(){
  ensureAccessUi();
  currentSeller=null;currentClientLink='';
  if($('sellerGreeting'))$('sellerGreeting').textContent='Hola.';
  if($('clientLink'))$('clientLink').textContent='Creá tu usuario o ingresá para ver tu enlace';
  const fields=$('greenDni')?.closest('.private-login-fields');if(fields)fields.hidden=false;
  if($('forgotGreen'))$('forgotGreen').hidden=false;
  if($('greenLoginMsg')){$('greenLoginMsg').hidden=false;$('greenLoginMsg').textContent='';}
  if($('greenSessionEntry')){$('greenSessionEntry').hidden=true;$('greenSessionEntry').textContent='';}
  if($('greenLoginBtn'))$('greenLoginBtn').textContent='Ingresar';
  if($('greenDni'))$('greenDni').value='';
  if($('greenPassword'))$('greenPassword').value='';
}
function applySeller(data){
  ensureAccessUi();
  currentSeller=data.seller||null;currentClientLink=data.clientLink||'';
  if(!currentSeller)return;
  activeChannel=currentSeller.channel==='b2b'?'b2b':'b2c';
  $('sellerGreeting').textContent=`Hola, ${currentSeller.firstName}.`;
  $('clientLink').textContent=currentClientLink||'Enlace disponible al ingresar';
  const fields=$('greenDni')?.closest('.private-login-fields');if(fields)fields.hidden=true;
  if($('forgotGreen'))$('forgotGreen').hidden=true;
  if($('greenLoginMsg')){$('greenLoginMsg').hidden=true;$('greenLoginMsg').textContent='';}
  if($('greenSessionEntry')){
    $('greenSessionEntry').hidden=false;
    $('greenSessionEntry').innerHTML=`Sesión iniciada como <strong>${currentSeller.firstName} ${currentSeller.lastName}</strong>.`;
  }
  $('greenPassword').value='';
  $('greenLoginBtn').textContent='Cerrar sesión';
  setChannel(activeChannel,false);
}
async function restoreSession(){
  ensureAccessUi();
  if(!sessionStorage.getItem(SESSION_KEY)){showLoggedOutView();return}
  try{const data=await sellerApi({action:'me'},true);applySeller(data)}
  catch{sessionStorage.removeItem(SESSION_KEY);showLoggedOutView()}
}
async function registerSeller(){
  const btn=$('createSubmit');const old=btn.textContent;
  const firstName=$('createFirstName').value.trim();
  const lastName=$('createLastName').value.trim();
  const phone=normalizePhone($('createPhone').value);
  const dni=normalizeDni($('createDni').value);
  const email=$('createEmail').value.trim();
  if(!firstName||!lastName||phone.length<12||dni.length<7||!email){setStatus('createStatus','Completá todos los datos y revisalos.','error');return}
  btn.disabled=true;btn.textContent='Guardando...';setStatus('createStatus','Creando tu usuario...');
  try{
    const data=await sellerApi({action:'register',firstName,lastName,phone,dni,email});
    sessionStorage.setItem(SESSION_KEY,data.token);applySeller(data);closeModal('createModal');
    toast('Usuario creado. Tu contraseña inicial es tu DNI.');
    setTimeout(()=>$('espacio').scrollIntoView({behavior:'smooth',block:'start'}),120);
  }catch(e){setStatus('createStatus',e.message,'error')}
  finally{btn.disabled=false;btn.textContent=old}
}
async function loginSeller(dni,password,statusId,closeId=''){
  dni=normalizeDni(dni);password=String(password||'');
  if(!dni||!password){setStatus(statusId,'Ingresá DNI y contraseña.','error');return false}
  setStatus(statusId,'Ingresando...');
  try{
    const data=await sellerApi({action:'login',dni,password});
    sessionStorage.setItem(SESSION_KEY,data.token);applySeller(data);setStatus(statusId,'');
    if(closeId)closeModal(closeId);toast(`Hola, ${data.seller.firstName}. Tu enlace ya está listo.`);
    setTimeout(()=>$('espacio').scrollIntoView({behavior:'smooth',block:'start'}),100);
    return true;
  }catch(e){setStatus(statusId,e.message,'error');return false}
}
async function logoutSeller(){
  const hadSession=Boolean(sessionStorage.getItem(SESSION_KEY));
  try{if(hadSession)await sellerApi({action:'logout'},true)}catch{}
  sessionStorage.removeItem(SESSION_KEY);
  showLoggedOutView();
  toast('Sesión cerrada.');
}
async function resetPassword(){
  const dni=normalizeDni($('resetDni').value);const phone=normalizePhone($('resetPhone').value);const email=$('resetEmail').value.trim();
  const p1=$('resetPassword').value,p2=$('resetPassword2').value;
  if(!dni||phone.length<12||!email||!p1){setStatus('resetStatus','Completá todos los datos.','error');return}
  if(p1!==p2){setStatus('resetStatus','Las contraseñas no coinciden.','error');return}
  const btn=$('resetSubmit'),old=btn.textContent;btn.disabled=true;btn.textContent='Guardando...';
  try{
    await sellerApi({action:'resetSelf',dni,phone,email,newPassword:p1});
    setStatus('resetStatus','Contraseña actualizada. Ya podés ingresar.','ok');
    setTimeout(()=>{closeModal('resetModal');$('espacio').scrollIntoView({behavior:'smooth',block:'start'});setTimeout(()=>$('greenDni').focus(),450)},700)
  }
  catch(e){setStatus('resetStatus',e.message,'error')}
  finally{btn.disabled=false;btn.textContent=old}
}
async function copyClientLink(){
  if(!currentClientLink){toast('Primero creá tu usuario o ingresá.');return}
  try{await navigator.clipboard.writeText(currentClientLink);toast('Enlace copiado.')}catch{toast('No se pudo copiar el enlace.')}
}
async function shareHero(key,title){
  try{
    toast('Preparando JPG...');
    const r=await fetch('/share-jpg?image='+encodeURIComponent(key),{cache:'no-store'});
    if(!r.ok)throw new Error();
    const blob=await r.blob();const file=new File([blob],`mate-topp-${key}.jpg`,{type:'image/jpeg'});
    if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){
      await navigator.share({files:[file],title:title,text:'Mate Topp®'});return;
    }
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=file.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('JPG descargado.');
  }catch(e){if(e?.name!=='AbortError')toast('No se pudo preparar el JPG. Reintentá.')}
}

const PRODUCT_CHANNEL_DATA={
  FF200:{b2c:{price:8500,commission:5490},b2b:{price:4300,commission:1290}},
  FC200:{b2c:{price:8500,commission:5000},b2b:{price:5000,commission:1500}},
  FZ200:{b2c:{price:8500,commission:5490},b2b:{price:4300,commission:1290}},
  FM200:{b2c:{price:8500,commission:5000},b2b:{price:5000,commission:1500}},
  BF200:{b2c:{price:6000,commission:3900},b2b:{price:3000,commission:900}},
  BC200:{b2c:{price:6000,commission:3200},b2b:{price:4000,commission:1200}},
  BZ200:{b2c:{price:6000,commission:3900},b2b:{price:3000,commission:900}},
  BM200:{b2c:{price:6000,commission:3900},b2b:{price:3000,commission:900}}
};
async function setChannel(channel,persist=true){
  activeChannel=channel==='b2b'?'b2b':'b2c';const isB2B=activeChannel==='b2b';
  const b2c=$('b2cToggle'),b2b=$('b2bToggle');
  if(b2c){b2c.style.background=isB2B?'#fff':'var(--verde)';b2c.style.color=isB2B?'var(--verde)':'#fff';b2c.querySelector('.channel-label').textContent=isB2B?'Activar B2C':'B2C activo'}
  if(b2b){b2b.style.background=isB2B?'var(--verde)':'#fff';b2b.style.color=isB2B?'#fff':'var(--verde)';b2b.querySelector('.channel-label').textContent=isB2B?'B2B activo':'Activar B2B'}
  document.querySelectorAll('.product-card').forEach(card=>{
    const data=PRODUCT_CHANNEL_DATA[card.dataset.sku];if(!data)return;const cur=data[activeChannel];
    const price=card.querySelector('.price-box:not(.commission-box)'),commission=card.querySelector('.commission-box');
    if(price){price.querySelector('small').textContent=isB2B?'Precio al comercio':'Precio al cliente';price.querySelector('strong').textContent=money(cur.price)}
    if(commission)commission.querySelector('strong').textContent=money(cur.commission);
  });
  if($('productModal')?.classList.contains('open')){
    const sku=$('productModal').dataset.sku;const data=PRODUCT_CHANNEL_DATA[sku];if(data){$('sheetPriceLabel').textContent=isB2B?'Precio al comercio':'Precio al cliente';$('sheetPrice').textContent=money(data[activeChannel].price);$('sheetCommission').textContent=money(data[activeChannel].commission)}
  }
  if(persist&&currentSeller&&sessionStorage.getItem(SESSION_KEY)){
    try{const data=await sellerApi({action:'setChannel',channel:activeChannel},true);currentSeller=data.seller;currentClientLink=data.clientLink;$('clientLink').textContent=currentClientLink}catch{}
  }
}

function initCatalog(){
  const search=$('catalogSearch');let activeCategory='Todos';const cards=[...document.querySelectorAll('.product-card')];
  function filter(){const q=(search?.value||'').toLowerCase().trim();cards.forEach(card=>{const matchesText=(card.dataset.search||'').includes(q);const matchesCategory=activeCategory==='Todos'||card.dataset.category===activeCategory;card.style.display=matchesText&&matchesCategory?'':'none'})}
  search?.addEventListener('input',filter);
  document.querySelectorAll('.category-tab').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.category-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');activeCategory=btn.dataset.category;filter()}));
  $('b2cToggle')?.addEventListener('click',()=>setChannel('b2c'));
  $('b2bToggle')?.addEventListener('click',()=>setChannel('b2b'));

  const modal=$('productModal');
  function openSheet(card){
    const sku=card.dataset.sku||'';const img=card.querySelector('.product-visual img');const category=card.dataset.category||'';
    const presentation=card.querySelector('.product-kicker').textContent.trim();const name=card.querySelector('.product-name').textContent.trim();
    $('sheetImage').src=img.src;$('sheetImage').alt=img.alt;$('sheetPresentation').textContent=`${category.toUpperCase()} · ${sku}`;$('sheetTitle').textContent=`${name} · ${presentation}`;
    const data=PRODUCT_CHANNEL_DATA[sku]?.[activeChannel];if(data){$('sheetPriceLabel').textContent=activeChannel==='b2b'?'Precio al comercio':'Precio al cliente';$('sheetPrice').textContent=money(data.price);$('sheetCommission').textContent=money(data.commission)}
    modal.dataset.sku=sku;modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';
  }
  function closeSheet(){modal.classList.remove('open');modal.setAttribute('aria-hidden','true');document.body.style.overflow=''}
  document.querySelectorAll('.card-btn').forEach(btn=>btn.addEventListener('click',()=>openSheet(btn.closest('.product-card'))));
  $('sheetCloseX')?.addEventListener('click',closeSheet);$('sheetCloseBtn')?.addEventListener('click',closeSheet);modal?.addEventListener('click',e=>{if(e.target===modal)closeSheet()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeSheet();document.querySelectorAll('.portal-modal.open').forEach(m=>closeModal(m.id))}});
  setChannel('b2c',false);
}

function initPortal(){
  ensureAccessUi();
  ['createPhone','resetPhone'].forEach(id=>bindPhone($(id)));['createDni','loginDni','greenDni','resetDni'].forEach(id=>bindDni($(id)));
  $('createUserBtn').addEventListener('click',()=>openModal('createModal'));
  $('haveUserBtn').addEventListener('click',()=>{
    $('espacio').scrollIntoView({behavior:'smooth',block:'start'});
    if(currentSeller){toast('Tu enlace ya está listo para copiar.');return}
    setTimeout(()=>$('greenDni').focus(),500);
  });
  $('createSubmit').addEventListener('click',registerSeller);
  $('loginSubmit').addEventListener('click',()=>loginSeller($('loginDni').value,$('loginPassword').value,'loginStatus','loginModal'));
  $('greenLoginBtn').addEventListener('click',()=>{
    if(currentSeller){logoutSeller();return}
    loginSeller($('greenDni').value,$('greenPassword').value,'greenLoginMsg');
  });
  $('copyClientBtn').addEventListener('click',copyClientLink);
  $('forgotGreen').addEventListener('click',()=>openModal('resetModal'));$('forgotLogin').addEventListener('click',()=>{closeModal('loginModal');openModal('resetModal')});
  $('resetSubmit').addEventListener('click',resetPassword);
  $('shareFolclore').addEventListener('click',()=>shareHero('folclore','Folclore Mate Topp®'));
  $('shareCumbia').addEventListener('click',()=>shareHero('cumbia','Cumbia Mate Topp®'));
  $('shareSeal').addEventListener('click',()=>toast('Tocá una de las fotos para compartirla o descargarla como JPG.'));
  document.querySelectorAll('[data-close]').forEach(btn=>btn.addEventListener('click',()=>closeModal(btn.dataset.close)));
  document.querySelectorAll('.portal-modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m.id)}));
  $('greenPasswordEye').addEventListener('click',()=>{const input=$('greenPassword');input.type=input.type==='password'?'text':'password'});
  $('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter')$('loginSubmit').click()});
  $('greenDni').addEventListener('keydown',e=>{if(e.key==='Enter')$('greenPassword').focus()});
  $('greenPassword').addEventListener('keydown',e=>{if(e.key==='Enter')$('greenLoginBtn').click()});
  restoreSession();
}

document.addEventListener('DOMContentLoaded',()=>{initCatalog();initPortal()});
