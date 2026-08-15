// POST /api/stripe-webhook
// Called automatically by Stripe when subscription events happen.
// This must receive the RAW request body (not parsed JSON) to verify the
// signature, so we disable Vercel's automatic body parsing for this file.

import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// How old a signed payload is allowed to be before we reject it, even if
// the signature itself is otherwise valid. Without this, a captured
// request (leaked logs, a compromised proxy, etc.) could be replayed
// indefinitely to re-trigger subscription activation.
const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutes, same default Stripe's own SDK uses

// Manual Stripe signature verification (no SDK dependency needed).
function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("="))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  // Reject stale signatures — closes off replay attacks even when the
  // signature itself checks out.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Same email pattern already used in forgot-password.js — reusing it
// directly rather than introducing a second way of sending mail.
const FROM_ADDRESS = "outtoeat <bookings@outtoeat.com.au>";
const PORTAL_URL = "https://restaurant-portal-seven.vercel.app";

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("RESEND_API_KEY missing — skipping email send");
    return;
  }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}

// Sent once, right when a subscription activates. Combines two things
// that used to risk being two separate emails at the same moment: a
// straightforward confirmation of what they just subscribed to (plan,
// price, billing status — the receipt-style reassurance people expect),
// and a nudge toward the two things that matter most right after
// subscribing — setting up their profile, and grabbing the embeddable
// badge for their own site (a genuine backlink to outtoeat, and free
// exposure for them).
async function sendSubscriptionConfirmationEmail({ ownerEmail, restaurantName }) {
  await sendEmail({
    to: ownerEmail,
    subject: "Your outtoeat subscription is confirmed ✅",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#DE3937;">You're subscribed, ${restaurantName}!</h2>
        <p>This confirms your outtoeat subscription is now <strong>active</strong> and your listing can accept bookings.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
          <tr>
            <td style="padding:6px 0;color:#666;">Plan</td>
            <td style="padding:6px 0;text-align:right;font-weight:600;">$29/month</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#666;">Status</td>
            <td style="padding:6px 0;text-align:right;font-weight:600;color:#4F8A5B;">Active</td>
          </tr>
        </table>
        <p style="color:#666;font-size:13px;">You'll be billed automatically each month until you cancel — no lock-in, cancel anytime from your dashboard.</p>
        <p><a href="${PORTAL_URL}" style="display:inline-block;background:#DE3937;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:600;">Go to your dashboard →</a></p>
        <p style="color:#444;">Now that you're subscribed, here's what's unlocked:</p>
        <ul style="color:#444;">
          <li>Full control over your listing — description, photos, menu, and current specials</li>
          <li>Correct your name, address, or hours if Google has them wrong</li>
          <li>Accept table bookings directly, no commission ever</li>
          <li>Your own <strong>outtoeat badge</strong> — a free "Featured on outtoeat" button for your own website, linking straight back to your listing. Grab the code from your dashboard.</li>
        </ul>
        <p style="color:#666;font-size:13px;">Thanks for joining outtoeat — no commission, ever.</p>
      </div>
    `,
  });
}

const ALLOWED_ORIGINS = [
  "https://outtoeat.com.au",
  "https://www.outtoeat.com.au",
  "https://outtoeat.au",
  "https://www.outtoeat.au",
  "https://dine-out-website.vercel.app",
  "https://dine-out-app.vercel.app",
  "https://restaurant-portal-seven.vercel.app",
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: "Server is missing STRIPE_WEBHOOK_SECRET" });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["stripe-signature"];
  if (!verifyStripeSignature(rawBody, signature, webhookSecret)) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(rawBody);
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const restaurantId = session.metadata?.restaurant_id || session.client_reference_id;
      if (restaurantId) {
        const rows = await sql`
          UPDATE restaurants
          SET subscription_status = 'active',
              stripe_customer_id = ${session.customer},
              stripe_subscription_id = ${session.subscription}
          WHERE id = ${restaurantId}
          RETURNING name, owner_email
        `;

        // Fire-and-forget from the webhook's perspective — an email
        // failure shouldn't turn into a 500 back to Stripe, which would
        // just cause Stripe to retry an already-successful subscription
        // update. Errors are logged inside sendEmail() itself.
        const restaurant = rows[0];
        if (restaurant?.owner_email) {
          await sendSubscriptionConfirmationEmail({ ownerEmail: restaurant.owner_email, restaurantName: restaurant.name || "there" });
        }
      }
    }

    if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const status = sub.status === "active" || sub.status === "trialing" ? "active" : "inactive";
      await sql`
        UPDATE restaurants
        SET subscription_status = ${status}
        WHERE stripe_subscription_id = ${sub.id}
      `;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("stripe-webhook error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
