/* ============================================================
   Wama' House — app.js
   主檔的所有邏輯皆抽離至此,結構與註解皆保留原樣
   ============================================================ */
/* ============================================================
   JAVASCRIPT 整體架構 (依下方區塊順序)
   ============================================================
   DATA       常數/可變資料來源 (商品、組合包、加價購、demo 帳號)
   STATE      頁面執行期狀態 (購物車、目前篩選、目前登入者)
   AUTH       登入 / 登出 / Modal 控制 / focus trap
   PAGE SWITCH SPA 分頁切換、權限阻擋、自動捲動
   PRODUCTS   單品篩選與卡片渲染
   BUNDLES    組合包價格計算 (原價/折後/省多少) 與卡片渲染
   ADMIN BUNDLE 後台組合包 CRUD (新增/上下架/刪除/即時預覽)
   ADMIN ADDON  後台加價購 CRUD (最多 8 件,加購價需低於原價)
   CART       購物車增刪改、結帳、運費 (滿 500 免運)、按鈕回饋動畫
   ADDON SECT 結帳前加價購區塊渲染 (僅一般顧客顯示,經銷不顯示)
   STATS/TOAST 後台統計數字 + 全域 toast 訊息
   INIT       自動執行的初始化 (IIFE)
   ============================================================ */

/* ============================ DATA ============================ */
/* ALL_PRODUCTS:單品商品資料庫
   欄位:id / name 名稱 / sub 副標 / emoji 圖示 / price 售價
        orig 原價 (有折扣才填) / badge 標籤 (hot/new/sale)
        type 適用對象 (dog 狗 / cat 貓 / both 通用)         */
const ALL_PRODUCTS = [
  {id:1,name:'嫩嫩雞肉肉乾',sub:'台灣在地雞胸肉',emoji:'🍗',price:240,badge:'hot',type:'dog'},
  {id:2,name:'鮪魚凍乾零食',sub:'100% 純鮪魚製作',emoji:'🐟',price:260,orig:300,badge:'sale',type:'cat'},
  {id:3,name:'紐西蘭牛肉條',sub:'單一原料無添加',emoji:'🥩',price:230,badge:'new',type:'dog'},
  {id:4,name:'藍莓雞肉凍乾',sub:'抗氧化超級食物',emoji:'🍇',price:280,badge:'new',type:'both'},
  {id:5,name:'鮭魚皮零食',sub:'富含 Omega-3',emoji:'🐠',price:320,orig:380,badge:'sale',type:'cat'},
  {id:6,name:'南瓜燕麥餅乾',sub:'天然素食零食',emoji:'🎃',price:180,type:'dog'},
  {id:7,name:'起司雞肉捲',sub:'貓狗都愛吃',emoji:'🧀',price:210,badge:'hot',type:'both'},
  {id:8,name:'鴨肉潔牙棒',sub:'潔牙美味雙效',emoji:'🦆',price:190,type:'dog'},
];

/* BUNDLES:組合包資料 (使用 let 因為後台可新增/刪除)
   欄位:items 連結 ALL_PRODUCTS 的 id 陣列 (2~4 件)
        disc 折扣百分比 (5~50)
        active 是否上架 (false 即下架)
        visibility 'public'公開組合 | 'dealer' 僅經銷可見          */
let BUNDLES = [
  {id:101,name:'狗狗健康三寶組',tag:'🐶 狗狗專屬',items:[1,3,8],disc:20,active:true,visibility:'public'},
  {id:102,name:'貓咪海鮮派對組',tag:'🐱 貓咪專屬',items:[2,5,4],disc:15,active:true,visibility:'public'},
  {id:103,name:'毛孩最愛嘗鮮組',tag:'🌟 毛孩通用',items:[1,2,6,7],disc:25,active:true,visibility:'public'},
  {id:104,name:'經銷專屬量販組',tag:'🐶 狗狗專屬',items:[1,3,6,8],disc:35,active:true,visibility:'dealer'},
  {id:105,name:'門市熱銷貓咪組',tag:'🐱 貓咪專屬',items:[2,5,7],disc:30,active:true,visibility:'dealer'},
  {id:106,name:'寵物店超值大全配',tag:'🌟 毛孩通用',items:[1,2,4,7],disc:40,active:true,visibility:'dealer'},
];

/* ADDON_PRODUCTS:加價購商品 (僅在購物車有商品時顯示,且最多 8 件)
   欄位:orig 原價 / special 加購價 (必須 < orig)
        active 是否上架,false 在前台不顯示但後台仍保留               */
let ADDON_PRODUCTS = [
  {id:'a1',name:'雞肉小肉乾片',emoji:'🍗',orig:120,special:49,active:true},
  {id:'a2',name:'迷你潔牙骨',emoji:'🦴',orig:90,special:39,active:true},
  {id:'a3',name:'貓草逗貓棒',emoji:'🌿',orig:150,special:59,active:true},
  {id:'a4',name:'寵物濕紙巾',emoji:'🧻',orig:80,special:29,active:true},
  {id:'a5',name:'凍乾起司丁',emoji:'🧀',orig:160,special:69,active:true},
  {id:'a6',name:'毛孩飲水添加劑',emoji:'💧',orig:200,special:89,active:true},
];

/* DEMO_ACCOUNTS:寫死的 demo 帳號表 (正式環境應改為後端驗證)
   ⚠️ 切勿在正式專案把密碼放在前端!此處純粹示範用                  */
const DEMO_ACCOUNTS = {
  dealer:{pass:'pet2026',role:'dealer',name:'毛孩之家寵物店'},
  admin:{pass:'admin2026',role:'admin',name:'系統管理員'},
};

/* ============================ STATE ============================ */
/* cart                    購物車 (key=商品 key,value={name,type,price,qty}) */
/* selectedChips           後台新增組合包時已勾選的商品 id 陣列              */
/* currentFilter           單品篩選狀態 (all/dog/cat/both)                  */
/* currentVisibility       後台新增組合包的可見度 (public/dealer)            */
/* currentUser             登入後使用者物件 (null 代表訪客)                  */
/* _lastFocusedBeforeModal 開啟登入 Modal 前的 focus,關閉後恢復 (a11y)      */
let cart = {};
let selectedChips = [];
let currentFilter = 'all';
let currentVisibility = 'public';
let currentUser = null;
let _lastFocusedBeforeModal = null;

/* ============================ AUTH ============================ */
/* openLoginModal:點擊角色徽章時觸發。
   - 若已登入則直接登出 (徽章扮演登入/登出開關)
   - 若未登入則開啟 Modal,並記憶開啟前的 focus 以便關閉後還原    */
function openLoginModal(){
  if(currentUser){logout();return;}
  _lastFocusedBeforeModal = document.activeElement;
  const m = document.getElementById('login-modal');
  m.classList.add('active'); m.setAttribute('aria-hidden','false');
  document.getElementById('login-error').textContent = '';
  // 動畫結束後再 focus,避免被瀏覽器忽略
  setTimeout(()=>document.getElementById('login-user').focus(),100);
}
/* closeLoginModal:關閉 Modal、清空輸入欄與錯誤訊息、恢復 focus  */
function closeLoginModal(){
  const m = document.getElementById('login-modal');
  m.classList.remove('active'); m.setAttribute('aria-hidden','true');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-error').textContent = '';
  if(_lastFocusedBeforeModal){try{_lastFocusedBeforeModal.focus();}catch(e){}}
}
/* 全域鍵盤事件:在登入 Modal 開啟時提供
   ESC          → 關閉 Modal
   Tab/Shift+Tab→ focus trap,讓焦點不會跑到 Modal 之外 (a11y) */
document.addEventListener('keydown',function(e){
  const m = document.getElementById('login-modal');
  if(!m||!m.classList.contains('active'))return;
  if(e.key==='Escape'){e.preventDefault();closeLoginModal();return;}
  if(e.key==='Tab'){
    const f = m.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if(!f.length)return;
    const first = f[0], last = f[f.length-1];
    if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
  }
});
/* doLogin:Modal 內登入按鈕 (或 Enter) 觸發
   - 比對 DEMO_ACCOUNTS,失敗則顯示錯誤
   - 成功則寫入 currentUser、切換 body class 控制顯示權限
   - 經銷登入後自動跳到經銷頁                                    */
function doLogin(){
  const u = document.getElementById('login-user').value.trim().toLowerCase();
  const p = document.getElementById('login-pass').value;
  const err = document.getElementById('login-error');
  const acc = DEMO_ACCOUNTS[u];
  if(!acc || acc.pass !== p){
    err.textContent = '⚠ 帳號或密碼錯誤，請再試一次';
    showToast('帳號或密碼錯誤！',false);
    return;
  }
  err.textContent = '';
  currentUser = {username:u,role:acc.role,name:acc.name};
  document.body.classList.remove('role-guest');
  document.body.classList.add('role-' + acc.role);
  updateRolePill();
  closeLoginModal();
  renderAll();
  showToast(`✓ 歡迎 ${acc.name}！`,true);
  if(acc.role==='dealer'){
    document.getElementById('dealer-welcome').textContent = `歡迎，${acc.name}`;
    setTimeout(()=>switchPage('dealer'),400);
  }
}
/* logout:清除登入狀態,回到訪客模式並導回首頁 */
function logout(){
  currentUser = null;
  document.body.className = 'role-guest';
  updateRolePill();
  switchPage('shop');
  renderAll();
  showToast('已登出',true);
}
/* updateRolePill:依目前角色更新右上角徽章的圖示、文字與配色 */
function updateRolePill(){
  const pill = document.getElementById('role-pill');
  const icon = document.getElementById('role-icon');
  const text = document.getElementById('role-text');
  pill.classList.remove('dealer','admin');
  if(!currentUser){icon.textContent='👤';text.textContent='登入 / 註冊';}
  else if(currentUser.role==='dealer'){pill.classList.add('dealer');icon.textContent='💼';text.textContent=currentUser.name;}
  else if(currentUser.role==='admin'){pill.classList.add('admin');icon.textContent='⚙️';text.textContent=currentUser.name;}
}

/* ============================ PAGE SWITCH ============================ */
/* switchPage:SPA 分頁切換,name = shop/dealer/cart/admin
   - 進入 dealer 需登入;進入 admin 需 admin 權限,否則改開登入 Modal
   - 同步更新桌面導覽 active 狀態與行動底部 nav active 狀態
   - 切換後平滑捲回頂端                                              */
function switchPage(name){
  if((name==='dealer'&&!currentUser) || (name==='admin'&&(!currentUser||currentUser.role!=='admin'))){
    openLoginModal(); return;
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-links button').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-selected','false');});
  document.querySelectorAll('.bnav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  const navLink = document.getElementById('nav-link-'+name);
  if(navLink){navLink.classList.add('active');navLink.setAttribute('aria-selected','true');}
  const bnav = document.getElementById('bnav-'+name);
  if(bnav)bnav.classList.add('active');
  window.scrollTo({top:0,behavior:'smooth'});
}

/* filterAndScroll:從首頁分類卡 (狗/貓/通用) 點擊時,
   先切到 shop 頁、設定篩選、再捲到產品區                       */
function filterAndScroll(type){
  switchPage('shop');
  const idxMap={dog:1,cat:2,both:3};
  const btn = document.querySelectorAll('.filter-btn')[idxMap[type]];
  if(btn) filterProds(type,btn);
  setTimeout(()=>document.getElementById('products-grid').scrollIntoView({behavior:'smooth',block:'start'}),200);
}
/* bundleScroll:Hero 上 CTA 按鈕→ 切到 shop 並捲到組合包區       */
function bundleScroll(){
  switchPage('shop');
  setTimeout(()=>document.getElementById('bundle-anchor').scrollIntoView({behavior:'smooth',block:'start'}),200);
}

/* ============================ PRODUCTS ============================ */
/* filterProds:篩選按鈕點擊,更新 currentFilter 並重新渲染卡片 */
function filterProds(type,btn){
  currentFilter = type;
  document.querySelectorAll('.filter-btn').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false');});
  btn.classList.add('active'); btn.setAttribute('aria-pressed','true');
  renderProducts();
}
/* renderProducts:依 currentFilter 過濾並渲染單品卡片網格
   - all:顯示全部
   - dog/cat:顯示對應 type,並包含 type='both' 的通用商品 */
function renderProducts(){
  const grid = document.getElementById('products-grid');
  const list = currentFilter==='all' ? ALL_PRODUCTS
            : ALL_PRODUCTS.filter(p=>p.type===currentFilter || p.type==='both');
  const lbl = {new:'新品',hot:'熱賣',sale:'優惠'};
  grid.innerHTML = list.map(p=>`
    <article class="product-card">
      ${p.badge?`<span class="product-badge ${p.badge}">${lbl[p.badge]}</span>`:''}
      <div class="product-img" aria-hidden="true">${p.emoji}</div>
      <div class="product-info">
        <h5>${p.name}</h5>
        <div class="product-sub">${p.sub}</div>
        <div class="price-wrap">
          <span class="price-sale">NT$ ${p.price}</span>
          ${p.orig?`<span class="price-regular">NT$ ${p.orig}</span>`:''}
        </div>
      </div>
      <button class="add-cart-btn" onclick="addToCart('prod_${p.id}','${p.emoji} ${p.name}','單品',${p.price},this)">加入購物車</button>
    </article>`).join('');
}

/* ============================ BUNDLES ============================ */
/* getProduct:用 id 從 ALL_PRODUCTS 找出單品                       */
function getProduct(id){return ALL_PRODUCTS.find(p=>p.id===id);}
/* bundleOrig:組合包「原價總和」(items 各自 price 加總)            */
function bundleOrig(b){return b.items.reduce((s,id)=>s+getProduct(id).price,0);}
/* bundleFinal:組合包折扣後價格,四捨五入到整數元                   */
function bundleFinal(b){return Math.round(bundleOrig(b)*(1-b.disc/100));}

/* renderBundleShop:在首頁渲染「公開」組合包卡片 (visibility=public)   */
function renderBundleShop(){
  const el = document.getElementById('bundle-grid-shop');
  const list = BUNDLES.filter(b=>b.active && b.visibility==='public');
  if(!list.length){el.innerHTML='<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">目前無上架組合包</p>';return;}
  el.innerHTML = list.map(b=>renderBundleCard(b,false)).join('');
}
/* renderBundleDealer:在經銷頁渲染「經銷限定」組合包 (visibility=dealer) */
function renderBundleDealer(){
  const el = document.getElementById('bundle-grid-dealer');
  if(!el)return;
  const list = BUNDLES.filter(b=>b.active && b.visibility==='dealer');
  if(!list.length){el.innerHTML='<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">目前無經銷專屬組合包</p>';return;}
  el.innerHTML = list.map(b=>renderBundleCard(b,true)).join('');
}
/* renderBundleCard:組合包卡片 HTML 樣板,共用於 shop/dealer 兩處
   isDealer=true 時顯示紫色 VIP 徽章與經銷專屬樣式                   */
function renderBundleCard(b,isDealer){
  const orig = bundleOrig(b), final = bundleFinal(b), save = orig-final;
  const items = b.items.map(getProduct);
  const emojis = items.map(p=>p.emoji).join('');
  const names = items.map(p=>p.name).join(' + ');
  const key = 'bundle_' + b.id;
  const type = isDealer ? '經銷組合包' : '組合包';
  return `
    <article class="product-card bundle-card ${isDealer?'dealer':''}">
      ${isDealer?'<span class="bundle-vip-tag">VIP</span>':''}
      <span class="bundle-ribbon">${b.disc}% OFF</span>
      <div class="product-img" aria-hidden="true"><span class="bundle-emojis-row">${emojis}</span></div>
      <div class="product-info">
        <h5>${b.name}</h5>
        <div class="product-sub">${b.tag}</div>
        <div class="bundle-items-list">${names}</div>
        <div class="price-wrap">
          <span class="price-sale">NT$ ${final}</span>
          <span class="price-regular">NT$ ${orig}</span>
        </div>
        <span class="bundle-save">省 NT$${save}</span>
      </div>
      <button class="add-cart-btn" onclick="addToCart('${key}','${emojis} ${b.name}','${type}',${final},this)">加入購物車</button>
    </article>`;
}

/* ============================ ADMIN: BUNDLE ============================ */
/* setVisibility:後台「公開 / 經銷限定」切換,改 currentVisibility */
function setVisibility(el,vis){
  document.querySelectorAll('.vis-opt').forEach(o=>o.classList.remove('active'));
  el.classList.add('active');
  currentVisibility = vis;
}
/* renderChipSelector:渲染後台「選擇商品」的 chip 列表
   被勾選的 chip 加 .selected,後續由 toggleChip 切換               */
function renderChipSelector(){
  const el = document.getElementById('prod-selector');
  el.innerHTML = ALL_PRODUCTS.map(p=>`
    <div class="sel-chip ${selectedChips.includes(p.id)?'selected':''}" onclick="toggleChip(this,${p.id})" role="button" tabindex="0">
      <span aria-hidden="true">${p.emoji}</span>${p.name} NT$${p.price}
    </div>`).join('');
}
/* toggleChip:勾選/取消勾選某商品 chip;組合包上限 4 件             */
function toggleChip(el,id){
  if(el.classList.contains('selected')){
    el.classList.remove('selected');
    selectedChips = selectedChips.filter(x=>x!==id);
  }else{
    if(selectedChips.length>=4){showToast('最多選擇 4 件商品！',false);return;}
    el.classList.add('selected');
    selectedChips.push(id);
  }
  updatePreview();
}
/* updatePreview:即時更新折扣 % 數字與下方「定價預覽」區塊
   - 至少需勾選 2 件才會顯示具體預覽                                 */
function updatePreview(){
  const disc = parseInt(document.getElementById('disc-slider').value,10);
  document.getElementById('disc-val').textContent = `${disc}% OFF`;
  const box = document.getElementById('preview-box');
  if(selectedChips.length<2){box.innerHTML='<span class="preview-hint">請選擇至少 2 件商品後預覽</span>';return;}
  const items = selectedChips.map(getProduct);
  const orig = items.reduce((s,p)=>s+p.price,0);
  const final = Math.round(orig*(1-disc/100));
  const save = orig - final;
  box.innerHTML = `
    <div>
      <div class="preview-emojis">${items.map(p=>p.emoji).join(' ')}</div>
      <div class="preview-names">${items.map(p=>p.name).join('、')}</div>
    </div>
    <div class="preview-right">
      <div class="preview-orig">原價 NT$${orig}</div>
      <div class="preview-final">NT$${final}</div>
      <span class="preview-save">省 NT$${save}（${disc}% OFF）</span>
    </div>`;
}
/* resetBundleForm:清空組合包新增表單,回到預設值 (15% 折扣 / 公開) */
function resetBundleForm(){
  document.getElementById('b-name').value = '';
  document.getElementById('disc-slider').value = 15;
  selectedChips = [];
  currentVisibility = 'public';
  document.querySelectorAll('.vis-opt').forEach(o=>o.classList.remove('active'));
  document.querySelector('.vis-opt[data-vis="public"]').classList.add('active');
  renderChipSelector();
  updatePreview();
}
/* saveBundle:驗證後新增一筆組合包 (id 用 Date.now 確保唯一)
   驗證:名稱不可空、商品至少 2 件                                   */
function saveBundle(){
  const name = document.getElementById('b-name').value.trim();
  if(!name){showToast('請輸入組合包名稱！',false);return;}
  if(selectedChips.length<2){showToast('請至少選擇 2 件商品！',false);return;}
  const disc = parseInt(document.getElementById('disc-slider').value,10);
  const tag = document.getElementById('b-tag').value;
  BUNDLES.push({id:Date.now(),name,tag,items:[...selectedChips],disc,active:true,visibility:currentVisibility});
  resetBundleForm();
  renderAll();
  const v = currentVisibility==='public'?'🌐 公開':'💼 經銷限定';
  showToast(`✓ 組合包已上架（${v}）`,true);
}
/* toggleBundleActive:切換組合包上下架狀態 (active 布林) */
function toggleBundleActive(id){const b=BUNDLES.find(x=>x.id===id);if(b)b.active=!b.active;renderAll();}
/* deleteBundle:從 BUNDLES 移除指定組合包 (含 confirm 確認) */
function deleteBundle(id){
  if(!confirm('確定要刪除這個組合包嗎？'))return;
  BUNDLES = BUNDLES.filter(x=>x.id!==id);
  renderAll();
}
/* renderBundleAdmin:後台「現有組合包」列表,顯示狀態燈/可見度徽章/操作鈕 */
function renderBundleAdmin(){
  const el = document.getElementById('bundle-admin-list');
  if(!BUNDLES.length){el.innerHTML='<div class="bundle-admin-empty">尚無組合包，請於上方新增</div>';return;}
  el.innerHTML = BUNDLES.map(b=>{
    const orig = bundleOrig(b), final = bundleFinal(b);
    const items = b.items.map(getProduct);
    const visBadge = b.visibility==='dealer' ? '<span class="bli-vis dealer">💼 經銷限定</span>' : '<span class="bli-vis public">🌐 公開</span>';
    return `
      <div class="bundle-list-item">
        <div class="status-dot ${b.active?'dot-on':'dot-off'}" title="${b.active?'上架中':'已下架'}"></div>
        <div class="bli-emojis" aria-hidden="true">${items.map(p=>p.emoji).join('')}</div>
        <div class="bli-info">
          <div class="bli-name">${b.name} ${visBadge} <span class="bli-tag">${b.tag}</span></div>
          <div class="bli-sub">${items.map(p=>p.name).join('、')}</div>
        </div>
        <div class="bli-price-col">
          <div class="bli-final">NT$${final}</div>
          <div class="bli-orig">NT$${orig}</div>
          <span class="bli-disc-badge">${b.disc}% OFF</span>
        </div>
        <div class="row-actions">
          <button class="pill-btn" onclick="toggleBundleActive(${b.id})">${b.active?'下架':'上架'}</button>
          <button class="pill-btn gray" onclick="deleteBundle(${b.id})">刪除</button>
        </div>
      </div>`;
  }).join('');
}

/* ============================ ADMIN: ADDON ============================ */
/* resetAddonForm:清空加價購表單四個欄位 */
function resetAddonForm(){['ad-name','ad-emoji','ad-orig','ad-special'].forEach(id=>document.getElementById(id).value='');}
/* saveAddon:新增加價購商品
   驗證:名稱不可空、原價/加購價需 >0、加購價必須低於原價、總數上限 8 */
function saveAddon(){
  const name = document.getElementById('ad-name').value.trim();
  const emoji = document.getElementById('ad-emoji').value.trim() || '🎁';
  const orig = parseInt(document.getElementById('ad-orig').value,10);
  const special = parseInt(document.getElementById('ad-special').value,10);
  if(!name){showToast('請輸入商品名稱！',false);return;}
  if(!orig||orig<=0){showToast('請輸入有效原價！',false);return;}
  if(!special||special<=0){showToast('請輸入有效加購價！',false);return;}
  if(special>=orig){showToast('加購價必須低於原價！',false);return;}
  if(ADDON_PRODUCTS.filter(a=>a.active!==false).length>=8){showToast('最多上架 8 件加價購商品！',false);return;}
  ADDON_PRODUCTS.push({id:'a'+Date.now(),name,emoji,orig,special,active:true});
  resetAddonForm();
  renderAddonAdmin();renderCart();updateStats();
  showToast(`✓ 加價購商品「${name}」已上架`,true);
}
/* toggleAddonActive:加價購上下架。要從下架→ 上架時需先檢查總數上限 */
function toggleAddonActive(id){
  const a = ADDON_PRODUCTS.find(x=>x.id===id);
  if(!a)return;
  if(!a.active && ADDON_PRODUCTS.filter(x=>x.active!==false).length>=8){
    showToast('最多上架 8 件加價購商品！',false);return;
  }
  a.active = !a.active;
  renderAddonAdmin();renderCart();updateStats();
}
/* deleteAddon:刪除加價購;若該商品已在購物車內,需同步移除避免殘留 */
function deleteAddon(id){
  if(!confirm('確定要刪除這個加價購商品嗎？'))return;
  ADDON_PRODUCTS = ADDON_PRODUCTS.filter(x=>x.id!==id);
  const key = 'addon_' + id;
  if(cart[key]){delete cart[key];updateCartBadge();}
  renderAddonAdmin();renderCart();updateStats();
  showToast('已刪除加價購商品',true);
}
/* renderAddonAdmin:渲染後台加價購列表,顯示折扣百分比與操作鈕 */
function renderAddonAdmin(){
  const el = document.getElementById('addon-admin-list');
  if(!el)return;
  if(!ADDON_PRODUCTS.length){el.innerHTML='<div class="bundle-admin-empty">尚無加價購商品</div>';return;}
  el.innerHTML = ADDON_PRODUCTS.map(a=>{
    const save = a.orig-a.special;
    const pct = Math.round((save/a.orig)*100);
    return `
      <div class="bundle-list-item">
        <div class="status-dot ${a.active!==false?'dot-on':'dot-off'}"></div>
        <div class="bli-emojis" aria-hidden="true">${a.emoji}</div>
        <div class="bli-info">
          <div class="bli-name">${a.name} <span class="bli-vis addon">🎁 加價購</span></div>
          <div class="bli-sub">特惠折扣 ${pct}% OFF</div>
        </div>
        <div class="bli-price-col">
          <div class="bli-final">NT$${a.special}</div>
          <div class="bli-orig">NT$${a.orig}</div>
          <span class="bli-disc-badge">省 $${save}</span>
        </div>
        <div class="row-actions">
          <button class="pill-btn" onclick="toggleAddonActive('${a.id}')">${a.active!==false?'下架':'上架'}</button>
          <button class="pill-btn gray" onclick="deleteAddon('${a.id}')">刪除</button>
        </div>
      </div>`;
  }).join('');
}

/* ============================ CART ============================ */
/* addToCart:加入購物車。key 同一商品則 qty++,並對按鈕做閃綠特效   */
function addToCart(key,name,type,price,btnEl){
  if(!cart[key])cart[key]={name,type,price,qty:0};
  cart[key].qty++;
  updateCartBadge();renderCart();
  if(btnEl)flashButton(btnEl);
  showToast(`✓ 已加入購物車`,true);
}
/* changeQty:+/- 數量。減到 0 自動移除該商品 (避免顯示 0 件) */
function changeQty(key,delta){
  if(!cart[key])return;
  cart[key].qty = Math.max(0, cart[key].qty+delta);
  if(cart[key].qty===0)delete cart[key];
  updateCartBadge();renderCart();
}
/* removeItem:移除單一商品 */
function removeItem(key){delete cart[key];updateCartBadge();renderCart();}
/* clearCart:清空整個購物車 */
function clearCart(){cart={};updateCartBadge();renderCart();}
/* updateCartBadge:更新右上角與底部 nav 的紅色數字徽章 */
function updateCartBadge(){
  const total = Object.values(cart).reduce((s,v)=>s+v.qty,0);
  document.getElementById('nav-cart-count').textContent = total;
  const bb = document.getElementById('bnav-badge');
  bb.textContent = total;
  bb.style.display = total>0 ? 'inline-block' : 'none';
}
/* renderCart:渲染購物車列表 + 加價購區塊 + 結帳摘要
   - 空車時顯示空狀態頁
   - 滿 NT$500 自動免運,否則 NT$60 並顯示「再買 X 元免運」提示
   - 經銷登入時結帳鈕文字改為「送出訂貨單 →」                       */
function renderCart(){
  const el = document.getElementById('cart-content');
  const keys = Object.keys(cart).filter(k=>cart[k].qty>0);
  if(!keys.length){
    el.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-emoji" aria-hidden="true">🛒</div>
        <h3>購物車是空的</h3>
        <p>快去選購毛孩最愛的零食吧！</p>
        <button class="back-shop-btn" onclick="switchPage('shop')">去逛逛 →</button>
      </div>`;
    return;
  }
  let subtotal = 0;
  const itemsHtml = keys.map(k=>{
    const item = cart[k];
    subtotal += item.price * item.qty;
    const [emoji,...nameParts] = item.name.split(' ');
    const isDealer = item.type==='經銷組合包';
    const isAddon = item.type==='加價購';
    return `
      <div class="cart-item${isAddon?' addon-item':''}">
        <span class="cart-item-emoji" aria-hidden="true">${emoji}</span>
        <div class="cart-item-info">
          <div class="cart-item-name">${nameParts.join(' ')}</div>
          <div class="cart-item-type ${isDealer?'dealer':isAddon?'addon':''}">${isDealer?'💼 ':isAddon?'🎁 ':''}${item.type}</div>
          <div class="cart-item-price">NT$ ${item.price}</div>
          <div class="qty-control">
            <button class="qty-btn" onclick="changeQty('${k}',-1)" aria-label="減少數量">−</button>
            <span class="qty-num">${item.qty}</span>
            <button class="qty-btn" onclick="changeQty('${k}',1)" aria-label="增加數量">+</button>
          </div>
        </div>
        <button class="remove-btn" onclick="removeItem('${k}')" aria-label="移除商品">✕</button>
      </div>`;
  }).join('');
  const shipping = subtotal>=500 ? 0 : 60;
  const total = subtotal + shipping;
  const shippingHtml = shipping===0 ? '<span class="free-ship-ok">免費 🎉</span>' : `NT$${shipping}`;
  const hintHtml = subtotal<500
    ? `<div class="free-ship-hint">再買 NT$${500-subtotal} 即可享免運！</div>`
    : '';
  const checkoutLabel = currentUser && currentUser.role==='dealer' ? '送出訂貨單 →' : '立即結帳 →';
  const addonHtml = renderAddonSection();
  el.innerHTML = itemsHtml + addonHtml + `
    <div class="cart-summary">
      <h4 class="summary-title">訂單明細</h4>
      <div class="summary-row"><span>商品小計</span><span>NT$${subtotal}</span></div>
      <div class="summary-row"><span>運費</span><span>${shippingHtml}</span></div>
      ${hintHtml}
      <hr class="summary-divider">
      <div class="summary-total"><span>合計</span><span class="total-price">NT$${total}</span></div>
      <button class="checkout-btn" onclick="checkout()">${checkoutLabel}</button>
    </div>`;
}
/* checkout:結帳 (示範用)。經銷顯示「訂貨單已送出」,
   一般顧客顯示「訂單成立」,1.5 秒後清空購物車回到空狀態          */
function checkout(){
  if(currentUser && currentUser.role==='dealer')showToast('✓ 訂貨單已送出，業務將盡快聯繫您！',true);
  else showToast('✓ 訂單成立！感謝您的購買 🐾',true);
  setTimeout(()=>{cart={};updateCartBadge();renderCart();},1500);
}
/* flashButton:加入購物車後的視覺回饋。文字暫時變為「已加入 ✓」,
   1 秒後恢復原狀,讓使用者知道操作成功                             */
function flashButton(btn){
  const orig = btn.textContent;
  btn.textContent = '已加入 ✓';
  btn.style.background = 'var(--gr)'; btn.style.color = '#fff'; btn.style.borderColor='var(--gr)';
  setTimeout(()=>{btn.textContent=orig;btn.style.background='';btn.style.color='';btn.style.borderColor='';},1000);
}

/* ============================ ADDON SECTION ============================ */
/* renderAddonSection:在購物車中渲染「加價購」區塊
   - 經銷使用者不顯示加價購 (回傳空字串)
   - 已加購的卡片改為綠色「已加入」狀態,且按鈕 disabled            */
function renderAddonSection(){
  if(currentUser && currentUser.role==='dealer')return '';
  const list = ADDON_PRODUCTS.filter(a=>a.active!==false);
  if(!list.length)return '';
  const cards = list.map(a=>{
    const key = 'addon_' + a.id;
    const added = !!cart[key];
    const save = a.orig - a.special;
    return `
      <div class="addon-card ${added?'added':''}">
        <div class="addon-emoji" aria-hidden="true">${a.emoji}</div>
        <div class="addon-name">${a.name}</div>
        <div class="addon-price-row">
          <span class="addon-orig">NT$${a.orig}</span>
          <span class="addon-special">NT$${a.special}</span>
        </div>
        <button class="addon-add-btn" ${added?'disabled aria-pressed="true"':'aria-pressed="false"'} onclick="addAddon('${a.id}',this)">
          ${added?'已加入 ✓':`加購省 $${save} +`}
        </button>
      </div>`;
  }).join('');
  return `
    <section class="addon-section" aria-label="加價購商品">
      <div class="addon-header">
        <h3 class="addon-title"><span aria-hidden="true">🎁</span> 加購好物 <span class="addon-flag">限結帳前</span></h3>
      </div>
      <p class="addon-sub">最低 1 折！結帳前加購不需另計運費，超划算！</p>
      <div class="addon-grid">${cards}</div>
    </section>`;
}
/* addAddon:把加價購商品加入購物車。已加過則顯示提示但不重複加      */
function addAddon(addonId,btn){
  const a = ADDON_PRODUCTS.find(x=>x.id===addonId);
  if(!a)return;
  const key = 'addon_'+a.id;
  if(cart[key]){showToast(`「${a.name}」已在購物車中`,true);return;}
  cart[key] = {name:`${a.emoji} ${a.name}`,type:'加價購',price:a.special,qty:1};
  updateCartBadge();renderCart();
  showToast(`✓ 已加購「${a.name}」省 NT$${a.orig-a.special}！`,true);
}

/* ============================ STATS & TOAST ============================ */
/* updateStats:後台 Dashboard 五張卡的數字 (商品/公開/經銷/加價購) */
function updateStats(){
  document.getElementById('stat-prod').textContent = ALL_PRODUCTS.length;
  document.getElementById('stat-bundle').textContent = BUNDLES.filter(b=>b.active && b.visibility==='public').length;
  document.getElementById('stat-dealer').textContent = BUNDLES.filter(b=>b.active && b.visibility==='dealer').length;
  const ad = document.getElementById('stat-addon');
  if(ad) ad.textContent = ADDON_PRODUCTS.filter(a=>a.active!==false).length;
}
/* showToast:全站通用 toast 提示
   success=true 顯示綠色,false 顯示紅色;2.4 秒後自動消失
   多次呼叫會 clearTimeout 上一個計時器,避免疊加閃爍              */
function showToast(msg,success=true){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = success ? 'var(--gr)' : 'var(--red)';
  t.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(()=>{t.style.display='none';},2400);
}
/* renderAll:資料異動 (新增/上下架/刪除組合包或加價購) 後一次刷新所有相關區塊 */
function renderAll(){
  renderBundleAdmin();renderBundleShop();renderBundleDealer();renderAddonAdmin();updateStats();
}

/* ============================ INIT ============================ */
/* IIFE 啟動程式:依序渲染單品 → 組合包/加價購/統計 → 後台 chip 與預覽 → 購物車 → 角色徽章 */
(function init(){
  renderProducts();
  renderAll();
  renderChipSelector();
  updatePreview();
  renderCart();
  updateRolePill();
})();
