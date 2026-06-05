import { Redis } from "@upstash/redis";

const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function sendPanelMessage() {
  const sent = await kv.get("panel:sent");
  if (sent) return { already: true };

  const r = await fetch(
    `https://discord.com/api/v10/channels/${process.env.DISCORD_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [{
          title: "LuluXStarDev — VIP Panel",
          description: "If you're a buyer, use the buttons below to redeem your key, get the script, or manage your account.",
          color: 0x7c3aed,
          footer: { text: "LuluXStarDev • VIP Members Only" },
        }],
        components: [
          { type: 1, components: [
            { type: 2, style: 3, label: "Verify Key", custom_id: "redeem_key", emoji: { name: "🔑" } },
          ]},
          { type: 1, components: [
            { type: 2, style: 2, label: "Key Info",   custom_id: "key_info",   emoji: { name: "📋" } },
            { type: 2, style: 4, label: "Reset HWID", custom_id: "reset_hwid", emoji: { name: "⚙️" } },
            { type: 2, style: 3, label: "Get Script", custom_id: "get_script", emoji: { name: "📜" } },
            { type: 2, style: 1, label: "Get Role",   custom_id: "get_role",   emoji: { name: "👤" } },
          ]},
        ],
      }),
    }
  );
  const data = await r.json();
  if (data.id) { await kv.set("panel:sent", data.id); return { success: true }; }
  return { success: false, error: data };
}

export default async function handler(req, res) {
  const secret = req.headers["x-admin-secret"];
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  // Register commands (kosong — semua pakai buttons)
  await fetch(
    `https://discord.com/api/v10/applications/${process.env.DISCORD_APP_ID}/guilds/${process.env.DISCORD_GUILD_ID}/commands`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([]),
    }
  );

  const panelResult = await sendPanelMessage();
  return res.json({ success: true, panel: panelResult });
}

