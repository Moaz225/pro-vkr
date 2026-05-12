/**
 * Сервер приёма заказов BRODSKY.
 * При оплате заказ сохраняется и передаётся работникам (файл + консоль).
 * Запуск: npm install && npm start
 * API: POST /api/orders — принять заказ (body: { items, total, paymentMethod })
 *      GET  /api/orders — список заказов (для работников/админки)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { PrismaClient, Prisma } = require('@prisma/client');
const { validateAndLoadEnv } = require('./env');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const csrf = require('csurf');
const pg = require('pg');
const PgSession = require('connect-pg-simple')(session);
const { createMailer } = require('./mail');
const { registerCancellationRoutes } = require('./cancellation-routes');

const app = express();
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const env = validateAndLoadEnv();
const prisma = new PrismaClient();
const pgPool = new pg.Pool({
  connectionString: env.databaseUrl,
  ssl: env.isProd ? { rejectUnauthorized: false } : false
});
const PORT = Number(process.env.PORT) || env.port || 3000;
const PUBLIC_DIR = path.join(__dirname, '..');

app.disable('x-powered-by');

// Phase 4: Security headers
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

// Phase 4: Rate limiting (global)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// Базовая конфигурация CORS (Phase 4: strict allowlist in production)
const allowedOrigins = env.corsOrigins || [];

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser requests (no Origin header) like curl/server-to-server (webhooks).
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes('*')) return cb(null, origin);

      if (allowedOrigins.includes(origin)) return cb(null, true);

      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true
  })
);

app.use(express.json({ limit: '100kb' }));

// Phase 5: Cookie-based sessions (HttpOnly + Secure + SameSite)
app.use(
  session({
    store: new PgSession({
      pool: pgPool,
      tableName: 'session',
      createTableIfMissing: true
    }),
    name: 'brodsky.sid',
    secret: env.sessionSecret || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      secure: Boolean(env.cookieSecure),
      sameSite: 'lax',
      maxAge: 14 * 24 * 60 * 60 * 1000
    }
  })
);

// Phase 2/5/Hardening: CSRF protection for cookie sessions.
// - Applied ONLY to state-changing routes.
// - Must NOT be applied to YooKassa webhook (server-to-server).
const csrfProtection = csrf();

app.get('/api/csrf', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// Render/health checks (DB must respond)
app.get('/health', (req, res) => {
  pgPool
    .query('SELECT 1')
    .then(() => {
      res.json({
        status: 'ok',
        db: 'connected',
        timestamp: new Date().toISOString()
      });
    })
    .catch((err) => {
      console.error('GET /health DB check failed:', err);
      res.status(503).json({
        status: 'unhealthy',
        db: 'disconnected',
        timestamp: new Date().toISOString()
      });
    });
});

// Public products endpoint for menu rendering and product modal images.
// Returns all products (clients скрывают недоступные в UI по полю isAvailable).
app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        category: true,
        imageUrl: true,
        isAvailable: true
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }]
    });

    res.json({ success: true, products });
  } catch (err) {
    console.error('GET /api/products failed:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Public availability map for customer UI "stop-list" badges.
// Returns minimal fields only (name + isAvailable) for all products.
app.get('/api/products/availability', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      select: { name: true, isAvailable: true }
    });
    res.json({ success: true, products });
  } catch (err) {
    console.error('GET /api/products/availability failed:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

function normalizeProductName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[0-9]/g, '')
    .replace(/₽/g, '')
    .replace(/\s*г\b/g, ' ')
    .replace(/\s*мл\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

app.patch('/api/products/:id/availability', csrfProtection, async (req, res) => {
  try {
    const productId = String(req.params.id || '');
    if (!req.body || typeof req.body.isAvailable !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Укажите isAvailable (boolean)' });
    }
    const isAvailable = req.body.isAvailable;

    const updated = await prisma.product.update({
      where: { id: productId },
      data: { isAvailable }
    });

    res.json({ success: true, product: { id: updated.id, isAvailable: updated.isAvailable } });
  } catch (err) {
    console.error('PATCH /api/products/:id/availability failed:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/products', csrfProtection, async (req, res) => {
  try {
    const { name, description, price, category, imageUrl } = req.body || {};
    const nm = String(name || '').trim();
    const desc = String(description || '').trim();
    const cat = String(category || '').trim();
    const imgRaw = String(imageUrl || '').trim();
    const img =
      imgRaw ||
      'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=800&q=60';

    const priceNum = Number(price);
    if (!nm || nm.length > 200) {
      return res.status(400).json({ success: false, error: 'Укажите название' });
    }
    if (!cat || cat.length > 120) {
      return res.status(400).json({ success: false, error: 'Укажите категорию' });
    }
    if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum > 1e7) {
      return res.status(400).json({ success: false, error: 'Укажите корректную цену' });
    }

    const created = await prisma.product.create({
      data: {
        name: nm,
        description: desc || '—',
        price: new Prisma.Decimal(priceNum.toFixed(2)),
        category: cat,
        imageUrl: img.slice(0, 2048),
        isAvailable: true
      }
    });

    res.json({
      success: true,
      product: {
        id: created.id,
        name: created.name,
        description: created.description,
        price: Number(created.price),
        category: created.category,
        imageUrl: created.imageUrl,
        isAvailable: created.isAvailable
      }
    });
  } catch (err) {
    console.error('POST /api/products:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.delete('/api/products/:id', csrfProtection, async (req, res) => {
  try {
    const productId = String(req.params.id || '').trim();
    if (!productId) return res.status(400).json({ success: false, error: 'Некорректный id' });

    await prisma.product.delete({ where: { id: productId } });
    res.json({ success: true, id: productId });
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Товар не найден' });
    }
    console.error('DELETE /api/products/:id:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Простейший логгер запросов
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`
    );
  });
  next();
});

// Раздача страниц меню и заказов для персонала (index.html, staff-orders.html, style.css, script.js)
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(path.join(PUBLIC_DIR, 'public', 'uploads')));
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// В упрощённой версии проекта столики не хранятся в БД,
// поэтому инициализация RestaurantTable не требуется.
async function ensureDefaultTables() {
  const uploadsDir = path.join(PUBLIC_DIR, 'public', 'uploads', 'cancellations');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 100000;
  const keylen = 32;
  const digest = 'sha256';
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, keylen, digest).toString('hex');
  return `pbkdf2$${digest}$${iterations}$${salt}$${hash}`;
}

function verifyPasswordHash(password, stored) {
  const raw = String(stored || '');
  const pwd = String(password || '');
  const parts = raw.split('$');
  if (parts.length === 5 && parts[0] === 'pbkdf2') {
    const digest = parts[1];
    const iterations = parseInt(parts[2], 10);
    const salt = parts[3];
    const expected = parts[4];
    if (!digest || !salt || !expected || !iterations) return false;
    const actual = crypto.pbkdf2Sync(pwd, salt, iterations, 32, digest).toString('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return actual === expected;
    }
  }
  return false;
}

function getSessionUserId(req) {
  return req && req.session && req.session.userId ? req.session.userId : null;
}

function mapOrderStatusToApi(s) {
  const v = String(s || '');
  if (v === 'PendingPayment') return 'pending';
  if (v === 'New') return 'new';
  if (v === 'InProgress') return 'in_progress';
  if (v === 'Done') return 'done';
  if (v === 'Cancelled') return 'cancelled';
  return 'pending';
}

function mapApiStatusToOrderStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'pending') return 'PendingPayment';
  if (v === 'new') return 'New';
  if (v === 'in_progress') return 'InProgress';
  if (v === 'done') return 'Done';
  if (v === 'cancelled') return 'Cancelled';
  return null;
}

// Phase 2: SSE «заказ готов» (in-memory; один процесс Node)
const orderReadySubscribers = new Map(); // userId -> Set<Response>

function subscribeOrderReady(userId, clientRes) {
  const id = String(userId || '');
  if (!id) return;
  if (!orderReadySubscribers.has(id)) orderReadySubscribers.set(id, new Set());
  orderReadySubscribers.get(id).add(clientRes);
}

function unsubscribeOrderReady(userId, clientRes) {
  const id = String(userId || '');
  const set = orderReadySubscribers.get(id);
  if (!set) return;
  set.delete(clientRes);
  if (set.size === 0) orderReadySubscribers.delete(id);
}

function emitOrderReadyForCustomer(userId, orderId, repeat) {
  const uid = String(userId || '');
  const oid = String(orderId || '');
  if (!uid || !oid) return;
  const set = orderReadySubscribers.get(uid);
  if (!set || set.size === 0) return;
  const line = `data: ${JSON.stringify({
    type: 'order_ready',
    orderId: oid,
    repeat: Boolean(repeat)
  })}\n\n`;
  for (const clientRes of [...set]) {
    try {
      clientRes.write(line);
    } catch (_) {
      unsubscribeOrderReady(uid, clientRes);
    }
  }
}

function mapPrismaRoleToApi(role) {
  const r = String(role || '');
  if (r === 'Manager') return 'manager';
  if (r === 'Staff') return 'staff';
  return 'user';
}

function mapReservationStatusToApi(s) {
  const v = String(s || '');
  if (v === 'Pending') return 'pending';
  if (v === 'Confirmed') return 'confirmed';
  if (v === 'Cancelled') return 'cancelled';
  return 'pending';
}

function mapApiStatusToReservationStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'pending') return 'Pending';
  if (v === 'confirmed') return 'Confirmed';
  if (v === 'cancelled') return 'Cancelled';
  return null;
}

function parseIsoDate(s) {
  const d = new Date(String(s || ''));
  return Number.isFinite(d.getTime()) ? d : null;
}

function dbg(label, obj) {
  try {
    console.log(`[DEBUG] ${label}`, obj);
  } catch {
    console.log(`[DEBUG] ${label}`);
  }
}

// ===== АУТЕНТИФИКАЦИЯ =====

// Phase 4: extra protection for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

// Регистрация пользователя
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const trimmedName = String(name || '').trim();
    const trimmedEmail = String(email || '').trim().toLowerCase();
    const rawPassword = String(password || '');

    if (!trimmedName || !trimmedEmail || !rawPassword) {
      return res.status(400).json({ success: false, error: 'Заполните имя, email и пароль' });
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
      return res.status(400).json({ success: false, error: 'Некорректный email' });
    }

    if (rawPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Пароль должен быть не короче 6 символов' });
    }

    const existing = await prisma.user.findUnique({ where: { email: trimmedEmail } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Пользователь с таким email уже существует' });
    }

    const user = await prisma.user.create({
      data: {
        name: trimmedName,
        email: trimmedEmail,
        passwordHash: makePasswordHash(rawPassword),
        role: 'User'
      }
    });

    req.session.userId = user.id;

    res.json({
      success: true,
      user: {
        id: String(user.id),
        name: user.name,
        email: user.email,
        role: mapPrismaRoleToApi(user.role)
      }
    });
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Вход пользователя
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const trimmedEmail = String(email || '').trim().toLowerCase();
    const rawPassword = String(password || '');

    if (!trimmedEmail || !rawPassword) {
      return res.status(400).json({ success: false, error: 'Введите email и пароль' });
    }

    const user = await prisma.user.findUnique({ where: { email: trimmedEmail } });
    if (!user || !verifyPasswordHash(rawPassword, user.passwordHash)) {
      return res.status(401).json({ success: false, error: 'Неверный email или пароль' });
    }

    req.session.userId = user.id;

    res.json({
      success: true,
      user: {
        id: String(user.id),
        name: user.name,
        email: user.email,
        role: mapPrismaRoleToApi(user.role)
      }
    });
  } catch (err) {
    console.error('Ошибка входа:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Получить текущего пользователя по cookie session
app.get('/api/auth/me', (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Не авторизовано' });
  }
  prisma.user
    .findUnique({ where: { id: userId } })
    .then((user) => {
      if (!user) {
        return res.status(401).json({ success: false, error: 'Не авторизовано' });
      }
      res.json({
        success: true,
        user: {
          id: String(user.id),
          name: user.name,
          email: user.email,
          role: mapPrismaRoleToApi(user.role)
        }
      });
    })
    .catch((err) => {
      console.error('Ошибка /api/auth/me:', err);
      res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    });
});

// Выйти из аккаунта
app.post('/api/auth/logout', csrfProtection, (req, res) => {
  try {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  } catch (err) {
    res.json({ success: true });
  }
});

/**
 * SSE: уведомление клиента о готовности заказа (роль Customer).
 * Одна вкладка = одно подключение; несколько вкладок — несколько записей в Set.
 */
app.get('/api/me/order-ready-events', (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Не авторизовано' });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  subscribeOrderReady(userId, res);
  try {
    res.write(': connected\n\n');
  } catch (_) {}

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribeOrderReady(userId, res);
    try {
      res.end();
    } catch (_) {}
  });
});

async function listOrdersFromDb(query) {
  const { status, from, to, sort = 'desc', limit, paymentMethod, q } = query || {};
  const orderBy = sort === 'asc' ? { createdAt: 'asc' } : { createdAt: 'desc' };
  const take = (() => {
    const n = parseInt(String(limit || ''), 10);
    return Number.isFinite(n) && n > 0 && n <= 500 ? n : 200;
  })();

  const where = {};

  if (status) {
    const mapped = mapApiStatusToOrderStatus(status);
    if (mapped) where.status = mapped;
  }
  if (paymentMethod) where.paymentMethod = String(paymentMethod);

  const createdAt = {};
  const fromDate = from ? parseIsoDate(from) : null;
  const toDate = to ? parseIsoDate(to) : null;
  if (fromDate) createdAt.gte = fromDate;
  if (toDate) createdAt.lte = toDate;
  if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

  if (q) {
    const term = String(q);
    where.OR = [
      { comment: { contains: term, mode: 'insensitive' } },
      { items: { some: { name: { contains: term, mode: 'insensitive' } } } }
    ];
  }

  const rows = await prisma.order.findMany({
    where,
    orderBy,
    take,
    include: { items: true, payment: true }
  });

  return rows.map((o) => ({
    orderId: o.id,
    items: (o.items || []).map((i) => ({
      name: i.name,
      price: Number(i.price),
      qty: i.quantity
    })),
    total: Number(o.totalAmount),
    paymentMethod: o.paymentMethod,
    comment: o.comment || undefined,
    tableNumber: o.tableNumber || undefined,
    createdAt: o.createdAt.toISOString(),
    status: mapOrderStatusToApi(o.status),
    payment: o.payment
      ? {
          paymentId: o.payment.providerPaymentId,
          confirmationUrl: o.payment.confirmationUrl || undefined
        }
      : null
  }));
}

app.post('/api/orders', csrfProtection, async (req, res) => {
  try {
    const { items = [], paymentMethod = 'cash', comment = '', tableNumber } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Пустой заказ' });
  }

    const allowedMethods = ['visa'];
    if (!allowedMethods.includes(paymentMethod)) {
      return res.status(400).json({ success: false, error: 'Доступна только онлайн-оплата (банковская карта через YooKassa)' });
    }

    const normalizedItems = [];
    for (const rawItem of items) {
      const name = rawItem && rawItem.name ? String(rawItem.name).trim() : '';
      const price = Number(rawItem && rawItem.price) || 0;
      const qty = Number(rawItem && rawItem.qty) || 0;
      if (!name || price <= 0 || qty <= 0) {
        return res.status(400).json({ success: false, error: 'Некорректные позиции заказа' });
      }
      normalizedItems.push({ name, price, qty });
    }

    // Phase 1 stop-list enforcement: do not allow ordering unavailable products.
    // We match by normalized name (best-effort, given current payload structure).
    const orderedKeys = [...new Set(normalizedItems.map((i) => normalizeProductName(i.name)).filter(Boolean))];
    if (orderedKeys.length) {
      const available = await prisma.product.findMany({
        where: { isAvailable: true },
        select: { name: true }
      });
      const availableKeys = new Set((available || []).map((p) => normalizeProductName(p.name)).filter(Boolean));
      const unavailableOrdered = orderedKeys.filter((k) => !availableKeys.has(k));
      if (unavailableOrdered.length) {
        return res.status(400).json({
          success: false,
          error: 'Некоторые позиции недоступны (стоп-лист). Обновите меню и попробуйте снова.'
        });
      }
    }

    const computedTotal = normalizedItems.reduce((sum, i) => sum + i.price * i.qty, 0);
    const userId = getSessionUserId(req);

    const order = await prisma.order.create({
      data: {
        userId: userId || null,
        status: 'PendingPayment',
        totalAmount: computedTotal,
        currency: env.yookassaCurrency || 'RUB',
    paymentMethod,
        comment: String(comment || '').trim() || null,
        tableNumber: tableNumber ? String(tableNumber).trim() || null : null,
        items: {
          create: normalizedItems.map((i) => ({
            name: i.name,
            price: i.price,
            quantity: i.qty
          }))
        }
      }
    });

    res.status(200).json({ success: true, orderId: order.id });
  } catch (err) {
    console.error('Ошибка при создании заказа:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await listOrdersFromDb(req.query);
    res.json({ orders });
  } catch (err) {
    console.error('Ошибка при получении заказов:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Aggregate orders created in [from, to] (ISO timestamps).
 * - orderCount: all orders in window
 * - totalRevenue / averageOrderValue: only orders with status !== Cancelled
 */
app.get('/api/orders/shift-summary', async (req, res) => {
  try {
    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    if (!fromRaw || !toRaw) {
      return res.status(400).json({ success: false, error: 'Укажите параметры from и to (ISO дата/время)' });
    }
    let fromDate = parseIsoDate(fromRaw);
    let toDate = parseIsoDate(toRaw);
    if (!fromDate || !toDate) {
      return res.status(400).json({ success: false, error: 'Некорректный формат from или to' });
    }
    if (fromDate.getTime() > toDate.getTime()) {
      const swap = fromDate;
      fromDate = toDate;
      toDate = swap;
    }

    const rows = await prisma.order.findMany({
      where: { createdAt: { gte: fromDate, lte: toDate } },
      select: { totalAmount: true, status: true }
    });

    const orderCount = rows.length;
    const revenueRows = rows.filter((r) => r.status !== 'Cancelled');
    const revenueOrderCount = revenueRows.length;
    const totalRevenue = revenueRows.reduce((sum, r) => sum + Number(r.totalAmount), 0);
    const averageOrderValue = revenueOrderCount === 0 ? 0 : totalRevenue / revenueOrderCount;

    res.json({
      success: true,
      summary: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        orderCount,
        revenueOrderCount,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        averageOrderValue: Math.round(averageOrderValue * 100) / 100
      }
    });
  } catch (err) {
    console.error('GET /api/orders/shift-summary:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/orders/shift-close', async (req, res) => {
  try {
    const { from, to, summary } = req.body || {};
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'Укажите from и to (ISO дата/время)' });
    }
    const fromDate = parseIsoDate(from);
    const toDate = parseIsoDate(to);
    if (!fromDate || !toDate) {
      return res.status(400).json({ success: false, error: 'Некорректный формат from или to' });
    }
    if (!summary || typeof summary !== 'object') {
      return res.status(400).json({ success: false, error: 'Не передан summary' });
    }

    const orderCount = Number(summary.orderCount);
    const totalRevenue = Number(summary.totalRevenue);
    const averageOrderValue = Number(summary.averageOrderValue);
    const revenueOrderCount = Number(summary.revenueOrderCount);

    if (!Number.isFinite(orderCount) || orderCount < 0) {
      return res.status(400).json({ success: false, error: 'Некорректный orderCount' });
    }
    if (!Number.isFinite(totalRevenue) || totalRevenue < 0) {
      return res.status(400).json({ success: false, error: 'Некорректная выручка' });
    }
    if (!Number.isFinite(averageOrderValue) || averageOrderValue < 0) {
      return res.status(400).json({ success: false, error: 'Некорректный средний чек' });
    }

    let cancelledCount = null;
    if (Number.isFinite(revenueOrderCount) && revenueOrderCount >= 0) {
      cancelledCount = Math.max(0, orderCount - revenueOrderCount);
    } else {
      // Fallback: compute cancelled count directly from DB.
      const cancelled = await prisma.order.count({
        where: { createdAt: { gte: fromDate, lte: toDate }, status: 'Cancelled' }
      });
      cancelledCount = cancelled;
    }

    let staffName = 'Сотрудник';
    const userId = getSessionUserId(req);
    if (userId) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      if (u && u.name) staffName = String(u.name);
    }

    const finalizeToken = crypto.randomBytes(16).toString('hex');
    const created = await prisma.shiftReport.create({
      data: {
        staffName,
        shiftStart: fromDate,
        shiftEnd: toDate,
        orderCount: Math.trunc(orderCount),
        totalRevenue,
        averageOrder: averageOrderValue,
        cancelledCount: Math.trunc(cancelledCount),
        finalizeToken
      }
    });

    res.json({ success: true, reportId: created.id, finalizeToken });
  } catch (err) {
    console.error('POST /api/orders/shift-close:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/orders/shift-finalize', async (req, res) => {
  try {
    const { reportId, finalizeToken } = req.body || {};
    const id = parseInt(String(reportId), 10);
    const token = String(finalizeToken || '').trim();

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Некорректный reportId' });
    }
    if (!token) {
      return res.status(400).json({ success: false, error: 'Не передан finalizeToken' });
    }

    const report = await prisma.shiftReport.findUnique({ where: { id } });
    if (!report) {
      return res.status(404).json({ success: false, error: 'Отчёт смены не найден' });
    }
    if (!report.finalizeToken || report.finalizeToken !== token) {
      return res.status(403).json({ success: false, error: 'Неверный токен подтверждения' });
    }
    if (report.finalizedAt) {
      return res.status(400).json({ success: false, error: 'Смена уже закрыта и очищена' });
    }

    // Destructive end-of-day reset. Delete in FK-safe order.
    const deleted = await prisma.$transaction(async (tx) => {
      const delWebhookEvents = await tx.webhookEvent.deleteMany({});
      const delPayments = await tx.payment.deleteMany({});
      const delOrderItems = await tx.orderItem.deleteMany({});
      const delOrders = await tx.order.deleteMany({});
      const delReservations = await tx.reservation.deleteMany({});

      // Mark report finalized and invalidate token to prevent re-run.
      await tx.shiftReport.update({
        where: { id },
        data: { finalizedAt: new Date(), finalizeToken: null }
      });

      return {
        webhookEvent: delWebhookEvents.count,
        payment: delPayments.count,
        orderItem: delOrderItems.count,
        order: delOrders.count,
        reservation: delReservations.count
      };
    });

    // Optional: clear server-side sessions (connect-pg-simple uses table "session").
    let sessionsDeleted = null;
    try {
      const r = await pgPool.query('DELETE FROM session');
      sessionsDeleted = typeof r.rowCount === 'number' ? r.rowCount : null;
    } catch (e) {
      // Table may not exist or DB user may not have permission; don't fail finalize.
      console.warn('[shift-finalize] session delete skipped:', e.message);
    }

    console.log('[shift-finalize] reportId=%s deleted=%j sessions=%s', id, deleted, sessionsDeleted);

    res.json({ success: true, deleted, sessionsDeleted });
  } catch (err) {
    console.error('POST /api/orders/shift-finalize:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Public read-only: shift reports after staff closes shift (no login required).
app.get('/api/shift-reports', async (req, res) => {
  try {
    const rows = await prisma.shiftReport.findMany({
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      reports: rows.map((r) => ({
        id: r.id,
        staffName: r.staffName,
        shiftStart: r.shiftStart.toISOString(),
        shiftEnd: r.shiftEnd.toISOString(),
        orderCount: r.orderCount,
        totalRevenue: Number(r.totalRevenue),
        averageOrder: Number(r.averageOrder),
        cancelledCount: r.cancelledCount,
        createdAt: r.createdAt.toISOString()
      }))
    });
  } catch (err) {
    console.error('GET /api/shift-reports:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.patch('/api/orders/:orderId', csrfProtection, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body || {};
    const next = String(status || '');

    const order = await prisma.order.findUnique({ where: { id: String(orderId) } });
    if (!order) return res.status(404).json({ success: false, error: 'Заказ не найден' });

    const cur = mapOrderStatusToApi(order.status);

    if (next === 'in_progress') {
      if (cur !== 'new') return res.status(400).json({ success: false, error: 'Заказ ещё не оплачен' });
      const updated = await prisma.order.update({ where: { id: order.id }, data: { status: 'InProgress', updatedAt: new Date() } });
      return res.json({ success: true, order: { orderId: updated.id, status: mapOrderStatusToApi(updated.status) } });
    }

    if (next === 'done') {
      if (cur !== 'in_progress') return res.status(400).json({ success: false, error: 'Сначала переведите заказ в работу' });
      const updated = await prisma.order.update({ where: { id: order.id }, data: { status: 'Done', updatedAt: new Date() } });
      if (updated.userId) emitOrderReadyForCustomer(updated.userId, updated.id, false);
      return res.json({ success: true, order: { orderId: updated.id, status: mapOrderStatusToApi(updated.status) } });
    }

    return res.status(400).json({ success: false, error: 'Некорректный статус' });
  } catch (err) {
    console.error('Ошибка обновления статуса заказа:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/orders/:id/notify-ready', csrfProtection, async (req, res) => {
  try {
    const staffId = getSessionUserId(req);
    if (!staffId) return res.status(401).json({ success: false, error: 'Не авторизовано' });
    const staff = await prisma.user.findUnique({ where: { id: staffId }, select: { role: true } });
    if (!staff || (staff.role !== 'Staff' && staff.role !== 'Manager')) {
      return res.status(403).json({ success: false, error: 'Нет доступа' });
    }

    const orderId = String(req.params.id || '').trim();
    if (!orderId) return res.status(400).json({ success: false, error: 'Некорректный заказ' });

    const ord = await prisma.order.findUnique({ where: { id: orderId } });
    if (!ord) return res.status(404).json({ success: false, error: 'Заказ не найден' });
    if (ord.status !== 'Done') {
      return res.status(400).json({ success: false, error: 'Уведомление доступно только для завершённого заказа' });
    }
    if (!ord.userId) {
      return res.json({ success: true, skipped: true, reason: 'no_linked_user' });
    }
    emitOrderReadyForCustomer(ord.userId, ord.id, true);
    return res.json({ success: true, orderId: ord.id });
  } catch (err) {
    console.error('POST /api/orders/:id/notify-ready:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// ===== YOO KASSA PAYMENT FLOW (Orders must be paid via backend, not frontend) =====

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) {
    return xf.split(',')[0].trim();
  }
  return req.ip || (req.connection && req.connection.remoteAddress) || null;
}

// IP allowlist from YooMoney/YooKassa docs for HTTP notifications.
// https://yookassa.ru/developers/using-api/webhooks
const ALLOWED_NOTIFICATION_IPS = [
  '185.71.76.',
  '185.71.77.',
  '77.75.153.',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.',
  '2a02:5180::'
];

function isAllowedNotificationIp(ip) {
  if (!ip) return false;
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  return ALLOWED_NOTIFICATION_IPS.some(prefix => ip.startsWith(prefix));
}

async function yookassaRequest({ method, path, jsonBody, idempotenceKey }) {
  const shopId = env.yookassaShopId;
  const secretKey = env.yookassaSecretKey;
  const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

  const url = `https://api.yookassa.ru/v3${path}`;

  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  };
  if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;

  const res = await fetch(url, {
    method,
    headers,
    body: jsonBody ? JSON.stringify(jsonBody) : undefined
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    const msg = (data && (data.message || data.description)) || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function safeOrderId(orderId) {
  const s = String(orderId || '').trim();
  if (!s) return null;
  return s;
}

function makeIdempotenceKey() {
  // YooKassa Idempotence-Key max length is 38 chars.
  return crypto.randomUUID();
}

async function verifyAndUpdateOrderFromYooKassa({ orderId, paymentId }) {
  const normalizedOrderId = safeOrderId(orderId);
  if (!normalizedOrderId) return null;

  const order = await prisma.order.findUnique({
    where: { id: normalizedOrderId },
    include: { payment: true }
  });
  if (!order) return null;

  if (!paymentId && order.payment && order.payment.providerPaymentId) {
    paymentId = order.payment.providerPaymentId;
  }
  if (!paymentId) return order;

  const payment = await yookassaRequest({
    method: 'GET',
    path: `/payments/${encodeURIComponent(paymentId)}`
  });

  // Extra security: confirm that the payment is really tied to this order.
  const metaOrderId = payment && payment.metadata && payment.metadata.orderId
    ? String(payment.metadata.orderId)
    : null;

  dbg('yookassa.verify.payment_status', {
    paymentId,
    status: payment && payment.status,
    metadataOrderId: metaOrderId,
    expectedOrderId: normalizedOrderId
  });

  if (metaOrderId && metaOrderId !== normalizedOrderId) {
    dbg('yookassa.verify.metadata_mismatch', {
      paymentId,
      metadataOrderId: metaOrderId,
      expectedOrderId: normalizedOrderId
    });
    return order;
  }

  // YooKassa payment statuses: succeeded / canceled / waiting_for_capture ...
  const status = payment && payment.status;
  const nextPaymentStatus = status === 'succeeded' ? 'Succeeded' : status === 'canceled' ? 'Canceled' : 'Pending';
  const nextOrderStatus = status === 'succeeded' ? 'New' : status === 'canceled' ? 'Cancelled' : 'PendingPayment';

  // Ensure payment row exists and is linked to the order.
  const amountValue = payment && payment.amount && payment.amount.value ? Number(payment.amount.value) : Number(order.totalAmount);
  const currency = payment && payment.amount && payment.amount.currency ? String(payment.amount.currency) : order.currency;

  const existingPayment = await prisma.payment.findUnique({
    where: { providerPaymentId: paymentId }
  });

  if (!existingPayment) {
    await prisma.payment.create({
      data: {
        provider: 'YooKassa',
        status: nextPaymentStatus,
        orderId: order.id,
        providerPaymentId: paymentId,
        confirmationUrl: order.payment ? order.payment.confirmationUrl : null,
        amount: amountValue,
        currency: currency || 'RUB'
      }
    });
  } else {
    await prisma.payment.update({
      where: { id: existingPayment.id },
      data: { status: nextPaymentStatus, updatedAt: new Date() }
    });
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { status: nextOrderStatus, updatedAt: new Date() }
  });

  return await prisma.order.findUnique({ where: { id: order.id }, include: { payment: true } });
}

const { startAutoApproveTimer } = registerCancellationRoutes(app, {
  prisma,
  env,
  csrfProtection,
  getSessionUserId,
  mapOrderStatusToApi,
  yookassaRequest,
  createMailer,
  rateLimit,
  publicDir: PUBLIC_DIR
});

// Create YooKassa payment and return redirect confirmation URL
const paymentCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
});

// Webhook can retry; allow a higher limit than payment creation
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false
});

app.post('/api/payments/yookassa/create', paymentCreateLimiter, csrfProtection, async (req, res) => {
  try {
    const { orderId, paymentMethod = null, idempotencyKey = null } = req.body || {};
    const normalizedOrderId = safeOrderId(orderId);
    if (!normalizedOrderId) return res.status(400).json({ success: false, error: 'Некорректный orderId' });

    const order = await prisma.order.findUnique({ where: { id: normalizedOrderId }, include: { payment: true } });
    if (!order) return res.status(404).json({ success: false, error: 'Заказ не найден' });

    // YooKassa configuration
    const currency = env.yookassaCurrency || 'RUB';
    const publicBaseUrl = env.publicBaseUrl;
    const returnUrl = `${publicBaseUrl}/payment/yookassa/return?orderId=${encodeURIComponent(normalizedOrderId)}`;

    // Idempotence key:
    // - If caller provides one => use it (allows safe retry).
    // - Otherwise generate a unique one to avoid "used within past 24h" errors.
    const stableKey = idempotencyKey || makeIdempotenceKey(`order_${normalizedOrderId}`);

    // Idempotency on our side: return existing confirmation if we already created payment for this order.
    if (order.payment && order.payment.confirmationUrl && order.payment.providerPaymentId) {
      return res.status(200).json({
        success: true,
        orderId: normalizedOrderId,
        paymentId: order.payment.providerPaymentId,
        confirmationUrl: order.payment.confirmationUrl
      });
    }

    // Create payment (redirect)
    const amountValue = Number(order.totalAmount);
    const amount = {
      currency,
      value: amountValue.toFixed(2)
    };

    const payload = {
      amount,
      description: `BRODSKY order #${normalizedOrderId}`,
      metadata: { orderId: normalizedOrderId },
      confirmation: {
        type: 'redirect',
        return_url: returnUrl
      }
    };

    dbg('yookassa.create.request', {
      orderId: normalizedOrderId,
      amountValue,
      currency,
      returnUrl,
      idempotenceKey: stableKey
    });

    const data = await yookassaRequest({
      method: 'POST',
      path: '/payments',
      jsonBody: payload,
      idempotenceKey: stableKey
    });

    dbg('yookassa.create.response', {
      id: data && data.id,
      status: data && data.status,
      confirmationUrl: data && data.confirmation && data.confirmation.confirmation_url,
      confirmationType: data && data.confirmation && data.confirmation.type
    });

    const confirmationUrl =
      data &&
      data.confirmation &&
      data.confirmation.confirmation_url;

    if (!data || !data.id || !confirmationUrl) {
      return res.status(500).json({ success: false, error: 'YooKassa вернул некорректный ответ' });
    }

    await prisma.payment.create({
      data: {
        provider: 'YooKassa',
        status: 'Pending',
        orderId: order.id,
        providerPaymentId: data.id,
        confirmationUrl,
        amount: amountValue,
        currency
      }
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'PendingPayment', updatedAt: new Date() }
    });

    res.status(200).json({
      success: true,
      orderId: normalizedOrderId,
      paymentId: data.id,
      confirmationUrl
    });
  } catch (err) {
    console.error('Ошибка /api/payments/yookassa/create:', err);
    dbg('yookassa.create.error', {
      message: err && err.message,
      status: err && err.status,
      data: err && err.data
    });
    res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка сервера' });
  }
});

// Redirect return handler (success/failure page)
app.get('/payment/yookassa/return', async (req, res) => {
  try {
    const orderId = req.query.orderId || '';
    const paymentId = req.query.payment_id || req.query.paymentId || req.query.payment_id;

    const order = await verifyAndUpdateOrderFromYooKassa({ orderId, paymentId });

    const status = order && order.status;
    const title = status === 'new'
      ? 'Оплата прошла успешно'
      : status === 'cancelled'
        ? 'Оплата не прошла (отменена)'
        : 'Оплата ожидает подтверждения';

    const message = status === 'new'
      ? 'Спасибо! Заказ готов к обработке сотрудниками.'
      : status === 'cancelled'
        ? 'Попробуйте оформить оплату снова.'
        : 'Мы проверим статус оплаты. Вы можете вернуться на главную страницу.';

    const backLink = env.publicBaseUrl ? `${env.publicBaseUrl}/` : '/';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YooKassa payment result</title>
</head><body style="font-family:Arial, sans-serif; padding:24px;">
  <h2>${title}</h2>
  <p>${message}</p>
  <p><a href="${backLink}">Вернуться на меню</a></p>
</body></html>`);
  } catch (err) {
    console.error('Ошибка /payment/yookassa/return:', err);
    res.status(500).send('Payment return error');
  }
});

// YooKassa webhook notification handler
app.post('/api/payments/yookassa/webhook', webhookLimiter, async (req, res) => {
  try {
    // Security: allow only YooKassa notification IPs
    const ip = getClientIp(req);
    dbg('yookassa.webhook.incoming', {
      ip,
      forwardedFor: req.headers['x-forwarded-for'] || null
    });
    if (!isAllowedNotificationIp(ip)) {
      dbg('yookassa.webhook.blocked_ip', { ip });
      return res.status(401).send('Unauthorized');
    }

    const body = req.body || {};
    const event = body.event;
    const object = body.object || {};
    const paymentId = object.id;
    const orderId = object.metadata && object.metadata.orderId ? String(object.metadata.orderId) : null;

    dbg('yookassa.webhook.payload_meta', { event, paymentId, orderId });

    if (!event || !paymentId || !orderId) {
      // Still acknowledge to prevent retries.
      return res.status(200).send('OK');
    }

    // Idempotency in DB: check FIRST by dedupeKey.
    const dedupeKey = `yk:${event}:${paymentId}`;
    const seen = await prisma.webhookEvent.findUnique({ where: { dedupeKey } });
    if (seen) {
      dbg('yookassa.webhook.dedupe_hit', { dedupeKey });
      return res.status(200).send('OK');
    }

    // Verify status with YooKassa API (object status authentication).
    const verified = await verifyAndUpdateOrderFromYooKassa({ orderId, paymentId });
    if (!verified) return res.status(200).send('OK');

    dbg('yookassa.webhook.verified', {
      orderId,
      paymentId,
      orderStatus: verified && verified.status
    });

    // Persist idempotency key ONLY after successful verification/update.
    const paymentRow = await prisma.payment.findUnique({ where: { providerPaymentId: paymentId } });
    if (paymentRow) {
      await prisma.webhookEvent.create({
        data: {
          provider: 'YooKassa',
          event: String(event),
          paymentId: paymentRow.id,
          dedupeKey,
          payload: body
        }
      });
    }

    // For extra idempotency, only act on succeeded/canceled. Others keep 'pending'.
    if (event === 'payment.succeeded') {
      // verify function already set to new
      console.log(`Webhook payment.succeeded: order ${orderId}`);
    } else if (event === 'payment.canceled') {
      console.log(`Webhook payment.canceled: order ${orderId}`);
    } else {
      // keep pending
      console.log(`Webhook event ${event}: order ${orderId}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Ошибка /api/payments/yookassa/webhook:', err);
    // Still acknowledge in order not to spam retries indefinitely.
    res.status(200).send('OK');
  }
});

app.post('/api/reservations', csrfProtection, async (req, res) => {
  try {
    const { name, phone, date, time, guests, comment } = req.body || {};

    const trimmedName = String(name || '').trim();
    const trimmedPhone = String(phone || '').trim();
    const trimmedDate = String(date || '').trim();
    const trimmedTime = String(time || '').trim();
    const guestsNumber = Number(guests);

    if (!trimmedName || !trimmedPhone || !trimmedDate || !trimmedTime || !guestsNumber) {
    return res.status(400).json({ success: false, error: 'Заполните все обязательные поля' });
  }

    if (guestsNumber <= 0 || guestsNumber > 50) {
      return res.status(400).json({ success: false, error: 'Количество гостей должно быть от 1 до 50' });
    }

    const startAt = parseIsoDate(`${trimmedDate}T${trimmedTime}:00`);
    if (!startAt) {
      return res.status(400).json({ success: false, error: 'Некорректная дата/время' });
    }

    const userId = getSessionUserId(req);

    const reservation = await prisma.reservation.create({
      data: {
        userId: userId || null,
        status: 'Pending',
        name: trimmedName,
        phone: trimmedPhone,
        startAt,
        guests: guestsNumber,
        comment: String(comment || '').trim() || null,
        // createdAt/updatedAt handled by Prisma defaults
      }
    });

    res.status(200).json({ success: true, reservationId: reservation.id });
  } catch (err) {
    console.error('Ошибка при создании бронирования:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/reservations', async (req, res) => {
  try {
    const { status, from, to, sort = 'desc', limit, q } = req.query || {};
    const orderBy = sort === 'asc' ? { createdAt: 'asc' } : { createdAt: 'desc' };
    const take = (() => {
      const n = parseInt(String(limit || ''), 10);
      return Number.isFinite(n) && n > 0 && n <= 500 ? n : 200;
    })();

    const where = {};
  if (status) {
      const mapped = mapApiStatusToReservationStatus(status);
      if (mapped) where.status = mapped;
    }

    const createdAt = {};
    const fromDate = from ? parseIsoDate(from) : null;
    const toDate = to ? parseIsoDate(to) : null;
    if (fromDate) createdAt.gte = fromDate;
    if (toDate) createdAt.lte = toDate;
    if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

    if (q) {
      const term = String(q);
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
        { comment: { contains: term, mode: 'insensitive' } }
      ];
    }

    const rows = await prisma.reservation.findMany({ where, orderBy, take });
    const reservations = rows.map((r) => ({
      reservationId: r.id,
      name: r.name,
      phone: r.phone,
      date: r.startAt.toISOString().slice(0, 10),
      time: r.startAt.toISOString().slice(11, 16),
      guests: r.guests,
      comment: r.comment || undefined,
      createdAt: r.createdAt.toISOString(),
      status: mapReservationStatusToApi(r.status)
    }));

    res.json({ reservations });
  } catch (err) {
    console.error('Ошибка при получении бронирований:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.patch('/api/reservations/:reservationId', csrfProtection, async (req, res) => {
  try {
  const { reservationId } = req.params;
    const { status } = req.body || {};
    const next = mapApiStatusToReservationStatus(status);
    if (!next) return res.status(400).json({ success: false, error: 'Некорректный статус' });

    const existing = await prisma.reservation.findUnique({ where: { id: String(reservationId) } });
    if (!existing) return res.status(404).json({ success: false, error: 'Бронирование не найдено' });

    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: { status: next, updatedAt: new Date() }
    });

    res.json({
      success: true,
      reservation: {
        reservationId: updated.id,
        status: mapReservationStatusToApi(updated.status)
      }
    });
  } catch (err) {
    console.error('Ошибка обновления статуса бронирования:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Health-check для мониторинга
app.get('/api/health', (req, res) => {
  Promise.all([prisma.order.count(), prisma.reservation.count()])
    .then(([ordersCount, reservationsCount]) => {
      res.json({
        status: 'ok',
        time: new Date().toISOString(),
        ordersCount,
        reservationsCount
      });
    })
    .catch(() => {
      res.json({ status: 'ok', time: new Date().toISOString() });
    });
});

async function start() {
  await ensureDefaultTables();
  if (env.trustProxy) {
    // Required when running behind ngrok / reverse proxy for correct client IP detection.
    app.set('trust proxy', 1);
  }
  // Phase 1 stability: wait for DB with retries so Render restarts cleanly.
  async function waitForDb() {
    const delays = [250, 750, 1750];
    let lastErr = null;
    for (let i = 0; i < delays.length; i++) {
      try {
        await pgPool.query('SELECT 1');
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
    throw lastErr || new Error('DB unavailable');
  }
  await waitForDb();
  startAutoApproveTimer();
app.listen(PORT, () => {
  console.log(`Server running on port: ${PORT}`);
  console.log(`Environment: ${env.nodeEnv}`);
  console.log('Сервер BRODSKY. запущен: http://localhost:' + PORT);
  console.log('  Меню для гостей:     http://localhost:' + PORT + '/');
  console.log('  Заказы для персонала: http://localhost:' + PORT + '/staff-orders.html');
  console.log('  Панель менеджера:    http://localhost:' + PORT + '/manager.html');
  console.log('  POST /api/orders — принять заказ');
  console.log('  GET  /api/orders — список заказов');
  console.log('  POST /api/reservations — принять бронирование');
  console.log('  GET  /api/reservations — список бронирований');
  });
}

start().catch((err) => {
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  try {
    await pgPool.end();
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
});

// CSRF errors MUST be handled after routes (earlier handlers are never reached).
app.use((err, req, res, next) => {
  if (err && (err.code === 'EBADCSRFTOKEN' || err.code === 'EBADCSRF')) {
    return res.status(403).json({
      success: false,
      error: 'CSRF token invalid or missing'
    });
  }
  return next(err);
});

// Global error handler (must be last). Prevents default HTML error pages.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-unused-vars
  const _ = next;
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal Server Error' });
});
