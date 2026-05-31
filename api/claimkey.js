import { Redis } from "@upstash/redis";
import crypto from "crypto";

const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const LINKVERTISE_API_KEY = process.env.LINKVERTISE_API_KEY;
const LINKVERTISE_USER_ID = process.env.LINKVERTISE_USER_ID;
const SITE_URL            = process.env.SITE_URL;
const TRIAL_HOURS         = 12;
const MAX_HOURS           = 48;
const COOLDOWN_SECS       = 120; // 2 menit

function genKeyStr() {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const r = (n) => Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join("");
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  return `LULUX-${r(4)}-${r(4)}-${dd}${yy}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const body   = req.body || {};
  const query  = req.query || {};
  const action = body.action || query.action;

  // ── GET LINKVERTISE URL ──────────────────────────────────────
  if (action === "getlink") {
    const callback = `${SITE_URL}/getkey`;
    const encoded  = Buffer.from(callback).toString("base64");
    const random   = (Math.random() * 1000).toFixed(10);
    const url      = `https://link-to.net/${LINKVERTISE_USER_ID}/${random}/dynamic?r=${encoded}`;
    return res.status(200).json({ url });
  }

  // ── VERIFY HASH FROM LINKVERTISE ─────────────────────────────
  if (action === "verify") {
    const { hash } = body;
    if (!hash) return res.status(400).json({ valid: false, message: "Missing hash" });

    try {
      const r = await fetch(
        `https://publisher.linkvertise.com/api/v1/antiBypass/hash/${hash}`,
        { headers: { Authorization: LINKVERTISE_API_KEY } }
      );
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch {
        return res.status(200).json({ valid: false, message: "Verification failed" });
      }
      if (!data?.response || data.response.status !== "FOUND") {
        return res.status(200).json({ valid: false, message: "Verification failed" });
      }
    } catch {
      return res.status(200).json({ valid: false, message: "Linkvertise error" });
    }

    // Issue one-time session token (valid 5 menit)
    const token = crypto.randomBytes(16).toString("hex");
    await kv.set(`session:${token}`, "1", { ex: 300 });
    return res.status(200).json({ valid: true, token });
  }

  // ── GENERATE KEY ─────────────────────────────────────────────
  if (action === "generate") {
    const { token } = body;
    const session = await kv.get(`session:${token}`);
    if (!session) return res.status(200).json({ success: false, message: "Session expired. Please verify again." });
    await kv.del(`session:${token}`);

    const ip  = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
    const cdKey = `cd:${ip}`;
    const cd  = await kv.get(cdKey);
    if (cd) return res.status(200).json({ success: false, message: "Please wait before generating again." });

    const key      = genKeyStr();
    const expireAt = Math.floor(Date.now() / 1000) + TRIAL_HOURS * 3600;
    const keyData  = {
      key, name: "Trial", status: "user",
      maxHwid: 1, hwids: [], expireAt,
      createdAt: Math.floor(Date.now() / 1000),
      source: "trial",
    };

    await kv.set(`key:${key}`, keyData);
    await kv.sadd("keys", key);
    await kv.set(cdKey, "1", { ex: COOLDOWN_SECS });

    return res.status(200).json({ success: true, key, expireAt });
  }

  // ── EXPAND KEY ───────────────────────────────────────────────
  if (action === "expand") {
    const { token, key } = body;
    const session = await kv.get(`session:${token}`);
    if (!session) return res.status(200).json({ success: false, message: "Session expired. Please verify again." });
    await kv.del(`session:${token}`);

    const ip    = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
    const cdKey = `cd:${ip}`;
    const cd    = await kv.get(cdKey);
    if (cd) return res.status(200).json({ success: false, message: "Please wait before expanding." });

    const keyData = await kv.get(`key:${key}`);
    if (!keyData) return res.status(200).json({ success: false, message: "Key not found." });

    const now        = Math.floor(Date.now() / 1000);
    const base       = Math.max(keyData.expireAt || now, now);
    const newExpire  = base + TRIAL_HOURS * 3600;
    const cap        = now + MAX_HOURS * 3600;

    if (base >= cap) return res.status(200).json({ success: false, message: "Max duration (48H) reached." });

    keyData.expireAt = Math.min(newExpire, cap);
    await kv.set(`key:${key}`, keyData);
    await kv.set(cdKey, "1", { ex: COOLDOWN_SECS });

    return res.status(200).json({ success: true, key, expireAt: keyData.expireAt });
  }

  return res.status(400).json({ error: "Unknown action" });
}
