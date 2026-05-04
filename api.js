/* ============================================================
   api.js — 後端 API client
   ============================================================
   - 自動偵測 dev / production 的 API_BASE
   - JWT token 存於 localStorage (跨 tab 共用,關瀏覽器仍保留)
   - 所有方法回傳 Promise,錯誤透過 throw 拋出
   ============================================================ */
(function () {
  /* ---------- 自動偵測 API base URL ---------- */
  const API_BASE = (() => {
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') {
      return 'http://localhost:3001/api/v1';
    }
    // 生產環境:之後 Render 部署完替換成你的網址
    return 'https://petsnack-backend.onrender.com/api/v1';
  })();

  const TOKEN_KEY = 'wama_token';

  const Api = {
    base: API_BASE,

    /* ---------- Token 管理 ---------- */
    getToken() {
      return localStorage.getItem(TOKEN_KEY);
    },
    setToken(t) {
      localStorage.setItem(TOKEN_KEY, t);
    },
    clearToken() {
      localStorage.removeItem(TOKEN_KEY);
    },

    /* ---------- 通用 fetch (自動帶 token、統一錯誤格式) ---------- */
    async _fetch(path, options = {}) {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      };
      const token = this.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      let res;
      try {
        res = await fetch(API_BASE + path, { ...options, headers });
      } catch (e) {
        const err = new Error('無法連線到後端,請確認 API 是否啟動');
        err.cause = e;
        err.network = true;
        throw err;
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.details = data.details;

        // token 失效 → 清掉,讓使用者重登
        if (res.status === 401 && this.getToken()) {
          this.clearToken();
        }
        throw err;
      }
      return data;
    },

    /* ---------- Auth ---------- */
    login(username, password) {
      return this._fetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    },
    me() {
      return this._fetch('/auth/me');
    },

    /* ---------- 公開:商品 / 組合包 / 加價購 ---------- */
    products(type) {
      const q = type && type !== 'all' ? `?type=${type}` : '';
      return this._fetch('/products' + q);
    },
    bundles(visibility) {
      const q = visibility ? `?visibility=${visibility}` : '';
      return this._fetch('/bundles' + q);
    },
    addons() {
      return this._fetch('/addons');
    },

    /* ---------- 結帳 ---------- */
    checkout(payload) {
      return this._fetch('/payments/checkout', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    /* ---------- ECPay 物流選店 ---------- */
    ecpayMapForm(mobile = false) {
      return this._fetch('/logistics/ecpay/map-form' + (mobile ? '?mobile=1' : ''));
    },

    /* ---------- Admin: Bundles ---------- */
    adminListBundles() {
      return this._fetch('/admin/bundles');
    },
    adminCreateBundle(data) {
      return this._fetch('/admin/bundles', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    adminUpdateBundle(id, data) {
      return this._fetch('/admin/bundles/' + id, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    adminDeleteBundle(id) {
      return this._fetch('/admin/bundles/' + id, { method: 'DELETE' });
    },

    /* ---------- Admin: Addons ---------- */
    adminListAddons() {
      return this._fetch('/admin/addons');
    },
    adminCreateAddon(data) {
      return this._fetch('/admin/addons', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    adminUpdateAddon(id, data) {
      return this._fetch('/admin/addons/' + id, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    adminDeleteAddon(id) {
      return this._fetch('/admin/addons/' + id, { method: 'DELETE' });
    },

    /* ---------- Orders ---------- */
    listOrders(params = {}) {
      const q = new URLSearchParams(params).toString();
      return this._fetch('/orders' + (q ? '?' + q : ''));
    },
    getOrder(orderId) {
      return this._fetch('/orders/' + encodeURIComponent(orderId));
    },

    /* ---------- Admin: Stock ---------- */
    adminListProducts() {
      return this._fetch('/admin/products');
    },
    adminUpdateProduct(productId, data) {
      return this._fetch('/admin/products/' + productId, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    adminUpdateProductStock(productId, stock) {
      return this._fetch('/admin/products/' + productId + '/stock', {
        method: 'PATCH',
        body: JSON.stringify({ stock }),
      });
    },
    adminUpdateAddonStock(addonId, stock) {
      return this._fetch('/admin/addons/' + encodeURIComponent(addonId) + '/stock', {
        method: 'PATCH',
        body: JSON.stringify({ stock }),
      });
    },
    adminLowStock() {
      return this._fetch('/admin/stock/low');
    },

    /* ---------- Admin: Order management ---------- */
    adminUpdateOrderStatus(orderId, status) {
      return this._fetch('/admin/orders/' + encodeURIComponent(orderId) + '/status', {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },
    adminUpdateOrderTracking(orderId, data) {
      return this._fetch('/admin/orders/' + encodeURIComponent(orderId) + '/tracking', {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    adminRefundOrder(orderId, refundAmount) {
      return this._fetch('/admin/orders/' + encodeURIComponent(orderId) + '/refund', {
        method: 'POST',
        body: JSON.stringify(refundAmount ? { refundAmount } : {}),
      });
    },
    adminCreateEcpayLogistics(orderId) {
      return this._fetch('/admin/orders/' + encodeURIComponent(orderId) + '/logistics/ecpay', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    adminStats() {
      return this._fetch('/admin/stats');
    },
  };

  window.Api = Api;
})();
