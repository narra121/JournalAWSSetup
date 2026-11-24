// Regenerates the binary/HTML fixtures: node src/features/import/fixtures/generate.mjs
// (CSV fixtures are plain text and edited by hand.) groww.xlsx, upstox_trade.xlsx, angelone_trades.xlsx, mt5.xlsx,
// mt4_volume.html and dhan_gtr.csv copy the header rows of real exports with invented values; dhan.csv, upstox.csv
// and angelone.csv are earlier guessed layouts the parsers still accept.
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

// MetaTrader 5 writes every XML part of its XLSX as UTF-16LE with a byte-order mark.
const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

function zip(files, encode = (s) => Buffer.from(s, 'utf8')) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = encode(content);
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
function xlsx(sheetName, rows, encode) {
  const sheetRows = rows
    .map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (typeof v === 'number' ? `<c r="${colName(j)}${i + 1}"><v>${v}</v></c>` : `<c r="${colName(j)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`)
    .join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  }, encode);
}

writeFileSync(
  join(dir, 'groww.xlsx'),
  xlsx('Order History', [
    ['Name', 'John Trader'],
    ['Unique Client Code', '1234567890'],
    ['Order History for stocks from 01-04-2026 to 30-04-2026'],
    [],
    ['Stock name', 'Symbol', 'ISIN', 'Type', 'Quantity', 'Value', 'Exchange', 'Exchange Order Id', 'Execution date and time', 'Order status'],
    ['Wipro Ltd', 'WIPRO', 'INE075A01022', 'BUY', 20, 9000, 'NSE', '1100000000200001', '07-04-2026 10:15 AM', 'Executed'],
    ['Wipro Ltd', 'WIPRO', 'INE075A01022', 'SELL', 20, 9200, 'NSE', '1100000000200002', '07-04-2026 02:05 PM', 'Executed'],
    ['Zomato Ltd', 'ZOMATO', 'INE758T01015', 'BUY', 100, 22000, 'NSE', '1100000000200003', '08-04-2026 09:30 AM', 'Cancelled'],
    ['Suzlon Energy Ltd', 'SUZLON', 'INE040H01021', 'BUY', 500, 27500, 'NSE', '1100000000200004', '08-04-2026 11:00 AM', 'Executed'],
    ['Suzlon Energy Ltd', 'SUZLON', 'INE040H01021', 'SELL', 500, 27000, 'NSE', '1100000000200005', '08-04-2026 01:20 PM', 'Executed'],
  ]),
);

writeFileSync(
  join(dir, 'upstox_trade.xlsx'),
  xlsx('TRADE', [
    ['UPSTOX SECURITIES PRIVATE LIMITED'],
    ['UCC'],
    ['Report Time Period', '28-08-2026 To 04-09-2026'],
    ['Generated On', '2026-09-04 00:07:10'],
    ['Date', 'Company', 'Amount', 'Exchange', 'Segment', 'Scrip Code', 'Instrument Type', 'Strike Price', 'Expiry', 'Trade Num', 'Trade Time', 'Side', 'Quantity', 'Price'],
    ['2026-08-28 00:00:00', 'GNG Electronics Limited', 1243.7, 'NSE', 'EQ', '544455', 'Equity', 0, '', '204257888', '11:52:13', 'Buy', 2, 621.85],
    ['2026-08-28 00:00:00', 'GNG Electronics Limited', 1865.7, 'NSE', 'EQ', '544455', 'Equity', 0, '', '204257889', '11:52:13', 'Buy', 3, 621.9],
    ['2026-08-28 00:00:00', 'GNG Electronics Limited', 3103, 'NSE', 'EQ', '544455', 'Equity', 0, '', '204288620', '11:53:57', 'Sell', 5, 620.6],
    ['2026-08-28 00:00:00', 'NIFTY', 2470, 'FON', 'FO', 'NIFTY', 'European Put', 24000, '01-09-2026', '1468483', '11:37:22', 'Buy', 65, 38],
    ['2026-08-28 00:00:00', 'NIFTY', 2385.5, 'FON', 'FO', 'NIFTY', 'European Put', 24000, '01-09-2026', '1489993', '11:38:40', 'Sell', 65, 36.7],
    ['2026-08-28 00:00:00', 'BSX', 1816, 'FOB', 'FO', 'BSX', 'European Call', 78300, '03-09-2026', '910080', '11:49:32', 'Sell', 20, 90.8],
    ['2026-08-28 00:00:00', 'BSX', 1801, 'FOB', 'FO', 'BSX', 'European Call', 78300, '03-09-2026', '903090', '11:46:39', 'Buy', 20, 90.05],
    ['From 19-Jul-2025, our Broking operations were transitioned from RKSV Commodities India Pvt. Ltd. to Upstox Securities Pvt. Ltd.'],
  ]),
);

const angelHeader = ['Scrip/Contract', 'Buy/Sell', 'Buy Price', 'Sell Price', 'Quantity', 'Brokerage', 'GST', 'STT', 'Sebi Tax', 'Exchange Turnover Charges', 'Stamp Duty', 'Other Charges', 'IPFT Charges', 'Order Type', 'Segment', 'Exchange', 'Order ID', 'Trade ID', 'Date'];
const angel = (scrip, side, price, qty, seg, exch, orderId, tradeId) =>
  [scrip, side, side === 'Buy' ? price : '', side === 'Sell' ? price : '', qty, 0, 0.1, 0, 0, 0.05, 0, 0, 0, 'Intraday', seg, exch, orderId, tradeId, '2026-08-27 00:00:00'];
writeFileSync(
  join(dir, 'angelone_trades.xlsx'),
  xlsx('TradesAndCharges', [
    ['ClientCode', ''],
    ['DateOfDownload', '2026-09-04'],
    ['Charges Summary'],
    ['Total Trades', '3'],
    ['TradeBook And Charges'],
    angelHeader,
    // listed sell first; the trade numbers show the buy came first
    angel('VA TECH WABAG LTD', 'Sell', 2158.2, 1, 'CAPITAL', 'NSE', '1300000034896423', '603956514'),
    angel('VA TECH WABAG LTD', 'Buy', 2163, 1, 'CAPITAL', 'NSE', '1300000034043618', '603859766'),
    angel('OPTIDX NIFTY Aug 25 2026 24150.00 PE (BT)', 'Buy', 17.65, 65, 'FUTURES', 'NSE', '2700000096568170', '8234904'),
    angel('OPTIDX NIFTY Aug 25 2026 24150.00 PE (BT)', 'Sell', 32.9, 65, 'FUTURES', 'NSE', '2700000117831547', '9219102'),
    // per-order brokerage row: no quantity, no trade id
    ['OPTIDX NIFTY Aug 25 2026 24150.00 PE (BT)', 'Buy', 0, '', 0, 20, 3.6, 0, 0, 0, 0, 0, 0, 'Intraday', 'FUTURES', 'NSE', '2700000096568170', '', '2026-08-27 00:00:00'],
    angel('BSXOPT SENSEX Aug 27 2026 77600.00 CE (BT)', 'Buy', 54.75, 40, 'FUTURES', 'BSE', '1787805984776337810', '17332330'),
    angel('BSXOPT SENSEX Aug 27 2026 77600.00 CE (BT)', 'Sell', 44.2, 40, 'FUTURES', 'BSE', '1787807596841291357', '19769610'),
    ['NOTE: Charges are as per the contract notes'],
  ]),
);

writeFileSync(
  join(dir, 'mt5.xlsx'),
  xlsx('Sheet1', [
    ['Trade History Report'],
    ['Name:', 'John Trader'],
    ['Positions'],
    ['Time', 'Position', 'Symbol', 'Type', 'Volume', 'Price', 'S / L', 'T / P', 'Time', 'Price', 'Commission', 'Swap', 'Profit'],
    ['2026.07.31 14:51:06', '1688228478', 'XAUUSD', 'buy', 0.05, 4053.41, 0, 0, '2026.07.31 15:20:53', 4054.3, 0, 0, 4.45],
    ['2026.08.03 09:00:00', '1688234031', 'XAUUSD', 'sell', 0.1, 4060, 4062, 0, '2026.08.03 10:00:00', 4062, -0.5, 0, -20],
    ['Orders'],
    ['Open Time', 'Order', 'Symbol', 'Type', 'Volume', '', 'Price', 'S / L', 'T / P', 'Time', '', 'State', 'Comment'],
    ['Results'],
    ['Total Net Profit:', '', '', -16.05],
  ], utf16),
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

// Newer MT4 builds head the lots column "Volume"; a deleted pending order is listed with its type and no fill.
writeFileSync(
  join(dir, 'mt4_volume.html'),
  `<html><head><title>Statement: 7654321</title></head><body><table>
<tr align=center><td colspan=14><b>Closed Transactions:</b></td></tr>
<tr align=center><td>Ticket</td><td>Open Time</td><td>Type</td><td>Volume</td><td>Item</td><td>Price</td><td>S / L</td><td>T / P</td><td>Close Time</td><td>Price</td><td>Commission</td><td>Taxes</td><td>Swap</td><td>Profit</td></tr>
${mt4Row(['1087504226', '2025.10.21 06:18:56', 'buy', '0.10', 'gold', '4 358.09', '0.00', '0.00', '2025.10.21 06:22:03', '4 356.54', '0.00', '0.00', '0.00', '-15.50'])}
<tr align=right><td>1087504300</td><td>2025.10.21 07:00:00</td><td>buy limit</td><td>0.10</td><td>gold</td><td>4 300.00</td><td>0.00</td><td>0.00</td><td>2025.10.21 23:59:59</td><td>4 340.00</td><td colspan=4>deleted [good for day]</td></tr>
${mt4Row(['1087504275', '2025.10.21 06:31:07', 'sell', '0.20', 'gold', '4 345.34', '0.00', '0.00', '2025.10.21 06:37:34', '4 339.00', '0.00', '0.00', '0.00', '126.80'])}
<tr align=right><td colspan=10><b>Closed P/L:</b></td><td>0.00</td><td>0.00</td><td>0.00</td><td>111.30</td></tr>
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
