import { Redis } from "@upstash/redis";

export const config = { api: { bodyParser: false } };

const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PUBLIC_KEY  = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const SCRIPT_LINK = process.env.SCRIPT_LINK || "Script link not configured.";

// ── Helpers ───────────────────────────────────────────────────
function hexToUint8(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}

async function verifySignature(sig, timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    "raw", hexToUint8(PUBLIC_KEY),
    { name: "Ed25519", namedCurve: "Ed25519" },
    false, ["verify"]
  );
  return crypto.subtle.verify(
    "Ed25519", key,
    hexToUint8(sig),
    new TextEncoder().encode(timestamp + rawBody)
  );
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function ephemeral(content, embeds) {
  const data = { flags: 64 };
  if (content) data.content = content;
  if (embeds)  data.embeds  = embeds;
  return { type: 4, data };
}

function formatRem(secs) {
  if (secs <= 0) return "Expired";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}D`);
  if (h > 0) parts.push(`${h}H`);
  if (m > 0) parts.push(`${m}min`);
  return (parts.length ? parts.join(" ") : "< 1min") + " remaining";
}

function dashboardComponents() {
  return [{
    type: 1,
    components: [
      { type: 2, style: 2, label: "Key Info",    custom_id: "keyinfo"   },
      { type: 2, style: 4, label: "Reset HWID",  custom_id: "resethwid" },
      { type: 2, style: 3, label: "Get Script",  custom_id: "getscript" },
    ]
  }];
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody  = await getRawBody(req);
  const sig      = req.headers["x-signature-ed25519"];
  const timestamp= req.headers["x-signature-timestamp"];

  try {
    const valid = await verifySignature(sig, timestamp, rawBody);
    if (!valid) return res.status(401).send("Invalid signature");
  } catch {
    return res.status(401).send("Verification failed");
  }

  const ix = JSON.parse(rawBody);

  // ── PING ─────────────────────────────────────────────────────
  if (ix.type === 1) return res.json({ type: 1 });

  const discordId = ix.member?.user?.id || ix.user?.id;

  // ── SLASH COMMAND: /verify ────────────────────────────────────
  if (ix.type === 2 && ix.data.name === "verify") {
    const key = ix.data.options?.find(o => o.name === "key")?.value?.trim();
    if (!key) return res.json(ephemeral("Please provide a key."));

    const keyData = await kv.get(`key:${key}`);
    if (!keyData)
      return res.json(ephemeral("Invalid key."));
    if (keyData.status !== "VIPMEM")
      return res.json(ephemeral("This key does not have VIP access."));

    // Cek: Discord ID ini sudah punya key lain?
    const existingKey = await kv.get(`discord:${discordId}`);
    if (existingKey && existingKey !== key)
      return res.json(ephemeral("You don't use other key!"));

    // Cek: key ini sudah di-link Discord lain?
    if (keyData.discordId && keyData.discordId !== discordId)
      return res.json(ephemeral("This key is already linked to another account."));

    // Link Discord → key
    keyData.discordId = discordId;
    await kv.set(`key:${key}`, keyData);
    await kv.set(`discord:${discordId}`, key);

    const now = Math.floor(Date.now() / 1000);
    const isPerm = !keyData.expireAt || keyData.expireAt === 0;
    const rem = isPerm ? "Permanent" : formatRem(keyData.expireAt - now);

    return res.json({
      type: 4,
      data: {
        embeds: [{
          title: `Welcome, ${keyData.name}!`,
          description: "Your VIP panel is now active.",
          fields: [
            { name: "Key",    value: `\`${key}\``,                        inline: false },
            { name: "Status", value: keyData.status,                      inline: true  },
            { name: "Expires",value: rem,                                  inline: true  },
            { name: "HWID",   value: `${(keyData.hwids||[]).length}/${keyData.maxHwid}`, inline: true },
          ],
          color: 0x7c3aed,
        }],
        components: dashboardComponents(),
        flags: 64,
      }
    });
  }

  // ── BUTTON INTERACTIONS ───────────────────────────────────────
  if (ix.type === 3) {
    const customId = ix.data.custom_id;

    const linkedKey = await kv.get(`discord:${discordId}`);
    if (!linkedKey)
      return res.json(ephemeral("You have not verified a key yet. Use /verify first."));

    const keyData = await kv.get(`key:${linkedKey}`);
    if (!keyData) {
      await kv.del(`discord:${discordId}`);
      return res.json(ephemeral("Your key no longer exists. Please verify again with /verify."));
    }

    // ── Key Info ────────────────────────────────────────────────
    if (customId === "keyinfo") {
      const now  = Math.floor(Date.now() / 1000);
      const isPerm = !keyData.expireAt || keyData.expireAt === 0;
      const rem  = isPerm ? "Permanent" : formatRem(keyData.expireAt - now);
      return res.json({
        type: 4,
        data: {
          embeds: [{
            title: "Key Info",
            fields: [
              { name: "Key",    value: `\`${linkedKey}\``,                     inline: false },
              { name: "Name",   value: keyData.name,                           inline: true  },
              { name: "Status", value: keyData.status,                         inline: true  },
              { name: "Expires",value: rem,                                     inline: true  },
              { name: "HWID",   value: `${(keyData.hwids||[]).length}/${keyData.maxHwid}`, inline: true },
            ],
            color: 0x7c3aed,
          }],
          components: dashboardComponents(),
          flags: 64,
        }
      });
    }

    // ── Reset HWID ──────────────────────────────────────────────
    if (customId === "resethwid") {
      const cdKey = `resethwid_cd:${discordId}`;
      const cd    = await kv.get(cdKey);
      if (cd)
        return res.json(ephemeral("You can only reset HWID once per day."));

      keyData.hwids = [];
      await kv.set(`key:${linkedKey}`, keyData);
      await kv.set(cdKey, "1", { ex: 86400 });

      return res.json({
        type: 4,
        data: {
          embeds: [{
            title: "HWID Reset",
            description: "Your HWID list has been cleared.\nYou can re-register on your next script launch.",
            color: 0x22d47a,
          }],
          components: dashboardComponents(),
          flags: 64,
        }
      });
    }

    // ── Get Script ──────────────────────────────────────────────
    if (customId === "getscript") {
      return res.json({
        type: 4,
        data: {
          embeds: [{
            title: "Your Script",
            description: `\`\`\`lua\n${SCRIPT_LINK}\n\`\`\``,
            color: 0x7c3aed,
          }],
          components: dashboardComponents(),
          flags: 64,
        }
      });
    }
  }

  return res.status(400).end();
}
