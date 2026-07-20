// POST /api/book
// Body: { slotId, name, email, phone, partySize }

import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { slotId, name, email, phone, partySize } = req.body || {};
  if (!slotId || !name || !email || !partySize) {
    return res.status(400).json({ error: "slotId, name, email and partySize are required" });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Atomically claim the slot only if it still has room — this is the
    // piece that stops two people from booking the last table at the same time.
    const [updatedSlot] = await sql`
      UPDATE time_slots
      SET booked_count = booked_count + 1
      WHERE id = ${slotId} AND booked_count < capacity
      RETURNING id, restaurant_id, slot_date, slot_time
    `;

    if (!updatedSlot) {
      return res.status(409).json({ error: "That time slot is no longer available. Please pick another." });
    }

    const [booking] = await sql`
      INSERT INTO bookings (slot_id, restaurant_id, customer_name, customer_email, customer_phone, party_size)
      VALUES (${updatedSlot.id}, ${updatedSlot.restaurant_id}, ${name}, ${email}, ${phone || null}, ${partySize})
      RETURNING id, status, created_at
    `;

    return res.status(201).json({
      booking,
      slot: { date: updatedSlot.slot_date, time: updatedSlot.slot_time },
    });
  } catch (err) {
    return res.status(500).json({ error: "Booking failed", detail: err.message });
  }
}
