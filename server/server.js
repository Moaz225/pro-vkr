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
const crypto = require('crypto');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');

const app = express();
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..');

// Базовая конфигурация CORS (можно ограничить через переменную окружения)
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

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
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// В упрощённой версии проекта столики не хранятся в БД,
// поэтому инициализация RestaurantTable не требуется.
async function ensureDefaultTables() {
  return;
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

async function getOrCreateGuestCustomer() {
  const guestEmail = 'guest@brodsky.local';
  const existing = await prisma.customer.findUnique({ where: { email: guestEmail } });
  if (existing) return existing;
  return await prisma.customer.create({
    data: {
      name: 'Guest',
      email: guestEmail,
      passwordHash: makePasswordHash(crypto.randomBytes(16).toString('hex')),
      phone: null,
      address: null
    }
  });
}

function parseId(param) {
  const n = parseInt(String(param), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

const sessions = new Map(); // token -> userId

// ===== АУТЕНТИФИКАЦИЯ =====

// Регистрация пользователя
app.post('/api/auth/register', async (req, res) => {
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

    const existing = await prisma.customer.findUnique({ where: { email: trimmedEmail } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Пользователь с таким email уже существует' });
    }

    const customer = await prisma.customer.create({
      data: {
        name: trimmedName,
        email: trimmedEmail,
        passwordHash: makePasswordHash(rawPassword),
        phone: null,
        address: null
      }
    });

    const token = generateToken();
    sessions.set(token, customer.id);

    res.json({
      success: true,
      token,
      user: { id: String(customer.id), name: customer.name, email: customer.email, role: 'user' }
    });
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Вход пользователя
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const trimmedEmail = String(email || '').trim().toLowerCase();
    const rawPassword = String(password || '');

    if (!trimmedEmail || !rawPassword) {
      return res.status(400).json({ success: false, error: 'Введите email и пароль' });
    }

    const customer = await prisma.customer.findUnique({ where: { email: trimmedEmail } });
    if (!customer || !verifyPasswordHash(rawPassword, customer.passwordHash)) {
      return res.status(401).json({ success: false, error: 'Неверный email или пароль' });
    }

    const token = generateToken();
    sessions.set(token, customer.id);

    res.json({
      success: true,
      token,
      user: { id: String(customer.id), name: customer.name, email: customer.email, role: 'user' }
    });
  } catch (err) {
    console.error('Ошибка входа:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Получить текущего пользователя по токену (опционально, для будущего использования)
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ success: false, error: 'Не авторизовано' });
  }
  const userId = sessions.get(token);
  prisma.customer
    .findUnique({ where: { id: userId } })
    .then((customer) => {
      if (!customer) {
        return res.status(401).json({ success: false, error: 'Не авторизовано' });
      }
      res.json({
        success: true,
        user: { id: String(customer.id), name: customer.name, email: customer.email, role: 'user' }
      });
    })
    .catch((err) => {
      console.error('Ошибка /api/auth/me:', err);
      res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    });
});

function filterAndSortByQuery(list, query) {
  let result = list.slice();
  const { status, from, to, sort = 'desc', limit, paymentMethod, q } = query;

  if (status) {
    result = result.filter((item) => item.status === status);
  }

  if (paymentMethod) {
    result = result.filter((item) => item.paymentMethod === paymentMethod);
  }

  if (q) {
    const term = String(q).toLowerCase();
    result = result.filter((item) => {
      const comment = (item.comment || '').toLowerCase();
      const names = Array.isArray(item.items)
        ? item.items.map(i => String(i.name || '').toLowerCase()).join(' ')
        : '';
      return comment.includes(term) || names.includes(term);
    });
  }

  if (from) {
    const fromDate = new Date(from);
    if (!isNaN(fromDate)) {
      result = result.filter((item) => new Date(item.createdAt) >= fromDate);
    }
  }

  if (to) {
    const toDate = new Date(to);
    if (!isNaN(toDate)) {
      result = result.filter((item) => new Date(item.createdAt) <= toDate);
    }
  }

  result.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (sort !== 'asc') {
    result.reverse();
  }

  const parsedLimit = parseInt(limit, 10);
  if (!isNaN(parsedLimit) && parsedLimit > 0) {
    result = result.slice(0, parsedLimit);
  }

  return result;
}

// для заказов больше не нужна маппинг-функция: memoryOrders уже в нужном формате

// Принять заказ (после оплаты на фронте)
const memoryOrders = [];

app.post('/api/orders', (req, res) => {
  const { items = [], paymentMethod = 'cash', comment = '', tableNumber } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Пустой заказ' });
  }

  const allowedMethods = ['visa', 'qr', 'cash'];
  if (!allowedMethods.includes(paymentMethod)) {
    return res.status(400).json({ success: false, error: 'Некорректный способ оплаты' });
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

  const computedTotal = normalizedItems.reduce((sum, i) => sum + i.price * i.qty, 0);

  const orderId = String(memoryOrders.length + 1);
  const order = {
    orderId,
    items: normalizedItems,
    total: computedTotal,
    paymentMethod,
    comment: String(comment || '').trim() || undefined,
    tableNumber: tableNumber ? String(tableNumber).trim() || undefined : undefined,
    createdAt: new Date().toISOString(),
    status: 'new'
  };

  memoryOrders.push(order);

  console.log('\n========== НОВЫЙ ЗАКАЗ ==========');
  console.log('Номер:', orderId);
  console.log('Оплата:', paymentMethod === 'visa' ? 'Visa' : paymentMethod === 'qr' ? 'QR-код' : 'Наличные');
  console.log('Сумма:', order.total + '₽');
  if (order.comment) console.log('Комментарий:', order.comment);
  console.log('Состав:');
  order.items.forEach(i => {
    console.log('  -', i.name, '×', i.qty, '—', i.price * i.qty + '₽');
  });
  console.log('====================================\n');

  res.status(200).json({ success: true, orderId });
});

// Список заказов (для работников / панели заказов)
app.get('/api/orders', (req, res) => {
  const list = filterAndSortByQuery(memoryOrders, req.query);
  res.json({ orders: list });
});

// Обновить статус заказа (для работников: в работу / готово)
app.patch('/api/orders/:orderId', (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};
  const order = memoryOrders.find(o => o.orderId === String(orderId));
  if (!order) {
    return res.status(404).json({ success: false, error: 'Заказ не найден' });
  }
  if (['new', 'in_progress', 'done'].includes(status)) {
    order.status = status;
  }
  res.json({ success: true, order });
});

// ===== РЕЗЕРВИРОВАНИЯ (in-memory, без БД) =====

const memoryReservations = [];

// Принять бронирование столика
app.post('/api/reservations', (req, res) => {
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

  const reservationId = String(memoryReservations.length + 1);
  const reservation = {
    reservationId,
    name: trimmedName,
    phone: trimmedPhone,
    date: trimmedDate,
    time: trimmedTime,
    guests: guestsNumber || 2,
    comment: String(comment || '').trim() || undefined,
    createdAt: new Date().toISOString(),
    status: 'pending'
  };

  memoryReservations.push(reservation);

  console.log('\n========== НОВОЕ БРОНИРОВАНИЕ ==========');
  console.log('Номер:', reservationId);
  console.log('Имя:', reservation.name);
  console.log('Телефон:', reservation.phone);
  console.log('Дата:', reservation.date);
  console.log('Время:', reservation.time);
  console.log('Гостей:', reservation.guests);
  if (reservation.comment) console.log('Пожелания:', reservation.comment);
  console.log('========================================\n');

  res.status(200).json({ success: true, reservationId });
});

// Список бронирований (для менеджера и персонала)
app.get('/api/reservations', (req, res) => {
  const list = filterAndSortByQuery(memoryReservations, req.query);
  res.json({ reservations: list });
});

// Обновить статус бронирования
app.patch('/api/reservations/:reservationId', (req, res) => {
  const { reservationId } = req.params;
  const { status } = req.body || {};
  const reservation = memoryReservations.find(r => r.reservationId === String(reservationId));
  if (!reservation) {
    return res.status(404).json({ success: false, error: 'Бронирование не найдено' });
  }
  if (['pending', 'confirmed', 'cancelled'].includes(status)) {
    reservation.status = status;
  }
  res.json({ success: true, reservation });
});

// Health-check для мониторинга
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    ordersCount: memoryOrders.length,
    reservationsCount: memoryReservations.length
  });
});

async function start() {
  await ensureDefaultTables();
app.listen(PORT, () => {
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
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
});
