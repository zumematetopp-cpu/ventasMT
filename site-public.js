const search=document.getElementById('catalogSearch');
const tabs=[...document.querySelectorAll('.tab')];
const cards=[...document.querySelectorAll('.product-card')];
let active='Todos';
let currentCard=null;

function filter(){
  const q=(search?.value||'').toLowerCase().trim();
  cards.forEach(card=>{
    const okText=(card.dataset.search||'').includes(q);
    const okCat=active==='Todos'||card.dataset.category===active;
    card.style.display=okText&&okCat?'':'none';
  });
}
search?.addEventListener('input',filter);
tabs.forEach(btn=>btn.addEventListener('click',()=>{
  tabs.forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  active=btn.dataset.category;
  filter();
}));

const modal=document.getElementById('productModal');
const img=document.getElementById('sheetImage');
const kicker=document.getElementById('sheetPresentation');
const title=document.getElementById('sheetTitle');
const price=document.getElementById('sheetPrice');

function openSheet(card){
  currentCard=card;
  const pimg=card.querySelector('.product-visual img');
  img.src=pimg.src;
  img.alt=pimg.alt;
  kicker.textContent=`${(card.dataset.category||'').toUpperCase()} · ${card.dataset.sku||''}`;
  title.textContent=card.querySelector('.product-name').textContent.trim();
  price.textContent=card.querySelector('.price-box strong').textContent.trim();
  modal.classList.add('open');
  modal.setAttribute('aria-hidden','false');
  document.body.style.overflow='hidden';
}
function closeSheet(){
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden','true');
  document.body.style.overflow='';
}
document.querySelectorAll('.card-btn').forEach(btn=>btn.addEventListener('click',()=>openSheet(btn.closest('.product-card'))));
document.getElementById('sheetCloseX')?.addEventListener('click',closeSheet);
modal?.addEventListener('click',e=>{if(e.target===modal)closeSheet()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal?.classList.contains('open'))closeSheet()});

document.getElementById('sheetSendBtn')?.addEventListener('click',()=>{
  if(!currentCard)return;
  const product=currentCard.querySelector('.product-name')?.textContent.trim()||'Producto Mate Topp®';
  const publicPrice=currentCard.querySelector('.price-box strong')?.textContent.trim()||'';
  const text=`Te comparto la ficha de ${product} de Mate Topp®.%0A%0APrecio al público: ${publicPrice}%0A%0ABlend 100% natural de hierbas y té en hebras. Podés disfrutarlo en mate, tereré, té caliente, cold brew y cócteles.`;
  window.open(`https://wa.me/?text=${text}`,'_blank','noopener');
});

(async()=>{
  const greeting=document.getElementById('sellerGreeting');
  const linkEl=document.getElementById('sellerClientLink');
  const copyBtn=document.getElementById('copySellerLink');
  if(!greeting||!linkEl||!copyBtn)return;
  try{
    const r=await fetch('/auth-api?action=me',{cache:'no-store',credentials:'same-origin'});
    const j=await r.json();
    if(!r.ok||!j?.authenticated||!j?.profile)return;
    const p=j.profile;
    greeting.textContent=`Hola, ${p.firstName||'Experto'}!`;
    linkEl.textContent=p.clientLink||'';
    copyBtn.disabled=!p.clientLink;
    copyBtn.addEventListener('click',async()=>{
      if(!p.clientLink)return;
      try{
        await navigator.clipboard.writeText(p.clientLink);
        const old=copyBtn.textContent;
        copyBtn.textContent='Copiado';
        setTimeout(()=>copyBtn.textContent=old,1400);
      }catch{
        const area=document.createElement('textarea');
        area.value=p.clientLink;
        area.style.position='fixed';area.style.opacity='0';
        document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();
      }
    });
  }catch{}
})();
