import { Redis } from "@upstash/redis";
const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || "changeme";

// ── Helper: parse "jam:hari:bulan" → unix expireAt ────────────
function parseExpiry(str) {
  if (!str || str.trim() === "" || str === "0:0:0") return 0; // permanent
  const parts = str.split(":").map((v) => parseInt(v) || 0);
  const [jam = 0, hari = 0, bulan = 0] = parts;
  const secs = jam * 3600 + hari * 86400 + bulan * 2592000;
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
    const items = await Promise.all(
      keys.map(async (k) => {
        const d = await kv.get(`key:${k}`);
        if (!d) return null;
        return { ...d, expireLabel: formatExpiry(d.expireAt) };
      })
    );
    return res.status(200).json(items.filter(Boolean));
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

    await kv.del(`key:${key}`);
    await kv.srem("keys", key);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
