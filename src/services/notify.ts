import { env } from "../config/env";
import { ccDb } from "../config/db";

type NotificationType = "apply_complete" | "alert" | "status_change" | "digest";

async function logNotification(params: {
  userId: string;
  type: NotificationType;
  channel: "email" | "sms";
  recipient: string;
  subject?: string;
  success: boolean;
  error?: string;
}) {
  await ccDb.query(
    `INSERT INTO cc_notification_logs (user_id, type, channel, recipient, subject, success, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [params.userId, params.type, params.channel, params.recipient, params.subject ?? null, params.success, params.error ?? null]
  );
}

export async function sendEmail(params: {
  userId: string;
  type: NotificationType;
  to: string;
  subject: string;
  html: string;
}) {
  if (!env.RESEND_API_KEY) {
    console.warn("[notify] RESEND_API_KEY not set — skipping email, logging as failed");
    await logNotification({
      userId: params.userId,
      type: params.type,
      channel: "email",
      recipient: params.to,
      subject: params.subject,
      success: false,
      error: "RESEND_API_KEY not configured",
    });
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Career Copilot <notifications@careercopilot.app>",
        to: params.to,
        subject: params.subject,
        html: params.html,
      }),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    await logNotification({ userId: params.userId, type: params.type, channel: "email", recipient: params.to, subject: params.subject, success: true });
  } catch (err: any) {
    console.error("[notify] email send failed:", err);
    await logNotification({ userId: params.userId, type: params.type, channel: "email", recipient: params.to, subject: params.subject, success: false, error: String(err?.message ?? err) });
  }
}

export async function sendSms(params: { userId: string; type: NotificationType; to: string; body: string }) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.warn("[notify] Twilio not configured — skipping SMS, logging as failed");
    await logNotification({ userId: params.userId, type: params.type, channel: "sms", recipient: params.to, success: false, error: "Twilio not configured" });
    return;
  }

  try {
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: env.TWILIO_PHONE_NUMBER, To: params.to, Body: params.body }),
    });
    if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
    await logNotification({ userId: params.userId, type: params.type, channel: "sms", recipient: params.to, success: true });
  } catch (err: any) {
    console.error("[notify] sms send failed:", err);
    await logNotification({ userId: params.userId, type: params.type, channel: "sms", recipient: params.to, success: false, error: String(err?.message ?? err) });
  }
}
