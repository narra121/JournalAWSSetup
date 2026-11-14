import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const generateText = vi.hoisted(() => vi.fn());
vi.mock('../../../shared/gemini', () => ({ generateText, geminiTimeoutMs: (ms: number) => ms }));

const { handler } = await import('../app.ts');

const jwt = `${btoa(JSON.stringify({ alg: 'RS256' }))}.${btoa(JSON.stringify({ sub: 'user-1' }))}.sig`;
const event = (body: unknown) =>
  ({ headers: { authorization: `Bearer ${jwt}` }, requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) }) as unknown as APIGatewayProxyEventV2;
const reply = (...lines: string[]) => generateText.mockResolvedValueOnce({ text: lines.join('\n'), finishReason: 'STOP' });
const HEADER = 'symbol,side,quantity,openTime,closeTime,entryPrice,exitPrice,stopLoss,takeProfit,pnl';
const call = async (body: unknown) => {
  const res = (await handler(event(body), {} as any, () => undefined)) as any;
  return { status: res.statusCode as number, body: JSON.parse(res.body) };
};

beforeEach(() => generateText.mockReset());

describe('extraction dates (model mocked, cells verbatim)', () => {
  it('cTrader history with only "Closing time": 03/12/2025 is 3 December, seconds kept, open marked missing', async () => {
    reply(
      'TIME_COLUMNS: open=NONE; close=Closing time',
      HEADER,
      'XAUUSD,BUY,0.92,,03/12/2025 08:41:09.075,4220.80,4221.20,0,0,32.20',
      'XAUUSD,BUY,0.60,,03/12/2025 08:52:34.859,4220.93,4228.94,0,0,477.60',
      'XAUUSD,BUY,0.70,,03/12/2025 20:37:00.730,4212.64,4214.23,0,0,107.80',
      'XAUUSD,BUY,0.96,,03/12/2025 20:47:20.652,4213.83,4213.99,0,0,10.56',
      'XAUUSD,BUY,0.35,,03/12/2025 20:47:20.660,4214.00,4213.99,0,0,-2.11',
      'DJIUSD,BUY,1.16,,04/12/2025 10:44:44.574,47888.00,47888.48,0,0,2.78',
    );
    const { status, body } = await call({ imageBase64: 'aGVsbG8=' });
    expect(status).toBe(200);
    const items = body.data.items;
    expect(items.map((t: any) => t.closeDate)).toEqual([
      '2025-12-03T08:41:09.075', '2025-12-03T08:52:34.859', '2025-12-03T20:37:00.730', '2025-12-03T20:47:20.652', '2025-12-03T20:47:20.660', '2025-12-04T10:44:44.574',
    ]);
    for (const t of items) {
      expect(t.openDate).toBe(t.closeDate);
      expect(t).toMatchObject({ openDateMissing: true, closeDateMissing: false, openDateRaw: '', image: 0 });
    }
    expect(items[0]).toMatchObject({ symbol: 'XAUUSD', side: 'BUY', quantity: 0.92, entryPrice: 4220.8, exitPrice: 4221.2, pnl: 32.2, closeDateRaw: '03/12/2025 08:41:09.075' });
    expect(body.data.images).toEqual([
      { image: 0, dateOrder: 'DMY', dateOrderSource: 'default', canSwitch: true, timeColumns: { open: null, close: 'Closing time' } },
    ]);
  });

  it('the close time copied into the open column on every row (seen live) is read as close-only', async () => {
    reply(
      'TIME_COLUMNS: open=Open time; close=Closing time',
      HEADER,
      'XAUUSD,BUY,0.92,03/12/2025 08:41:09.075,03/12/2025 08:41:09.075,4220.80,4221.20,0,0,32.20',
      'DJIUSD,BUY,1.16,04/12/2025 10:44:44.574,04/12/2025 10:44:44.574,47888.00,47888.48,0,0,2.78',
    );
    const { body } = await call({ imageBase64: 'x' });
    expect(body.data.items.map((t: any) => [t.closeDate, t.openDateMissing, t.openDateRaw])).toEqual([
      ['2025-12-03T08:41:09.075', true, ''],
      ['2025-12-04T10:44:44.574', true, ''],
    ]);
    expect(body.data.images[0].timeColumns).toEqual({ open: null, close: 'Closing time' });
  });

  it('a copy into the close column of an open-only table is read as open-only', async () => {
    reply('TIME_COLUMNS: open=Time; close=NONE', HEADER, 'NIFTY,BUY,50,2025-12-03 09:15,2025-12-03 09:15,24000,24050,0,0,2500');
    const { body } = await call({ imageBase64: 'x' });
    expect(body.data.items[0]).toMatchObject({ openDate: '2025-12-03T09:15:00', closeDateMissing: true, openDateMissing: false });
  });

  it('the same table for a user in New York reads month first, from the region, and can be switched', async () => {
    reply('TIME_COLUMNS: open=NONE; close=Closing time', HEADER, 'XAUUSD,BUY,1,,03/12/2025 08:41:09,1,2,0,0,1');
    const { body } = await call({ imageBase64: 'x', timeZone: 'America/New_York' });
    expect(body.data.items[0].closeDate).toBe('2025-03-12T08:41:09');
    expect(body.data.images[0]).toMatchObject({ dateOrder: 'MDY', dateOrderSource: 'region', canSwitch: true });
  });

  it('DD/MM with a day above 12 anywhere decides every row, even for a US user', async () => {
    reply(HEADER, 'EURUSD,SELL,1,02/11/2025 09:00,02/11/2025 10:30,1.1,1.09,0,0,10', 'EURUSD,BUY,1,13/11/2025 09:00,13/11/2025 09:45,1.1,1.11,0,0,10');
    const { body } = await call({ imageBase64: 'x', timeZone: 'America/Chicago' });
    expect(body.data.items.map((t: any) => [t.openDate, t.closeDate])).toEqual([
      ['2025-11-02T09:00:00', '2025-11-02T10:30:00'],
      ['2025-11-13T09:00:00', '2025-11-13T09:45:00'],
    ]);
    expect(body.data.images[0]).toMatchObject({ dateOrder: 'DMY', dateOrderSource: 'evidence', canSwitch: false, timeColumns: { open: 'Open time', close: 'Close time' } });
  });

  it('MM/DD with 12-hour clocks (TradingView, Tradovate) for an Indian user', async () => {
    reply(
      'TIME_COLUMNS: open=Entry Time; close=Exit Time',
      HEADER,
      'MNQ,BUY,2,"11/13/2025, 9:31:05 AM","11/13/2025, 10:02:40 AM",21000,21010.5,0,0,42',
      'MNQ,SELL,1,11/14/2025 12:15 PM,11/14/2025 12:45 PM,21050,21040,0,0,20',
    );
    const { body } = await call({ imageBase64: 'x', timeZone: 'Asia/Kolkata' });
    expect(body.data.items.map((t: any) => [t.openDate, t.closeDate])).toEqual([
      ['2025-11-13T09:31:05', '2025-11-13T10:02:40'],
      ['2025-11-14T12:15:00', '2025-11-14T12:45:00'],
    ]);
    expect(body.data.images[0]).toMatchObject({ dateOrder: 'MDY', dateOrderSource: 'evidence', timeColumns: { open: 'Entry Time', close: 'Exit Time' } });
  });

  it('an open-only table keeps the open time and marks the close missing', async () => {
    reply('TIME_COLUMNS: open=Open time; close=NONE', HEADER, 'NIFTY,BUY,50,2025.12.03 09:15:00,,24000,24050,0,0,2500');
    const { body } = await call({ imageBase64: 'x' });
    expect(body.data.items[0]).toMatchObject({ openDate: '2025-12-03T09:15:00', closeDate: '2025-12-03T09:15:00', openDateMissing: false, closeDateMissing: true });
    expect(body.data.images[0].timeColumns).toEqual({ open: 'Open time', close: null });
  });

  it('a row with no readable date keeps empty dates for the review to flag, instead of being dropped', async () => {
    reply(HEADER, 'AAPL,BUY,10,,,150,155,0,0,50');
    const { body } = await call({ imageBase64: 'x' });
    expect(body.data.items[0]).toMatchObject({ symbol: 'AAPL', openDate: '', closeDate: '', openDateMissing: false, closeDateMissing: false });
  });

  it('each image of a request gets its own date order', async () => {
    reply(HEADER, 'A,BUY,1,13/11/2025 09:00,13/11/2025 10:00,1,2,0,0,1');
    reply(HEADER, 'B,BUY,1,11/13/2025 09:00,11/13/2025 10:00,1,2,0,0,1');
    const { body } = await call({ images: ['x', 'y'] });
    expect(body.data.items.map((t: any) => [t.symbol, t.image, t.openDate])).toEqual([['A', 0, '2025-11-13T09:00:00'], ['B', 1, '2025-11-13T09:00:00']]);
    expect(body.data.images.map((d: any) => [d.image, d.dateOrder])).toEqual([[0, 'DMY'], [1, 'MDY']]);
  });

  it('pasted text goes through the same reading (Zerodha style DD-MM-YYYY)', async () => {
    reply('TIME_COLUMNS: open=Order Execution Time; close=NONE', HEADER, 'INFY,SELL,10,"05-11-2025 10:15:30",,1500,1490,0,0,100', 'INFY,BUY,10,"25-11-2025 14:01:00",,1490,1500,0,0,100');
    const { status, body } = await call({ textContent: 'symbol,trade_type,quantity,order_execution_time\nINFY,sell,10,05-11-2025 10:15:30', timeZone: 'Asia/Kolkata' });
    expect(status).toBe(200);
    expect(body.meta.source).toBe('text');
    expect(body.data.items.map((t: any) => t.openDate)).toEqual(['2025-11-05T10:15:30', '2025-11-25T14:01:00']);
    expect(body.data.items[0].closeDateMissing).toBe(true);
    expect(body.data.images[0]).toMatchObject({ dateOrder: 'DMY', dateOrderSource: 'evidence' });
  });

  it('an old-style JSON reply still parses through the same date reading', async () => {
    generateText.mockResolvedValueOnce({ text: JSON.stringify([{ symbol: 'X', side: 'BUY', quantity: 1, openDate: '2025-08-20T10:00:00', closeDate: '2025-08-20T11:00:00', entryPrice: 1, exitPrice: 2, pnl: 1 }]) });
    const { body } = await call({ imageBase64: 'x' });
    expect(body.data.items[0]).toMatchObject({ openDate: '2025-08-20T10:00:00', closeDate: '2025-08-20T11:00:00' });
  });

  it('the prompt asks for cells verbatim and never for the model to complete or reorder dates', async () => {
    reply(HEADER);
    await call({ imageBase64: 'x' });
    const prompt = generateText.mock.calls[0][0].parts[0].text as string;
    expect(prompt).toMatch(/EXACTLY as it is written/);
    expect(prompt).toMatch(/NEVER reorder day and month/);
    expect(prompt).not.toMatch(/CurrentYear|DATE COMPLETION/);
  });

  it('a failed model call names no vendor in the processing details', async () => {
    generateText.mockRejectedValueOnce(new Error('Gemini API error: 500 Internal')).mockResolvedValueOnce({ text: `${HEADER}\nA,BUY,1,,2025-01-01 10:00,1,2,0,0,1` });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { body } = await call({ images: ['x', 'y'] });
    err.mockRestore();
    const details = JSON.stringify(body.meta.processingDetails);
    expect(details).toContain('AI extraction failed');
    expect(details).not.toMatch(/gemini/i);
  });
});
