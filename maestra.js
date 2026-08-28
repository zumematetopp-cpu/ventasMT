function copyText(id){
  const txt = document.getElementById(id).innerText;
  navigator.clipboard.writeText(txt);
}
function copyPrivate(){
  const data = localStorage.getItem('mateToppAccess') || '';
  navigator.clipboard.writeText(data);
}

const ACCESS_STORAGE_KEY = 'mateToppAccess';
const CLIENT_LINK_BASE = location.origin + '/comprar';
const PHONE_PREFIX = '549';

function setFieldState(input, errorEl, message){
  input.classList.toggle('input-error', Boolean(message));
  input.classList.toggle('input-ok', !message && input.value.trim() !== '');
  errorEl.textContent = message || '';
}

function ensurePhonePrefix(rawValue = ''){
  let digits = String(rawValue || '').replace(/\D/g, '');

  if(digits.startsWith('549')){
    digits = digits.slice(3);
  } else if(digits.startsWith('54')){
    digits = digits.slice(2);
  } else if(digits.startsWith('9')){
    digits = digits.slice(1);
  }

  digits = digits.slice(0, 12);
  return PHONE_PREFIX + digits;
}

function validateName(){
  const input = document.getElementById('name');
  const error = document.getElementById('nameError');
  const value = input.value.trim();

  if(!value){
    setFieldState(input, error, 'Ingresá tu nombre para crear el acceso.');
    return false;
  }

  setFieldState(input, error, '');
  return true;
}

function validatePhone(){
  const input = document.getElementById('phone');
  const error = document.getElementById('phoneError');
  input.value = ensurePhonePrefix(input.value);
  const value = input.value.trim();
  const rest = value.slice(3);

  let message = '';

  if(rest.length === 0){
    message = 'Completá tu WhatsApp después de 549.';
  } else if(!/^\d+$/.test(value)){
    message = 'Usá solo números.';
  } else if(!value.startsWith(PHONE_PREFIX)){
    message = 'El número debe comenzar con 549.';
  } else if(value.length < 12 || value.length > 15){
    message = 'Revisá el número: faltan o sobran dígitos.';
  } else if(rest.startsWith('0')){
    message = 'Después de 549 no debe ir un cero.';
  } else if(/(^|\D)15/.test(rest)){
    message = 'No ingreses el prefijo 15.';
  }

  setFieldState(input, error, message);
  return !message;
}

async function apiPost(payload){
  const response = await fetch('/api',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(payload)
  });
  const data = await response.json().catch(()=>({ok:false,error:'Respuesta inválida'}));
  if(!response.ok || !data.ok) throw new Error(data.error || 'No se pudo conectar con Mate Topp®');
  return data;
}

function buildClientLink(name, phone, sellerId = '', channel = activeChannel){
  const params = new URLSearchParams({asesora:name, wa:phone || '', canal:channel});
  if(sellerId) params.set('sid', sellerId);
  return CLIENT_LINK_BASE + '?' + params.toString();
}

function updateSellerArea(name, phone, channel = activeChannel, sellerId = ''){
  const greeting = document.getElementById('sellerGreeting');
  const clientLink = document.getElementById('clientLink');
  greeting.textContent = `Hola, ${name}.`;
  clientLink.textContent = buildClientLink(name, phone, sellerId, channel);
}

async function saveAccess(){
  const nameOk = validateName();
  const phoneOk = validatePhone();

  if(!nameOk || !phoneOk){
    const firstInvalid = document.querySelector('.input-error');
    if(firstInvalid) firstInvalid.focus();
    return;
  }

  const name = document.getElementById('name').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const saveButton = document.querySelector('.save-btn');
  const oldText = saveButton ? saveButton.textContent : '';
  if(saveButton){ saveButton.disabled = true; saveButton.textContent = 'Guardando...'; }

  try{
    const provisionalLink = buildClientLink(name, phone, '', activeChannel);
    const data = await apiPost({
      action:'upsertSeller',
      seller:{name,phone,clientLink:provisionalLink,b2c:true,b2b:activeChannel === 'b2b'}
    });
    const seller = data.seller || {};
    const sellerId = seller.id || seller.sellerId || '';
    const saved = {
      sellerId,
      name:seller.name || name,
      phone:seller.phone || phone,
      channel:activeChannel,
      b2b:activeChannel === 'b2b'
    };
    localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify(saved));
    updateSellerArea(saved.name, saved.phone, saved.channel, saved.sellerId);
    alert('Acceso creado');
  }catch(error){
    alert('No se pudo guardar el acceso. ' + (error.message || 'Reintentá.'));
  }finally{
    if(saveButton){ saveButton.disabled = false; saveButton.textContent = oldText; }
  }
}

function loadSavedAccess(){
  try{
    const saved = JSON.parse(localStorage.getItem(ACCESS_STORAGE_KEY) || 'null');
    const phoneInput = document.getElementById('phone');

    if(!saved || !saved.name || !saved.phone){
      phoneInput.value = PHONE_PREFIX;
      validatePhone();
      return;
    }

    document.getElementById('name').value = saved.name;
    phoneInput.value = ensurePhonePrefix(saved.phone);
    if(saved.channel === 'b2b') activeChannel = 'b2b';
    setChannel(activeChannel, false);
    updateSellerArea(saved.name, phoneInput.value, activeChannel, saved.sellerId || '');
    validateName();
    validatePhone();
  }catch(e){
    localStorage.removeItem(ACCESS_STORAGE_KEY);
    const phoneInput = document.getElementById('phone');
    phoneInput.value = PHONE_PREFIX;
    validatePhone();
  }
}

document.getElementById('name').addEventListener('blur', validateName);

document.getElementById('phone').addEventListener('focus', () => {
  const input = document.getElementById('phone');
  input.value = ensurePhonePrefix(input.value);
  requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
});

document.getElementById('phone').addEventListener('blur', validatePhone);
document.getElementById('phone').addEventListener('input', (e) => {
  const input = e.target;
  input.value = ensurePhonePrefix(input.value);
  const error = document.getElementById('phoneError');
  if(error.textContent) validatePhone();
});

document.getElementById('phone').addEventListener('keydown', (e) => {
  const input = e.target;
  const start = input.selectionStart || 0;
  if((e.key === 'Backspace' && start <= 3) || (e.key === 'Delete' && start < 3)){
    e.preventDefault();
  }
});

function celebrateButton(button){
  button.classList.remove('button-glow');
  void button.offsetWidth;
  button.classList.add('button-glow');
  setTimeout(() => button.classList.remove('button-glow'), 420);

  const rect = button.getBoundingClientRect();
  const points = [
    [rect.left + 8, rect.top + 8, -24, -24],
    [rect.right - 8, rect.top + 9, 24, -26],
    [rect.left + rect.width * .28, rect.top - 1, -8, -30],
    [rect.left + rect.width * .72, rect.top - 1, 10, -32],
    [rect.left + 10, rect.bottom - 8, -26, 20],
    [rect.right - 10, rect.bottom - 8, 28, 20]
  ];

  points.forEach(([x,y,dx,dy], i) => {
    const spark = document.createElement('span');
    spark.className = 'button-spark';
    spark.textContent = i % 2 === 0 ? '✦' : '✧';
    spark.style.left = x + 'px';
    spark.style.top = y + 'px';
    spark.style.setProperty('--dx', dx + 'px');
    spark.style.setProperty('--dy', dy + 'px');
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 700);
  });
}

document.querySelectorAll('button').forEach(button => {
  button.addEventListener('click', () => celebrateButton(button));
});

const PRODUCT_CHANNEL_DATA = {
  FF200:{b2c:{price:8500,commission:5490},b2b:{price:4300,commission:1290}},
  FC200:{b2c:{price:8500,commission:5000},b2b:{price:5000,commission:1500}},
  FZ200:{b2c:{price:8500,commission:5490},b2b:{price:4300,commission:1290}},
  FM200:{b2c:{price:8500,commission:5000},b2b:{price:5000,commission:1500}},
  BF200:{b2c:{price:6000,commission:3900},b2b:{price:3000,commission:900}},
  BC200:{b2c:{price:6000,commission:3200},b2b:{price:4000,commission:1200}},
  BZ200:{b2c:{price:6000,commission:3900},b2b:{price:3000,commission:900}},
  BM200:{b2c:{price:6000,commission:3900},b2b:{price:3000,commission:900}}
};
let activeChannel = 'b2c';
const money = n => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(n);

function setChannel(channel, persist = true){
  activeChannel = channel === 'b2b' ? 'b2b' : 'b2c';
  const isB2B = activeChannel === 'b2b';
  const b2cToggle = document.getElementById('b2cToggle');
  const b2bToggle = document.getElementById('b2bToggle');
  if(b2cToggle){
    b2cToggle.style.background = isB2B ? '#fff' : 'var(--verde)';
    b2cToggle.style.color = isB2B ? 'var(--verde)' : '#fff';
    b2cToggle.querySelector('.channel-label').textContent = isB2B ? 'Activar B2C' : 'B2C activo';
  }
  if(b2bToggle){
    b2bToggle.style.background = isB2B ? 'var(--verde)' : '#fff';
    b2bToggle.style.color = isB2B ? '#fff' : 'var(--verde)';
    b2bToggle.querySelector('.channel-label').textContent = isB2B ? 'B2B activo' : 'Activar B2B';
  }
  document.querySelectorAll('.product-card').forEach(card => {
    const data = PRODUCT_CHANNEL_DATA[card.dataset.sku];
    if(!data) return;
    const current = data[activeChannel];
    const priceBox = card.querySelector('.price-box');
    const commissionBox = card.querySelector('.commission-box');
    if(priceBox){
      const label = priceBox.querySelector('small');
      if(label) label.textContent = isB2B ? 'Precio al comercio' : 'Precio al cliente';
      const strong = priceBox.querySelector('strong');
      if(strong) strong.textContent = money(current.price);
    }
    if(commissionBox){
      const strong = commissionBox.querySelector('strong');
      if(strong) strong.textContent = money(current.commission);
    }
  });
  const saved = JSON.parse(localStorage.getItem(ACCESS_STORAGE_KEY) || 'null');
  if(saved && saved.name && saved.phone){
    saved.channel = activeChannel;
    if(persist) localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify(saved));
    updateSellerArea(saved.name, ensurePhonePrefix(saved.phone), activeChannel, saved.sellerId || '');
  }
  if(document.getElementById('productModal')?.classList.contains('open')){
    const sku = document.getElementById('sheetPresentation').textContent.split('·').pop().trim();
    const data = PRODUCT_CHANNEL_DATA[sku];
    if(data){
      document.getElementById('sheetPriceLabel').textContent = isB2B ? 'Precio al comercio' : 'Precio al cliente';
      document.getElementById('sheetPrice').textContent = money(data[activeChannel].price);
      document.getElementById('sheetCommission').textContent = money(data[activeChannel].commission);
    }
  }
}

async function changeChannel(channel){
  setChannel(channel);
  const saved = JSON.parse(localStorage.getItem(ACCESS_STORAGE_KEY) || 'null');
  if(saved && saved.sellerId){
    try{
      await apiPost({action:'setB2B',sellerId:saved.sellerId,phone:saved.phone || '',enabled:channel === 'b2b'});
      saved.b2b = channel === 'b2b';
      saved.channel = channel;
      localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify(saved));
    }catch(error){
      alert('No se pudo actualizar el canal. Reintentá.');
    }
  }
}

document.getElementById('b2cToggle').addEventListener('click', () => changeChannel('b2c'));
document.getElementById('b2bToggle').addEventListener('click', () => changeChannel('b2b'));
setChannel('b2c', false);
loadSavedAccess();

const searchInput = document.getElementById('catalogSearch');
const categoryButtons = document.querySelectorAll('.category-tab');
const cards = document.querySelectorAll('.product-card');
let activeCategory = 'Todos';

function filterCatalog(){
  const q = (searchInput.value || '').toLowerCase().trim();
  cards.forEach(card => {
    const matchesText = card.dataset.search.includes(q);
    const matchesCategory = activeCategory === 'Todos' || card.dataset.category === activeCategory;
    card.style.display = matchesText && matchesCategory ? '' : 'none';
  });
}

searchInput.addEventListener('input', filterCatalog);
categoryButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    categoryButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCategory = btn.dataset.category;
    filterCatalog();
  });
});

const productModal = document.getElementById('productModal');
const sheetImage = document.getElementById('sheetImage');
const sheetPresentation = document.getElementById('sheetPresentation');
const sheetTitle = document.getElementById('sheetTitle');
const sheetPrice = document.getElementById('sheetPrice');
const sheetCommission = document.getElementById('sheetCommission');

function openProductSheet(card){
  const img = card.querySelector('.product-visual img');
  const category = card.dataset.category || '';
  const sku = card.dataset.sku || '';
  const presentation = card.querySelector('.product-kicker').textContent.trim();
  const name = card.querySelector('.product-name').innerText.trim();
  const price = card.querySelector('.price-box strong').innerText.trim();
  const commission = card.querySelector('.commission-box strong').innerText.trim();

  sheetImage.src = img.src;
  sheetImage.alt = img.alt;
  sheetPresentation.innerText = `${category.toUpperCase()} · ${sku}`;
  sheetTitle.textContent = `${name} · ${presentation}`;
  sheetPrice.innerText = price;
  sheetCommission.innerText = commission;
  document.getElementById('sheetPriceLabel').textContent = activeChannel === 'b2b' ? 'Precio al comercio' : 'Precio al cliente';

  productModal.classList.add('open');
  productModal.setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
}

function closeProductSheet(){
  productModal.classList.remove('open');
  productModal.setAttribute('aria-hidden','true');
  document.body.style.overflow = '';
}

document.querySelectorAll('.card-btn').forEach(btn => {
  btn.addEventListener('click', () => openProductSheet(btn.closest('.product-card')));
});

document.getElementById('sheetCloseX').addEventListener('click', closeProductSheet);
document.getElementById('sheetCloseBtn').addEventListener('click', closeProductSheet);

productModal.addEventListener('click', (e) => {
  if(e.target === productModal) closeProductSheet();
});

document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape' && productModal.classList.contains('open')) closeProductSheet();
});

const ordersButton = document.getElementById('pedidos');
if(ordersButton){
  ordersButton.addEventListener('click', () => {
    const saved = JSON.parse(localStorage.getItem(ACCESS_STORAGE_KEY) || 'null');
    if(!saved || !saved.name || !saved.phone){
      alert('Primero creá tu acceso.');
      document.getElementById('acceso')?.scrollIntoView({behavior:'smooth'});
      return;
    }
    location.href = '/panel.html';
  });
}
