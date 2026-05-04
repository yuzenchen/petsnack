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
let currentSearchQuery = '';
let _searchTimer = null;
let _mobileSearchTimer = null;

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

/* Modal backdrop click → close（點到 overlay 本體而非內容） */
const _MODAL_CLOSERS = {
  'product-modal': () => closeProductModal(),
  'order-confirm-modal': () => closeOrderConfirmModal(),
  'order-modal': () => closeOrderModal(),
  'checkout-modal': () => closeCheckoutModal(),
  'login-modal': () => closeLoginModal(),
};
document.addEventListener('click', function (e) {
  const overlay = e.target;
  if (!overlay.classList) return;
  // 標準 modal 或 search overlay,只在點到背景本體時關閉
  const isModal = overlay.classList.contains('modal-overlay');
  const isSearchOverlay = overlay.classList.contains('search-overlay');
  if (!isModal && !isSearchOverlay) return;
  if (!overlay.classList.contains('active')) return;
  if (isSearchOverlay) {
    closeSearchOverlay();
    return;
  }
  const closer = _MODAL_CLOSERS[overlay.id];
  if (closer) closer();
});

document.addEventListener('keydown', function (e) {
  // 手機搜尋 overlay: Escape 關閉
  const searchO = document.getElementById('search-overlay');
  if (searchO && searchO.classList.contains('active')) {
    if (e.key === 'Escape') { e.preventDefault(); closeSearchOverlay(); return; }
  }
  // 商品詳情 modal: Escape 關閉
  const prodM = document.getElementById('product-modal');
  if (prodM && prodM.classList.contains('active')) {
    if (e.key === 'Escape') { e.preventDefault(); closeProductModal(); return; }
  }
  // 訂單確認 modal: Escape 關閉
  const ocM = document.getElementById('order-confirm-modal');
  if (ocM && ocM.classList.contains('active')) {
    if (e.key === 'Escape') { e.preventDefault(); closeOrderConfirmModal(); return; }
  }
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

/* 控制手機搜尋 icon 的顯示
   用 matchMedia 只在跨越斷點時觸發,比 resize listener 高效 */
const _mobileMQ = window.matchMedia('(max-width: 899px)');
function updateSearchIconVisibility() {
  const icon = document.getElementById('bnav-search');
  if (icon) icon.style.display = _mobileMQ.matches ? 'flex' : 'none';
}
_mobileMQ.addEventListener('change', updateSearchIconVisibility);
document.addEventListener('DOMContentLoaded', updateSearchIconVisibility);

function updateRolePill() {
  const pill = document.getElementById('role-pill');
  const icon = document.getElementById('role-icon');
  const text = document.getElementById('role-text');
  pill.classList.remove('dealer', 'admin');
  if (!currentUser) { icon.textContent = '👤'; text.textContent = '登入 / 註冊'; }
  else if (currentUser.role === 'dealer') { pill.classList.add('dealer'); icon.textContent = '💼'; text.textContent = currentUser.displayName; }
  else if (currentUser.role === 'admin') { pill.classList.add('admin'); icon.textContent = '⚙️'; text.textContent = currentUser.displayName; }
}

/* ============================ PRODUCT SEARCH ============================ */
/* 切換 body.searching + 更新狀態列文字; 從非搜尋進入搜尋時自動 scroll to top */
function _setSearchingMode(query) {
  const wasSearching = document.body.classList.contains('searching');
  const isSearching = !!query;
  document.body.classList.toggle('searching', isSearching);

  if (isSearching) {
    const productCount = ALL_PRODUCTS.filter(p => matchesSearchQuery(p, query)).length;
    const visibleBundles = BUNDLES.filter(b => {
      if (!b.active) return false;
      if (b.visibility === 'public') return true;
      return currentUser && (currentUser.role === 'dealer' || currentUser.role === 'admin');
    });
    const bundleCount = visibleBundles.filter(b => matchesBundleSearchQuery(b, query)).length;
    const total = productCount + bundleCount;
    const text = document.getElementById('search-status-text');
    if (text) text.textContent = `搜尋「${query}」 ・ ${total} 件結果`;
    if (!wasSearching) {
      // 首次進入搜尋模式 → 捲到頂端讓使用者看到結果
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
}

function handleProductSearch() {
  const input = document.getElementById('product-search');
  if (!input) return;
  const query = input.value.trim();
  const clearBtn = document.getElementById('search-clear-btn');
  if (clearBtn) clearBtn.style.display = query.length > 0 ? 'block' : 'none';
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    currentSearchQuery = query;
    const onShop = document.getElementById('page-shop')?.classList.contains('active');
    if (!onShop && query) switchPage('shop');
    renderProducts();
    renderBundleShop();
    renderBundleDealer();
    _setSearchingMode(query);
  }, 250);
}

function clearProductSearch() {
  const input = document.getElementById('product-search');
  const clearBtn = document.getElementById('search-clear-btn');
  if (input) { input.value = ''; input.focus(); }
  if (clearBtn) clearBtn.style.display = 'none';
  currentSearchQuery = '';
  renderProducts();
  renderBundleShop();
  renderBundleDealer();
  _setSearchingMode('');
}

function matchesSearchQuery(product, query) {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  const searchableFields = [product.name || '', product.sub || ''];
  return searchableFields.some(field => String(field).toLowerCase().includes(lowerQuery));
}

function matchesBundleSearchQuery(bundle, query) {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  const bundleName = bundle.name || '';
  const bundleTag = bundle.tag || '';
  if (bundleName.toLowerCase().includes(lowerQuery) || bundleTag.toLowerCase().includes(lowerQuery)) return true;
  const items = bundle.items?.map(getProduct).filter(Boolean) || [];
  return items.some(p => matchesSearchQuery(p, query));
}

/* 手機搜尋 Overlay */
function openSearchOverlay() {
  const overlay = document.getElementById('search-overlay');
  if (overlay) {
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => document.getElementById('mobile-product-search')?.focus(), 100);
  }
}

function closeSearchOverlay() {
  const overlay = document.getElementById('search-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    const input = document.getElementById('mobile-product-search');
    if (input) input.value = '';
  }
}

function handleMobileSearch() {
  const input = document.getElementById('mobile-product-search');
  if (!input) return;
  const query = input.value.trim();
  const clearBtn = document.getElementById('mobile-search-clear');
  if (clearBtn) clearBtn.style.display = query.length > 0 ? 'block' : 'none';
  clearTimeout(_mobileSearchTimer);
  _mobileSearchTimer = setTimeout(() => {
    renderMobileSearchResults(query);
  }, 250);
}

function clearMobileSearch() {
  const input = document.getElementById('mobile-product-search');
  const clearBtn = document.getElementById('mobile-search-clear');
  if (input) { input.value = ''; input.focus(); }
  if (clearBtn) clearBtn.style.display = 'none';
  renderMobileSearchResults('');
}

function renderMobileSearchResults(query) {
  const container = document.getElementById('search-results-container');
  if (!container) return;
  if (!query) {
    container.innerHTML = '<div class="search-result-empty">輸入商品名稱開始搜尋</div>';
    return;
  }
  const products = ALL_PRODUCTS.filter(p => matchesSearchQuery(p, query));
  const bundles = BUNDLES
    .filter(b => b.active && (b.visibility === 'public' || (currentUser && (currentUser.role === 'dealer' || currentUser.role === 'admin'))))
    .filter(b => matchesBundleSearchQuery(b, query));

  if (!products.length && !bundles.length) {
    container.innerHTML = `<div class="search-result-empty">搜尋「${escHtml(query)}」無結果</div>`;
    return;
  }

  const productItems = products.map(p => `
    <button type="button" class="search-result-item" onclick="selectSearchResult('prod',${p.id})">
      <div class="search-result-emoji">${escHtml(p.emoji)}</div>
      <div class="search-result-info">
        <div class="search-result-name">${escHtml(p.name)}</div>
        ${p.sub ? `<div class="search-result-sub">${escHtml(p.sub)}</div>` : ''}
      </div>
      <div class="search-result-price">NT$ ${p.price}</div>
    </button>`).join('');

  const bundleItems = bundles.map(b => {
    const final = bundleFinal(b);
    const items = (b.items || []).map(getProduct).filter(Boolean);
    const emojis = items.map(p => p.emoji).join('');
    return `
    <button type="button" class="search-result-item" onclick="selectSearchResult('bundle',${b.id})">
      <div class="search-result-emoji">${escHtml(emojis || '📦')}</div>
      <div class="search-result-info">
        <div class="search-result-name">${escHtml(b.name)} <span class="search-result-tag">組合包</span></div>
        ${b.tag ? `<div class="search-result-sub">${escHtml(b.tag)}</div>` : ''}
      </div>
      <div class="search-result-price">NT$ ${final}</div>
    </button>`;
  }).join('');

  container.innerHTML = productItems + bundleItems;
}

/* 點搜尋結果 → 開商品詳情 modal,讓使用者看完再決定要不要加購 */
function selectSearchResult(itemType, id) {
  closeSearchOverlay();
  openProductModal(itemType, id);
}

/* ============================ PAGE SWITCH ============================ */
function switchPage(name, opts = {}) {
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
  // 切到非分類頁時,清掉 hash 路由（避免重整跳回分類頁）
  if (name !== 'category' && !opts.skipHashSync) {
    if (location.hash && location.hash !== '#/') {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function filterAndScroll(type) {
  switchPage('shop');
  const idxMap = { dog: 1, cat: 2, both: 3 };
  const btn = document.querySelectorAll('.filter-btn')[idxMap[type]];
  if (btn) filterProds(type, btn);
  setTimeout(() => document.getElementById('products-grid').scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

/* ============================ CATEGORY PAGE & HASH ROUTING ============================ */
const CATEGORY_META = {
  dog:  { eyebrow: 'DOG TREATS',       title: '狗狗鮮肉零食系列', emoji: '🐶',
          desc: '精選低脂肉品,適合日常訓練。使用當日屠宰新鮮肉品,讓食材本身的鮮味,訴說產品的用心。' },
  cat:  { eyebrow: 'CAT TREATS',       title: '貓咪海鮮零食系列', emoji: '🐱',
          desc: '挑選硬度適中食材,人工精細修除油膜,讓正在飲食控制中的貓咪也能享受開心啃咬的樂趣。' },
  both: { eyebrow: 'UNIVERSAL TREATS', title: '毛孩通用零食系列', emoji: '🌟',
          desc: '狗狗貓咪都適用的精選配方,溫和不刺激,是多寵物家庭的理想選擇。' },
};

/* admin 可上傳分類橫幅圖,fetch 後存這裡;空字串 = 沿用 emoji */
let CATEGORY_IMAGES = { dog: '', cat: '', both: '' };

async function loadCategoryImages() {
  try {
    const { categories } = await Api.categories();
    (categories || []).forEach((c) => {
      if (CATEGORY_IMAGES[c.key] !== undefined) CATEGORY_IMAGES[c.key] = c.imageUrl || '';
    });
    applyCategoryImagesToShowcase();
  } catch (e) {
    // 失靜默 — 沿用 emoji 即可,不擋首頁
    console.warn('載入分類圖片失敗,沿用 emoji:', e.message);
  }
}

/* admin 後台:渲染三個分類的圖片網址編輯卡 */
function renderAdminCategoryImages() {
  const wrap = document.getElementById('admin-category-images');
  if (!wrap) return;
  wrap.innerHTML = ['dog', 'cat', 'both'].map((key) => {
    const meta = CATEGORY_META[key];
    const url = CATEGORY_IMAGES[key] || '';
    const previewHtml = url
      ? `<img src="${escHtml(url)}" alt="" class="cat-image-preview-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="cat-image-preview-fallback" style="display:none">⚠ 圖片載入失敗</div>`
      : `<div class="cat-image-preview-fallback">${escHtml(meta.emoji)} 尚未設定圖片</div>`;
    return `
      <div class="cat-image-row">
        <div class="cat-image-preview">${previewHtml}</div>
        <div class="cat-image-form">
          <label class="cat-image-label">${escHtml(meta.title)}</label>
          <input type="url" id="cat-img-${key}" class="cat-image-input"
                 value="${escHtml(url)}" placeholder="https://..."
                 onkeypress="if(event.key==='Enter')saveCategoryImage('${key}')">
          <div class="cat-image-actions">
            <button class="pill-btn green" onclick="saveCategoryImage('${key}')">儲存</button>
            ${url ? `<button class="pill-btn gray" onclick="clearCategoryImage('${key}')">清除</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

async function saveCategoryImage(key) {
  const inp = document.getElementById('cat-img-' + key);
  if (!inp) return;
  const imageUrl = inp.value.trim();
  try {
    await Api.adminUpdateCategory(key, { imageUrl });
    CATEGORY_IMAGES[key] = imageUrl;
    applyCategoryImagesToShowcase();
    renderAdminCategoryImages();
    showToast(imageUrl ? `✓ ${CATEGORY_META[key].title} 圖片已更新` : `✓ 已清除${CATEGORY_META[key].title}圖片`, true);
  } catch (e) {
    showToast('儲存失敗: ' + (e.message || ''), false);
  }
}

async function clearCategoryImage(key) {
  const inp = document.getElementById('cat-img-' + key);
  if (inp) inp.value = '';
  await saveCategoryImage(key);
}

/* 把 CATEGORY_IMAGES 套用到首頁三個系列橫幅 (csr-img-dog/cat/both) */
function applyCategoryImagesToShowcase() {
  ['dog', 'cat', 'both'].forEach((key) => {
    const wrap = document.getElementById('csr-img-' + key);
    if (!wrap) return;
    const url = CATEGORY_IMAGES[key];
    const meta = CATEGORY_META[key];
    if (url) {
      wrap.innerHTML = `<img src="${escHtml(url)}" alt="${escHtml(meta.title)}" class="csr-real-img" onerror="this.parentNode.innerHTML='<span class=&quot;csr-emoji&quot;>${escHtml(meta.emoji)}</span>'">`;
    } else {
      wrap.innerHTML = `<span class="csr-emoji">${escHtml(meta.emoji)}</span>`;
    }
  });
}

function goCategory(type) {
  if (!CATEGORY_META[type]) return;
  location.hash = '#/cat/' + type;
}

function renderCategoryPage(type) {
  const meta = CATEGORY_META[type];
  if (!meta) return;
  document.getElementById('cat-hero-eyebrow').textContent = meta.eyebrow;
  document.getElementById('cat-hero-title').textContent = meta.title;
  document.getElementById('cat-hero-desc').textContent = meta.desc;
  // hero 區圖片:有 imageUrl 則顯示 <img> + cover crop;否則 emoji
  const heroBg = document.getElementById('cat-hero-bg');
  if (heroBg) {
    const url = CATEGORY_IMAGES[type];
    if (url) {
      heroBg.innerHTML = `<img src="${escHtml(url)}" alt="${escHtml(meta.title)}" class="cat-hero-img" onerror="this.parentNode.innerHTML='<span class=&quot;cat-hero-emoji&quot;>${escHtml(meta.emoji)}</span>'">`;
    } else {
      heroBg.innerHTML = `<span class="cat-hero-emoji" id="cat-hero-emoji">${escHtml(meta.emoji)}</span>`;
    }
  }

  const grid = document.getElementById('cat-products-grid');
  const list = ALL_PRODUCTS.filter(p => p.type === type || (type !== 'both' && p.type === 'both'));
  if (!list.length) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">此分類目前無商品</p>';
    return;
  }
  const lbl = { new: '新品', hot: '熱賣', sale: '優惠' };
  grid.innerHTML = list.map(p => {
    const tracked = p.trackStock !== false;
    const isOut = tracked && (p.stock ?? 0) <= 0;
    const badge = stockBadgeHtml(p.stock, p.lowStockThreshold ?? 5, p.trackStock);
    return `
    <article class="product-card${isOut ? ' is-out' : ''}" onclick="openProductModal('prod',${p.id})" style="cursor:pointer" tabindex="0" onkeydown="if(event.key==='Enter')openProductModal('prod',${p.id})">
      ${p.badge ? `<span class="product-badge ${p.badge}">${lbl[p.badge]}</span>` : ''}
      ${countdownBadgeHtml(p.endsAt)}
      ${productMediaHtml(p)}
      <div class="product-info">
        <h5>${escHtml(p.name)}</h5>
        <div class="product-sub">${escHtml(p.sub || '')}</div>
        <div class="price-wrap">
          <span class="price-sale">NT$ ${p.price}</span>
          ${p.orig ? `<span class="price-regular">NT$ ${p.orig}</span>` : ''}
        </div>
        ${badge}
      </div>
      <button class="add-cart-btn" ${isOut ? 'disabled aria-disabled="true"' : ''} onclick="event.stopPropagation();addToCart('prod_${p.id}','${escAttrJs(p.emoji + ' ' + p.name)}','單品',${p.price},this)">${isOut ? '缺貨中' : '加入購物車'}</button>
    </article>`;
  }).join('');
}

function applyHashRoute() {
  const m = (location.hash || '').match(/^#\/cat\/(dog|cat|both)$/);
  if (m) {
    switchPage('category', { skipHashSync: true });
    renderCategoryPage(m[1]);
  } else {
    // 空 hash 或 #/ → 若目前停在分類頁,切回首頁
    const onCat = document.getElementById('page-category')?.classList.contains('active');
    if (onCat) switchPage('shop', { skipHashSync: true });
  }
}
window.addEventListener('hashchange', applyHashRoute);

function bundleScroll() {
  switchPage('shop');
  setTimeout(() => document.getElementById('bundle-anchor').scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

/* ============================ DATA RELOAD ============================ */
function _normalizeProduct(p) {
  return {
    id: p.productId, name: p.name, sub: p.sub, emoji: p.emoji,
    price: p.price, orig: p.orig, badge: p.badge, type: p.type,
    stock: p.stock, lowStockThreshold: p.lowStockThreshold,
    trackStock: p.trackStock, stockStatus: p.stockStatus,
    imageUrl: p.imageUrl || '', description: p.description || '',
    endsAt: p.endsAt || null,
    active: p.active !== false,
  };
}
function _normalizeBundle(b)  { return { id: b.bundleId, name: b.name, tag: b.tag, items: b.items, disc: b.disc, visibility: b.visibility, active: b.active, imageUrl: b.imageUrl || '', description: b.description || '', endsAt: b.endsAt || null }; }
function _normalizeAddon(a) {
  return {
    id: a.addonId, name: a.name, emoji: a.emoji,
    orig: a.orig, special: a.special, active: a.active,
    stock: a.stock, lowStockThreshold: a.lowStockThreshold,
    trackStock: a.trackStock, stockStatus: a.stockStatus,
  };
}

/* 計算組合包 availableStock = MIN(items 的 stock) */
function bundleAvailableStock(b) {
  if (!b.items?.length) return 0;
  let min = Infinity;
  for (const id of b.items) {
    const p = getProduct(id);
    if (!p) return 0;
    if (p.trackStock === false) continue;
    if (p.stock < min) min = p.stock;
  }
  return Number.isFinite(min) ? min : 999;
}

/* 共用:渲染 stock badge HTML */
function stockBadgeHtml(stockOrItem, lowThreshold = 5, trackStock = true) {
  const stock = typeof stockOrItem === 'number' ? stockOrItem : (stockOrItem?.stock ?? 0);
  if (trackStock === false) return '';
  if (stock <= 0) return '<span class="stock-badge out">缺貨</span>';
  if (stock <= lowThreshold) return `<span class="stock-badge low">僅剩 ${stock} 件</span>`;
  return '<span class="stock-badge ok">有現貨</span>';
}

/* ============================ COUNTDOWN ============================ */
/* 把 endsAt (ISO 字串 / Date / null) 轉成倒數 badge HTML
   class="countdown-timer" + data-ends-at,讓全域 tick 每秒更新文字 */
function countdownBadgeHtml(endsAt, opts = {}) {
  if (!endsAt) return '';
  const ms = new Date(endsAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return ''; // 已過期 (lazy filter 應該已濾掉,雙保險)
  const size = opts.size || 'sm'; // sm | lg
  const isUrgent = ms <= 3600 * 1000; // < 1hr 紅色 + pulse
  const text = formatCountdown(ms);
  const ts = new Date(endsAt).toLocaleString('zh-TW', { hour12: false });
  return `<span class="countdown-timer cd-${size}${isUrgent ? ' urgent' : ''}" data-ends-at="${escHtml(new Date(endsAt).toISOString())}" title="截止時間: ${escHtml(ts)}">⏳ ${text}</span>`;
}

function formatCountdown(ms) {
  if (ms <= 0) return '已結束';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/* 全域 tick:每秒更新所有 .countdown-timer 文字
   倒數歸零 → 直接把所屬卡片從 DOM 移除 (不重打 API,避免 reloadCatalog 把
   整個 grid 換成 skeleton 造成閃爍;伺服器端 lazy filter + cron 會在下次
   頁面載入時自然同步)。
   modal 中的倒數歸零 → 顯示「已結束」+ 禁用加入購物車按鈕。 */
let _countdownInterval = null;
function startCountdownTicker() {
  if (_countdownInterval) return;
  _countdownInterval = setInterval(_tickCountdowns, 1000);
}

function _tickCountdowns() {
  const els = document.querySelectorAll('.countdown-timer[data-ends-at]');
  if (!els.length) return;
  els.forEach((el) => {
    const ms = new Date(el.dataset.endsAt).getTime() - Date.now();
    if (ms > 0) {
      el.textContent = '⏳ ' + formatCountdown(ms);
      if (ms <= 3600 * 1000) el.classList.add('urgent');
      return;
    }
    // 到期:依元素位置決定處置
    el.classList.remove('urgent');
    el.classList.add('expired');
    el.textContent = '⏳ 已結束';
    delete el.dataset.endsAt; // 防止下一輪 tick 重複處理

    const card = el.closest('.product-card');
    if (card) {
      // 商品/組合包卡片 — 直接移除 (淡出動畫)
      card.style.transition = 'opacity .35s ease, transform .35s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(.96)';
      setTimeout(() => card.remove(), 360);
      return;
    }
    // modal / admin 列表 / 其他位置 — 不移除,顯示「已結束」+ 禁用加購按鈕
    const pmd = el.closest('.pmd-info, .pmd-layout');
    if (pmd) {
      const cartBtn = pmd.querySelector('.pmd-cart-btn');
      if (cartBtn) {
        cartBtn.disabled = true;
        cartBtn.textContent = '⏳ 限時銷售已結束';
      }
    }
  });
}

/* HTML / 屬性內 JS 字串跳脫 helper */
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttrJs(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* 商品圖片 / emoji 顯示（有 imageUrl 時顯示 img，否則顯示 emoji） */
function productMediaHtml(item) {
  if (item.imageUrl) {
    return `<div class="product-img" data-emoji="${escHtml(item.emoji || '')}" aria-hidden="true"><img src="${escHtml(item.imageUrl)}" alt="${escHtml(item.name)}" class="prod-real-img" onerror="this.parentNode.innerHTML=this.parentNode.dataset.emoji"></div>`;
  }
  return `<div class="product-img" aria-hidden="true">${escHtml(item.emoji || '')}</div>`;
}

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

/* Dashboard 統計卡點擊 → 捲到對應功能區塊 (有需要的話順便預設篩選) */
function dashJump(target) {
  const map = {
    stock:    'stock-admin-card',     // 上架商品 / 低庫存
    lowstock: 'stock-admin-card',
    bundle:   'bundle-admin-card',    // 公開 / 經銷組合
    addon:    'addon-admin-card',
    revenue:  'order-admin-card',     // 本月營收 → 訂單列表
    pending:  'order-admin-card',     // 待出貨 → 訂單列表 + 預設 status=paid
  };
  const id = map[target];
  const el = id ? document.getElementById(id) : null;
  if (!el) return;

  // 待出貨 → 自動把訂單篩選器設成 status=paid
  if (target === 'pending') {
    const sel = document.getElementById('order-filter-status');
    if (sel) {
      sel.value = 'paid';
      if (typeof onOrderFilterChange === 'function') onOrderFilterChange();
    }
  }
  // 低庫存 → 自動勾「只看低庫存」
  if (target === 'lowstock') {
    const cb = document.getElementById('stock-show-low-only');
    if (cb && !cb.checked) {
      cb.checked = true;
      if (typeof renderStockList === 'function') renderStockList();
    }
  }

  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // 短暫高亮提示視覺對焦
  el.classList.add('dash-jump-flash');
  setTimeout(() => el.classList.remove('dash-jump-flash'), 1200);
}

async function reloadAdminLists() {
  if (!currentUser || currentUser.role !== 'admin') return;
  try {
    const [bRes, aRes] = await Promise.all([Api.adminListBundles(), Api.adminListAddons()]);
    BUNDLES = bRes.bundles.map(_normalizeBundle);
    ADDON_PRODUCTS = aRes.addons.map(_normalizeAddon);
    renderBundleAdmin();
    renderAddonAdmin();
    renderAdminCategoryImages();
    updateStats();
    renderBundleShop();
    renderBundleDealer();
    // 訂單管理 + 真實統計 + 庫存列表 (並行載入,不阻塞 UI)
    loadOrders();
    loadDashboardStats();
    loadStockList();
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
  let list = currentFilter === 'all' ? ALL_PRODUCTS
    : ALL_PRODUCTS.filter(p => p.type === currentFilter || p.type === 'both');
  list = list.filter(p => matchesSearchQuery(p, currentSearchQuery));
  const lbl = { new: '新品', hot: '熱賣', sale: '優惠' };
  if (!list.length) {
    const msg = currentSearchQuery ? `搜尋「${escHtml(currentSearchQuery)}」無結果` : '此分類無商品';
    grid.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">${msg}</p>`;
    return;
  }
  grid.innerHTML = list.map(p => {
    const tracked = p.trackStock !== false;
    const isOut = tracked && (p.stock ?? 0) <= 0;
    const badge = stockBadgeHtml(p.stock, p.lowStockThreshold ?? 5, p.trackStock);
    return `
    <article class="product-card${isOut ? ' is-out' : ''}" onclick="openProductModal('prod',${p.id})" style="cursor:pointer" tabindex="0" onkeydown="if(event.key==='Enter')openProductModal('prod',${p.id})">
      ${p.badge ? `<span class="product-badge ${p.badge}">${lbl[p.badge]}</span>` : ''}
      ${countdownBadgeHtml(p.endsAt)}
      ${productMediaHtml(p)}
      <div class="product-info">
        <h5>${escHtml(p.name)}</h5>
        <div class="product-sub">${escHtml(p.sub || '')}</div>
        <div class="price-wrap">
          <span class="price-sale">NT$ ${p.price}</span>
          ${p.orig ? `<span class="price-regular">NT$ ${p.orig}</span>` : ''}
        </div>
        ${badge}
      </div>
      <button class="add-cart-btn" ${isOut ? 'disabled aria-disabled="true"' : ''} onclick="event.stopPropagation();addToCart('prod_${p.id}','${escAttrJs(p.emoji + ' ' + p.name)}','單品',${p.price},this)">${isOut ? '缺貨中' : '加入購物車'}</button>
    </article>`;
  }).join('');
}

/* ============================ BUNDLES ============================ */
function getProduct(id) { return ALL_PRODUCTS.find(p => p.id === id); }
function bundleOrig(b) { return b.items.reduce((s, id) => s + (getProduct(id)?.price || 0), 0); }
function bundleFinal(b) { return Math.round(bundleOrig(b) * (1 - b.disc / 100)); }

function renderBundleShop() {
  const el = document.getElementById('bundle-grid-shop');
  let list = BUNDLES.filter(b => b.active && b.visibility === 'public');
  list = list.filter(b => matchesBundleSearchQuery(b, currentSearchQuery));
  if (!list.length) { el.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">目前無上架組合包</p>'; return; }
  el.innerHTML = list.map(b => renderBundleCard(b, false)).join('');
}

function renderBundleDealer() {
  const el = document.getElementById('bundle-grid-dealer');
  if (!el) return;
  let list = BUNDLES.filter(b => b.active && b.visibility === 'dealer');
  list = list.filter(b => matchesBundleSearchQuery(b, currentSearchQuery));
  if (!list.length) { el.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:40px">目前無經銷專屬組合包</p>'; return; }
  el.innerHTML = list.map(b => renderBundleCard(b, true)).join('');
}

/* ============================================================
   PRODUCT DETAIL MODAL (項目 1)
   ============================================================ */
const PET_LABEL = { dog: '🐶 狗狗', cat: '🐱 貓咪', both: '🌟 通用' };
const BADGE_LABEL = { new: '新品', hot: '熱賣', sale: '優惠' };

function openProductModal(itemType, id) {
  const modal = document.getElementById('product-modal');
  const body = document.getElementById('product-modal-body');
  if (!modal || !body) return;

  let html = '';

  if (itemType === 'prod') {
    const p = ALL_PRODUCTS.find(x => String(x.id) === String(id));
    if (!p) return;
    const tracked = p.trackStock !== false;
    const isOut = tracked && (p.stock ?? 0) <= 0;
    const badge = stockBadgeHtml(p.stock, p.lowStockThreshold ?? 5, p.trackStock);
    const imgContent = p.imageUrl
      ? `<div class="pmd-img-wrap" data-emoji="${escHtml(p.emoji)}" aria-hidden="true"><img src="${escHtml(p.imageUrl)}" alt="${escHtml(p.name)}" class="prod-real-img" onerror="this.parentNode.innerHTML=this.parentNode.dataset.emoji"></div>`
      : `<div class="pmd-img-wrap" aria-hidden="true"><div class="product-modal-emoji">${escHtml(p.emoji)}</div></div>`;
    html = `
      <div class="pmd-layout">
        ${imgContent}
        <div class="pmd-info">
          <h3 id="product-modal-title">${escHtml(p.name)}</h3>
          ${p.sub ? `<p class="pmd-sub">${escHtml(p.sub)}</p>` : ''}
          <div class="pmd-price-wrap">
            <span class="price-sale">NT$ ${p.price}</span>
            ${p.orig ? `<span class="price-regular">NT$ ${p.orig}</span>` : ''}
          </div>
          ${p.description ? `<p class="pmd-desc">${escHtml(p.description)}</p>` : ''}
          ${p.endsAt ? `<div class="pmd-countdown-wrap">${countdownBadgeHtml(p.endsAt, { size: 'lg' })}<span class="pmd-countdown-label">限時優惠倒數</span></div>` : ''}
          <div class="pmd-tags">
            ${p.type ? `<span class="pmd-tag">${escHtml(PET_LABEL[p.type] || p.type)}</span>` : ''}
            ${p.badge ? `<span class="pmd-tag ${p.badge}">${escHtml(BADGE_LABEL[p.badge] || p.badge)}</span>` : ''}
          </div>
          ${badge}
          <button class="modal-btn primary pmd-cart-btn" ${isOut ? 'disabled' : ''} onclick="addToCart('prod_${p.id}','${escAttrJs(p.emoji + ' ' + p.name)}','單品',${p.price},this);closeProductModal()">
            ${isOut ? '⚠ 缺貨中' : '🛒 加入購物車'}
          </button>
        </div>
      </div>`;

  } else if (itemType === 'bundle') {
    const b = BUNDLES.find(x => String(x.id) === String(id));
    if (!b) return;
    const orig = bundleOrig(b), final = bundleFinal(b), save = orig - final;
    const items = b.items.map(getProduct).filter(Boolean);
    const emojis = items.map(p => p.emoji).join('');
    const key = 'bundle_' + b.id;
    const bType = b.visibility === 'dealer' ? '經銷組合包' : '組合包';
    const avail = bundleAvailableStock(b);
    const isOut = avail <= 0;
    const badge = stockBadgeHtml(avail, 5);
    const imgContent = b.imageUrl
      ? `<div class="pmd-img-wrap" data-emoji="${escHtml(emojis)}" aria-hidden="true"><img src="${escHtml(b.imageUrl)}" alt="${escHtml(b.name)}" class="prod-real-img" onerror="this.parentNode.innerHTML=this.parentNode.dataset.emoji"></div>`
      : `<div class="pmd-img-wrap" aria-hidden="true"><div class="product-modal-emoji bundle-modal-emoji">${escHtml(emojis)}</div></div>`;
    html = `
      <div class="pmd-layout">
        ${imgContent}
        <div class="pmd-info">
          <h3 id="product-modal-title">${escHtml(b.name)}</h3>
          ${b.tag ? `<p class="pmd-sub">${escHtml(b.tag)}</p>` : ''}
          <div class="pmd-price-wrap">
            <span class="bundle-ribbon-inline">${b.disc}% OFF</span>
            <span class="price-sale">NT$ ${final}</span>
            <span class="price-regular">NT$ ${orig}</span>
          </div>
          ${b.description ? `<p class="pmd-desc">${escHtml(b.description)}</p>` : ''}
          ${b.endsAt ? `<div class="pmd-countdown-wrap">${countdownBadgeHtml(b.endsAt, { size: 'lg' })}<span class="pmd-countdown-label">限時優惠倒數</span></div>` : ''}
          <div class="pmd-bundle-items">
            <div class="pmd-items-label">包含商品</div>
            ${items.map(p => `
              <div class="pmd-bundle-item">
                <span class="pmd-item-emoji">${escHtml(p.emoji)}</span>
                <span class="pmd-item-name">${escHtml(p.name)}</span>
                <span class="pmd-item-price">NT$${p.price}</span>
              </div>`).join('')}
          </div>
          <span class="bundle-save">組合立省 NT$${save}</span>
          ${badge}
          <button class="modal-btn primary pmd-cart-btn" ${isOut ? 'disabled' : ''} onclick="addToCart('${escAttrJs(key)}','${escAttrJs(emojis + ' ' + b.name)}','${escAttrJs(bType)}',${final},this);closeProductModal()">
            ${isOut ? '⚠ 缺貨中' : '🛒 加入購物車'}
          </button>
        </div>
      </div>`;
  }

  body.innerHTML = html;
  _lastFocusedBeforeModal = document.activeElement;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => modal.querySelector('.modal-close')?.focus(), 100);
}

function closeProductModal() {
  const m = document.getElementById('product-modal');
  if (!m) return;
  m.classList.remove('active');
  m.setAttribute('aria-hidden', 'true');
  if (_lastFocusedBeforeModal) {
    try { _lastFocusedBeforeModal.focus(); } catch (_) {}
  }
}

function renderBundleCard(b, isDealer) {
  const orig = bundleOrig(b), final = bundleFinal(b), save = orig - final;
  const items = b.items.map(getProduct).filter(Boolean);
  const emojis = items.map(p => p.emoji).join('');
  const names = items.map(p => p.name).join(' + ');
  const key = 'bundle_' + b.id;
  const type = isDealer ? '經銷組合包' : '組合包';
  const avail = bundleAvailableStock(b);
  const isOut = avail <= 0;
  const badge = stockBadgeHtml(avail, 5);
  const bundleImgHtml = b.imageUrl
    ? `<div class="product-img" data-emoji="${escHtml(emojis)}" aria-hidden="true"><img src="${escHtml(b.imageUrl)}" alt="${escHtml(b.name)}" class="prod-real-img" onerror="this.parentNode.innerHTML=this.parentNode.dataset.emoji"></div>`
    : `<div class="product-img" aria-hidden="true"><span class="bundle-emojis-row">${escHtml(emojis)}</span></div>`;
  return `
    <article class="product-card bundle-card ${isDealer ? 'dealer' : ''}${isOut ? ' is-out' : ''}" onclick="openProductModal('bundle',${b.id})" style="cursor:pointer" tabindex="0" onkeydown="if(event.key==='Enter')openProductModal('bundle',${b.id})">
      ${isDealer ? '<span class="bundle-vip-tag">VIP</span>' : ''}
      <span class="bundle-ribbon">${b.disc}% OFF</span>
      ${countdownBadgeHtml(b.endsAt)}
      ${bundleImgHtml}
      <div class="product-info">
        <h5>${escHtml(b.name)}</h5>
        <div class="product-sub">${escHtml(b.tag || '')}</div>
        <div class="bundle-items-list">${escHtml(names)}</div>
        <div class="price-wrap">
          <span class="price-sale">NT$ ${final}</span>
          <span class="price-regular">NT$ ${orig}</span>
        </div>
        <span class="bundle-save">省 NT$${save}</span>
        ${badge}
      </div>
      <button class="add-cart-btn" ${isOut ? 'disabled aria-disabled="true"' : ''} onclick="event.stopPropagation();addToCart('${escAttrJs(key)}','${escAttrJs(emojis + ' ' + b.name)}','${escAttrJs(type)}',${final},this)">${isOut ? '缺貨中' : '加入購物車'}</button>
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
  const imgEl = document.getElementById('b-imageUrl'); if (imgEl) imgEl.value = '';
  const descEl = document.getElementById('b-description'); if (descEl) descEl.value = '';
  const endsEl = document.getElementById('b-endsAt'); if (endsEl) endsEl.value = '';
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
  const imageUrl = document.getElementById('b-imageUrl')?.value.trim() || undefined;
  const description = document.getElementById('b-description')?.value.trim() || undefined;
  // datetime-local 給的是「無時區字串」(2026-05-04T15:00),new Date() 會視為本地時間
  // 後端用 ISO 字串再轉 Date,所以這邊轉 ISO 一致化
  const endsAtRaw = document.getElementById('b-endsAt')?.value || '';
  const endsAt = endsAtRaw ? new Date(endsAtRaw).toISOString() : null;
  try {
    await Api.adminCreateBundle({ name, tag, imageUrl, description, items: selectedChips, disc, visibility: currentVisibility, active: true, endsAt });
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
    const endsAtInfo = adminScheduleInfoHtml(b.endsAt);
    return `
      <div class="bundle-list-item">
        <div class="status-dot ${b.active ? 'dot-on' : 'dot-off'}" title="${b.active ? '上架中' : '已下架'}"></div>
        <div class="bli-emojis" aria-hidden="true">${items.map(p => p.emoji).join('')}</div>
        <div class="bli-info">
          <div class="bli-name">${b.name} ${visBadge} <span class="bli-tag">${b.tag || ''}</span></div>
          <div class="bli-sub">${items.map(p => p.name).join('、')}</div>
          ${endsAtInfo}
        </div>
        <div class="bli-price-col">
          <div class="bli-final">NT$${final}</div>
          <div class="bli-orig">NT$${orig}</div>
          <span class="bli-disc-badge">${b.disc}% OFF</span>
        </div>
        <div class="row-actions">
          <button class="pill-btn" onclick="editBundleSchedule(${b.id})" title="編輯限時">⏳</button>
          <button class="pill-btn" onclick="toggleBundleActive(${b.id})">${b.active ? '下架' : '上架'}</button>
          <button class="pill-btn gray" onclick="deleteBundle(${b.id})">刪除</button>
        </div>
      </div>`;
  }).join('');
}

/* admin 列表中顯示限時資訊:倒數 / 已結束 / 永久 */
function adminScheduleInfoHtml(endsAt) {
  if (!endsAt) return '<div class="bli-schedule">⏱ 永久上架</div>';
  const ms = new Date(endsAt).getTime() - Date.now();
  const ts = new Date(endsAt).toLocaleString('zh-TW', { hour12: false });
  if (ms <= 0) return `<div class="bli-schedule expired">⛔ 限時已結束 (${escHtml(ts)})</div>`;
  return `<div class="bli-schedule">⏳ 限時截止: <code>${escHtml(ts)}</code> (還有 <span class="countdown-timer cd-sm" data-ends-at="${escHtml(new Date(endsAt).toISOString())}">${formatCountdown(ms)}</span>)</div>`;
}

/* admin 點 ⏳ 按鈕,prompt 簡易輸入新截止時間 */
async function editBundleSchedule(bundleId) {
  const b = BUNDLES.find(x => x.id === bundleId);
  if (!b) return;
  const current = b.endsAt
    ? new Date(b.endsAt).toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T')
    : '';
  const input = prompt(
    `設定限時截止時間 (格式: YYYY-MM-DDTHH:mm)\n留空 = 永久上架`,
    current
  );
  if (input === null) return; // 取消
  const trimmed = input.trim();
  let endsAt = null;
  if (trimmed) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) { showToast('日期格式錯誤', false); return; }
    endsAt = d.toISOString();
  }
  try {
    // 設定新 endsAt 同時帶 active=true:過期被 cron 設成 active=false 的組合包,
    // 重設限時 (新時間 OR 改永久) 應該自動恢復上架,不必再手動點「上架」。
    // 若 admin 想保持下架,可獨立用「上架/下架」按鈕切換。
    await Api.adminUpdateBundle(bundleId, { endsAt, active: true });
    await reloadAdminLists();
    showToast(endsAt ? '✓ 限時時間已更新並重新上架' : '✓ 已改為永久上架', true);
  } catch (e) { showToast('更新失敗: ' + e.message, false); }
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
      </div>
      <div class="order-lookup-section">
        <h4>🔍 查詢訂單</h4>
        <p>輸入訂單編號查看您的訂單狀態</p>
        <div class="order-lookup-row">
          <input type="text" id="order-lookup-input" placeholder="請輸入訂單編號" maxlength="64"
                 onkeypress="if(event.key==='Enter')lookupOrder()">
          <button class="pill-btn green" onclick="lookupOrder()">查詢</button>
        </div>
        <div id="order-lookup-error" role="alert" style="min-height:18px;font-size:12px;color:var(--red);margin-top:6px;font-weight:700"></div>
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
    const emojiArr = Array.from(emoji || '');
    const isMulti = emojiArr.length > 1;
    const emojiInner = isMulti
      ? `<span class="cart-emoji-grid">${emojiArr.slice(0, 4).map(e => `<span>${escHtml(e)}</span>`).join('')}</span>`
      : escHtml(emoji);
    return `
      <div class="cart-item${isAddon ? ' addon-item' : ''}">
        <span class="cart-item-emoji${isMulti ? ' bundle' : ''}" aria-hidden="true">${emojiInner}</span>
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

  // 預設配送方式 = 宅配 (除非剛從選店 callback 回來,handleCvStoreReturn 會在 modal 開好後 override)
  setShippingMethod(_selectedCvStore ? 'convenience_store' : 'home_delivery');
  // 預設付款方式 = LINE Pay
  setPaymentMethod('linepay');
  if (!_selectedCvStore) {
    const display = document.getElementById('co-cvstore-display');
    if (display) {
      display.classList.remove('selected');
      display.textContent = '尚未選擇門市';
    }
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('co-name').focus(), 100);
}

function closeCheckoutModal() {
  const m = document.getElementById('checkout-modal');
  m.classList.remove('active');
  m.setAttribute('aria-hidden', 'true');
}

/* ============================ SHIPPING METHOD ============================ */
let _checkoutShippingMethod = 'home_delivery';
let _selectedCvStore = null;  // { cvStoreId, cvStoreName, cvAddress }
let _checkoutPaymentMethod = 'linepay';

function setPaymentMethod(method) {
  _checkoutPaymentMethod = method;
  document.querySelectorAll('.pay-opt').forEach(b => {
    const on = b.dataset.method === method;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  // 動態更新底下「跳轉至 LINE Pay」說明文字 + 按鈕文字
  const sub = document.querySelector('#checkout-modal .modal-sub');
  const btn = document.getElementById('co-submit');
  if (method === 'bank_transfer') {
    if (sub) sub.textContent = '請填寫收件資料,完成後將顯示銀行帳號供轉帳';
    if (btn) btn.textContent = '產生轉帳資訊 →';
  } else {
    if (sub) sub.textContent = '請填寫收件資料,完成後將跳轉至 LINE Pay';
    if (btn) btn.textContent = '確認結帳 →';
  }
}

function setShippingMethod(method) {
  _checkoutShippingMethod = method;
  document.querySelectorAll('.ship-opt').forEach(b => {
    const on = b.dataset.method === method;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  const addrField = document.getElementById('co-address-field');
  const cvField = document.getElementById('co-cvstore-field');
  if (addrField) addrField.style.display = method === 'home_delivery' ? 'block' : 'none';
  if (cvField) cvField.style.display = method === 'convenience_store' ? 'block' : 'none';
}

async function openEcpayMapPicker() {
  // 暫存 checkout 草稿,選店回來後恢復
  _saveCheckoutDraft();
  try {
    const isMobile = window.matchMedia('(max-width: 899px)').matches;
    const resp = await Api.ecpayMapForm(isMobile);
    // 動態建立 form 並 submit 到 ECPay
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = resp.action;
    form.style.display = 'none';
    Object.entries(resp.fields).forEach(([k, v]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = k;
      input.value = v;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  } catch (e) {
    showToast('無法開啟選店頁面: ' + (e.message || ''), false);
  }
}

const CHECKOUT_DRAFT_KEY = 'wama_checkout_draft';
function _saveCheckoutDraft() {
  const draft = {
    name: document.getElementById('co-name')?.value || '',
    phone: document.getElementById('co-phone')?.value || '',
    email: document.getElementById('co-email')?.value || '',
    cart,
  };
  try { sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(draft)); } catch (_) {}
}
function _loadCheckoutDraft() {
  try {
    const s = sessionStorage.getItem(CHECKOUT_DRAFT_KEY);
    if (!s) return null;
    sessionStorage.removeItem(CHECKOUT_DRAFT_KEY);
    return JSON.parse(s);
  } catch (_) { return null; }
}

/* 偵測 ECPay 選店 callback redirect 回來 (URL 帶 cvStoreId, hash=#/cv-store) */
function handleCvStoreReturn() {
  const params = new URLSearchParams(location.search);
  const cvStoreId = params.get('cvStoreId');
  const cvStoreName = params.get('cvStoreName');
  if (!cvStoreId || !location.hash.startsWith('#/cv-store')) return false;

  _selectedCvStore = {
    cvStoreId,
    cvStoreName: cvStoreName || '',
    cvAddress: params.get('cvAddress') || '',
  };
  // 清掉 URL,避免 reload 重入
  history.replaceState(null, '', location.pathname);

  // 恢復購物車草稿
  const draft = _loadCheckoutDraft();
  if (draft?.cart) { cart = draft.cart; saveCart(); updateCartBadge(); }

  // 開啟 checkout modal,預填欄位 + 切到 7-11 取貨
  switchPage('cart');
  setTimeout(() => {
    openCheckoutModal();
    setShippingMethod('convenience_store');
    if (draft) {
      const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
      setVal('co-name', draft.name);
      setVal('co-phone', draft.phone);
      setVal('co-email', draft.email);
    }
    const display = document.getElementById('co-cvstore-display');
    if (display) {
      display.classList.add('selected');
      display.innerHTML = `<strong>✓ ${escHtml(_selectedCvStore.cvStoreName || '已選擇門市')}</strong>` +
        `<div style="font-size:11px;color:var(--text-light);margin-top:2px">店號: ${escHtml(cvStoreId)}` +
        (_selectedCvStore.cvAddress ? ` · ${escHtml(_selectedCvStore.cvAddress)}` : '') + `</div>`;
    }
  }, 200);
  return true;
}

async function confirmCheckout() {
  const items = collectCartItems();
  if (!items.length) { showToast('購物車是空的', false); closeCheckoutModal(); return; }

  const name = document.getElementById('co-name').value.trim();
  const phone = document.getElementById('co-phone').value.trim();
  const address = document.getElementById('co-address').value.trim();
  const email = document.getElementById('co-email').value.trim();
  const errEl = document.getElementById('checkout-error');
  const isCvs = _checkoutShippingMethod === 'convenience_store';

  // 客端驗證
  if (!name) { errEl.textContent = '⚠ 請輸入姓名'; document.getElementById('co-name').focus(); return; }
  if (!phone) { errEl.textContent = '⚠ 請輸入電話'; document.getElementById('co-phone').focus(); return; }
  if (isCvs) {
    if (!_selectedCvStore?.cvStoreId) {
      errEl.textContent = '⚠ 請選擇 7-11 取貨門市'; return;
    }
  } else {
    if (!address) { errEl.textContent = '⚠ 請輸入收件地址'; document.getElementById('co-address').focus(); return; }
  }
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
    shippingMethod: _checkoutShippingMethod,
    paymentMethod: _checkoutPaymentMethod,
    shippingInfo: isCvs
      ? { cvStoreId: _selectedCvStore.cvStoreId, cvStoreName: _selectedCvStore.cvStoreName }
      : { address },
  };

  const submitBtn = document.getElementById('co-submit');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '處理中...'; }

  try {
    const result = await Api.checkout(payload);
    // 結帳送出後清掉已選門市,避免下次開 modal 還記得舊的
    _selectedCvStore = null;

    if (result.paymentMethod === 'bank_transfer' && result.bankInfo) {
      // 銀行轉帳:顯示帳號資訊 modal,清空購物車
      closeCheckoutModal();
      cart = {}; saveCart(); updateCartBadge(); renderCart();
      openBankTransferModal(result.orderId, result.bankInfo);
    } else if (result.paymentUrl) {
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
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = _checkoutPaymentMethod === 'bank_transfer' ? '產生轉帳資訊 →' : '確認結帳 →';
    }
  }
}

/* ============================ BANK TRANSFER MODAL ============================ */
/* 顯示銀行帳號 + 訂單金額 + 期限。重用既有的 order-confirm-modal,動態填內容。 */
function openBankTransferModal(orderId, bankInfo) {
  const modal = document.getElementById('order-confirm-modal');
  const body = document.getElementById('order-confirm-body');
  if (!modal || !body) return;
  const orderIdEnc = encodeURIComponent(orderId);
  const expireText = bankInfo.expireAt
    ? new Date(bankInfo.expireAt).toLocaleString('zh-TW', { hour12: false })
    : `${bankInfo.expireHours || 24} 小時內`;
  body.innerHTML = `
    <div class="occ-header">
      <div class="occ-icon">🏦</div>
      <h3 id="order-confirm-title">請完成銀行轉帳</h3>
      <p class="modal-sub">訂單已建立,請於 ${escHtml(String(bankInfo.expireHours || 24))} 小時內完成轉帳</p>
    </div>
    <div class="occ-order-no">訂單編號:<code>${escHtml(orderId)}</code></div>
    <div class="occ-bank-block">
      <div class="occ-section-label">💳 轉帳資訊</div>
      <div class="occ-bank-row"><span>收款銀行</span><strong>${escHtml(bankInfo.bankName)}</strong></div>
      <div class="occ-bank-row"><span>戶名</span><strong>${escHtml(bankInfo.accountHolder)}</strong></div>
      <div class="occ-bank-row">
        <span>帳號</span>
        <code class="occ-code occ-bank-acc" id="occ-bank-acc">${escHtml(bankInfo.accountNo)}</code>
      </div>
      <div class="occ-bank-row">
        <span>金額</span>
        <strong style="color:var(--sale);font-size:18px">NT$${(bankInfo.amount || 0).toLocaleString()}</strong>
      </div>
      <button class="modal-btn outline occ-bank-copy" onclick="copyBankAccount('${escAttrJs(bankInfo.accountNo)}')">
        📋 複製帳號
      </button>
    </div>
    <div class="occ-bank-tips">
      ⚠ 請於 <strong>${escHtml(expireText)}</strong> 前完成轉帳<br>
      ⚠ 轉帳後我們會在 1-2 個工作日內人工確認,確認後會更新訂單狀態<br>
      ⚠ 請保留訂單編號,有問題請洽客服
    </div>
    <div class="occ-cta-row">
      <button class="modal-btn outline" onclick="reopenOrderLookup('${orderIdEnc}')">🔍 之後查詢狀態</button>
      <button class="modal-btn primary" onclick="closeOrderConfirmModal();switchPage('shop')">繼續購物 →</button>
    </div>
    <div class="occ-help-line">有任何問題?請洽客服 📞 0800-123-456 / ✉️ hello@petsnack.tw</div>`;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}

/* 訂單查詢時點「查看轉帳資訊」— 用 Api.bankInfo() 拿銀行帳號再開 modal */
async function showBankInfoForOrder(orderIdEnc, amount) {
  const orderId = decodeURIComponent(orderIdEnc);
  try {
    const { bankInfo } = await Api.bankInfo();
    openBankTransferModal(orderId, { ...bankInfo, amount });
  } catch (e) {
    showToast('無法取得銀行資訊: ' + (e.message || ''), false);
  }
}

function copyBankAccount(acc) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(acc).then(
      () => showToast('✓ 帳號已複製', true),
      () => showToast(`帳號:${acc}`, true)
    );
  } else {
    showToast(`帳號:${acc}`, true);
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
    const tracked = a.trackStock !== false;
    const isOut = tracked && (a.stock ?? 0) <= 0;
    const badge = stockBadgeHtml(a.stock, a.lowStockThreshold ?? 5, a.trackStock);
    let label;
    if (isOut) label = '缺貨';
    else if (added) label = '已加入 ✓';
    else label = `加購省 $${save} +`;
    return `
      <div class="addon-card ${added ? 'added' : ''}${isOut ? ' is-out' : ''}">
        <div class="addon-emoji" aria-hidden="true">${a.emoji}</div>
        <div class="addon-name">${a.name}</div>
        <div class="addon-price-row">
          <span class="addon-orig">NT$${a.orig}</span>
          <span class="addon-special">NT$${a.special}</span>
        </div>
        ${badge}
        <button class="addon-add-btn" ${(added || isOut) ? 'disabled' : 'aria-pressed="false"'} onclick="addAddon('${a.id}',this)">
          ${label}
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

/* ============================================================
   ORDER CONFIRM MODAL (項目 5)
   ============================================================ */
const ORDER_STATUS_ZH = {
  created: '建立中', paid: '已付款', processing: '備貨中',
  shipped: '已出貨', delivered: '已送達', cancelled: '已取消',
};

function lookupOrder(inputId, errId) {
  // 預設用購物車空狀態的 ID;footer 查詢用 'footer-order-lookup-input' / 'footer-order-lookup-error'
  inputId = inputId || 'order-lookup-input';
  errId = errId || 'order-lookup-error';
  const input = document.getElementById(inputId);
  const errEl = document.getElementById(errId);
  if (!input) return;
  const orderId = input.value.trim();
  if (!orderId) { if (errEl) errEl.textContent = '⚠ 請輸入訂單編號'; return; }
  if (errEl) errEl.textContent = '';
  openOrderConfirmModal(orderId, true);
}

async function openOrderConfirmModal(orderId, isLookup) {
  const modal = document.getElementById('order-confirm-modal');
  const body = document.getElementById('order-confirm-body');
  if (!modal || !body) return;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  body.innerHTML = '<p class="modal-sub" style="padding:30px 0;text-align:center">載入訂單資料中…</p>';
  try {
    const { order } = await Api.getOrder(orderId);
    body.innerHTML = renderOrderConfirmContent(order, isLookup);
  } catch (e) {
    if (isLookup) {
      body.innerHTML = `
        <div style="text-align:center;padding:20px 0">
          <div style="font-size:42px;margin-bottom:12px">🔍</div>
          <p style="font-weight:700;color:var(--red);margin-bottom:8px">找不到訂單</p>
          <p class="modal-sub">${e.message || '請確認訂單編號是否正確'}</p>
          <button class="modal-btn outline" style="margin-top:14px;max-width:200px" onclick="closeOrderConfirmModal()">關閉</button>
        </div>`;
    } else {
      body.innerHTML = `
        <div style="text-align:center;padding:20px 0">
          <div style="font-size:48px;margin-bottom:10px">✅</div>
          <h3 style="font-family:'Playfair Display',serif;margin-bottom:6px">感謝您的訂購！</h3>
          <p class="modal-sub">訂單編號：${orderId}</p>
          <button class="modal-btn primary" style="margin-top:16px" onclick="closeOrderConfirmModal();switchPage('shop')">繼續購物 →</button>
        </div>`;
    }
  }
}

function closeOrderConfirmModal() {
  const m = document.getElementById('order-confirm-modal');
  if (!m) return;
  m.classList.remove('active');
  m.setAttribute('aria-hidden', 'true');
}

function renderOrderConfirmContent(o, isLookup) {
  const statusZh = ORDER_STATUS_ZH[o.status] || o.status;
  const statusCls = STATUS_CLASS[o.status] || 's-pend';
  const items = (o.items || []).map(i => `
    <div class="occ-item">
      <span class="occ-item-name">${escHtml(i.name || '-')}</span>
      <span class="occ-item-qty">×${i.qty}</span>
      <span class="occ-item-price">NT$${((i.price || 0) * i.qty).toLocaleString()}</span>
    </div>`).join('');
  const header = isLookup
    ? `<div class="occ-header">
         <div class="occ-icon">🔍</div>
         <h3 id="order-confirm-title">訂單查詢結果</h3>
         <p class="modal-sub">狀態：<span class="order-status ${statusCls}">${statusZh}</span></p>
       </div>`
    : `<div class="occ-header">
         <div class="occ-icon">✅</div>
         <h3 id="order-confirm-title">感謝您的訂購！</h3>
         <p class="modal-sub">我們已收到您的訂單,以下是訂單明細</p>
       </div>`;

  /* --- 預計到貨資訊 (依配送方式) --- */
  const etaText = {
    convenience_store: '📦 預計 2–3 個工作日寄達門市,到店後 7-11 會發簡訊通知',
    home_delivery:     '🚚 預計 2–3 個工作日內出貨',
    dealer_logistics:  '💼 依出貨單排程配送',
  }[o.shippingMethod];

  /* --- 轉帳未付款警示 --- */
  const isPendingBankTransfer = o.payment?.method === 'bank_transfer' && o.payment?.status === 'pending';
  const bankPendingBlock = isPendingBankTransfer ? `
    <div class="occ-bank-pending">
      <strong>⏳ 尚未收到款項</strong>
      <div style="font-size:12px;margin-top:4px;color:var(--text-light)">完成銀行轉帳後,我們會在 1-2 個工作日內人工確認</div>
      <button class="modal-btn outline" style="margin-top:10px"
              onclick="showBankInfoForOrder('${encodeURIComponent(o.orderId)}', ${o.totalAmount || 0})">
        查看轉帳資訊
      </button>
    </div>` : '';

  /* --- 超商取貨資訊 (寄件代碼 + 驗證碼,給客戶取貨用) --- */
  const cvsBlock = (o.shippingMethod === 'convenience_store') ? `
    <div class="occ-shipping occ-cvs-block">
      <div class="occ-section-label">🏪 取貨資訊</div>
      ${o.shippingInfo?.cvStoreName ? `<div class="occ-addr-row">門市:${escHtml(o.shippingInfo.cvStoreName)}${o.shippingInfo?.cvStoreId ? ` <code style="font-size:11px;color:var(--text-light)">(${escHtml(o.shippingInfo.cvStoreId)})</code>` : ''}</div>` : ''}
      ${o.shippingInfo?.cvsPaymentNo ? `<div class="occ-addr-row">寄件代碼:<code class="occ-code">${escHtml(o.shippingInfo.cvsPaymentNo)}</code></div>` : ''}
      ${o.shippingInfo?.cvsValidationNo ? `<div class="occ-addr-row">取貨驗證碼:<code class="occ-code">${escHtml(o.shippingInfo.cvsValidationNo)}</code> <span style="font-size:11px;color:var(--text-light)">(取貨時出示)</span></div>` : ''}
      ${(!o.shippingInfo?.cvsPaymentNo && !o.shippingInfo?.cvsValidationNo) ? `<div class="occ-addr-row" style="color:var(--text-light);font-size:12px">物流單建立中,稍後再查可看到取貨碼</div>` : ''}
    </div>` : '';

  /* --- 收件人資訊 --- */
  const recipientBlock = (o.customer?.name || o.customer?.phone || o.shippingInfo?.address) ? `
    <div class="occ-shipping">
      <div class="occ-section-label">收件資訊</div>
      ${o.shippingMethod ? `<div class="occ-addr-row">${shippingMethodLabel(o.shippingMethod)}</div>` : ''}
      ${o.customer?.name ? `<div class="occ-addr-row">👤 ${escHtml(o.customer.name)}</div>` : ''}
      ${o.customer?.phone ? `<div class="occ-addr-row">📞 ${escHtml(o.customer.phone)}</div>` : ''}
      ${o.shippingInfo?.address ? `<div class="occ-addr-row">📍 ${escHtml(o.shippingInfo.address)}</div>` : ''}
    </div>` : '';

  /* --- CTA 區 --- */
  const orderIdEnc = encodeURIComponent(o.orderId);
  const ctaBlock = isLookup
    ? `<button class="modal-btn primary" onclick="closeOrderConfirmModal();switchPage('shop')">繼續購物 →</button>`
    : `<div class="occ-cta-row">
         <button class="modal-btn outline" onclick="reopenOrderLookup('${orderIdEnc}')">🔍 隨時查詢狀態</button>
         <button class="modal-btn primary" onclick="closeOrderConfirmModal();switchPage('shop')">繼續購物 →</button>
       </div>
       <div class="occ-help-line">有任何問題?請洽客服 📞 0800-123-456 / ✉️ hello@petsnack.tw</div>`;

  return `
    ${header}
    <div class="occ-order-no">訂單編號:<code>${escHtml(o.orderId)}</code></div>
    ${bankPendingBlock}
    ${etaText && !isLookup ? `<div class="occ-eta">${etaText}</div>` : ''}
    ${items ? `<div class="occ-items-section">
      <div class="occ-section-label">訂購品項</div>
      ${items}
    </div>` : ''}
    <div class="occ-totals">
      <div class="occ-total-row"><span>商品小計</span><span>NT$${(o.subtotal || 0).toLocaleString()}</span></div>
      <div class="occ-total-row"><span>運費</span><span>NT$${(o.shipping || 0).toLocaleString()}</span></div>
      <div class="occ-total-row grand"><span>總金額</span><span>NT$${(o.totalAmount || 0).toLocaleString()}</span></div>
    </div>
    ${recipientBlock}
    ${cvsBlock}
    ${ctaBlock}`;
}

/* 在訂單成功 modal 上點「隨時查詢狀態」— 把訂單編號複製到剪貼簿 + 顯示提示 */
function reopenOrderLookup(orderIdEnc) {
  const orderId = decodeURIComponent(orderIdEnc);
  closeOrderConfirmModal();
  // 嘗試複製到剪貼簿
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(orderId).then(
      () => showToast(`訂單編號已複製:${orderId}`, true),
      () => showToast(`訂單編號:${orderId}`, true)
    );
  } else {
    showToast(`訂單編號:${orderId}`, true);
  }
  // 把編號帶進 footer 查詢框,讓使用者下次來可以直接送
  setTimeout(() => {
    const inp = document.getElementById('footer-order-lookup-input');
    if (inp) { inp.value = orderId; inp.focus(); inp.scrollIntoView({behavior:'smooth', block:'center'}); }
  }, 200);
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
        <div class="od-row"><span>方式</span>${shippingMethodLabel(o.shippingMethod)}</div>
        ${o.shippingMethod === 'convenience_store' ? `
          <div class="od-row"><span>取貨門市</span>${escHtml(o.shippingInfo?.cvStoreName || '-')}${o.shippingInfo?.cvStoreId ? ` <code style="font-size:11px;color:var(--text-light)">(${escHtml(o.shippingInfo.cvStoreId)})</code>` : ''}</div>
          <div class="od-row"><span>ECPay 物流單號</span>${o.shippingInfo?.ecpayAllPayLogisticsId ? `<code style="font-size:11px">${escHtml(o.shippingInfo.ecpayAllPayLogisticsId)}</code>` : '<span style="color:var(--red)">⚠ 尚未建立</span>'}</div>
          ${!o.shippingInfo?.ecpayAllPayLogisticsId ? `
            <div style="margin:10px 0">
              <button class="pill-btn green" onclick="adminBuildLogistics('${encodeURIComponent(o.orderId)}')">📦 補建 ECPay 物流單</button>
            </div>` : ''}
        ` : `
          <div class="od-row"><span>地址</span>${escHtml(o.shippingInfo?.address || '-')}</div>
        `}
        <div class="od-form">
          <label for="tracking-input">手動物流單號</label>
          <input type="text" id="tracking-input" value="${escHtml(o.shippingInfo?.trackingNo || '')}" placeholder="例: 9999-1234-5678">
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
        ${o.payment?.method === 'bank_transfer' && o.payment?.status === 'pending'
          ? `<button class="pill-btn green" onclick="adminMarkPaid('${encodeURIComponent(o.orderId)}')">💰 標記已收款 (轉帳)</button>`
          : ''}
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

const _SHIPPING_METHOD_LABEL = {
  home_delivery: '🚚 宅配到府',
  convenience_store: '🏪 7-11 取貨',
  dealer_logistics: '💼 經銷物流',
};
function shippingMethodLabel(m) {
  return _SHIPPING_METHOD_LABEL[m] || m || '-';
}

async function adminMarkPaid(orderIdEnc) {
  const orderId = decodeURIComponent(orderIdEnc);
  if (!confirm(`確定已收到訂單 ${orderId} 的轉帳款項?\n標記後若是超商取貨,會自動建立 ECPay 物流單`)) return;
  try {
    await Api.adminMarkPaid(orderId);
    showToast('✓ 訂單已標記為已收款', true);
    openOrderModal(orderIdEnc);
    loadOrders();
    loadDashboardStats();
  } catch (e) {
    showToast('標記失敗: ' + (e.message || ''), false);
  }
}

async function adminBuildLogistics(orderIdEnc) {
  const orderId = decodeURIComponent(orderIdEnc);
  if (!confirm(`確定要為訂單 ${orderId} 補建 ECPay 物流單?`)) return;
  try {
    const res = await Api.adminCreateEcpayLogistics(orderId);
    showToast('✓ ' + (res.message || '物流單已建立'), true);
    // 重整訂單詳情
    openOrderModal(orderIdEnc);
  } catch (e) {
    showToast('建立失敗: ' + (e.message || ''), false);
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
    setText('stat-lowstock', stats.lowStockCount ?? 0);
    // 警示卡視覺強調
    const card = document.getElementById('stat-lowstock-card');
    if (card) card.classList.toggle('alert', (stats.lowStockCount ?? 0) > 0);
  } catch (_) { /* keep 原本 0 */ }
}

/* ============================================================
   STOCK MANAGEMENT (admin)
   ============================================================ */
let _adminStockCache = { products: [], addons: [] };

async function loadStockList() {
  if (!currentUser || currentUser.role !== 'admin') return;
  const el = document.getElementById('stock-admin-list');
  if (!el) return;
  el.innerHTML = '<div class="bundle-admin-empty">載入中...</div>';
  try {
    const [prodRes, addonRes] = await Promise.all([
      Api.adminListProducts(),
      Api.adminListAddons(),
    ]);
    _adminStockCache.products = prodRes.products.map(_normalizeProduct);
    _adminStockCache.addons = addonRes.addons.map(_normalizeAddon);
    renderStockList();
  } catch (e) {
    el.innerHTML = `<div class="bundle-admin-empty">載入失敗: ${e.message}</div>`;
  }
}

function renderStockList() {
  const el = document.getElementById('stock-admin-list');
  if (!el) return;
  const lowOnly = document.getElementById('stock-show-low-only')?.checked;

  const filterFn = (item) => {
    if (item.trackStock === false) return false;  // 不追蹤的不顯示
    if (!lowOnly) return true;
    return (item.stock ?? 0) <= (item.lowStockThreshold ?? 5);
  };

  const products = _adminStockCache.products.filter(filterFn);
  const addons = _adminStockCache.addons.filter(filterFn);

  if (!products.length && !addons.length) {
    el.innerHTML = `<div class="bundle-admin-empty">${lowOnly ? '👍 沒有低庫存商品' : '無商品'}</div>`;
    return;
  }

  const renderRow = (item, type) => {
    const stock = item.stock ?? 0;
    const threshold = item.lowStockThreshold ?? 5;
    const status = stock === 0 ? 'out' : (stock <= threshold ? 'low' : 'ok');
    const badge = stockBadgeHtml(stock, threshold, item.trackStock);
    const idAttr = type === 'addon' ? `data-addon-id="${item.id}"` : `data-product-id="${item.id}"`;
    // datetime-local 接受 YYYY-MM-DDTHH:mm,用 sv-SE locale 取得 ISO-like 但是本地時間
    const endsAtLocal = type === 'product' && item.endsAt
      ? new Date(item.endsAt).toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T')
      : '';
    const metaPanel = type === 'product' ? `
        <div class="prod-meta-edit" id="meta-${item.id}" style="display:none;grid-column:1/-1;padding:10px 14px;background:#fafafa;border-top:1px dashed var(--border);">
          <div style="display:grid;gap:8px;">
            <label style="font-size:12px;color:var(--text-light)">圖片網址
              <input type="url" class="meta-imageUrl" value="${escHtml(item.imageUrl || '')}" placeholder="https://..." style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;font:inherit">
            </label>
            <label style="font-size:12px;color:var(--text-light)">描述
              <textarea class="meta-description" rows="2" placeholder="商品介紹" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;font:inherit;resize:vertical">${escHtml(item.description || '')}</textarea>
            </label>
            <label style="font-size:12px;color:var(--text-light)">⏳ 限時截止 <span style="color:var(--text-light);font-weight:500">(留空 = 永久)</span>
              <input type="datetime-local" class="meta-endsAt" value="${escHtml(endsAtLocal)}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;font:inherit">
            </label>
            <div style="text-align:right">
              <button class="pill-btn green" onclick="saveProductMeta(${item.id})">儲存</button>
            </div>
          </div>
        </div>` : '';
    const metaToggle = type === 'product'
      ? `<button class="pill-btn gray" onclick="toggleProductMeta(${item.id})" title="編輯圖片/描述">✎</button>`
      : '';
    return `
      <div class="bundle-list-item stock-row ${status === 'ok' ? '' : 'stock-warn'}" style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;">
        <div class="bli-emojis" aria-hidden="true">${escHtml(item.emoji)}</div>
        <div class="bli-info">
          <div class="bli-name">${escHtml(item.name)} ${badge}</div>
          <div class="bli-sub">${type === 'addon' ? '🎁 加價購' : '單品'} · 警示線:${threshold}</div>
        </div>
        <div class="stock-edit" style="display:flex;gap:6px;align-items:center;">
          <input type="number" min="0" max="99999" class="stock-input" value="${stock}" ${idAttr} aria-label="庫存數量"
                 onkeypress="if(event.key==='Enter')saveStockChange(this)">
          <button class="pill-btn green" onclick="saveStockChange(this.previousElementSibling)" title="儲存">儲存</button>
          ${metaToggle}
        </div>
        ${metaPanel}
      </div>`;
  };

  el.innerHTML = `
    ${products.map((p) => renderRow(p, 'product')).join('')}
    ${addons.map((a) => renderRow(a, 'addon')).join('')}
  `;
}

function toggleProductMeta(productId) {
  const panel = document.getElementById('meta-' + productId);
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function saveProductMeta(productId) {
  const panel = document.getElementById('meta-' + productId);
  if (!panel) return;
  const imageUrl = panel.querySelector('.meta-imageUrl').value.trim();
  const description = panel.querySelector('.meta-description').value.trim();
  const endsAtRaw = panel.querySelector('.meta-endsAt')?.value || '';
  // 空值送 null 給後端清除限時;有值轉 ISO 字串
  const endsAt = endsAtRaw ? new Date(endsAtRaw).toISOString() : null;

  // 找到目前的 product 看 endsAt 是否真的有變動
  const cur = (_adminStockCache?.products || []).find((p) => p.id === productId);
  const curEndsAtIso = cur?.endsAt ? new Date(cur.endsAt).toISOString() : null;
  const endsAtChanged = endsAt !== curEndsAtIso;

  // 只有當 endsAt 真的變動時才強制 active=true
  // (避免使用者只改圖片/描述時也把已下架商品自動上架)
  const payload = { imageUrl, description, endsAt };
  if (endsAtChanged) payload.active = true;

  try {
    await Api.adminUpdateProduct(productId, payload);
    showToast(endsAtChanged
      ? (endsAt ? '✓ 已更新限時時間並重新上架' : '✓ 已改為永久上架')
      : '✓ 商品資訊已更新', true);
    await loadStockList();
    reloadCatalog();
  } catch (e) {
    showToast('更新失敗: ' + e.message, false);
  }
}

async function saveStockChange(input) {
  const stock = parseInt(input.value, 10);
  if (Number.isNaN(stock) || stock < 0) {
    showToast('請輸入 >= 0 的整數', false);
    return;
  }
  const productId = input.getAttribute('data-product-id');
  const addonId = input.getAttribute('data-addon-id');
  try {
    if (productId) {
      await Api.adminUpdateProductStock(Number(productId), stock);
    } else if (addonId) {
      await Api.adminUpdateAddonStock(addonId, stock);
    }
    showToast('✓ 庫存已更新', true);
    // 重新載入,順便更新 dashboard 警示
    await loadStockList();
    loadDashboardStats();
    reloadCatalog(); // 商店端的 stock badge 也跟著更新
  } catch (e) {
    showToast('更新失敗: ' + e.message, false);
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
      cart = {};
      saveCart();
      updateCartBadge();
      renderCart();
      if (orderId) {
        openOrderConfirmModal(orderId, false);
      } else {
        switchPage('cart');
        showToast('✓ 付款成功！感謝您的訂購', true);
      }
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
  // 不擋首頁載入,平行抓分類圖片設定
  loadCategoryImages();
  await reloadCatalog();
  if (currentUser?.role === 'admin') await reloadAdminLists();
  updateRolePill();
  renderCart();
  handlePaymentRedirect();
  startCountdownTicker();
  hideLoading();
  // 套用 URL hash 路由（例如直接進到 #/cat/dog）
  applyHashRoute();
  // 偵測 ECPay 選店 callback redirect 回來
  handleCvStoreReturn();
}

init().catch(e => {
  console.error(e);
  showToast('初始化失敗: ' + (e.message || ''), false);
});
