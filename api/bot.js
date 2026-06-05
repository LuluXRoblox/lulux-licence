
  }

  return res.status(400).end();
}
import { Redis } from "@upstash/redis";

export const config = { api: { bodyParser: false } };

const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PUBLIC_KEY  = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID    = process.env.DISCORD_GUILD_ID;
const CHANNEL_ID  = process.env.DISCORD_CHANNEL_ID;
const ROLE_ID     = process.env.DISCORD_ROLE_ID;
const SCRIPT_LINK = process.env.SCRIPT_LINK || "";

// ── Helpers ───────────────────────────────────────────────────
function hexToUint8(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}
async function verifySignature(sig, timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    "raw", hexToUint8(PUBLIC_KEY),
    { name: "Ed25519", namedCurve: "Ed25519" }, false, ["verify"]
  );
  return crypto.subtle.verify("Ed25519", key,
    hexToUint8(sig), new TextEncoder().encode(timestamp + rawBody));
}
function getRawBody(req) {
  return new Promise((res, rej) => {
    let d = ""; req.on("data", c => d += c);
    req.on("end", () => res(d)); req.on("error", rej);
  });
}
async function discordAPI(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { "Authorization": `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
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

// ── Panel message ─────────────────────────────────────────────
export async function sendPanelMessage() {
  // Cek apakah panel sudah pernah dikirim
  const sent = await kv.get("panel:sent");
  if (sent) return { already: true };

  const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: "LuluXStarDev — VIP Panel",
        description: "If you're a buyer, use the buttons below to redeem your key, get the script, or manage your account.",
        color: 0x7c3aed,
        footer: { text: "LuluXStarDev • VIP Members Only" },
      }],
      components: [
        { type: 1, components: [
          { type: 2, style: 3, label: "Verify Key",  custom_id: "redeem_key", emoji: { name: "" } },
        ]},
        { type: 1, components: [
          { type: 2, style: 2, label: "Key Info",    custom_id: "key_info",   emoji: { name: "" } },
          { type: 2, style: 4, label: "Reset HWID",  custom_id: "reset_hwid", emoji: { name: "" } },
          { type: 2, style: 3, label: "Get Script",  custom_id: "get_script", emoji: { name: "" } },
          { type: 2, style: 1, label: "Get Role",    custom_id: "get_role",   emoji: { name: "" } },
        ]},
      ],
    }),
  });
  const data = await r.json();
  if (data.id) {
    await kv.set("panel:sent", data.id); // simpan message ID
    return { success: true, messageId: data.id };
  }
  return { success: false, error: data };
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody  = await getRawBody(req);
  const sig      = req.headers["x-signature-ed25519"];
  const timestamp= req.headers["x-signature-timestamp"];

  try {
    if (!await verifySignature(sig, timestamp, rawBody))
      return res.status(401).send("Invalid signature");
  } catch { return res.status(401).send("Verification failed"); }

  const ix = JSON.parse(rawBody);
  if (ix.type === 1) return res.json({ type: 1 });

  const discordId = ix.member?.user?.id || ix.user?.id;

  // ── BUTTON INTERACTIONS ───────────────────────────────────────
  if (ix.type === 3) {
    const cid = ix.data.custom_id;

    // Verify Key → modal
    if (cid === "redeem_key") {
      return res.json({
        type: 9,
        data: {
          title: "Verify Your Key",
          custom_id: "redeem_modal",
          components: [{
            type: 1,
            components: [{
              type: 4,
              custom_id: "key_input",
              label: "Enter your VIPMEM key",
              style: 1,
              placeholder: "LULUX-NAME-XXXX-HHMM-MMDDYY",
              required: true,
            }]
          }]
        }
      });
    }

    // Buttons yang butuh key terverifikasi
    const linkedKey = await kv.get(`discord:${discordId}`);
    if (!linkedKey)
      return res.json(ephemeral("You have not verified a key yet. Click **Verify Key** first."));

    const keyData = await kv.get(`key:${linkedKey}`);
    if (!keyData) {
      await kv.del(`discord:${discordId}`);
      return res.json(ephemeral("Your key no longer exists. Please verify again."));
    }

    // Key Info
    if (cid === "key_info") {
      const now    = Math.floor(Date.now() / 1000);
      const isPerm = !keyData.expireAt || keyData.expireAt === 0;
      const rem    = isPerm ? "Permanent" : formatRem(keyData.expireAt - now);
      return res.json(ephemeral(null, [{
        title: "Key Info",
        fields: [
          { name: "Key",    value: `\`${linkedKey}\``,                          inline: false },
          { name: "Name",   value: keyData.name,                                inline: true  },
          { name: "Status", value: keyData.status,                              inline: true  },
          { name: "Expires",value: rem,                                          inline: true  },
          { name: "HWID",   value: `${(keyData.hwids||[]).length}/${keyData.maxHwid}`, inline: true },
        ],
        color: 0x7c3aed,
      }]));
    }

    // Reset HWID — VIP: 3x per hari
    if (cid === "reset_hwid") {
      const cdKey   = `resethwid_cd:${discordId}`;
      const cdCount = parseInt(await kv.get(cdKey) || "0");
      if (cdCount >= 3)
        return res.json(ephemeral("You have used all 3 HWID resets for today."));

      keyData.hwids = [];
      await kv.set(`key:${linkedKey}`, keyData);

      const newCount = cdCount + 1;
      const ttl = await kv.ttl(cdKey);
      await kv.set(cdKey, String(newCount), { ex: ttl > 0 ? ttl : 86400 });

      return res.json(ephemeral(null, [{
        title: "HWID Reset",
        description: `HWID list cleared. Re-register on next script launch.\n**Resets used today:** ${newCount}/3`,
        color: 0x22d47a,
      }]));
    }

    // Get Script
    if (cid === "get_script") {
      const script = `script_key="${linkedKey}";\nloadstring(game:HttpGet("${SCRIPT_LINK}",true))()`;
      return res.json(ephemeral(null, [{
        title: "Your Script",
        description: `Copy the script below:\n\`\`\`lua\n${script}\n\`\`\``,
        color: 0x7c3aed,
      }]));
    }

    // Get Role
    if (cid === "get_role") {
      if (!ROLE_ID) return res.json(ephemeral("Role not configured."));
      try {
        await discordAPI("PUT", `/guilds/${GUILD_ID}/members/${discordId}/roles/${ROLE_ID}`, {});
        return res.json(ephemeral("VIP role has been assigned!"));
      } catch {
        return res.json(ephemeral("Failed to assign role."));
      }
    }
  }

  // ── MODAL SUBMIT ──────────────────────────────────────────────
  if (ix.type === 5 && ix.data.custom_id === "redeem_modal") {
    const key = ix.data.components[0].components[0].value?.trim();
    if (!key) return res.json(ephemeral("Please enter a key."));

    const keyData = await kv.get(`key:${key}`);
    if (!keyData)          return res.json(ephemeral("Invalid key."));
    if (keyData.status !== "VIPMEM")
      return res.json(ephemeral("This key does not have VIP access."));

    const existingKey = await kv.get(`discord:${discordId}`);
    if (existingKey && existingKey !== key)
      return res.json(ephemeral("You don't use other key!"));
    if (keyData.discordId && keyData.discordId !== discordId)
      return res.json(ephemeral("This key is already linked to another account."));

    keyData.discordId = discordId;
    await kv.set(`key:${key}`, keyData);
    await kv.set(`discord:${discordId}`, key);

    const now    = Math.floor(Date.now() / 1000);
    const isPerm = !keyData.expireAt || keyData.expireAt === 0;
    const rem    = isPerm ? "Permanent" : formatRem(keyData.expireAt - now);

    return res.json(ephemeral(null, [{
      title: `Welcome, ${keyData.name}!`,
      description: "Your VIP panel is now active.",
      fields: [
        { name: "Key",    value: `\`${key}\``,                             inline: false },
        { name: "Status", value: keyData.status,                           inline: true  },
        { name: "Expires",value: rem,                                       inline: true  },
        { name: "HWID",   value: `${(keyData.hwids||[]).length}/${keyData.maxHwid}`, inline: true },
      ],
      color: 0x7c3aed,
    }]));
  }

  return res.status(400).end();
}
