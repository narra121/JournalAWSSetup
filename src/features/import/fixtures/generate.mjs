// Regenerates the binary/HTML fixtures: node src/features/import/fixtures/generate.mjs
// (CSV fixtures are plain text and edited by hand.) Layouts are modelled on the brokers' exports and have not
// been compared with real files; see progress log "UNVERIFIED".
import { deflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const colName = (i) => String.fromCharCode(65 + i);
function xlsx(sheetName, rows) {
  const sheetRows = rows
    .map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (typeof v === 'number' ? `<c r="${colName(j)}${i + 1}"><v>${v}</v></c>` : `<c r="${colName(j)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`)
    .join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

writeFileSync(
  join(dir, 'groww.xlsx'),
  xlsx('Order History', [
    ['Groww Order History'],
    ['Stock name', 'Symbol', 'ISIN', 'Type', 'Quantity', 'Value', 'Exchange', 'Exchange Order Id', 'Executed date and time', 'Order status'],
    ['Wipro Ltd', 'WIPRO', 'INE075A01022', 'BUY', 20, 9000, 'NSE', '1100000000200001', '07-04-2026 10:15 AM', 'Executed'],
    ['Wipro Ltd', 'WIPRO', 'INE075A01022', 'SELL', 20, 9200, 'NSE', '1100000000200002', '07-04-2026 02:05 PM', 'Executed'],
    ['Zomato Ltd', 'ZOMATO', 'INE758T01015', 'BUY', 100, 22000, 'NSE', '1100000000200003', '08-04-2026 09:30 AM', 'Cancelled'],
    ['Suzlon Energy Ltd', 'SUZLON', 'INE040H01021', 'BUY', 500, 27500, 'NSE', '1100000000200004', '08-04-2026 11:00 AM', 'Executed'],
    ['Suzlon Energy Ltd', 'SUZLON', 'INE040H01021', 'SELL', 500, 27000, 'NSE', '1100000000200005', '08-04-2026 01:20 PM', 'Executed'],
  ]),
);

writeFileSync(
  join(dir, 'zerodha_pnl.xlsx'),
  xlsx('Equity', [
    ['Client ID', 'AB1234'],
    ['P&L Statement for Equity from 2025-04-01 to 2026-03-31'],
    ['Symbol', 'ISIN', 'Quantity', 'Buy Value', 'Sell Value', 'Realized P&L', 'Realized P&L Pct.'],
    ['INFY', 'INE009A01021', 10, 14000, 15000, 1000, 7.14],
    ['TCS', 'INE467B01029', 4, 14000, 13200, -800, -5.71],
  ]),
);

const mt4Row = (cells) => `<tr align=right>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
writeFileSync(
  join(dir, 'mt4.html'),
  `<html><head><title>Statement: 1234567 - John Trader</title><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>
<div align=center><div style="font: 20pt Times New Roman"><b>1234567 - John Trader</b></div></div>
<table cellspacing=1 cellpadding=3 border=0>
<tr align=left><td colspan=14><b>Account: 1234567 &nbsp;&nbsp; Name: John Trader &nbsp;&nbsp; Currency: USD</b></td></tr>
<tr align=center><td colspan=14><b>Closed Transactions:</b></td></tr>
<tr align=center bgcolor="#C0C0C0"><td nowrap><b>Ticket</b></td><td nowrap><b>Open Time</b></td><td><b>Type</b></td><td><b>Size</b></td><td><b>Item</b></td><td><b>Price</b></td><td><b>S / L</b></td><td><b>T / P</b></td><td nowrap><b>Close Time</b></td><td><b>Price</b></td><td><b>Commission</b></td><td><b>Taxes</b></td><td><b>Swap</b></td><td><b>Profit</b></td></tr>
${mt4Row(['50010001', '2026.04.07 08:15:00', 'buy', '0.10', 'eurusd', '1.08500', '1.08300', '1.09000', '2026.04.07 10:30:00', '1.08800', '-0.70', '0.00', '-0.20', '30.00'])}
${mt4Row(['50010002', '2026.04.07 11:00:00', 'sell', '0.20', 'usdjpy', '150.200', '150.600', '149.500', '2026.04.07 15:45:00', '149.900', '-1.40', '0.00', '0.00', '40.03'])}
${mt4Row(['50010003', '2026.04.08 09:00:00', 'buy', '0.05', 'xauusd', '2300.50', '0.00', '0.00', '2026.04.08 12:00:00', '2295.50', '-0.35', '0.00', '-0.60', '-25.00'])}
<tr align=right><td>50010004</td><td>2026.04.08 00:00:00</td><td>balance</td><td colspan=10>Deposit</td><td>1 000.00</td></tr>
<tr align=right><td colspan=10><b>Closed P/L:</b></td><td><b>-2.45</b></td><td><b>0.00</b></td><td><b>-0.80</b></td><td><b>45.03</b></td></tr>
<tr align=center><td colspan=14><b>Open Trades:</b></td></tr>
<tr align=center bgcolor="#C0C0C0"><td><b>Ticket</b></td><td><b>Open Time</b></td><td><b>Type</b></td><td><b>Size</b></td><td><b>Item</b></td><td><b>Price</b></td><td><b>S / L</b></td><td><b>T / P</b></td><td><b>Price</b></td><td><b>Commission</b></td><td><b>Taxes</b></td><td><b>Swap</b></td><td><b>Profit</b></td></tr>
</table></body></html>`,
);

const mt5Row = (cells) => `<tr align=right><td class="hidden" colspan=8></td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const mt5Html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-16LE"><title>Trade History Report</title></head><body>
<table>
<tr><th colspan=13><div style="font: 10pt Tahoma"><b>Trade History Report</b></div></th></tr>
<tr><th colspan=3>Name:</th><th colspan=10><b>John Trader</b></th></tr>
<tr><th colspan=13><b>Positions</b></th></tr>
<tr><th>Time</th><th>Position</th><th>Symbol</th><th>Type</th><th>Volume</th><th>Price</th><th>S / L</th><th>T / P</th><th>Time</th><th>Price</th><th>Commission</th><th>Swap</th><th>Profit</th></tr>
${mt5Row(['2026.04.07 09:00:00', '700100', 'EURUSD.m', 'buy', '0.10', '1.08500', '1.08300', '1.09000', '2026.04.07 12:00:00', '1.08800', '-0.70', '0.00', '30.00'])}
${mt5Row(['2026.04.08 10:30:00', '700101', 'GBPUSD.m', 'sell', '0.20', '1.26500', '1.26800', '1.26000', '2026.04.08 16:00:00', '1.26700', '-1.40', '-0.35', '-40.00'])}
${mt5Row(['2026.04.09 08:00:00', '700102', 'XAUUSD.m', 'buy', '0.02', '2310.00', '0.00', '0.00', '2026.04.09 14:00:00', '2318.50', '-0.14', '0.00', '17.00'])}
<tr><th colspan=13><b>Orders</b></th></tr>
<tr><th>Open Time</th><th>Order</th><th>Symbol</th><th>Type</th></tr>
</table></body></html>`;
writeFileSync(join(dir, 'mt5.html'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(mt5Html, 'utf16le')]));
console.log('fixtures written to', dir);
