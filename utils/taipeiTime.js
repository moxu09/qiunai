// Database timestamp-without-time-zone values are stored as UTC, not host local time.
function parseDatabaseTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let input = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(input)) {
    input = input.replace(' ', 'T');
    if (!/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(input)) input += 'Z';
    else if (/[+-]\d{2}$/.test(input)) input += ':00';
  }
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatTaipeiTime(value) {
  const date = parseDatabaseTime(value);
  if (!date) return '未提供時間';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Taipei', year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
  }).formatToParts(date);
  const p = key => parts.find(x => x.type === key).value;
  return `${p('year')}/${p('month')}/${p('day')} ${p('hour')}:${p('minute')}:${p('second')}（台北時間）`;
}
module.exports = {parseDatabaseTime,formatTaipeiTime};
