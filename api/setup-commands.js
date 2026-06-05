import { sendPanelMessage } from "./bot.js";

export default async function handler(req, res) {
  const secret = req.headers["x-admin-secret"];
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const appId   = process.env.DISCORD_APP_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const token   = process.env.DISCORD_BOT_TOKEN;

  // Register slash commands (kosong — semua pakai buttons sekarang)
  await fetch(
    `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
    {
      method: "PUT",
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([]),
    }
  );

  // Auto send panel ke channel
  const panelResult = await sendPanelMessage();

  return res.json({ success: true, panel: panelResult });
}
