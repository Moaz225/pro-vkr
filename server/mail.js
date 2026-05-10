const nodemailer = require('nodemailer');

function createMailer(env) {
  const configured = Boolean(env.smtpHost && env.mailFrom);

  if (!configured) {
    return {
      isConfigured: false,
      async sendMail(opts) {
        console.warn('[mail] SMTP not configured, skipping email:', opts && opts.subject);
        return { skipped: true };
      }
    };
  }

  const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined
  });

  return {
    isConfigured: true,
    async sendMail({ to, subject, text, html, attachments }) {
      await transporter.sendMail({
        from: env.mailFrom,
        to,
        subject,
        text,
        html,
        attachments
      });
    }
  };
}

module.exports = { createMailer };
