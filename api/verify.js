import { Redis } from "@upstash/redis";

const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Discord webhook ───────────────────────────────────────────
async function sendWebhook(title, desc, color = 0xff4455) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{ title, description: desc, color,
        timestamp: new Date().toISOString() }]
    })
  }).catch(() => {});
}

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

  // ── Block check ───────────────────────────────────────────────
  const blockKey = `block:hwid:${hwid}`;
  const blocked  = await kv.get(blockKey);
  if (blocked)
    return res.status(200).json({ valid: false,
      message: "Too many failed attempts. Try again in 30 minutes." });

  // ── Rate limit: 5x per jam per HWID ──────────────────────────
  const rlKey   = `rl:hwid:${hwid}`;
  const rlCount = await kv.incr(rlKey);
  if (rlCount === 1) await kv.expire(rlKey, 60);
  if (rlCount > 10) {
    await sendWebhook("Rate Limit Hit",
      `**HWID:** \`${hwid}\`\nExceeded 10 verify requests/minute.`, 0xf59e0b);
    return res.status(200).json({ valid: false,
      message: "Too many requests. Try again later." });
  }

  // ── Fetch key data ────────────────────────────────────────────
  let data;
  try { data = await kv.get(`key:${key}`); }
  catch { return res.status(500).json({ valid: false, message: "Database error" }); }

  if (!data) {
    // ── Fail counter (key tidak valid) ────────────────────────
    const failKey   = `fail:hwid:${hwid}`;
    const failCount = await kv.incr(failKey);
    if (failCount === 1) await kv.expire(failKey, 3600);
    if (failCount >= 10) {
      await kv.set(blockKey, "1", { ex: 1800 });
      await sendWebhook("HWID Blocked",
        `**HWID:** \`${hwid}\`\n10 failed attempts. Blocked for 30 minutes.`, 0xff4455);
    }
    return res.status(200).json({ valid: false, message: "Invalid key" });
  }

  const now = Math.floor(Date.now() / 1000);

  // ── Expiry check ──────────────────────────────────────────────
  if (data.expireAt && data.expireAt > 0 && now > data.expireAt) {
    await kv.del(`key:${key}`);
    await kv.srem("keys", key);
    await sendWebhook("Key Expired",
      `**Key:** \`${key}\`\n**Owner:** ${data.name}\nAuto-deleted.`, 0xf59e0b);
    return res.status(200).json({ valid: false, message: "Key expired" });
  }

  // ── Reset fail counter on valid key ──────────────────────────
  await kv.del(`fail:hwid:${hwid}`);

  // ── HWID check ────────────────────────────────────────────────
  const hwids = data.hwids || [];
  if (!hwids.includes(hwid)) {
    if (hwids.length >= (data.maxHwid || 1)) {
      return res.status(200).json({ valid: false,
        message: `HWID limit reached (max ${data.maxHwid})` });
    }
    hwids.push(hwid);
    data.hwids = hwids;
    await kv.set(`key:${key}`, data);
    await sendWebhook("New HWID Registered",
      `**Key:** \`${key}\`\n**Owner:** ${data.name}\n**HWID:** \`${hwid}\`\n**Slots:** ${hwids.length}/${data.maxHwid}`,
      0x22d47a);
  }

  // ── Success ───────────────────────────────────────────────────
  return res.status(200).json({
    valid: true,
    name: data.name,
    status: data.status,
    expireAt: data.expireAt || 0,
    serverNow: Math.floor(Date.now() / 1000),
    message: "OK",
  });
}
