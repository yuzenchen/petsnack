/* ============================================================
   Wama' House — app.js  (v3, 後端對接版)
   ============================================================
   依賴: api.js (定義 window.Api)

   差異 vs v2 (純前端):
     - 移除 hardcode 的 ALL_PRODUCTS / BUNDLES / ADDON_PRODUCTS / DEMO_ACCOUNTS
     - 改從 backend API 取得所有資料
     - 登入呼叫 /api/v1/auth/login,token 存 localStorage
     - 結帳呼叫 /api/v1/payments/checkout,跳到 LINE Pay paymentUrl
     - 後台 CRUD 全部走 admin API (寫入後重新拉取)
     - URL 含 ?payment=success/cancelled/error 自動處理付款回呼
   ============================================================ */

/* ============================ STATE ============================ */
let ALL_PRODUCTS = [];
let BUNDLES = [];
let ADDON_PRODUCTS = [];

let cart = {};
// 從 localStorage 恢復購物車（重整後不清空）
try {
  const _saved = localStorage.getItem('wama_cart');
  if (_saved) cart = JSON.parse(_saved);
} catch (_e) { cart = {}; }

let selectedChips = [];
let currentFilter = 'all';
let currentVisibility = 'public';
let currentUser = null;
let _lastFocusedBeforeModal = null;

/* ============================ AUTH ============================ */
function openLoginModal() {
  if (currentUser) { logout(); return; }
  _lastFocusedBeforeModal = document.activeElement;
  const m = document.getElementById('login-modal');
  m.classList.add('active');
  m.setAttribute('aria-hidden', 'false');
  document.getElementById('login-error').textContent = '';
  setTimeout(() => document.getElementById('login-user').focus(), 100);
}

function closeLoginModal() {
  const m = document.getElementById('login-modal');
  m.classList.remove('active');
  m.setAttribute('aria-hidden', 'true');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-error').textContent = '';
  if (_lastFocusedBeforeModal) {
    try { _lastFocusedBeforeModal.focus(); } catch (e) {}
  }
}

document.addEventListener('keydown', function (e) {
  // 訂單 modal: Escape 關閉
  const orderM = document.getElementById('order-modal');
  if (orderM && orderM.classList.contains('active')) {
    if (e.key === 'Escape') { e.preventDefault(); closeOrderModal(); return; }
  }
  // 結帳 modal: Escape 關閉
  const coM = document.getElementById('checkout-modal');
  if (coM && coM.classList.contains('active')) {
    if (e.key === 'Escape') { e.preventDefault(); closeCheckoutModal(); return; }
  }
  // 登入 modal: Escape 關閉 + focus trap
  const m = document.getElementById('login-modal');
  if (!m || !m.classList.contains('active')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeLoginModal(); return; }
  if (e.key === 'Tab') {
    const f = m.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

async function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value;
  const err = document.getElementById('login-error');
  if (!u || !p) { err.textContent = '⚠ 請輸入帳號密碼'; return; }
  try {
    const result = await Api.login(u, p);
    Api.setToken(result.token);
    currentUser = result.user;
    document.body.classList.remove('role-guest');
    document.body.classList.add('role-' + result.user.role);
    err.textContent = '';
    closeLoginModal();
    await reloadCatalog();
    if (result.user.role === 'admin') await reloadAdminLists();
    updateRolePill();
    showToast(`✓ 歡迎 ${result.user.displayName}！`, true);
    if (result.user.role === 'dealer') {
      document.getElementById('dealer-welcome').textContent = `歡迎，${result.user.displayName}`;
      setTimeout(() => switchPage('dealer'), 400);
    }
    if (result.user.role === 'admin') {
      setTimeout(() => switchPage('admin'), 400);
    }
  } catch (e) {
    err.textContent = '⚠ ' + (e.network ? '無法連線到後端,請確認 API 是否啟動' : (e.message || '登入失敗'));
    showToast(e.message || '登入失敗', false);
  }
}

function logout() {
  Api.clearToken();
  currentUser = null;
  document.body.className = 'role-guest';
  updateRolePill();
  switchPage('shop');
  reloadCatalog();
  showToast('已登出', true);
}

async function tryRestoreSession() {
  if (!Api.getToken()) return;
  try {
    const { user } = await Api.me();
    currentUser = user;
    document.body.classList.remove('role-guest');
    document.body.classList.add('role-' + user.role);
  } catch (_) {
    currentUser = null;
  }
}

function updateRolePill() {
  const pill = document.getElementById('role-pill');
  const icon = document.getElementById('role-icon');
  const text = document.getElementById('role-text');
  pill.classList.remove('dealer', 'admin');
  if (!currentUser) { icon.textContent = '👤'; text.textContent = '登入 / 註冊'; }
  else if (currentUser.role === 'dealer') { pill.classList.add('dealer'); icon.textContent = '💼'; text.textContent = currentUser.displayName; }
  else if (currentUser.role === 'admin') { pill.classList.add('admin'); icon.textContent = '⚙️'; text.textContent = currentUser.displayName; }
}

/* ============================ PAGE SWITCH ============================ */
function switchPage(name) {
  if ((name === 'dealer' && !currentUser) || (name === 'admin' && (!currentUser || currentUser.role !== 'admin'))) {
    openLoginModal();
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-links button').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  const navLink = document.getElementById('nav-link-' + name);
  if (navLink) { navLink.classList.add('active'); navLink.setAttribute('aria-selected', 'true'); }
  const bnav = document.getElementById('bnav-' + name);
  if (bnav) bnav.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function filterAndScroll(type) {
  switchPage('shop');
  const idxMap = { dog: 1, cat: 2, both: 3 };
  const btn = document.querySelectorAll('.filter-btn')[idxMap[type]];
  if (btn) filterProds(type, btn);
  setTimeout(() => document.getElementById('products-grid').scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

function bundleScroll() {
  switchPage('shop');
  setTimeout(() => document.getElementById('bundle-anchor').scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

/* ============================ DATA RELOAD ============================ */
function _normalizeProduct(p) { return { id: p.productId, name: p.name, sub: p.sub, emoji: p.emoji, price: p.price, orig: p.orig, badge: p.badge, type: p.type }; }
function _normalizeBundle(b)  { return { id: b.bundleId, name: b.name, tag: b.tag, items: b.items, disc: b.disc, visibility: b.visibility, active: b.active }; }
function _normalizeAddon(a)   { return { id: a.addonId, name: a.name, emoji: a.emoji, orig: a.orig, special: a.special, active: a.active }; }

async function reloadCatalog() {
  renderSkeletons(4);   // 先顯示骨架屏
  try {
    const [pRes, pubBRes, addonsRes] = await Promise.all([
      Api.products(), Api.bundles('public'), Api.addons(),
    ]);
    ALL_PRODUCTS = pRes.products.map(_normalizeProduct);
    let allBundles = pubBRes.bundles.slice();
    if (currentUser && (currentUser.role === 'dealer' || currentUser.role === 'admin')) {
      const dealerBRes = await Api.bundles('dealer');
      allBundles = allBundles.concat(dealerBRes.bundles);
    }
    BUNDLES = allBundles.map(_normalizeBundle);
    ADDON_PRODUCTS = addonsRes.addons.map(_normalizeAddon);
    renderProducts();
    renderBundleShop();
    renderBundleDealer();
    renderChipSelector();
    updateStats();
    renderCart();
  } catch (e) {
    console.error(e);
    showToast('載入資料失敗: ' + (e.message || ''), false);
  }
}

async function reloadAdminLists() {
  if (!currentUser || currentUser.role !== 'admin') return;
  try {
    const [bRes, aRes] = await Promise.all([Api.adminListBundles(), Api.adminListAddons()]);
    BUNDLES = bRes.bundles.map(_normalizeBundle);
    ADDON_PRODUCTS = aRes.addons.map(_normalizeAddon);
    renderBundleAdmin();
    renderAddonAdmin();
    updateStats();
    renderBundleShop();
    renderBundleDealer();
    // 訂單管理 + 真實統計 (並行載入,不阻塞 UI)
    loadOrders();
    loadDashboardStats();
  } catch (e) {
    console.error(e);
    showToast('讀取後台資料失敗: ' + (e.message || ''), false);
  }
}

/* ============================ PRODUCTS ============================ */
function filterProds(type, btn) {
  currentFilter = type;
  document.querySelectorAll('.filter-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
  renderProducts();
}

function renderProducts() {
  const grid = document.getElementById('products-grid');
  const list = currentFilter === 'all' ? ALL_PRODUCTS
    : ALL_PRODUCTS.filter(p => p.type === currentFilter || p.type === 'both');
  const lbl = { new: '新品', hot: '熱賣', sale: '優惠' };
  grid.innerHTML = list.map(p => `
    <article class="product-card">
      ${p.badge ? `<span class="product-badge ${p.badge}">${lbl[p.badge]}</span>` : ''}
      <div class="product-img" aria-hidden="true">${p.emoji}</div>
      <div class="product-info">
        <h5>${p.name}</h5>
        <div class="product-sub">${p.sub || ''}</div>
        <div class="price-wrap">
          <span class="price-sale">NT$ ${p.price}</span>
          ${p.orig ? `<span class="price-regular">NT$ ${p.orig}</span>` : ''}
        </div>
      </div>
      <button class="add-cart-btn" onclick="addToCart('prod_${p.id}','${p.emoji} ${p.name}','單品',${p.price},this)">加入購物車</button>
    </article>`).join('');
}

/* ============================ BUNDLES ============================ */
function getProduct(id) { return ALL_PRODUCTS.find(p => p.id === id); }
function bundleOrig(b) { return b.items.reduce((s, id) => s + (getProduct(id)?.price || 0), 0); }
function bundleFinal(b) { return Math.round(bundleOrig(b) * (1 - b.disc / 100)); }

function renderBundleShop() {
  const el = document.getElementById('bundle-grid-shop');
  const list = BUNDLES.filter(b => b.active && b.visibility === 'public');
  if (!list.length) { el.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">目前無上架組合包</p>'; return; }
  el.innerHTML = list.map(b => renderBundleCard(b, false)).join('');
}

function renderBundleDealer() {
  const el = document.getElementById('bundle-grid-dealer');
  if (!el) return;
  const list = BUNDLES.filter(b => b.active && b.visibility === 'dealer');
  if (!list.length) { el.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">目前無經銷專屬組合包</p>'; return; }
  el.innerHTML = list.map(b => renderBundleCard(b, true)).join('');
}

function renderBundleCard(b, isDealer) {
  const orig = bundleOrig(b), final = bundleFinal(b), save = orig - final;
  const items = b.items.map(getProduct).filter(Boolean);
  const emojis = items.map(p => p.emoji).join('');
  const names = items.map(p => p.name).join(' + ');
  const key = 'bundle_' + b.id;
  const type = isDealer ? '經銷組合包' : '組合包';
  return `
    <article class="product-card bundle-card ${isDealer ? 'dealer' : ''}">
      ${isDealer ? '<span class="bundle-vip-tag">VIP</span>' : ''}
      <span class="bundle-ribbon">${b.disc}% OFF</span>
      <div class="product-img" aria-hidden="true"><span class="bundle-emojis-row">${emojis}</span></div>
      <div class="product-info">
        <h5>${b.name}</h5>
        <div class="product-sub">${b.tag || ''}</div>
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
function setVisibility(el, vis) {
  document.querySelectorAll('.vis-opt').forEach(o => {
    o.classList.remove('active');
    o.setAttribute('aria-checked', 'false');
  });
  el.classList.add('active');
  el.setAttribute('aria-checked', 'true');
  currentVisibility = vis;
}

function renderChipSelector() {
  const el = document.getElementById('prod-selector');
  if (!el) return;
  el.innerHTML = ALL_PRODUCTS.map(p => `
    <div class="sel-chip ${selectedChips.includes(p.id) ? 'selected' : ''}"
         onclick="toggleChip(this,${p.id})"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleChip(this,${p.id})}"
         role="button" tabindex="0" aria-pressed="${selectedChips.includes(p.id)}">
      <span aria-hidden="true">${p.emoji}</span>${p.name} NT$${p.price}
    </div>`).join('');
}

function toggleChip(el, id) {
  if (el.classList.contains('selected')) {
    el.classList.remove('selected');
    selectedChips = selectedChips.filter(x => x !== id);
  } else {
    if (selectedChips.length >= 4) { showToast('最多選擇 4 件商品！', false); return; }
    el.classList.add('selected');
    selectedChips.push(id);
  }
  updatePreview();
}

function updatePreview() {
  const slider = document.getElementById('disc-slider');
  if (!slider) return;
  const disc = parseInt(slider.value, 10);
  document.getElementById('disc-val').textContent = `${disc}% OFF`;
  const box = document.getElementById('preview-box');
  if (selectedChips.length < 2) { box.innerHTML = '<span class="preview-hint">請選擇至少 2 件商品後預覽</span>'; return; }
  const items = selectedChips.map(getProduct).filter(Boolean);
  const orig = items.reduce((s, p) => s + p.price, 0);
  const final = Math.round(orig * (1 - disc / 100));
  const save = orig - final;
  box.innerHTML = `
    <div>
      <div class="preview-emojis">${items.map(p => p.emoji).join(' ')}</div>
      <div class="preview-names">${items.map(p => p.name).join('、')}</div>
    </div>
    <div class="preview-right">
      <div class="preview-orig">原價 NT$${orig}</div>
      <div class="preview-final">NT$${final}</div>
      <span class="preview-save">省 NT$${save}（${disc}% OFF）</span>
    </div>`;
}

function resetBundleForm() {
  document.getElementById('b-name').value = '';
  document.getElementById('disc-slider').value = 15;
  selectedChips = [];
  currentVisibility = 'public';
  document.querySelectorAll('.vis-opt').forEach(o => o.classList.remove('active'));
  document.querySelector('.vis-opt[data-vis="public"]').classList.add('active');
  renderChipSelector();
  updatePreview();
}

async function saveBundle() {
  const name = document.getElementById('b-name').value.trim();
  if (!name) { showToast('請輸入組合包名稱！', false); return; }
  if (selectedChips.length < 2) { showToast('請至少選擇 2 件商品！', false); return; }
  const disc = parseInt(document.getElementById('disc-slider').value, 10);
  const tag = document.getElementById('b-tag').value;
  try {
    await Api.adminCreateBundle({ name, tag, items: selectedChips, disc, visibility: currentVisibility, active: true });
    resetBundleForm();
    await reloadAdminLists();
    const v = currentVisibility === 'public' ? '🌐 公開' : '💼 經銷限定';
    showToast(`✓ 組合包已上架 (${v})`, true);
  } catch (e) {
    showToast('新增失敗: ' + e.message, false);
  }
}

async function toggleBundleActive(id) {
  const b = BUNDLES.find(x => x.id === id);
  if (!b) return;
  try {
    await Api.adminUpdateBundle(id, { active: !b.active });
    await reloadAdminLists();
  } catch (e) { showToast('上下架失敗: ' + e.message, false); }
}

async function deleteBundle(id) {
  showConfirm('確定要刪除這個組合包嗎？此動作無法復原。', async () => {
    try {
      await Api.adminDeleteBundle(id);
      await reloadAdminLists();
      showToast('已刪除組合包', true);
    } catch (e) { showToast('刪除失敗: ' + e.message, false); }
  }, '🗑️');
}

function renderBundleAdmin() {
  const el = document.getElementById('bundle-admin-list');
  if (!el) return;
  if (!BUNDLES.length) { el.innerHTML = '<div class="bundle-admin-empty">尚無組合包,請於上方新增</div>'; return; }
  el.innerHTML = BUNDLES.map(b => {
    const orig = bundleOrig(b), final = bundleFinal(b);
    const items = b.items.map(getProduct).filter(Boolean);
    const visBadge = b.visibility === 'dealer' ? '<span class="bli-vis dealer">💼 經銷限定</span>' : '<span class="bli-vis public">🌐 公開</span>';
    return `
      <div class="bundle-list-item">
        <div class="status-dot ${b.active ? 'dot-on' : 'dot-off'}" title="${b.active ? '上架中' : '已下架'}"></div>
        <div class="bli-emojis" aria-hidden="true">${items.map(p => p.emoji).join('')}</div>
        <div class="bli-info">
          <div class="bli-name">${b.name} ${visBadge} <span class="bli-tag">${b.tag || ''}</span></div>
          <div class="bli-sub">${items.map(p => p.name).join('、')}</div>
        </div>
        <div class="bli-price-col">
          <div class="bli-final">NT$${final}</div>
          <div class="bli-orig">NT$${orig}</div>
          <span class="bli-disc-badge">${b.disc}% OFF</span>
        </div>
        <div class="row-actions">
          <button class="pill-btn" onclick="toggleBundleActive(${b.id})">${b.active ? '下架' : '上架'}</button>
          <button class="pill-btn gray" onclick="deleteBundle(${b.id})">刪除</button>
        </div>
      </div>`;
  }).join('');
}

/* ============================ ADMIN: ADDON ============================ */
function resetAddonForm() {
  ['ad-name', 'ad-emoji', 'ad-orig', 'ad-special'].forEach(id => document.getElementById(id).value = '');
}

async function saveAddon() {
  const name = document.getElementById('ad-name').value.trim();
  const emoji = document.getElementById('ad-emoji').value.trim() || '🎁';
  const orig = parseInt(document.getElementById('ad-orig').value, 10);
  const special = parseInt(document.getElementById('ad-special').value, 10);
  if (!name) { showToast('請輸入商品名稱！', false); return; }
  if (!orig || orig <= 0) { showToast('請輸入有效原價！', false); return; }
  if (!special || special <= 0) { showToast('請輸入有效加購價！', false); return; }
  if (special >= orig) { showToast('加購價必須低於原價！', false); return; }
  try {
    await Api.adminCreateAddon({ name, emoji, orig, special, active: true });
    resetAddonForm();
    await reloadAdminLists();
    showToast(`✓ 加價購商品「${name}」已上架`, true);
  } catch (e) { showToast('新增失敗: ' + e.message, false); }
}

async function toggleAddonActive(id) {
  const a = ADDON_PRODUCTS.find(x => x.id === id);
  if (!a) return;
  try {
    await Api.adminUpdateAddon(id, { active: !a.active });
    await reloadAdminLists();
  } catch (e) { showToast('上下架失敗: ' + e.message, false); }
}

async function deleteAddon(id) {
  showConfirm('確定要刪除這個加價購商品嗎？此動作無法復原。', async () => {
    try {
      await Api.adminDeleteAddon(id);
      const key = 'addon_' + id;
      if (cart[key]) { delete cart[key]; saveCart(); updateCartBadge(); }
      await reloadAdminLists();
      showToast('已刪除加價購商品', true);
    } catch (e) { showToast('刪除失敗: ' + e.message, false); }
  }, '🗑️');
}

function renderAddonAdmin() {
  const el = document.getElementById('addon-admin-list');
  if (!el) return;
  if (!ADDON_PRODUCTS.length) { el.innerHTML = '<div class="bundle-admin-empty">尚無加價購商品</div>'; return; }
  el.innerHTML = ADDON_PRODUCTS.map(a => {
    const save = a.orig - a.special;
    const pct = Math.round((save / a.orig) * 100);
    return `
      <div class="bundle-list-item">
        <div class="status-dot ${a.active !== false ? 'dot-on' : 'dot-off'}"></div>
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
          <button class="pill-btn" onclick="toggleAddonActive('${a.id}')">${a.active !== false ? '下架' : '上架'}</button>
          <button class="pill-btn gray" onclick="deleteAddon('${a.id}')">刪除</button>
        </div>
      </div>`;
  }).join('');
}

/* ============================ CART ============================ */
function parseCartKey(key) {
  const idx = key.indexOf('_');
  return { refType: key.slice(0, idx), refId: key.slice(idx + 1) };
}

function addToCart(key, name, type, price, btnEl) {
  if (!cart[key]) cart[key] = { name, type, price, qty: 0 };
  cart[key].qty++;
  saveCart();
  updateCartBadge();
  renderCart();
  if (btnEl) flashButton(btnEl);
  showToast('✓ 已加入購物車', true);
}

function changeQty(key, delta) {
  if (!cart[key]) return;
  cart[key].qty = Math.max(0, cart[key].qty + delta);
  if (cart[key].qty === 0) delete cart[key];
  saveCart();
  updateCartBadge();
  renderCart();
}

function removeItem(key) { delete cart[key]; saveCart(); updateCartBadge(); renderCart(); }
function clearCart() { cart = {}; saveCart(); updateCartBadge(); renderCart(); }

function updateCartBadge() {
  const total = Object.values(cart).reduce((s, v) => s + v.qty, 0);
  document.getElementById('nav-cart-count').textContent = total;
  const bb = document.getElementById('bnav-badge');
  bb.textContent = total;
  bb.style.display = total > 0 ? 'inline-block' : 'none';
}

/* 將購物車寫入 localStorage，達成重整後持久化 */
function saveCart() {
  try { localStorage.setItem('wama_cart', JSON.stringify(cart)); } catch (_e) {}
}

function renderCart() {
  const el = document.getElementById('cart-content');
  const keys = Object.keys(cart).filter(k => cart[k].qty > 0);
  if (!keys.length) {
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
  const itemsHtml = keys.map(k => {
    const item = cart[k];
    subtotal += item.price * item.qty;
    const [emoji, ...nameParts] = item.name.split(' ');
    const isDealer = item.type === '經銷組合包';
    const isAddon = item.type === '加價購';
    return `
      <div class="cart-item${isAddon ? ' addon-item' : ''}">
        <span class="cart-item-emoji" aria-hidden="true">${emoji}</span>
        <div class="cart-item-info">
          <div class="cart-item-name">${nameParts.join(' ')}</div>
          <div class="cart-item-type ${isDealer ? 'dealer' : isAddon ? 'addon' : ''}">${isDealer ? '💼 ' : isAddon ? '🎁 ' : ''}${item.type}</div>
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
  const isDealer = currentUser?.role === 'dealer';
  const shipping = isDealer ? 0 : (subtotal >= 500 ? 0 : 60);
  const total = subtotal + shipping;
  const shippingHtml = shipping === 0
    ? (isDealer ? '<span class="free-ship-ok">經銷免運</span>' : '<span class="free-ship-ok">免費 🎉</span>')
    : `NT$${shipping}`;
  const hintHtml = !isDealer && subtotal < 500
    ? `<div class="free-ship-hint">再買 NT$${500 - subtotal} 即可享免運！</div>` : '';
  const checkoutLabel = isDealer ? '送出訂貨單 →' : '立即結帳 →';
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

/**
 * 點購物車「立即結帳」按鈕入口:
 *   - dealer  -> 直接送出訂貨單 (用 dealer 表單,不走 LINE Pay)
 *   - guest/general -> 開「填寫收件資訊 modal」,讓使用者輸入姓名/電話/地址
 */
async function checkout() {
  const items = collectCartItems();
  if (!items.length) { showToast('購物車是空的', false); return; }

  if (currentUser?.role === 'dealer') {
    return submitDealerCheckout(items);
  }
  // 一般訂單 -> 開 modal
  openCheckoutModal();
}

/* ---------- 共用:整理購物車 ---------- */
function collectCartItems() {
  return Object.entries(cart)
    .filter(([_, v]) => v.qty > 0)
    .map(([key, v]) => {
      const { refType, refId } = parseCartKey(key);
      return { refType, refId, qty: v.qty };
    });
}

/* ---------- 經銷下單 (沿用原邏輯) ---------- */
async function submitDealerCheckout(items) {
  const payload = {
    items, orderType: 'dealer',
    dealer: {
      shopName: document.getElementById('do-shop')?.value.trim() || currentUser.displayName,
      contact: document.getElementById('do-contact')?.value.trim() || '',
      phone: document.getElementById('do-phone')?.value.trim() || '',
      deliveryDate: document.getElementById('do-date')?.value.trim() || '',
      note: document.getElementById('do-note')?.value.trim() || '',
    },
  };
  if (!payload.dealer.contact || !payload.dealer.phone) {
    showToast('請先到「經銷專區」填寫聯絡人與電話', false);
    switchPage('dealer');
    return;
  }
  const btn = document.querySelector('.checkout-btn');
  if (btn) { btn.disabled = true; btn.textContent = '處理中...'; }
  try {
    const result = await Api.checkout(payload);
    showToast(`✓ 訂貨單已送出 (${result.orderId})`, true);
    cart = {}; saveCart(); updateCartBadge(); renderCart();
  } catch (e) {
    showToast('結帳失敗: ' + e.message, false);
    if (btn) { btn.disabled = false; btn.textContent = '送出訂貨單 →'; }
  }
}

/* ---------- 結帳 Modal (一般訂單) ---------- */
const CO_KEY = 'wama_customer';

function openCheckoutModal() {
  const modal = document.getElementById('checkout-modal');
  if (!modal) return;

  // 從 localStorage 帶回上次填的資料
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CO_KEY) || '{}'); } catch (_) {}
  document.getElementById('co-name').value = saved.name || '';
  document.getElementById('co-phone').value = saved.phone || '';
  document.getElementById('co-address').value = saved.address || '';
  document.getElementById('co-email').value = saved.email || '';
  document.getElementById('checkout-error').textContent = '';
  const submitBtn = document.getElementById('co-submit');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '確認結帳 →'; }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('co-name').focus(), 100);
}

function closeCheckoutModal() {
  const m = document.getElementById('checkout-modal');
  m.classList.remove('active');
  m.setAttribute('aria-hidden', 'true');
}

async function confirmCheckout() {
  const items = collectCartItems();
  if (!items.length) { showToast('購物車是空的', false); closeCheckoutModal(); return; }

  const name = document.getElementById('co-name').value.trim();
  const phone = document.getElementById('co-phone').value.trim();
  const address = document.getElementById('co-address').value.trim();
  const email = document.getElementById('co-email').value.trim();
  const errEl = document.getElementById('checkout-error');

  // 客端驗證
  if (!name) { errEl.textContent = '⚠ 請輸入姓名'; document.getElementById('co-name').focus(); return; }
  if (!phone) { errEl.textContent = '⚠ 請輸入電話'; document.getElementById('co-phone').focus(); return; }
  if (!address) { errEl.textContent = '⚠ 請輸入收件地址'; document.getElementById('co-address').focus(); return; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = '⚠ Email 格式不正確'; document.getElementById('co-email').focus(); return;
  }
  errEl.textContent = '';

  // 儲存到 localStorage 方便下次帶回
  try { localStorage.setItem(CO_KEY, JSON.stringify({ name, phone, address, email })); } catch (_) {}

  const payload = {
    items,
    orderType: 'general',
    customer: { name, phone, ...(email ? { email } : {}) },
    shippingMethod: 'home_delivery',
    shippingInfo: { address },
  };

  const submitBtn = document.getElementById('co-submit');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '處理中...'; }

  try {
    const result = await Api.checkout(payload);
    if (result.paymentUrl) {
      showToast('正在跳轉到 LINE Pay...', true);
      closeCheckoutModal();
      setTimeout(() => { window.location.href = result.paymentUrl; }, 600);
    } else {
      showToast(`✓ 訂單已建立 (${result.orderId})`, true);
      closeCheckoutModal();
      cart = {}; saveCart(); updateCartBadge(); renderCart();
    }
  } catch (e) {
    errEl.textContent = '⚠ ' + (e.message || '結帳失敗');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '確認結帳 →'; }
  }
}

function flashButton(btn) {
  const orig = btn.textContent;
  btn.textContent = '已加入 ✓';
  btn.style.background = 'var(--gr)';
  btn.style.color = '#fff';
  btn.style.borderColor = 'var(--gr)';
  setTimeout(() => {
    btn.textContent = orig;
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
  }, 1000);
}

/* ============================ ADDON SECTION ============================ */
function renderAddonSection() {
  if (currentUser && currentUser.role === 'dealer') return '';
  const list = ADDON_PRODUCTS.filter(a => a.active !== false);
  if (!list.length) return '';
  const cards = list.map(a => {
    const key = 'addon_' + a.id;
    const added = !!cart[key];
    const save = a.orig - a.special;
    return `
      <div class="addon-card ${added ? 'added' : ''}">
        <div class="addon-emoji" aria-hidden="true">${a.emoji}</div>
        <div class="addon-name">${a.name}</div>
        <div class="addon-price-row">
          <span class="addon-orig">NT$${a.orig}</span>
          <span class="addon-special">NT$${a.special}</span>
        </div>
        <button class="addon-add-btn" ${added ? 'disabled aria-pressed="true"' : 'aria-pressed="false"'} onclick="addAddon('${a.id}',this)">
          ${added ? '已加入 ✓' : `加購省 $${save} +`}
        </button>
      </div>`;
  }).join('');
  return `
    <section class="addon-section" aria-label="加價購商品">
      <div class="addon-header">
        <h3 class="addon-title"><span aria-hidden="true">🎁</span> 加購好物 <span class="addon-flag">限結帳前</span></h3>
      </div>
      <p class="addon-sub">最低 1 折！結帳前加購不需另計運費,超划算！</p>
      <div class="addon-grid">${cards}</div>
    </section>`;
}

function addAddon(addonId, btn) {
  const a = ADDON_PRODUCTS.find(x => x.id === addonId);
  if (!a) return;
  const key = 'addon_' + a.id;
  if (cart[key]) { showToast(`「${a.name}」已在購物車中`, true); return; }
  cart[key] = { name: `${a.emoji} ${a.name}`, type: '加價購', price: a.special, qty: 1 };
  saveCart();
  updateCartBadge();
  renderCart();
  showToast(`✓ 已加購「${a.name}」省 NT$${a.orig - a.special}！`, true);
}

/* ============================ CONFIRM MODAL ============================ */
let _confirmCb = null;

function showConfirm(msg, onConfirm, icon) {
  const overlay = document.getElementById('confirm-overlay');
  if (!overlay) { if (confirm(msg)) onConfirm(); return; }
  overlay.querySelector('.confirm-icon').textContent = icon || '⚠️';
  overlay.querySelector('.confirm-msg').textContent = msg;
  _confirmCb = onConfirm;
  overlay.classList.add('active');
}

function closeConfirm(doIt) {
  const overlay = document.getElementById('confirm-overlay');
  if (overlay) overlay.classList.remove('active');
  if (doIt && _confirmCb) _confirmCb();
  _confirmCb = null;
}

/* ============================ LOADING / SKELETON ============================ */
function showLoading(msg) {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  el.querySelector('.loading-text').textContent = msg || '載入中…';
  el.classList.add('active');
}

function hideLoading() {
  const el = document.getElementById('loading-overlay');
  if (el) el.classList.remove('active');
}

function renderSkeletons(count) {
  const n = count || 4;
  const skeletonHtml = Array(n).fill(0).map(() => `
    <div class="product-skeleton">
      <div class="skeleton-img"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line short"></div>
      <div class="skeleton-line price"></div>
    </div>`).join('');
  ['products-grid', 'bundle-grid-shop'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = skeletonHtml;
  });
}

/* ============================================================
   ORDER MANAGEMENT (admin)
   ============================================================ */
const STATUS_LABEL = {
  created: '新建', paid: '已付款', processing: '處理中',
  shipped: '已出貨', delivered: '已送達', cancelled: '已取消',
};
const STATUS_CLASS = {
  created: 's-pend', paid: 's-paid', processing: 's-pend',
  shipped: 's-ship', delivered: 's-paid', cancelled: 's-cancel',
};
const NEXT_STATUS = {
  created: 'paid', paid: 'processing', processing: 'shipped', shipped: 'delivered',
};

let orderState = { page: 1, limit: 20, status: '', orderType: '', q: '', total: 0 };
let _orderSearchTimer = null;

function onOrderFilterChange() {
  // debounce 350ms
  clearTimeout(_orderSearchTimer);
  _orderSearchTimer = setTimeout(() => {
    orderState.page = 1;
    orderState.q = document.getElementById('order-search')?.value.trim() || '';
    orderState.status = document.getElementById('order-filter-status')?.value || '';
    orderState.orderType = document.getElementById('order-filter-type')?.value || '';
    loadOrders();
  }, 350);
}

async function loadOrders(page) {
  if (page) orderState.page = page;
  if (!currentUser || currentUser.role !== 'admin') return;

  const el = document.getElementById('order-list-container');
  if (!el) return;
  el.innerHTML = '<div class="bundle-admin-empty">載入中...</div>';

  try {
    const params = {
      page: orderState.page,
      limit: orderState.limit,
    };
    if (orderState.status) params.status = orderState.status;
    if (orderState.orderType) params.orderType = orderState.orderType;
    if (orderState.q) params.q = orderState.q;

    const res = await Api.listOrders(params);
    orderState.total = res.pagination.total;
    renderOrderList(res.orders);
    renderOrderPagination(res.pagination);
  } catch (e) {
    el.innerHTML = `<div class="bundle-admin-empty">載入失敗:${e.message}</div>`;
  }
}

function renderOrderList(orders) {
  const el = document.getElementById('order-list-container');
  if (!orders.length) {
    el.innerHTML = '<div class="bundle-admin-empty">沒有符合條件的訂單</div>';
    return;
  }
  el.innerHTML = `
    <div class="table-wrap">
      <table class="order-table">
        <thead><tr>
          <th>訂單編號</th><th>類型</th><th>顧客 / 店家</th>
          <th style="text-align:right">金額</th><th>付款</th><th>狀態</th><th>建立時間</th>
        </tr></thead>
        <tbody>
          ${orders.map(o => {
            const isDealer = o.orderType === 'dealer';
            const customerName = isDealer
              ? (o.dealer?.shopName || '-')
              : (o.customer?.email || o.customer?.name || '-');
            const ts = new Date(o.createdAt).toLocaleString('zh-TW', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            return `
              <tr onclick="openOrderModal('${encodeURIComponent(o.orderId)}')" style="cursor:pointer" title="點擊查看詳情">
                <td><code style="font-size:12px">${o.orderId}</code></td>
                <td><span class="order-status ${isDealer ? 's-dealer' : 's-pend'}">${isDealer ? '經銷' : '一般'}</span></td>
                <td>${customerName}</td>
                <td style="text-align:right;font-weight:700">NT$${o.totalAmount.toLocaleString()}</td>
                <td><span class="order-status ${o.payment.status === 'paid' ? 's-paid' : o.payment.status === 'failed' ? 's-cancel' : 's-pend'}">${o.payment.status}</span></td>
                <td><span class="order-status ${STATUS_CLASS[o.status] || 's-pend'}">${STATUS_LABEL[o.status] || o.status}</span></td>
                <td style="font-size:12px;color:var(--text-light)">${ts}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderOrderPagination(p) {
  const el = document.getElementById('order-pagination');
  if (!el) return;
  if (p.pages <= 1) { el.innerHTML = ''; return; }
  const prev = p.page > 1 ? `<button class="pill-btn" onclick="loadOrders(${p.page - 1})">上一頁</button>` : '';
  const next = p.page < p.pages ? `<button class="pill-btn" onclick="loadOrders(${p.page + 1})">下一頁</button>` : '';
  el.innerHTML = `${prev}<span class="page-info">第 ${p.page} / ${p.pages} 頁 (共 ${p.total} 筆)</span>${next}`;
}

/* ---------- 訂單詳情 modal ---------- */
async function openOrderModal(orderIdEnc) {
  const orderId = decodeURIComponent(orderIdEnc);
  const modal = document.getElementById('order-modal');
  const body = document.getElementById('order-modal-body');
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  body.innerHTML = '<p class="modal-sub">載入中...</p>';
  try {
    const { order } = await Api.getOrder(orderId);
    body.innerHTML = renderOrderDetail(order);
  } catch (e) {
    body.innerHTML = `<p style="color:var(--red)">載入失敗:${e.message}</p>`;
  }
}

function closeOrderModal() {
  const m = document.getElementById('order-modal');
  m.classList.remove('active');
  m.setAttribute('aria-hidden', 'true');
}

function renderOrderDetail(o) {
  const isDealer = o.orderType === 'dealer';
  const items = (o.items || []).map(i => `
    <li>
      <span class="item-name">${i.name}</span>
      <span class="item-qty">×${i.qty}</span>
      <span class="item-price">NT$${(i.price * i.qty).toLocaleString()}</span>
    </li>
  `).join('');

  const next = NEXT_STATUS[o.status];
  const canRefund = o.payment?.status === 'paid' && o.status !== 'cancelled';

  const customerHtml = isDealer
    ? `<div><b>店家:</b> ${o.dealer?.shopName || '-'}</div>
       <div><b>聯絡人:</b> ${o.dealer?.contact || '-'}</div>
       <div><b>電話:</b> ${o.dealer?.phone || '-'}</div>
       <div><b>預計交貨:</b> ${o.dealer?.deliveryDate || '-'}</div>
       <div><b>備註:</b> ${o.dealer?.note || '-'}</div>`
    : `<div><b>姓名:</b> ${o.customer?.name || '-'}</div>
       <div><b>Email:</b> ${o.customer?.email || '-'}</div>
       <div><b>電話:</b> ${o.customer?.phone || '-'}</div>`;

  return `
    <div class="order-detail">
      <div class="od-section">
        <div class="od-row"><span>訂單編號</span><code>${o.orderId}</code></div>
        <div class="od-row"><span>類型</span><span class="order-status ${isDealer ? 's-dealer' : 's-pend'}">${isDealer ? '經銷' : '一般'}</span></div>
        <div class="od-row"><span>狀態</span><span class="order-status ${STATUS_CLASS[o.status] || 's-pend'}">${STATUS_LABEL[o.status] || o.status}</span></div>
        <div class="od-row"><span>付款</span><span class="order-status ${o.payment?.status === 'paid' ? 's-paid' : 's-pend'}">${o.payment?.status || '-'}</span></div>
        <div class="od-row"><span>建立</span>${new Date(o.createdAt).toLocaleString('zh-TW')}</div>
        ${o.payment?.paidAt ? `<div class="od-row"><span>付款於</span>${new Date(o.payment.paidAt).toLocaleString('zh-TW')}</div>` : ''}
      </div>

      <div class="od-section">
        <h4 class="od-title">商品明細</h4>
        <ul class="od-items">${items}</ul>
        <div class="od-totals">
          <div><span>小計</span><span>NT$${o.subtotal.toLocaleString()}</span></div>
          <div><span>運費</span><span>NT$${o.shipping.toLocaleString()}</span></div>
          <div class="od-grand"><span>合計</span><span>NT$${o.totalAmount.toLocaleString()}</span></div>
        </div>
      </div>

      <div class="od-section">
        <h4 class="od-title">${isDealer ? '經銷資訊' : '顧客資訊'}</h4>
        ${customerHtml}
      </div>

      <div class="od-section">
        <h4 class="od-title">物流資訊</h4>
        <div class="od-row"><span>方式</span>${o.shippingMethod || '-'}</div>
        <div class="od-row"><span>地址</span>${o.shippingInfo?.address || '-'}</div>
        <div class="od-form">
          <label for="tracking-input">物流單號</label>
          <input type="text" id="tracking-input" value="${o.shippingInfo?.trackingNo || ''}" placeholder="例: 9999-1234-5678">
          <button class="pill-btn green" onclick="saveTracking('${encodeURIComponent(o.orderId)}')">儲存單號</button>
        </div>
      </div>

      ${o.payment?.transactionId ? `
      <div class="od-section">
        <h4 class="od-title">金流</h4>
        <div class="od-row"><span>方式</span>${o.payment.method}</div>
        <div class="od-row"><span>Transaction ID</span><code style="font-size:11px">${o.payment.transactionId}</code></div>
      </div>` : ''}

      <div class="od-actions">
        ${next ? `<button class="pill-btn green" onclick="advanceOrderStatus('${encodeURIComponent(o.orderId)}','${next}')">→ 標記為「${STATUS_LABEL[next]}」</button>` : ''}
        ${o.status !== 'cancelled' ? `<button class="pill-btn gray" onclick="advanceOrderStatus('${encodeURIComponent(o.orderId)}','cancelled')">取消訂單</button>` : ''}
        ${canRefund ? `<button class="pill-btn" style="background:var(--red-light);color:var(--red)" onclick="refundOrder('${encodeURIComponent(o.orderId)}')">💸 退款</button>` : ''}
      </div>
    </div>
  `;
}

async function advanceOrderStatus(orderIdEnc, newStatus) {
  const orderId = decodeURIComponent(orderIdEnc);
  if (newStatus === 'cancelled' && !confirm(`確定取消訂單 ${orderId}?`)) return;
  try {
    await Api.adminUpdateOrderStatus(orderId, newStatus);
    showToast(`✓ 狀態已更新:${STATUS_LABEL[newStatus]}`, true);
    closeOrderModal();
    loadOrders();
    loadDashboardStats();
  } catch (e) {
    showToast('狀態更新失敗:' + e.message, false);
  }
}

async function saveTracking(orderIdEnc) {
  const orderId = decodeURIComponent(orderIdEnc);
  const trackingNo = document.getElementById('tracking-input')?.value.trim() || '';
  try {
    await Api.adminUpdateOrderTracking(orderId, { trackingNo });
    showToast('✓ 物流單號已更新', true);
  } catch (e) {
    showToast('更新失敗:' + e.message, false);
  }
}

async function refundOrder(orderIdEnc) {
  const orderId = decodeURIComponent(orderIdEnc);
  if (!confirm(`確定要對訂單 ${orderId} 退款?\n此動作會呼叫 LINE Pay Refund API,實際扣款將返還給顧客。`)) return;
  try {
    await Api.adminRefundOrder(orderId);
    showToast('✓ 退款已送出', true);
    closeOrderModal();
    loadOrders();
    loadDashboardStats();
  } catch (e) {
    showToast('退款失敗:' + e.message, false);
  }
}

/* ---------- CSV 匯出 ---------- */
async function exportOrdersCSV() {
  try {
    // 抓當前篩選條件下「全部」訂單 (最多 1000 筆,避免太大)
    const params = { page: 1, limit: 1000 };
    if (orderState.status) params.status = orderState.status;
    if (orderState.orderType) params.orderType = orderState.orderType;
    if (orderState.q) params.q = orderState.q;
    const res = await Api.listOrders(params);

    const headers = ['訂單編號', '類型', '狀態', '付款', '小計', '運費', '合計', '顧客/店家', 'Email/電話', '建立時間'];
    const rows = res.orders.map(o => [
      o.orderId,
      o.orderType === 'dealer' ? '經銷' : '一般',
      STATUS_LABEL[o.status] || o.status,
      o.payment?.status || '-',
      o.subtotal,
      o.shipping,
      o.totalAmount,
      o.orderType === 'dealer' ? (o.dealer?.shopName || '') : (o.customer?.name || ''),
      o.orderType === 'dealer' ? (o.dealer?.phone || '') : (o.customer?.email || ''),
      new Date(o.createdAt).toISOString(),
    ]);

    const csv = [headers, ...rows].map(r =>
      r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    // 加 BOM 讓 Excel 開不亂碼
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`✓ 已匯出 ${rows.length} 筆訂單`, true);
  } catch (e) {
    showToast('匯出失敗:' + e.message, false);
  }
}

/* ---------- Dashboard 統計 ---------- */
async function loadDashboardStats() {
  if (!currentUser || currentUser.role !== 'admin') return;
  try {
    const { stats } = await Api.adminStats();
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('stat-prod', stats.catalog.products);
    setText('stat-bundle', stats.catalog.bundlesPublic);
    setText('stat-dealer', stats.catalog.bundlesDealer);
    setText('stat-addon', stats.catalog.addons);
    setText('stat-revenue', 'NT$' + (stats.month.revenue || 0).toLocaleString());
    setText('stat-pending', stats.pendingShipping);
  } catch (_) {
    // 失敗時 keep 原本 0,不打擾使用者
  }
}

/* ============================ STATS & TOAST ============================ */
function updateStats() {
  const e1 = document.getElementById('stat-prod');
  const e2 = document.getElementById('stat-bundle');
  const e3 = document.getElementById('stat-dealer');
  const e4 = document.getElementById('stat-addon');
  if (e1) e1.textContent = ALL_PRODUCTS.length;
  if (e2) e2.textContent = BUNDLES.filter(b => b.active && b.visibility === 'public').length;
  if (e3) e3.textContent = BUNDLES.filter(b => b.active && b.visibility === 'dealer').length;
  if (e4) e4.textContent = ADDON_PRODUCTS.filter(a => a.active !== false).length;
}

function showToast(msg, success = true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = success ? 'var(--gr)' : 'var(--red)';
  t.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2400);
}

/* ============================ PAYMENT REDIRECT ============================ */
function handlePaymentRedirect() {
  const params = new URLSearchParams(location.search);
  const status = params.get('payment');
  if (!status) return;
  const orderId = params.get('orderId');
  const msg = params.get('msg');
  setTimeout(() => {
    if (status === 'success') {
      showToast(`✓ 訂單 ${orderId || ''} 付款成功!`, true);
      cart = {};
      saveCart();
      updateCartBadge();
      renderCart();
      switchPage('cart');
    } else if (status === 'cancelled') {
      showToast('已取消付款', false);
    } else if (status === 'error') {
      showToast('付款失敗: ' + (decodeURIComponent(msg || '') || '未知錯誤'), false);
    }
  }, 500);
  history.replaceState({}, '', location.pathname);
}

/* ============================ INIT ============================ */
async function init() {
  showLoading('商品載入中…');
  renderChipSelector();
  updatePreview();
  await tryRestoreSession();
  await reloadCatalog();
  if (currentUser?.role === 'admin') await reloadAdminLists();
  updateRolePill();
  renderCart();
  handlePaymentRedirect();
  hideLoading();
}

init().catch(e => {
  console.error(e);
  showToast('初始化失敗: ' + (e.message || ''), false);
});
