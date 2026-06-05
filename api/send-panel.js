// Kirim panel permanen ke channel Discord
// Panggil sekali dari admin panel

export default async function handler(req, res) {
  const secret = req.headers["x-admin-secret"];
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const channelId = process.env.DISCORD_CHANNEL_ID;
  const token     = process.env.DISCORD_BOT_TOKEN;

  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      embeds: [{
        title: "LuluXStarDev — VIP Panel",
        description: "If you're a buyer, click the buttons below to redeem your key, get the script, or manage your account.",
        color: 0x7c3aed,
        footer: { text: "LuluXStarDev • VIP Members Only" },
      }],
      components: [
        { type: 1, components: [
          { type: 2, style: 3, label: "Redeem Key",  custom_id: "redeem_key",  emoji: { name: "🔑" } },
          { type: 2, style: 1, label: "Get Script",  custom_id: "get_script",  emoji: { name: "📋" } },
        ]},
        { type: 1, components: [
          { type: 2, style: 1, label: "Get Role",    custom_id: "get_role",    emoji: { name: "👤" } },
          { type: 2, style: 2, label: "Reset HWID",  custom_id: "reset_hwid",  emoji: { name: "⚙️" } },
          { type: 2, style: 2, label: "Get Stats",   custom_id: "get_stats",   emoji: { name: "📊" } },
        ]},
      ],
    }),
  });
  const data = await r.json();
  if (data.id) return res.json({ success: true, messageId: data.id });
  return res.json({ success: false, error: data });
}
