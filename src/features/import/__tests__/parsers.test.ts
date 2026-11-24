import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseImport } from '../service';
import { sourcesMetadata } from '../registry';

const FIX = join(__dirname, '..', 'fixtures');
const load = (name: string) => readFileSync(join(FIX, name)).toString('base64');
const run = (name: string, source: any = 'auto', extra: object = {}) => parseImport({ source, fileName: name, contentBase64: load(name), ...extra });
const sym = (r: ReturnType<typeof run>, s: string) => r.trades.find((t) => t.symbol === s)!;
const text = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('broker fixtures', () => {
  it('zerodha tradebook: round trips, options charges, unmatched + open warnings', () => {
    const r = run('zerodha.csv');
    expect(r.detectedSource).toBe('zerodha');
    expect(r.trades.map((t) => t.symbol)).toEqual(['RELIANCE', 'INFY', 'NIFTY2641324000CE']);
    expect(r.warnings.join(' ')).toMatch(/1 closing fills had no opening fill/);
    expect(r.warnings.join(' ')).toMatch(/1 positions are still open/);

    const opt = sym(r, 'NIFTY2641324000CE');
    expect(opt).toMatchObject({ assetClass: 'options', optionType: 'call', strike: 24000, expiry: '2026-04-13', underlying: 'NIFTY', quantity: 75, entryPrice: 120.5, exitPrice: 150.25, grossPnl: 2231.25, openDate: '2026-04-08T04:00:10.000Z' });
    // Hand-computed: brokerage 2×₹20; STT 0.15% × 11,268.75 (2026-04-01 rate); NSE options 0.0355299% × 20,306.25 (FA73061, from 2026-03-01); IPFT ₹0.01/cr; SEBI ₹10/cr; stamp 0.003% × 9,037.50; GST 18% on brokerage+exchange+SEBI.
    expect(opt.charges).toEqual({ brokerage: 40, stt: 16.9, exchange: 7.21, sebi: 0.02, stamp: 0.27, gst: 8.5, other: 0 });
    expect(opt.fees).toBe(72.9);
    expect(opt.pnl).toBe(2158.35);
    expect(opt.chargesEstimated).toBe(true);
    expect(opt.externalId).toBe('zerodha:41000006:41000007');

    const infy = sym(r, 'INFY');
    expect(infy).toMatchObject({ side: 'BUY', quantity: 10, entryPrice: 1500, exitPrice: 1510, grossPnl: 100, outcome: 'TP' });
    expect(infy.fees).toBeCloseTo(15.99, 1);
    const rel = sym(r, 'RELIANCE');
    expect(rel.grossPnl).toBe(100);
    expect(rel.charges!.stt).toBe(14.1); // delivery: 0.1% on both sides of 7,000 + 7,100
    expect(rel.charges!.brokerage).toBe(0);
  });

  it('dhan: scale-out is one trade with VWAP exit', () => {
    const r = run('dhan.csv');
    expect(r.detectedSource).toBe('dhan');
    expect(r.trades).toHaveLength(2);
    expect(sym(r, 'SBIN')).toMatchObject({ grossPnl: 650, entryPrice: 800, exitPrice: 806.5 });
    expect(sym(r, 'TATASTEEL')).toMatchObject({ quantity: 200, entryPrice: 150, exitPrice: 150.5, grossPnl: 100, fills: 3 });
  });

  it('upstox: equity + futures', () => {
    const r = run('upstox.csv');
    expect(r.detectedSource).toBe('upstox');
    expect(sym(r, 'HDFCBANK')).toMatchObject({ grossPnl: -300, outcome: 'SL' });
    expect(sym(r, 'NIFTY26APRFUT')).toMatchObject({ assetClass: 'futures', grossPnl: 4500, expiry: '2026-04-30' });
  });

  it('angelone: intraday short', () => {
    const r = run('angelone.csv');
    expect(r.detectedSource).toBe('angelone');
    expect(sym(r, 'ITC').grossPnl).toBe(900);
    expect(sym(r, 'ICICIBANK')).toMatchObject({ side: 'SELL', entryPrice: 1100, exitPrice: 1095, grossPnl: 250 });
  });

  it('groww xlsx: price from value, cancelled orders skipped', () => {
    const r = run('groww.xlsx');
    expect(r.detectedSource).toBe('groww');
    expect(r.trades).toHaveLength(2);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(sym(r, 'WIPRO')).toMatchObject({ entryPrice: 450, exitPrice: 460, grossPnl: 200, openDate: '2026-04-07T04:45:00.000Z', closeDate: '2026-04-07T08:35:00.000Z' });
    expect(sym(r, 'SUZLON').grossPnl).toBe(-500);
  });

  it('mt4 detailed statement: costs become fees, balance rows ignored, offset applied', () => {
    const r = run('mt4.html');
    expect(r.detectedSource).toBe('mt4');
    expect(r.trades).toHaveLength(3);
    expect(r.skipped).toBe(0);
    const eur = sym(r, 'EURUSD');
    expect(eur).toMatchObject({ side: 'BUY', quantity: 0.1, grossPnl: 30, fees: 0.9, pnl: 29.1, stopLoss: 1.083, takeProfit: 1.09, assetClass: 'forex', contractMultiplier: 100000, openDate: '2026-04-07T08:15:00.000Z', externalId: 'mt4:50010001' });
    expect(sym(r, 'XAUUSD')).toMatchObject({ assetClass: 'commodity', pnl: -25.95, stopLoss: null });
    expect(r.warnings.join(' ')).toMatch(/server time/);
    const shifted = run('mt4.html', 'mt4', { utcOffsetMinutes: 180 });
    expect(sym(shifted, 'EURUSD').openDate).toBe('2026-04-07T05:15:00.000Z');
  });

  it('mt5 positions report (UTF-16LE html): suffix stripped, swap and commission in fees', () => {
    const r = run('mt5.html');
    expect(r.detectedSource).toBe('mt5');
    expect(r.trades.map((t) => t.symbol)).toEqual(['EURUSD', 'GBPUSD', 'XAUUSD']);
    expect(sym(r, 'GBPUSD')).toMatchObject({ side: 'SELL', fees: 1.75, pnl: -41.75, outcome: 'SL' });
    expect(sym(r, 'EURUSD').externalId).toBe('mt5:700100');
  });

  it('zerodha P&L statement: summary trades dated by the period', () => {
    const r = run('zerodha_pnl.xlsx');
    expect(r.detectedSource).toBe('zerodha_pnl');
    expect(r.trades).toHaveLength(2);
    expect(sym(r, 'INFY')).toMatchObject({ quantity: 10, entryPrice: 1400, exitPrice: 1500, grossPnl: 1000 });
    expect(sym(r, 'TCS').grossPnl).toBe(-800);
    expect(r.warnings.join(' ')).toMatch(/per-symbol/);
  });

  it('every fixture file has a parser source and the registry lists all seven required sources', () => {
    const ids = sourcesMetadata().map((s) => s.id);
    for (const id of ['zerodha', 'dhan', 'upstox', 'angelone', 'groww', 'mt4', 'mt5']) expect(ids).toContain(id);
    const files = readdirSync(FIX).filter((f) => !f.endsWith('.mjs'));
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('auto-detect never confuses fixtures', () => {
    const expected: Record<string, string> = {
      'zerodha.csv': 'zerodha', 'dhan.csv': 'dhan', 'upstox.csv': 'upstox', 'angelone.csv': 'angelone', 'groww.xlsx': 'groww', 'mt4.html': 'mt4', 'mt5.html': 'mt5', 'zerodha_pnl.xlsx': 'zerodha_pnl',
      'dhan_gtr.csv': 'dhan', 'upstox_trade.xlsx': 'upstox', 'angelone_trades.xlsx': 'angelone', 'mt4_volume.html': 'mt4', 'mt5.xlsx': 'mt5',
    };
    for (const [f, id] of Object.entries(expected)) expect(run(f).detectedSource).toBe(id);
  });
});

describe('real export layouts', () => {
  const total = (r: ReturnType<typeof run>, k: 'pnl' | 'grossPnl' | 'fees') => Math.round(r.trades.reduce((a, t) => a + t[k], 0) * 100) / 100;

  it('dhan global transaction report: a BUY and a SELL per row, the report\'s own charges, net = Gross Amount column', () => {
    const r = run('dhan_gtr.csv');
    expect(r.detectedSource).toBe('dhan');
    expect(r.trades.map((t) => t.symbol)).toEqual(['NIFTY 07 APR 2026 23000 CE', 'RELIANCE INDUSTRIES', 'WIPRO 28 APR 2026 FUT', 'CRUDEOIL 16 APR 2026 9000 PE']);
    expect(sym(r, 'NIFTY 07 APR 2026 23000 CE')).toMatchObject({ assetClass: 'options', optionType: 'call', strike: 23000, expiry: '2026-04-07', underlying: 'NIFTY', quantity: 150, entryPrice: 100, exitPrice: 110, grossPnl: 1500, fees: 70.23, pnl: 1429.77, chargesEstimated: false, openDate: '2026-03-31T18:30:00.000Z' });
    expect(sym(r, 'RELIANCE INDUSTRIES')).toMatchObject({ assetClass: 'stock', side: 'BUY', entryPrice: 1300, exitPrice: 1340, grossPnl: 400, fees: 29.56, closeDate: '2026-04-05T18:30:00.000Z' });
    expect(sym(r, 'WIPRO 28 APR 2026 FUT')).toMatchObject({ assetClass: 'futures', expiry: '2026-04-28', grossPnl: 3000 });
    expect(sym(r, 'CRUDEOIL 16 APR 2026 9000 PE').grossPnl).toBe(960);
    // Sum of the Gross Amount column (sell − buy − charges) of the five rows.
    expect(total(r, 'pnl')).toBe(5470.43);
    expect(r.warnings.join(' ')).toMatch(/no trade times/);
    expect(r.warnings.join(' ')).not.toMatch(/estimated/);
  });

  it('upstox trade report: time from Trade Time, F&O contract from its columns, FOB/BSX → BSE SENSEX', () => {
    const r = run('upstox_trade.xlsx');
    expect(r.detectedSource).toBe('upstox');
    expect(r.trades).toHaveLength(3);
    expect(sym(r, 'GNG ELECTRONICS LIMITED')).toMatchObject({ quantity: 5, grossPnl: -6.4, fills: 3, openDate: '2026-08-28T06:22:13.000Z', closeDate: '2026-08-28T06:23:57.000Z' });
    expect(sym(r, 'NIFTY 01 SEP 2026 24000 PE')).toMatchObject({ assetClass: 'options', optionType: 'put', strike: 24000, expiry: '2026-09-01', grossPnl: -84.5, openDate: '2026-08-28T06:07:22.000Z' });
    // The sell is listed first but happened later.
    expect(sym(r, 'SENSEX 03 SEP 2026 78300 CE')).toMatchObject({ side: 'BUY', entryPrice: 90.05, exitPrice: 90.8, grossPnl: 15, underlying: 'SENSEX' });
    expect(total(r, 'grossPnl')).toBe(-75.9);
  });

  it('angel one trades and charges: price by side, spelled-out contracts, same-day fills in trade-number order', () => {
    const r = run('angelone_trades.xlsx');
    expect(r.detectedSource).toBe('angelone');
    expect(r.trades).toHaveLength(3);
    expect(sym(r, 'VA TECH WABAG LTD')).toMatchObject({ side: 'BUY', entryPrice: 2163, exitPrice: 2158.2, grossPnl: -4.8, openDate: '2026-08-26T18:30:00.000Z' });
    expect(sym(r, 'NIFTY 25 AUG 2026 24150 PE')).toMatchObject({ assetClass: 'options', optionType: 'put', strike: 24150, expiry: '2026-08-25', grossPnl: 991.25 });
    expect(sym(r, 'SENSEX 27 AUG 2026 77600 CE')).toMatchObject({ assetClass: 'options', underlying: 'SENSEX', grossPnl: -422 });
    expect(r.skipped).toBe(2);
    expect(r.warnings.join(' ')).toMatch(/no times/);
  });

  it('angel one csv dates are month first (8/5/26 0:00)', () => {
    const csv = 'Scrip/Contract,Buy/Sell,Buy Price,Sell Price,Quantity,Order ID,Trade ID,Date,Exchange,Segment\nITC LTD,Buy,400,,10,11,101,8/5/26 0:00,NSE,CAPITAL\nITC LTD,Sell,,410,10,12,102,8/5/26 0:00,NSE,CAPITAL\n';
    const r = parseImport({ source: 'auto', fileName: 'trades.csv', contentBase64: text(csv) });
    expect(r.detectedSource).toBe('angelone');
    expect(r.trades[0]).toMatchObject({ symbol: 'ITC LTD', grossPnl: 100, openDate: '2026-08-04T18:30:00.000Z' });
    // A four-digit year stays day first.
    const dmy = parseImport({ source: 'auto', fileName: 'trades.csv', contentBase64: text(csv.replace(/8\/5\/26 0:00/g, '13/04/2026')) });
    expect(dmy.trades[0].openDate).toBe('2026-04-12T18:30:00.000Z');
  });

  it('mt4 statement headed "Volume": read like "Size", deleted pending orders are not trades', () => {
    const r = run('mt4_volume.html');
    expect(r.detectedSource).toBe('mt4');
    expect(r.trades.map((t) => t.externalId)).toEqual(['mt4:1087504226', 'mt4:1087504275']);
    expect(r.skipped).toBe(0);
    // Closed P/L line of the statement.
    expect(total(r, 'pnl')).toBe(111.3);
  });

  it('mt5 xlsx history with UTF-16LE parts: positions read, net = Total Net Profit', () => {
    const r = run('mt5.xlsx');
    expect(r.detectedSource).toBe('mt5');
    expect(r.trades).toHaveLength(2);
    expect(r.trades[1]).toMatchObject({ side: 'SELL', quantity: 0.1, fees: 0.5, stopLoss: 4062 });
    expect(total(r, 'pnl')).toBe(-16.05);
  });
});

describe('unknown and generic files', () => {
  it('random csv → unknown with a warning and no trades', () => {
    const r = parseImport({ source: 'auto', fileName: 'x.csv', contentBase64: text('a,b,c\n1,2,3\n') });
    expect(r).toMatchObject({ detectedSource: 'unknown', trades: [], skipped: 0 });
    expect(r.warnings[0]).toMatch(/does not match/);
  });

  it('wrong explicit source is rejected, not silently parsed', () => {
    const r = run('zerodha.csv', 'dhan');
    expect(r.detectedSource).toBe('unknown');
    expect(r.warnings[0]).toMatch(/does not look like a Dhan/);
  });

  it('empty and oversized input become warnings', () => {
    expect(parseImport({ source: 'auto', fileName: 'e.csv', contentBase64: '' }).warnings[0]).toMatch(/empty/);
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 'a').toString('base64');
    expect(parseImport({ source: 'auto', fileName: 'b.csv', contentBase64: big }).warnings[0]).toMatch(/4 MB/);
  });

  const generic = 'Instrument,Direction,Lots,Entry Price,Exit Price,Open Time,Close Time,Net P/L\nEURUSD,Buy,1,1.1000,1.1050,2026-04-07 09:00,2026-04-07 11:00,50\nGBPUSD,Sell,2,1.2700,1.2650,2026-04-08 09:00,2026-04-08 11:00,100\n';

  it('generic csv with entry+exit columns is mapped automatically', () => {
    const r = parseImport({ source: 'generic_csv', fileName: 'g.csv', contentBase64: text(generic), utcOffsetMinutes: 0 });
    expect(r.detectedSource).toBe('generic_csv');
    expect(r.trades).toHaveLength(2);
    expect(r.trades[0]).toMatchObject({ symbol: 'EURUSD', side: 'BUY', quantity: 1, openDate: '2026-04-07T09:00:00.000Z' });
  });

  it('generic csv in a zone with summer time reads each row with its own date\'s offset (timeZone wins over utcOffsetMinutes)', () => {
    // London: 7 Apr 2026 is BST (UTC+1), 3 Jan 2026 is GMT (UTC+0). A November upload sends today's offset 0.
    const csv = 'Instrument,Direction,Lots,Entry Price,Exit Price,Open Time,Close Time,Net P/L\nEURUSD,Buy,1,1.1000,1.1050,2026-04-07 09:00,2026-04-07 11:00,50\nGBPUSD,Sell,2,1.2700,1.2650,2026-01-03 09:00,2026-01-03 11:00,100\n';
    const r = parseImport({ source: 'generic_csv', fileName: 'g.csv', contentBase64: text(csv), utcOffsetMinutes: 0, timeZone: 'Europe/London' });
    expect(r.trades.map((t) => t.openDate).sort()).toEqual(['2026-01-03T09:00:00.000Z', '2026-04-07T08:00:00.000Z']);
  });

  it('generic csv needing a mapping returns columns, then parses with the mapping', () => {
    const odd = 'Foo,Bar,Baz,Qux,Quux,Corge,Grault\nEURUSD,Buy,1,1.1,1.2,2026-04-07 09:00,2026-04-07 10:00\n';
    const first = parseImport({ source: 'generic_csv', fileName: 'o.csv', contentBase64: text(odd), utcOffsetMinutes: 0 });
    expect(first.trades).toEqual([]);
    expect(first.columns!.headers).toContain('Qux');
    const mapping = { symbol: 'Foo', side: 'Bar', quantity: 'Baz', entryPrice: 'Qux', exitPrice: 'Quux', openTime: 'Corge', closeTime: 'Grault' };
    const second = parseImport({ source: 'generic_csv', fileName: 'o.csv', contentBase64: text(odd), utcOffsetMinutes: 0, mapping });
    expect(second.trades).toHaveLength(1);
    expect(second.trades[0]).toMatchObject({ symbol: 'EURUSD', entryPrice: 1.1, exitPrice: 1.2, grossPnl: 0.1 });
    expect(second.fileHash).toBe(first.fileHash);
  });
});

describe('generic csv columns (BE-051, BE-052, BE-106)', () => {
  const csv = (header: string, ...rows: string[]) => parseImport({ source: 'generic_csv', fileName: 'g.csv', contentBase64: text([header, ...rows].join('\n') + '\n'), utcOffsetMinutes: 0 });
  const head = 'Symbol,Side,Qty,Entry Price,Exit Price,Open Time,Close Time';

  it('a Net P&L column is not charged the fees a second time', () => {
    const r = csv(`${head},Net P&L,Charges`, 'EURUSD,Buy,1,1.1,1.2,2026-04-07 09:00,2026-04-07 10:00,950,50');
    expect(r.trades[0]).toMatchObject({ grossPnl: 1000, fees: 50, pnl: 950 });
  });

  it('a gross profit column still has the fees taken off', () => {
    const r = csv(`${head},Profit,Charges`, 'EURUSD,Buy,1,1.1,1.2,2026-04-07 09:00,2026-04-07 10:00,1000,50');
    expect(r.trades[0]).toMatchObject({ grossPnl: 1000, fees: 50, pnl: 950 });
  });

  it('a Net P&L column without a fees column is the P&L as it is', () => {
    const r = csv(`${head},Net P&L`, 'EURUSD,Buy,1,1.1,1.2,2026-04-07 09:00,2026-04-07 10:00,950');
    expect(r.trades[0]).toMatchObject({ pnl: 950, fees: 0 });
  });

  it('a signed quantity (SELL -100) is its size, so a winning sell stays a win', () => {
    const r = csv(head, 'XYZ,Sell,-100,50,40,2026-04-07 09:00,2026-04-07 10:00');
    expect(r.trades[0]).toMatchObject({ side: 'SELL', quantity: 100, pnl: 1000, outcome: 'TP' });
  });

  it('a zero quantity is skipped', () => {
    const r = csv(head, 'XYZ,Sell,0,50,40,2026-04-07 09:00,2026-04-07 10:00');
    expect(r.trades).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('negative quantities in a fills file open and close lots like positive ones', () => {
    const fills = 'Symbol,Side,Qty,Price,Time\nABC,Buy,10,100,2026-04-07 09:00\nABC,Sell,-10,110,2026-04-07 10:00';
    const r = parseImport({ source: 'generic_csv', fileName: 'f.csv', contentBase64: text(fills + '\n'), utcOffsetMinutes: 0 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ quantity: 10, pnl: 100 });
  });

  it('a position closed in two rows with the same open, entry and size keeps both rows when there is no id column', () => {
    const r = csv(head, 'XYZ,Buy,50,100,110,2026-04-07 09:00,2026-04-07 10:00', 'XYZ,Buy,50,100,120,2026-04-07 09:00,2026-04-07 11:00');
    expect(r.trades).toHaveLength(2);
    expect(r.trades.map((t) => t.pnl).sort((a, b) => a - b)).toEqual([500, 1000]);
    expect(r.skipped).toBe(0);
  });

  it('identical rows are kept (counted) and get the same ids again when the file is re-parsed', () => {
    const row = 'XYZ,Buy,50,100,110,2026-04-07 09:00,2026-04-07 10:00';
    const a = csv(head, row, row);
    const b = csv(head, row, row);
    expect(a.trades).toHaveLength(2);
    expect(a.trades.map((t) => t.externalId)).toEqual(b.trades.map((t) => t.externalId));
    expect(new Set(a.trades.map((t) => t.externalId)).size).toBe(2);
  });
});

