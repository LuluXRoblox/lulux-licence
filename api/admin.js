import { Redis } from "@upstash/redis";
const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || "changeme";

async function sendWebhook(title, desc, color = 0x7c3aed) {
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

// ── Helper: parse format H/D/W/M → unix expireAt ─────────────
// H=jam, D=hari, W=minggu, M=bulan
// contoh: "2H" "1D" "1W" "2D 1W" "1M"
function parseExpiry(str) {
  if (!str || str.trim() === "") return 0; // permanent
  let secs = 0;
  for (const [, num, unit] of str.matchAll(/(\d+)\s*([HhDdWwMm])/g)) {
    const n = parseInt(num);
    const u = unit.toUpperCase();
    if      (u === "H") secs += n * 3600;
    else if (u === "D") secs += n * 86400;
    else if (u === "W") secs += n * 604800;
    else if (u === "M") secs += n * 2592000;
  }
  if (secs === 0) return 0;
  return Math.floor(Date.now() / 1000) + secs;
}

function formatExpiry(unixTs) {
  if (!unixTs || unixTs === 0) return "Permanent";
  const now = Math.floor(Date.now() / 1000);
  const rem = unixTs - now;
  if (rem <= 0) return "Expired";
  const d = Math.floor(rem / 86400);
  const h = Math.floor((rem % 86400) / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}D`);
  if (h > 0) parts.push(`${h}H`);
  if (m > 0) parts.push(`${m}min`);
  return parts.join(" ") + " remaining";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Auth ─────────────────────────────────────────────────────
  const secret = req.headers["x-admin-secret"];
  if (secret !== ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  // ── GET: list all keys ────────────────────────────────────────
  if (req.method === "GET") {
    const keys = (await kv.smembers("keys")) || [];
    const now = Math.floor(Date.now() / 1000);
    const items = [];
    await Promise.all(
      keys.map(async (k) => {
        const d = await kv.get(`key:${k}`);
        if (!d) { await kv.srem("keys", k); return; }
        // Auto-delete expired keys
        if (d.expireAt && d.expireAt > 0 && d.expireAt < now) {
          await kv.del(`key:${k}`);
          await kv.srem("keys", k);
          return;
        }
        items.push({ ...d, expireLabel: formatExpiry(d.expireAt) });
      })
    );
    return res.status(200).json(items);
  }

  // ── POST: add new key ─────────────────────────────────────────
  if (req.method === "POST") {
    const { key, name, status, maxHwid, expireIn } = req.body || {};
    if (!key || !name)
      return res.status(400).json({ error: "key and name are required" });

    const exists = await kv.get(`key:${key}`);
    if (exists) return res.status(400).json({ error: "Key already exists" });

    const data = {
      key,
      name,
      status: status || "user",
      maxHwid: parseInt(maxHwid) || 1,
      expireAt: parseExpiry(expireIn),
      hwids: [],
      createdAt: Math.floor(Date.now() / 1000),
    };

    await kv.set(`key:${key}`, data);
    await kv.sadd("keys", key);
    return res.status(200).json({
      success: true,
      data: { ...data, expireLabel: formatExpiry(data.expireAt) },
    });
  }

  // ── PUT: edit key ─────────────────────────────────────────────
  if (req.method === "PUT") {
    const { key, name, status, maxHwid, expireIn, resetHwids } = req.body || {};
    if (!key) return res.status(400).json({ error: "key is required" });

    const data = await kv.get(`key:${key}`);
    if (!data) return res.status(404).json({ error: "Key not found" });

    if (name !== undefined) data.name = name;
    if (status !== undefined) data.status = status;
    if (maxHwid !== undefined) data.maxHwid = parseInt(maxHwid) || 1;
    if (expireIn !== undefined) data.expireAt = parseExpiry(expireIn);
    if (resetHwids) data.hwids = [];

    await kv.set(`key:${key}`, data);
    return res.status(200).json({
      success: true,
      data: { ...data, expireLabel: formatExpiry(data.expireAt) },
    });
  }

  // ── DELETE: remove key ────────────────────────────────────────
  if (req.method === "DELETE") {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: "key is required" });

    const delData = await kv.get(`key:${key}`);
    await kv.del(`key:${key}`);
    await kv.srem("keys", key);
    if (delData) await sendWebhook("Key Deleted by Admin",
      `**Key:** \`${key}\`
**Owner:** ${delData.name}`, 0xff4455);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
