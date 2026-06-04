// Panggil endpoint ini SEKALI untuk register slash commands ke Discord
// GET /api/setup-commands dengan header x-admin-secret

export default async function handler(req, res) {
  const secret = req.headers["x-admin-secret"];
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const appId   = process.env.DISCORD_APP_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const token   = process.env.DISCORD_BOT_TOKEN;

  const commands = [
    {
      name: "verify",
      description: "Verify your VIP key to unlock the panel",
      options: [{
        name: "key",
        description: "Your VIPMEM key",
        type: 3,       // STRING
        required: true,
      }]
    }
  ];

  const r = await fetch(
    `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    }
  );
  const data = await r.json();
  return res.json(data);
}
