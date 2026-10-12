export function buildEmail({ name, company, notes, email, unsubscribeUrl }) {
  const firstName = (name || 'there').split(' ')[0];

  const observation = notes
    ? notes
    : company
      ? `I was looking at ${company}'s site`
      : `I came across your work`;

  const subject = company
    ? `Quick question about ${company}`
    : `Quick question about your site`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#111;max-width:560px;">
  <p>Hey ${firstName},</p>
  <p>${observation} and noticed a few things that could be improved — especially around speed, mobile experience, and conversion.</p>
  <p>I build clean, fast websites for people who want something that actually converts. Would you be open to a short chat this week?</p>
  <p style="margin-top:24px;">– Your Name<br><span style="color:#555;font-size:14px;">Web Developer</span></p>
  <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;">
  <p style="font-size:12px;color:#888;">
    <a href="${unsubscribeUrl}" style="color:#888;">Unsubscribe</a> · 
    You received this because I thought there might be a fit.
  </p>
</body>
</html>`;

  const text = `Hey ${firstName},

${observation} and noticed a few things that could be improved — especially around speed, mobile experience, and conversion.

I build clean, fast websites for people who want something that actually converts. Would you be open to a short chat this week?

– Your Name
Web Developer

Unsubscribe: ${unsubscribeUrl}`;

  return { subject, html, text };
}
