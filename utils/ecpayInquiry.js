const { createHmac } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
function buildEcpayInquiryRow(order) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ecpay_inquiry_${order}`)
    .setLabel('我已付款，重新查詢').setStyle(ButtonStyle.Secondary));
}
async function requestEcpayInquiry(order, { source, userId, channelId, baseUrl, secret = process.env.SUPABASE_SERVICE_ROLE_KEY, fetcher = fetch }) {
  if (!secret || !/^https:\/\//.test(baseUrl || '') || !/^[A-Za-z0-9]{1,20}$/.test(order)) throw new Error('付款查詢尚未設定');
  const body = JSON.stringify({ order, source, userId, channelId, timestamp: Math.floor(Date.now() / 1000) });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/api/payments/ecpay/service/inquiry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ecpay-Bot-Signature': signature }, body, signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error('查詢暫時無法完成，請稍後再試；勿重複付款');
  return response.json();
}
async function handleEcpayInquiry(interaction, supabase, baseUrl) {
  const match = String(interaction.customId || '').match(/^ecpay_inquiry_([A-Za-z0-9]{1,20})$/);
  if (!match) return false;
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 });
  try {
    const { data: payment, error } = await supabase.from('ecpay_service_payments').select('user_id,channel_id,organization_code')
      .eq('merchant_trade_no', match[1]).maybeSingle();
    if (error || !payment || payment.organization_code !== 'qiunai' || payment.user_id !== interaction.user.id || String(payment.channel_id) !== String(interaction.channelId))
      throw new Error('這筆付款不屬於你或此頻道');
    const result = await requestEcpayInquiry(match[1], { source: 'manual', userId: interaction.user.id, channelId: interaction.channelId, baseUrl });
    const content = result.status === 'paid'
      ? result.fulfillment_status === 'completed' ? '✅ 綠界已確認付款，訂單後續處理已完成。' : '✅ 綠界已確認付款，正在完成入帳或訂單處理，請勿重複付款。'
      : result.status === 'needs_review' ? '⚠️ 此筆需要客服核對是否已人工補款或付款，系統不會重複入帳。'
      : result.status === 'cooldown' ? `請約 ${Math.max(1, Number(result.retry_after) || 60)} 秒後再查詢；銀行／超商回報仍可能需要時間。`
      : result.status === 'pending' ? '綠界目前尚未確認付款。若已繳費，請保留收據，等待銀行／超商回報，勿重複付款。'
      : '目前無法取得新的付款確認，請稍後再試或聯繫客服；勿重複付款。';
    await interaction.editReply({ content });
  } catch (error) { await interaction.editReply({ content: `❌ ${error.message}` }); }
  return true;
}
async function recoverPendingEcpayPayments(supabase, baseUrl, { now = Date.now(), request = requestEcpayInquiry } = {}) {
  const { data: payments, error } = await supabase.from('ecpay_service_payments')
    .select('merchant_trade_no,raw_result,metadata,created_at').eq('organization_code','qiunai').eq('status','pending')
    .gte('created_at', new Date(now - 7 * 86400000).toISOString()).lte('created_at',new Date(now - 60000).toISOString())
    .order('created_at').limit(500);
  if (error) throw new Error('無法讀取待付款查單清單');
  const candidates = (payments || []).filter(p => ['ATM','CVS'].includes(String(p.raw_result?.PaymentType || p.metadata?.ecpay_direct_method || '').split('_')[0]));
  if (!candidates.length) return { checked: 0 };
  const { data: checks, error: checksError } = await supabase.from('ecpay_service_inquiries')
    .select('merchant_trade_no,next_check_at,last_checked_at,review_required,lease_until').in('merchant_trade_no',candidates.map(p=>p.merchant_trade_no));
  if (checksError) throw new Error('無法讀取查單節流紀錄');
  const byNo = new Map((checks || []).map(q=>[q.merchant_trade_no,q]));
  const due = candidates.filter(p=>{const q=byNo.get(p.merchant_trade_no);return !q?.review_required && !(Date.parse(q?.next_check_at)>now) && !(Date.parse(q?.lease_until)>now);})
    .sort((a,b)=>(Date.parse(byNo.get(a.merchant_trade_no)?.last_checked_at)||0)-(Date.parse(byNo.get(b.merchant_trade_no)?.last_checked_at)||0));
  if (!due.length) return { checked: 0 };
  const result = await request(due[0].merchant_trade_no,{ source: 'scheduled',baseUrl });
  return { checked: 1, status: result.status };
}
module.exports = { buildEcpayInquiryRow, requestEcpayInquiry, handleEcpayInquiry, recoverPendingEcpayPayments };
