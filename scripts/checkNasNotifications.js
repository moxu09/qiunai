require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const { readLinks, processNasNotifications } = require('../events/qiunaiNasUploadNotifications');
async function main() {
  const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9);
  const links = source ? readLinks(JSON.stringify(JSON.parse(fs.readFileSync(source, 'utf8')))) : readLinks();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.rest.setToken(process.env.TOKEN);
  client.user = await client.users.fetch('@me');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const summary = await processNasNotifications(db, client, { dryRun: true, links });
  const reasons = {};
  for (const row of summary.skipped) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  console.log('[UGREEN 雲端預檢]', JSON.stringify({ date: summary.date, provider: summary.provider, dailyLinks: links.length, eligible: summary.eligible, skipped: summary.skipped.length, reasons, dryRun: true, sent: summary.sent }));
  client.destroy();
}
main().catch(() => { console.error('[NAS 雲端預檢失敗] 請檢查設定、Discord 權限與資料庫連線'); process.exitCode = 1; });
