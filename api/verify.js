import { Redis } from "@upstash/redis";
const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ valid: false, message: "Method not allowed" });

  const { key, hwid } = req.body || {};
  if (!key || !hwid)
    return res.status(400).json({ valid: false, message: "Missing key or hwid" });

  // ── Fetch key data ──────────────────────────────────────────
  let data;
  try {
    data = await kv.get(`key:${key}`);
  } catch {
    return res.status(500).json({ valid: false, message: "Database error" });
  }

  if (!data) return res.status(200).json({ valid: false, message: "Invalid key" });

  const now = Math.floor(Date.now() / 1000);

  // ── Expiry check ─────────────────────────────────────────────
  if (data.expireAt && data.expireAt > 0 && now > data.expireAt) {
    await kv.del(`key:${key}`);
    await kv.srem("keys", key);
    return res.status(200).json({ valid: false, message: "Key expired" });
  }

  // ── HWID check ───────────────────────────────────────────────
  const hwids = data.hwids || [];
  if (!hwids.includes(hwid)) {
    if (hwids.length >= (data.maxHwid || 1)) {
      return res.status(200).json({
        valid: false,
        message: `HWID limit reached (max ${data.maxHwid})`,
      });
    }
    hwids.push(hwid);
    data.hwids = hwids;
    await kv.set(`key:${key}`, data);
  }

  // ── Success ──────────────────────────────────────────────────
  return res.status(200).json({
    valid: true,
    name: data.name,
    status: data.status,
    expireAt: data.expireAt || 0,
    message: "OK",
  });
}
