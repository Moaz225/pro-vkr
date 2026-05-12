const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const CANCEL_REASONS = [
  'DELAY_OVER_30_MIN',
  'WRONG_ORDER',
  'PRODUCT_UNAVAILABLE',
  'CUSTOMER_CHANGED_MIND',
  'BAD_QUALITY',
  'EMERGENCY',
  'RESTAURANT_CLOSED'
];

const PROOF_REQUIRED = new Set(['BAD_QUALITY', 'EMERGENCY']);

function mapCancelStatusToApi(s) {
  if (!s) return null;
  const v = String(s);
  if (v === 'Pending') return 'pending';
  if (v === 'Approved') return 'approved';
  if (v === 'Rejected') return 'rejected';
  if (v === 'AutoApproved') return 'auto_approved';
  return null;
}

function refundIdempotenceKey(orderId) {
  return crypto.createHash('sha256').update(`refund:${orderId}`).digest('hex').slice(0, 36);
}

function orderToMeOrderDto(o, mapOrderStatusToApi) {
  return {
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
          confirmationUrl: o.payment.confirmationUrl || undefined,
          paymentStatus: o.payment.status
        }
      : null,
    cancellation: {
      reason: o.cancelReason || null,
      description: o.cancelDescription || null,
      proofPath: o.cancelProofPath || null,
      status: mapCancelStatusToApi(o.cancelStatus),
      requestedAt: o.cancelRequestedAt ? o.cancelRequestedAt.toISOString() : null,
      reviewedAt: o.cancelReviewedAt ? o.cancelReviewedAt.toISOString() : null,
      rejectionReason: o.cancelRejectionReason || null,
      autoApproveAt: o.cancelAutoApproveAt ? o.cancelAutoApproveAt.toISOString() : null,
      yookassaRefundId: o.yookassaRefundId || null
    }
  };
}

function registerCancellationRoutes(app, deps) {
  const {
    prisma,
    env,
    csrfProtection,
    getSessionUserId,
    mapOrderStatusToApi,
    yookassaRequest,
    createMailer,
    rateLimit,
    publicDir
  } = deps;

  const mailer = createMailer(env);

  const cancelLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false
  });

  const uploadsDir = path.join(publicDir, 'public', 'uploads', 'cancellations');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
      const safeExt = allowed.includes(ext) ? ext : '';
      cb(null, crypto.randomBytes(16).toString('hex') + (safeExt || '.bin'));
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
      if (!ok) return cb(new Error('INVALID_FILE_TYPE'));
      cb(null, true);
    }
  });

  function uploadProofMiddleware(req, res, next) {
    upload.single('proof')(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'Файл слишком большой (макс. 2 МБ)' });
      }
      if (err && err.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ success: false, error: 'Недопустимый тип файла' });
      }
      console.error('[multer] upload error:', err);
      return res.status(400).json({ success: false, error: 'Ошибка загрузки файла' });
    });
  }

  async function loadManager(userId) {
    if (!userId) return null;
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.role !== 'Manager') return null;
    return u;
  }

  async function sendCustomerEmail(userEmail, subject, text, html, attachments) {
    if (!userEmail) return;
    try {
      await mailer.sendMail({ to: userEmail, subject, text, html, attachments });
    } catch (e) {
      console.error('[mail] customer email failed:', e.message);
    }
  }

  async function notifyManager(subject, text) {
    const to = env.mailToManager;
    if (!to || !mailer.isConfigured) return;
    try {
      await mailer.sendMail({ to, subject, text, html: `<pre>${text}</pre>` });
    } catch (e) {
      console.error('[mail] manager email failed:', e.message);
    }
  }

  async function performApprove(orderId, via) {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { payment: true, user: true, items: true }
      });
      if (!order) return { type: 'not_found' };
      if (order.cancelStatus !== 'Pending') {
        return { type: 'noop', order };
      }

      let refundId = order.yookassaRefundId || null;
      if (!refundId && order.payment && order.payment.status === 'Succeeded' && order.payment.providerPaymentId) {
        const amountValue = Number(order.totalAmount);
        const currency = order.payment.currency || env.yookassaCurrency || 'RUB';
        const body = {
          payment_id: order.payment.providerPaymentId,
          amount: { value: amountValue.toFixed(2), currency }
        };
        const data = await yookassaRequest({
          method: 'POST',
          path: '/refunds',
          jsonBody: body,
          idempotenceKey: refundIdempotenceKey(order.id)
        });
        refundId = data && data.id ? String(data.id) : null;
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          cancelStatus: via === 'auto' ? 'AutoApproved' : 'Approved',
          cancelReviewedAt: new Date(),
          cancelAutoApproveAt: null,
          status: 'Cancelled',
          yookassaRefundId: refundId,
          updatedAt: new Date()
        }
      });

      if (order.payment && order.payment.status === 'Succeeded' && refundId) {
        await tx.payment.update({
          where: { orderId },
          data: { status: 'Canceled', updatedAt: new Date() }
        });
      }

      const updated = await tx.order.findUnique({
        where: { id: orderId },
        include: { payment: true, user: true, items: true }
      });
      return { type: 'ok', order: updated, refundId };
    });

    if (result.type === 'not_found') return result;
    if (result.type === 'noop') return result;

    const o = result.order;
    const proofLink = o.cancelProofPath ? `${env.publicBaseUrl}${o.cancelProofPath}` : null;
    const refundLine = result.refundId ? `Refund ID: ${result.refundId}` : 'No card refund (cash or unpaid).';
    await sendCustomerEmail(
      o.user && o.user.email,
      'BRODSKY — cancellation approved',
      `Your cancellation for order ${o.id} was approved.\n${refundLine}\n`,
      `<p>Your cancellation for order <strong>${o.id}</strong> was approved.</p><p>${refundLine}</p>${
        proofLink ? `<p>Proof: <a href="${proofLink}">${proofLink}</a></p>` : ''
      }`
    );

    return result;
  }

  app.get('/api/me/orders', async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Не авторизовано' });
      }
      const rows = await prisma.order.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { items: true, payment: true }
      });
      res.json({
        success: true,
        orders: rows.map((o) => orderToMeOrderDto(o, mapOrderStatusToApi))
      });
    } catch (err) {
      console.error('GET /api/me/orders:', err);
      res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
  });

  app.post(
    '/api/orders/:id/cancel',
    cancelLimiter,
    csrfProtection,
    uploadProofMiddleware,
    async (req, res) => {
      try {
        const userId = getSessionUserId(req);
        if (!userId) {
          return res.status(401).json({ success: false, error: 'Не авторизовано' });
        }
        const orderId = String(req.params.id || '');
        const reason = String(req.body.reason || '').trim();
        const description = String(req.body.description || '').trim();

        if (!CANCEL_REASONS.includes(reason)) {
          return res.status(400).json({ success: false, error: 'Некорректная причина отмены' });
        }

        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { user: true }
        });
        if (!order || order.userId !== userId) {
          return res.status(404).json({ success: false, error: 'Заказ не найден' });
        }

        const cancellable = ['PendingPayment', 'New', 'InProgress'].includes(order.status);
        if (!cancellable) {
          return res.status(400).json({ success: false, error: 'Этот заказ нельзя отменить' });
        }
        if (order.cancelStatus === 'Pending') {
          return res.status(400).json({ success: false, error: 'Запрос на отмену уже отправлен' });
        }
        if (order.cancelStatus && ['Approved', 'AutoApproved'].includes(order.cancelStatus)) {
          return res.status(400).json({ success: false, error: 'Отмена уже обработана' });
        }

        const needProof = PROOF_REQUIRED.has(reason);
        let proofPath = null;
        if (needProof) {
          if (!req.file) {
            return res.status(400).json({ success: false, error: 'Требуется файл подтверждения' });
          }
          proofPath = `/uploads/cancellations/${req.file.filename}`;
        } else if (req.file) {
          proofPath = `/uploads/cancellations/${req.file.filename}`;
        }

        const autoAt = new Date(Date.now() + 15 * 60 * 1000);
        await prisma.order.update({
          where: { id: orderId },
          data: {
            cancelReason: reason,
            cancelDescription: description || null,
            cancelProofPath: proofPath,
            cancelStatus: 'Pending',
            cancelRequestedAt: new Date(),
            cancelAutoApproveAt: autoAt,
            cancelRejectionReason: null,
            cancelReviewedAt: null,
            updatedAt: new Date()
          }
        });

        const proofLink = proofPath ? `${env.publicBaseUrl}${proofPath}` : null;
        await sendCustomerEmail(
          order.user && order.user.email,
          'BRODSKY — cancellation request received',
          `We received your cancellation request for order ${orderId}. Reason: ${reason}. It will be reviewed within 15 minutes.`,
          `<p>We received your cancellation request for order <strong>${orderId}</strong>.</p><p>Reason: <code>${reason}</code></p><p>Review within 15 minutes (auto-approve may apply).</p>${
            proofLink ? `<p>Proof: <a href="${proofLink}">${proofLink}</a></p>` : ''
          }`
        );

        await notifyManager(
          `BRODSKY cancellation pending: ${orderId}`,
          `Order ${orderId}\nCustomer: ${order.user ? order.user.email : userId}\nReason: ${reason}\nDescription: ${description}\nProof: ${proofLink || 'none'}`
        );

        res.json({ success: true, orderId, cancelStatus: 'pending', autoApproveAt: autoAt.toISOString() });
      } catch (err) {
        console.error('POST /api/orders/:id/cancel:', err);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
      }
    }
  );

  app.post(
    '/api/orders/:id/cancel-proof',
    cancelLimiter,
    csrfProtection,
    uploadProofMiddleware,
    async (req, res) => {
      try {
        const userId = getSessionUserId(req);
        if (!userId) {
          return res.status(401).json({ success: false, error: 'Не авторизовано' });
        }
        if (!req.file) {
          return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }
        const orderId = String(req.params.id || '');
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (!order || order.userId !== userId) {
          return res.status(404).json({ success: false, error: 'Заказ не найден' });
        }
        if (order.cancelStatus !== 'Pending') {
          return res.status(400).json({ success: false, error: 'Нет активного запроса на отмену' });
        }
        if (!order.cancelReason || !PROOF_REQUIRED.has(order.cancelReason)) {
          return res.status(400).json({ success: false, error: 'Доказательство не требуется для этой причины' });
        }
        if (order.cancelProofPath) {
          return res.status(400).json({ success: false, error: 'Доказательство уже загружено' });
        }
        const proofPath = `/uploads/cancellations/${req.file.filename}`;
        await prisma.order.update({
          where: { id: orderId },
          data: { cancelProofPath: proofPath, updatedAt: new Date() }
        });
        res.json({ success: true, proofPath });
      } catch (err) {
        console.error('POST /api/orders/:id/cancel-proof:', err);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
      }
    }
  );

  app.get('/api/cancellations/pending', async (req, res) => {
    try {
      const rows = await prisma.order.findMany({
        where: { cancelStatus: 'Pending' },
        orderBy: { cancelRequestedAt: 'asc' },
        include: { user: true, items: true, payment: true }
      });
      res.json({
        success: true,
        cancellations: rows.map((o) => ({
          orderId: o.id,
          customerName: o.user ? o.user.name : '—',
          customerEmail: o.user ? o.user.email : '—',
          reason: o.cancelReason,
          description: o.cancelDescription || '',
          proofPath: o.cancelProofPath || null,
          requestedAt: o.cancelRequestedAt ? o.cancelRequestedAt.toISOString() : null,
          autoApproveAt: o.cancelAutoApproveAt ? o.cancelAutoApproveAt.toISOString() : null,
          orderStatus: mapOrderStatusToApi(o.status),
          total: Number(o.totalAmount)
        }))
      });
    } catch (err) {
      console.error('GET /api/cancellations/pending:', err);
      res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
  });

  app.post('/api/cancellations/:orderId/approve', cancelLimiter, csrfProtection, async (req, res) => {
    try {
      const orderId = String(req.params.orderId || '');
      const out = await performApprove(orderId, 'manager');
      if (out.type === 'not_found') {
        return res.status(404).json({ success: false, error: 'Заказ не найден' });
      }
      if (out.type === 'noop') {
        return res.json({ success: true, message: 'Already processed', orderId });
      }
      res.json({
        success: true,
        orderId,
        cancelStatus: mapCancelStatusToApi(out.order.cancelStatus),
        refundId: out.refundId || null
      });
    } catch (err) {
      console.error('POST /api/cancellations/:orderId/approve:', err);
      const msg = err && err.message ? err.message : 'Refund failed';
      res.status(400).json({ success: false, error: msg });
    }
  });

  app.post('/api/cancellations/:orderId/reject', cancelLimiter, csrfProtection, async (req, res) => {
    try {
      const orderId = String(req.params.orderId || '');
      const rejectionReason = String(req.body.rejectionReason || '').trim();
      if (!rejectionReason) {
        return res.status(400).json({ success: false, error: 'Укажите причину отказа' });
      }

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { user: true }
      });
      if (!order) {
        return res.status(404).json({ success: false, error: 'Заказ не найден' });
      }
      if (order.cancelStatus !== 'Pending') {
        return res.status(400).json({ success: false, error: 'Нет активного запроса на отмену' });
      }

      await prisma.order.update({
        where: { id: orderId },
        data: {
          cancelStatus: 'Rejected',
          cancelRejectionReason: rejectionReason,
          cancelReviewedAt: new Date(),
          cancelAutoApproveAt: null,
          updatedAt: new Date()
        }
      });

      const proofLink = order.cancelProofPath ? `${env.publicBaseUrl}${order.cancelProofPath}` : null;
      await sendCustomerEmail(
        order.user && order.user.email,
        'BRODSKY — cancellation rejected',
        `Your cancellation for order ${orderId} was rejected. Reason: ${rejectionReason}`,
        `<p>Your cancellation for order <strong>${orderId}</strong> was rejected.</p><p><strong>Reason:</strong> ${rejectionReason}</p>${
          proofLink ? `<p>Proof you submitted: <a href="${proofLink}">${proofLink}</a></p>` : ''
        }`
      );

      res.json({ success: true, orderId, cancelStatus: 'rejected' });
    } catch (err) {
      console.error('POST /api/cancellations/:orderId/reject:', err);
      res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
  });

  function startAutoApproveTimer() {
    setInterval(async () => {
      try {
        const now = new Date();
        const due = await prisma.order.findMany({
          where: {
            cancelStatus: 'Pending',
            cancelAutoApproveAt: { lte: now }
          },
          select: { id: true }
        });
        for (const row of due) {
          try {
            await performApprove(row.id, 'auto');
          } catch (e) {
            console.error('[cancellation] auto-approve failed for', row.id, e.message);
          }
        }
      } catch (e) {
        console.error('[cancellation] auto-approve tick:', e.message);
      }
    }, 60 * 1000);
  }

  return { startAutoApproveTimer };
}

module.exports = {
  registerCancellationRoutes,
  CANCEL_REASONS
};
