document.addEventListener('DOMContentLoaded', () => {
  const sections = document.querySelectorAll('.menu-section');
  const buttons = document.querySelectorAll('.category-btn');
  const searchInput = document.getElementById('searchInput');
  const toTop = document.getElementById('toTop');
  const reservationSection = document.getElementById('reservation');
  const openReservationBtn = document.getElementById('openReservation');
  const reservationCloseBtn = document.getElementById('reservationClose');

  // ===== Auth overlay =====
  const authOverlay = document.getElementById('authOverlay');
  const btnAuthLogin = document.getElementById('btnAuthLogin');
  const btnAuthRegister = document.getElementById('btnAuthRegister');
  const btnAuthGuest = document.getElementById('btnAuthGuest');
  const authForm = document.getElementById('authForm');
  const authName = document.getElementById('authName');
  const authNameLabel = document.getElementById('authNameLabel');
  const authEmail = document.getElementById('authEmail');
  const authPassword = document.getElementById('authPassword');
  const authError = document.getElementById('authError');
  const authSubmitBtn = document.getElementById('authSubmitBtn');
  const changeUserBtn = document.getElementById('changeUserBtn');

  const apiBase = window.BRODSKY_API_BASE || 'http://localhost:3000';

  function saveUserSession(session) {
    try {
      localStorage.setItem('brodsky_user', JSON.stringify(session));
    } catch (_) {}
  }

  function loadUserSession() {
    try {
      const s = localStorage.getItem('brodsky_user');
      return s ? JSON.parse(s) : null;
    } catch (_) {
      return null;
    }
  }

  function hideAuthOverlay() {
    if (authOverlay) {
      authOverlay.hidden = true;
      authOverlay.style.display = 'none';
      authOverlay.style.pointerEvents = 'none';
      document.body.style.overflow = '';
    }
  }

  function showAuthOverlay() {
    if (authOverlay) {
      authOverlay.hidden = false;
      authOverlay.style.display = 'flex';
      authOverlay.style.pointerEvents = 'auto';
      document.body.style.overflow = 'hidden';
    }
  }

  let currentAuthMode = null; // 'login' | 'register'

  if (authOverlay) {
    const existingSession = loadUserSession();
    if (!existingSession) {
      showAuthOverlay();
    } else {
      // На случай если браузер игнорирует hidden/стили — принудительно убираем оверлей
      hideAuthOverlay();
    }

    if (btnAuthGuest) {
      btnAuthGuest.addEventListener('click', () => {
        saveUserSession({ mode: 'guest' });
        hideAuthOverlay();
      });
    }

    function setMode(mode) {
      currentAuthMode = mode;
      if (!authForm) return;
      authForm.hidden = false;
      if (authError) {
        authError.hidden = true;
        authError.textContent = '';
      }
      if (mode === 'login') {
        if (authNameLabel) authNameLabel.textContent = 'Имя (необязательно)';
        if (authSubmitBtn) authSubmitBtn.textContent = 'Войти';
      } else {
        if (authNameLabel) authNameLabel.textContent = 'Имя';
        if (authSubmitBtn) authSubmitBtn.textContent = 'Создать аккаунт';
      }
    }

    if (btnAuthLogin) {
      btnAuthLogin.addEventListener('click', () => setMode('login'));
    }
    if (btnAuthRegister) {
      btnAuthRegister.addEventListener('click', () => setMode('register'));
    }

    // Клик по фону — войти как гость и закрыть
    authOverlay.addEventListener('click', (e) => {
      if (e.target === authOverlay) {
        saveUserSession({ mode: 'guest' });
        hideAuthOverlay();
      }
    });

    if (authForm) {
      authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentAuthMode) {
          setMode('login');
        }
        const name = authName?.value.trim() || '';
        const email = authEmail?.value.trim() || '';
        const password = authPassword?.value || '';

        if (!email || !password || (currentAuthMode === 'register' && !name)) {
          if (authError) {
            authError.textContent = 'Заполните все обязательные поля.';
            authError.hidden = false;
          }
          return;
        }

        if (authError) {
          authError.hidden = true;
          authError.textContent = '';
        }

        authSubmitBtn && (authSubmitBtn.disabled = true);
        try {
          const url = apiBase + (currentAuthMode === 'register' ? '/api/auth/register' : '/api/auth/login');
          const body = currentAuthMode === 'register'
            ? { name, email, password }
            : { email, password };
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) {
            const message = data && data.error ? data.error : 'Ошибка авторизации. Попробуйте ещё раз.';
            if (authError) {
              authError.textContent = message;
              authError.hidden = false;
            }
            return;
          }
          saveUserSession({
            mode: 'user',
            token: data.token,
            user: data.user
          });
          hideAuthOverlay();
        } catch (err) {
          if (authError) {
            authError.textContent = 'Сервер недоступен. Попробуйте позже.';
            authError.hidden = false;
          }
        } finally {
          authSubmitBtn && (authSubmitBtn.disabled = false);
        }
      });
    }
  }

  if (changeUserBtn && authOverlay) {
    changeUserBtn.addEventListener('click', () => {
      // Сброс текущей сессии и повторный выбор: войти / зарегистрироваться / гость
      saveUserSession(null);
      localStorage.removeItem('brodsky_user');
      showAuthOverlay();
    });
  }

  function hideAllSections() {
    sections.forEach(s => s.style.display = 'none');
  }

  function showSection(target, doScroll = true) {
    hideAllSections();

    if (target && target.startsWith('meals-')) {
      const meals = document.getElementById('meals');
      if (meals) meals.style.display = 'block';
      const sub = document.getElementById(target);
      if (sub && doScroll) sub.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const sec = document.getElementById(target || 'coffee');
      if (sec) {
        sec.style.display = 'block';
        if (doScroll) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  // Переключение категорий
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const target = btn.dataset.target || btn.dataset.category;

      // Сброс поиска
      if (searchInput) searchInput.value = '';
      document.querySelectorAll('.menu-card, .meal-item').forEach(i => i.style.display = '');

      showSection(target);
    });
  });

  // Отображение по умолчанию
  showSection('coffee', false);
  document.querySelector('.category-btn[data-target="coffee"], .category-btn[data-category="coffee"]')?.classList.add('active');

  // Поиск
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim().toLowerCase();
      const items = document.querySelectorAll('.menu-card, .meal-item');

      if (term) {
        // При поиске показываем все разделы
        sections.forEach(s => s.style.display = 'block');
        items.forEach(item => {
          const nameEl = item.querySelector('.item-name') || item.querySelector('.meal-name');
          const name = nameEl ? nameEl.textContent.toLowerCase() : '';
          item.style.display = name.includes(term) ? '' : 'none';
        });
      } else {
        // При очистке поиска возвращаемся к активному разделу
        items.forEach(i => i.style.display = '');
        const activeBtn = document.querySelector('.category-btn.active');
        const target = activeBtn ? (activeBtn.dataset.target || activeBtn.dataset.category) : 'coffee';
        showSection(target, false);
      }
    });
  }

  // Кнопка "наверх" — всегда видима и работает на всех контейнерах
  if (toTop) {
    // Принудительно показываем кнопку поверх всего
    try {
      toTop.style.setProperty('opacity', '1', 'important');
      toTop.style.setProperty('pointer-events', 'auto', 'important');
      toTop.style.setProperty('transform', 'translateY(0)', 'important');
      toTop.style.setProperty('z-index', '2147483647', 'important');
    } catch (e) { }

    function scrollToTop() {
      const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const behavior = prefersReduced ? 'auto' : 'smooth';

      // Окно браузера
      try {
        window.scrollTo({ top: 0, behavior });
      } catch (_) { }

      // Все прокручиваемые контейнеры
      document.querySelectorAll('*').forEach(el => {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
          try {
            el.scrollTo({ top: 0, behavior });
          } catch (_) {
            el.scrollTop = 0;
          }
        }
      });

      // Fallback для старых систем
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }

    toTop.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      scrollToTop();
    });
  }

  // ===== Бронирование столика (модальное окно) =====
  function openReservationModal() {
    if (reservationSection) {
      reservationSection.hidden = false;
      document.body.style.overflow = 'hidden';
    }
  }

  function closeReservationModal() {
    if (reservationSection) {
      reservationSection.hidden = true;
      document.body.style.overflow = '';
    }
  }

  if (openReservationBtn) {
    openReservationBtn.addEventListener('click', openReservationModal);
  }

  if (reservationCloseBtn) {
    reservationCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeReservationModal();
    });
  }

  if (reservationSection) {
    reservationSection.addEventListener('click', (e) => {
      if (e.target === reservationSection || e.target.getAttribute('data-close-reservation') === 'true') {
        closeReservationModal();
      }
    });
    
    const reservationModal = reservationSection.querySelector('.reservation-modal');
    if (reservationModal) {
      reservationModal.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
  }

  const reservationForm = document.getElementById('reservationForm');
  if (reservationForm) {
    reservationForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(reservationForm);
      const reservation = {
        name: formData.get('name') || '',
        phone: formData.get('phone') || '',
        date: formData.get('date') || '',
        time: formData.get('time') || '',
        guests: parseInt(formData.get('guests') || '2', 10),
        comment: formData.get('comment') || ''
      };

      const submitBtn = reservationForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await fetch(apiBase + '/api/reservations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reservation)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          alert(`Спасибо, ${reservation.name}! Заявка на бронирование отправлена.\n\nНомер бронирования: ${data.reservationId || ''}\nАдминистратор свяжется с вами для подтверждения.`);
          reservationForm.reset();
          closeReservationModal();
        } else {
          alert('Ошибка отправки бронирования. Попробуйте позже или позвоните нам.');
        }
      } catch (err) {
        alert('Сервер недоступен. Пожалуйста, позвоните нам для бронирования столика.');
      }
      if (submitBtn) submitBtn.disabled = false;
    });
  }

  // ===== Информация о существующих продуктах =====
  const productInfoSection = document.getElementById('productInfo');
  const productInfoImage = document.getElementById('productInfoImage');
  const productInfoName = document.getElementById('productInfoName');
  const productInfoDescription = document.getElementById('productInfoDescription');
  const productInfoCalories = document.getElementById('productInfoCalories');
  const productInfoIngredients = document.getElementById('productInfoIngredients');
  const productInfoCloseBtn = document.getElementById('productInfoClose');

  const productMeta = {
    'эспрессо': {
      calories: '5 ккал (на 40 мл)',
      ingredients: 'Эспрессо: 100% арабика, вода.',
      image: 'https://images.unsplash.com/photo-1511920170033-f8396924c348?auto=format&fit=crop&w=800&q=80'
    },
    'американо': {
      calories: '10 ккал (на 200 мл)',
      ingredients: 'Эспрессо, горячая вода.',
      image: 'https://images.unsplash.com/photo-1503481766315-7a586b20f66d?auto=format&fit=crop&w=800&q=80'
    },
    'фильтр-кофе': {
      calories: '5–10 ккал (на 250 мл)',
      ingredients: 'Молотый кофе спешелти-обжарки, вода.',
      image: 'https://images.unsplash.com/photo-1477764227684-8c4e5bca6f0d?auto=format&fit=crop&w=800&q=80'
    },
    'харио v60': {
      calories: '5–10 ккал (на 250 мл)',
      ingredients: 'Молотый кофе спешелти-обжарки, вода, метод заваривания V60.',
      image: 'https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&w=800&q=80'
    },
    'капучино': {
      calories: '120–170 ккал (в зависимости от объёма)',
      ingredients: 'Эспрессо, молоко, молочная пенка.',
      image: 'https://images.unsplash.com/photo-1517705008128-361805f42e86?auto=format&fit=crop&w=800&q=80'
    },
    'латте': {
      calories: '150–220 ккал (300 мл)',
      ingredients: 'Эспрессо, молоко, небольшое количество молочной пенки.',
      image: 'https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&w=800&q=80'
    },
    'флэт уайт': {
      calories: '120–170 ккал (200 мл)',
      ingredients: 'Двойной эспрессо, молоко, тонкий слой пенки.',
      image: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=800&q=80'
    },
    'раф': {
      calories: '220–320 ккал (300 мл)',
      ingredients: 'Эспрессо, сливки, ванильный/цитрусовый сахар, молоко.',
      image: 'https://images.unsplash.com/photo-1485808191679-5f86510681a2?auto=format&fit=crop&w=800&q=80'
    },
    'маття': {
      calories: '80–140 ккал (300 мл)',
      ingredients: 'Чай маття, молоко/растительное молоко.',
      image: 'https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=800&q=80'
    },
    'маргарита': {
      calories: '750–900 ккал (на пиццу 360 г)',
      ingredients: 'Римское тесто, томатный соус, моцарелла, томаты черри, песто, пармезан.',
      image: 'https://images.unsplash.com/photo-1601924582970-9238bcb495d9?auto=format&fit=crop&w=800&q=80'
    },
    'томатная паста': {
      calories: '550–700 ккал (порция)',
      ingredients: 'Паста, томатный соус, томаты черри, печёный перец, страчателла, песто.',
      image: 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=800&q=80'
    }
  };

  function normalizeName(name) {
    return name
      .toLowerCase()
      .replace(/[0-9]/g, '')
      .replace(/₽|г|мл/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function openProductInfoModal() {
    if (productInfoSection) {
      productInfoSection.hidden = false;
      document.body.style.overflow = 'hidden';
    }
  }

  function closeProductInfoModal() {
    if (productInfoSection) {
      productInfoSection.hidden = true;
      document.body.style.overflow = '';
    }
  }

  function parsePriceFromElement(element) {
    const priceEl = element.querySelector('.item-price') || element.querySelector('.meal-price');
    if (!priceEl) return 0;
    const match = priceEl.textContent.match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
  }

  let currentProductForCart = { name: '', price: 0 };

  function showProductInfoFromElement(element) {
    if (!productInfoSection || !productInfoName) return;

    const nameEl = element.querySelector('.item-name') || element.querySelector('.meal-name');
    const descEl = element.querySelector('.item-description') || element.querySelector('.meal-description');

    if (!nameEl) return;

    const rawNameNode = nameEl.childNodes[0];
    const baseName = (rawNameNode && rawNameNode.textContent ? rawNameNode.textContent : nameEl.textContent).trim();
    const description = descEl ? descEl.textContent.trim() : '';
    const price = parsePriceFromElement(element);

    currentProductForCart = { name: baseName, price };

    const normalized = normalizeName(baseName);
    const metaKey = Object.keys(productMeta).find(key => normalized.startsWith(key));
    const meta = metaKey ? productMeta[metaKey] : null;

    productInfoName.textContent = baseName;
    productInfoDescription.textContent = meta && meta.description ? meta.description : description || 'Описание будет добавлено позже.';
    productInfoCalories.textContent = meta && meta.calories ? meta.calories : 'Информация уточняется.';
    productInfoIngredients.textContent = meta && meta.ingredients ? meta.ingredients : 'Состав скоро будет доступен.';

    const priceEl = document.getElementById('productInfoPrice');
    if (priceEl) priceEl.textContent = price ? price + '₽' : '—';

    const qtyEl = document.getElementById('productInfoQty');
    if (qtyEl) qtyEl.value = '1';

    if (productInfoImage) {
      if (meta && meta.image) {
        productInfoImage.src = meta.image;
      } else {
        productInfoImage.src = 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=800&q=80';
      }
    }

    openProductInfoModal();
  }

  const clickableItems = document.querySelectorAll('.menu-card, .meal-item');
  clickableItems.forEach(item => {
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => showProductInfoFromElement(item));
  });

  if (productInfoSection) {
    productInfoSection.addEventListener('click', (e) => {
      if (e.target === productInfoSection || e.target.getAttribute('data-close-product') === 'true') {
        closeProductInfoModal();
      }
    });
    
    const productInfoCard = productInfoSection.querySelector('.product-info-card');
    if (productInfoCard) {
      productInfoCard.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
  }

  if (productInfoCloseBtn) {
    productInfoCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProductInfoModal();
    });
  }

  // ===== Корзина =====
  const cart = {
    items: [],
    add(name, price, qty = 1) {
      const id = name;
      const existing = this.items.find(i => i.name === name);
      if (existing) {
        existing.qty += qty;
      } else {
        this.items.push({ id, name, price, qty });
      }
      this.save();
      renderCart();
    },
    remove(name) {
      this.items = this.items.filter(i => i.name !== name);
      this.save();
      renderCart();
    },
    getTotal() {
      return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
    },
    getCount() {
      return this.items.reduce((sum, i) => sum + i.qty, 0);
    },
    clear() {
      this.items = [];
      this.save();
      renderCart();
    },
    save() {
      try {
        localStorage.setItem('brodsky_cart', JSON.stringify(this.items));
      } catch (_) {}
    },
    load() {
      try {
        const s = localStorage.getItem('brodsky_cart');
        if (s) this.items = JSON.parse(s);
      } catch (_) {}
    }
  };
  cart.load();

  const cartFab = document.getElementById('cartFab');
  const cartFabBadge = document.getElementById('cartFabBadge');
  const cartDrawer = document.getElementById('cartDrawer');
  const cartDrawerClose = document.getElementById('cartDrawerClose');
  const cartList = document.getElementById('cartList');
  const cartTotalSum = document.getElementById('cartTotalSum');
  const cartBackdrop = document.getElementById('cartBackdrop');
  const btnCheckout = document.getElementById('btnCheckout');
  const productInfoQty = document.getElementById('productInfoQty');
  const productInfoAddToCart = document.getElementById('productInfoAddToCart');

  function renderCart() {
    const count = cart.getCount();
    if (cartFab) {
      cartFab.hidden = count === 0;
      cartFab.style.display = count === 0 ? 'none' : 'flex';
    }
    if (cartFabBadge) cartFabBadge.textContent = count;
    if (cartTotalSum) cartTotalSum.textContent = cart.getTotal() + '₽';

    if (count === 0 && cartDrawer && !cartDrawer.hidden) closeCartDrawer();

    if (!cartList) return;
    cartList.innerHTML = '';
    cart.items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'cart-list-item';
      li.innerHTML = `
        <div class="cart-item-info">
          <span class="cart-item-name">${escapeHtml(item.name)}</span>
          <span class="cart-item-detail">${item.price}₽ × ${item.qty}</span>
        </div>
        <div class="cart-item-right">
          <span class="cart-item-subtotal">${item.price * item.qty}₽</span>
          <button type="button" class="cart-item-remove" data-index="${index}" aria-label="Удалить">&times;</button>
        </div>
      `;
      cartList.appendChild(li);
    });

    cartList.querySelectorAll('.cart-item-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index, 10);
        if (!isNaN(index) && cart.items[index]) cart.remove(cart.items[index].name);
      });
    });
  }
  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : s;
    return div.innerHTML;
  }

  if (productInfoAddToCart) {
    productInfoAddToCart.addEventListener('click', () => {
      const qty = Math.max(1, parseInt(productInfoQty?.value || '1', 10));
      if (currentProductForCart.name && currentProductForCart.price > 0) {
        cart.add(currentProductForCart.name, currentProductForCart.price, qty);
        closeProductInfoModal();
      }
    });
  }

  function openCartDrawer() {
    if (cart.getCount() === 0) return;
    if (cartDrawer) cartDrawer.hidden = false;
    if (cartBackdrop) cartBackdrop.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeCartDrawer() {
    if (cartDrawer) cartDrawer.hidden = true;
    if (cartBackdrop) cartBackdrop.hidden = true;
    document.body.style.overflow = '';
  }

  const btnCartContinue = document.getElementById('btnCartContinue');
  if (btnCartContinue) btnCartContinue.addEventListener('click', closeCartDrawer);

  if (cartFab) cartFab.addEventListener('click', openCartDrawer);
  if (cartDrawerClose) cartDrawerClose.addEventListener('click', closeCartDrawer);
  if (cartBackdrop) {
    cartBackdrop.addEventListener('click', () => {
      if (cartBackdrop.getAttribute('data-close-cart') === 'true') closeCartDrawer();
    });
  }

  // Корзина скрыта при загрузке — показывается только по клику на кнопку корзины
  if (cartDrawer) cartDrawer.hidden = true;
  if (cartBackdrop) cartBackdrop.hidden = true;

  renderCart();

  // ===== Оформление заказа (оплата) =====
  const checkoutModal = document.getElementById('checkoutModal');
  const checkoutClose = document.getElementById('checkoutClose');
  const checkoutSummary = document.getElementById('checkoutSummary');
  const checkoutTotal = document.getElementById('checkoutTotal');
  const btnPay = document.getElementById('btnPay');

  function openCheckout() {
    if (cart.getCount() === 0) return;
    if (!checkoutModal) return;
    if (checkoutSummary) {
      checkoutSummary.innerHTML = cart.items
        .map(i => `<div class="checkout-line">${escapeHtml(i.name)} × ${i.qty} — ${i.price * i.qty}₽</div>`)
        .join('');
    }
    if (checkoutTotal) checkoutTotal.textContent = cart.getTotal() + '₽';
    const tableNumberEl = document.getElementById('tableNumber');
    if (tableNumberEl) tableNumberEl.value = '';
    const orderCommentEl = document.getElementById('orderComment');
    if (orderCommentEl) orderCommentEl.value = '';
    checkoutModal.hidden = false;
    document.body.style.overflow = 'hidden';
    closeCartDrawer();
  }
  function closeCheckout() {
    checkoutModal.hidden = true;
    document.body.style.overflow = '';
  }

  if (btnCheckout) btnCheckout.addEventListener('click', openCheckout);
  if (checkoutClose) checkoutClose.addEventListener('click', closeCheckout);
  checkoutModal?.querySelector('.checkout-backdrop')?.addEventListener('click', closeCheckout);

  if (btnPay) {
    btnPay.addEventListener('click', async () => {
      const method = document.querySelector('input[name="paymentMethod"]:checked');
      const paymentMethod = method ? method.value : 'cash';
      const tableNumberEl = document.getElementById('tableNumber');
      const tableNumber = tableNumberEl ? tableNumberEl.value.trim() : '';
      const orderCommentEl = document.getElementById('orderComment');
      const comment = orderCommentEl ? orderCommentEl.value.trim() : '';
      const order = {
        items: cart.items.map(i => ({ name: i.name, price: i.price, qty: i.qty })),
        total: cart.getTotal(),
        paymentMethod,
        comment: comment || undefined,
        tableNumber: tableNumber || undefined
      };

      btnPay.disabled = true;
      try {
        const res = await fetch(apiBase + '/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(order)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          cart.clear();
          closeCheckout();
          alert('Заказ №' + (data.orderId || '') + ' принят. Оплата: ' + (paymentMethod === 'visa' ? 'Visa' : paymentMethod === 'qr' ? 'QR-код' : 'Наличные') + '. Ожидайте приготовления.');
        } else {
          alert('Ошибка отправки заказа. Попробуйте позже или оплатите на кассе.');
        }
      } catch (err) {
        alert('Сервер недоступен. Заказ можно оплатить на кассе (наличные, карта или QR).');
      }
      btnPay.disabled = false;
    });
  }

  // Один обработчик ESC: закрывает верхнее открытое окно (приоритет: оплата → корзина → товар → бронь)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (checkoutModal && !checkoutModal.hidden) {
      closeCheckout();
      return;
    }
    if (cartDrawer && !cartDrawer.hidden) {
      closeCartDrawer();
      return;
    }
    if (productInfoSection && !productInfoSection.hidden) {
      closeProductInfoModal();
      return;
    }
    if (reservationSection && !reservationSection.hidden) {
      closeReservationModal();
    }
  });
});
