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
        await sql`
          UPDATE restaurants
          SET subscription_status = 'active',
              stripe_customer_id = ${session.customer},
              stripe_subscription_id = ${session.subscription}
          WHERE id = ${restaurantId}
        `;
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
