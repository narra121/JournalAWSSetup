import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectsCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(tradeId: string, body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'PUT /trades/{tradeId}', rawPath: `/trades/${tradeId}`, rawQueryString: '',
    headers: { authorization: `Bearer ${makeJwt('user-1')}`, ...((overrides as any).headers || {}) },
    pathParameters: { tradeId },
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'PUT', path: `/trades/${tradeId}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'PUT /trades/{tradeId}', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingTrade = {
  userId: 'user-1', tradeId: 'trade-1', symbol: 'AAPL', side: 'BUY', quantity: 100,
  entryPrice: 150, exitPrice: 160, openDate: '2024-06-15', accountId: 'acc-1', images: [],
};

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  // A fresh item per read, like DynamoDB: the handler edits the item it reads, and a request that changes nothing writes nothing.
  ddbMock.on(GetCommand).callsFake(() => ({ Item: { ...existingTrade } }));
  ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, updatedAt: '2024-06-16T00:00:00Z' } });
  ddbMock.on(PutCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(DeleteObjectsCommand).resolves({});
});

describe('update-trade handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('updates a trade and returns 200', async () => {
    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trade).toBeDefined();
  });

  it('recalculates PnL for BUY trade when entry/exit prices change', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, pnl: undefined } });
    ddbMock.on(UpdateCommand).callsFake((input) => {
      // Return the merged values
      return { Attributes: { ...existingTrade, entryPrice: 100, exitPrice: 200, pnl: 10000 } };
    });

    const res = await handler(makeEvent('trade-1', { entryPrice: 100, exitPrice: 200 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('uses provided PnL when passed in request body', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, pnl: 999 } });

    const res = await handler(makeEvent('trade-1', { pnl: 999 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
  });

  it('handles partial closes with FIFO logic', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, partialCloses: [] } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade } });

    const res = await handler(makeEvent('trade-1', {
      partialCloses: [{ quantity: 50, exitPrice: 170, time: '2024-06-16T00:00:00Z' }],
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
  });

  it('creates additional trades for multiple accountIds', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade } });

    const res = await handler(makeEvent('trade-1', {
      accountIds: ['acc-1', 'acc-2', 'acc-3'],
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should have created 2 additional trades (acc-2, acc-3)
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(2);
  });

  const written = () => {
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    const names = input.ExpressionAttributeNames as Record<string, string>;
    const values = input.ExpressionAttributeValues as Record<string, any>;
    return Object.fromEntries(Object.entries(names).map(([n, field]) => [field, values[`:${field}`]]));
  };

  describe('partial updates leave omitted fields unchanged (BE-R10)', () => {
    const stored = { ...existingTrade, pnl: 123.45, netPnl: 120, riskRewardRatio: 2.5, riskAmount: 0, images: [] };

    it('a notes-only edit writes only the notes and updatedAt, so accountId, pnl, netPnl and riskRewardRatio stay as stored (BE-032)', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored } });
      await handler(makeEvent('trade-1', { tradeNotes: 'new note' }), {} as any, () => {});
      expect(Object.keys(written()).sort()).toEqual(['tradeNotes', 'updatedAt']);
    });

    it('recomputes pnl only when an input of the formula changes', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored } });
      await handler(makeEvent('trade-1', { exitPrice: 170 }), {} as any, () => {});
      expect(written().pnl).toBe(2000);
    });

    it('an explicit pnl wins over the formula, and null stays null', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored } });
      await handler(makeEvent('trade-1', { exitPrice: 170, pnl: 5 }), {} as any, () => {});
      expect(written().pnl).toBe(5);
      ddbMock.resetHistory();
      await handler(makeEvent('trade-1', { pnl: null }), {} as any, () => {});
      expect(written().pnl).toBeNull();
    });

    it('moves the trade only when accountIds / accountId is sent', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored } });
      await handler(makeEvent('trade-1', { accountIds: ['acc-9'] }), {} as any, () => {});
      expect(written().accountId).toBe('acc-9');
    });
  });

  describe('tags (BE-E3)', () => {
    it('stores up to 10 tags of at most 24 characters', async () => {
      const res = (await handler(makeEvent('trade-1', { tags: ['breakout', 'a+'] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(written().tags).toEqual(['breakout', 'a+']);
    });

    it('400 for 11 tags or a tag longer than 24 characters, and for a null body', async () => {
      expect(((await handler(makeEvent('trade-1', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), {} as any, () => {})) as any).statusCode).toBe(400);
      expect(((await handler(makeEvent('trade-1', { tags: ['x'.repeat(25)] }), {} as any, () => {})) as any).statusCode).toBe(400);
      const nul = makeEvent('trade-1', null);
      expect(((await handler(nul, {} as any, () => {})) as any).statusCode).toBe(400);
    });
  });

  describe('images', () => {
    it('keeps an image the client sends back as received (id = key) and does not delete it', async () => {
      const key = 'images/user-1/trade-1/a.png';
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, images: [{ id: 'img-a', key }] } });
      await handler(makeEvent('trade-1', { images: [{ id: key, key }] }), {} as any, () => {});
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
      expect((written().images as any[])[0]).toMatchObject({ id: 'img-a', key });
    });

    it("drops a key under another user's prefix instead of attaching it", async () => {
      await handler(makeEvent('trade-1', { images: [{ id: 'x', url: 'images/user-2/t/secret.png' }] }), {} as any, () => {});
      expect(written().images).toBeUndefined();
    });

    it('attaches an uploaded key under the caller prefix, drops foreign keys, and caps images at 6', async () => {
      await handler(makeEvent('trade-1', { images: [{ id: 'n1', key: 'images/user-1/upload/a.png' }, { id: 'n2', key: 'images/user-2/upload/b.png' }] }), {} as any, () => {});
      expect((written().images as any[]).map((i) => i.key)).toEqual(['images/user-1/upload/a.png']);
      const seven = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, key: `images/user-1/upload/${i}.png` }));
      expect(((await handler(makeEvent('trade-1', { images: seven }), {} as any, () => {})) as any).statusCode).toBe(400);
    });

    it('never deletes objects outside the caller prefix', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, images: [{ id: 'old', key: 'images/user-2/t/other.png' }] } });
      await handler(makeEvent('trade-1', { images: [] }), {} as any, () => {});
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    });

    it('rejects unsupported inline types and oversized inline images with 400', async () => {
      const bad = (await handler(makeEvent('trade-1', { images: [{ base64Data: 'data:application/pdf;base64,AAAA' }] }), {} as any, () => {})) as any;
      expect(bad.statusCode).toBe(400);
      const big = 'data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024 + 10).toString('base64');
      const res = (await handler(makeEvent('trade-1', { images: [{ base64Data: big }] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent('trade-1', { symbol: 'MSFT' });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when tradeId is missing', async () => {
    const event = makeEvent('trade-1', { symbol: 'MSFT' });
    event.pathParameters = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent('trade-1', undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 when trade does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('nonexistent', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 on ConditionalCheckFailedException', async () => {
    const error = new Error('Conditional check failed');
    (error as any).name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(error);

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB GetCommand fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
  });

  it('returns 500 when DynamoDB UpdateCommand fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('Update failed'));

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
  });

  // ── JSON / Body errors ────────────────────────────────────────

  it('returns 400 when body contains invalid JSON', async () => {
    const event = makeEvent('trade-1', undefined);
    event.body = '{not valid json}';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // ── S3 image errors ───────────────────────────────────────────

  it('returns 500 when S3 PutObjectCommand fails while uploading a new image', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('S3 upload failed'));

    const res = await handler(makeEvent('trade-1', {
      images: [{ base64Data: 'data:image/png;base64,iVBORw0KGgoAAAANS', description: 'chart' }],
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('still returns 200 when S3 DeleteObjectsCommand fails after the update was stored', async () => {
    const tradeWithImages = {
      ...existingTrade,
      images: [
        { id: 'old-img-1', url: `https://test-bucket.s3.amazonaws.com/images/user-1/trade-1/old-img-1.jpg` },
      ],
    };
    ddbMock.on(GetCommand).resolves({ Item: { ...tradeWithImages } });
    s3Mock.on(DeleteObjectsCommand).rejects(new Error('S3 delete failed'));

    // Send empty images array to trigger deletion of old-img-1
    const res = await handler(makeEvent('trade-1', { images: [] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
  });

  // ── Partial close validation ──────────────────────────────────

  it('rejects a partial close with a negative quantity', async () => {
    const res = await handler(makeEvent('trade-1', {
      partialCloses: [{ quantity: -1, exitPrice: 1.1, time: '2024-06-16T00:00:00Z' }],
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('skips partial close entries missing required exitPrice', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, partialCloses: [] } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, partialCloses: [] } });

    const res = await handler(makeEvent('trade-1', {
      partialCloses: [{ quantity: 1 }],
    }), {} as any, () => {}) as any;

    // The handler's guard `pc.exitPrice == null` skips entries missing exitPrice
    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    // Verify the skipped entry was not appended — check the UpdateCommand input
    const updateInput = updateCalls[0].args[0].input as any;
    const partialClosesValue = Object.entries(updateInput.ExpressionAttributeValues || {})
      .find(([k]) => k === ':partialCloses');
    if (partialClosesValue) {
      expect((partialClosesValue[1] as any[]).length).toBe(0);
    }
  });

  // ── Data edge cases ───────────────────────────────────────────

  it('handles NaN price values by computing NaN pnl', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, entryPrice: NaN } });

    const res = await handler(makeEvent('trade-1', { entryPrice: NaN }), {} as any, () => {}) as any;

    // Handler does not reject NaN — Number(NaN) is NaN; it persists through
    expect(res.statusCode).toBe(200);
  });

  it('rejects an empty symbol', async () => {
    const res = await handler(makeEvent('trade-1', { symbol: '' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('returns 404 when trade is deleted between GET and UPDATE (race condition)', async () => {
    // GetCommand succeeds (trade exists at read time)
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade } });
    // UpdateCommand fails because the trade was deleted in the meantime
    const error = new Error('The conditional request failed');
    (error as any).name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(error);

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Multi-account errors ──────────────────────────────────────

  it('creates additional trades even when some accountIds look invalid', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade } });
    ddbMock.on(PutCommand).resolves({});

    const res = await handler(makeEvent('trade-1', {
      accountIds: ['valid-acc', '-1'],
    }), {} as any, () => {}) as any;

    // Handler does not validate individual accountId values; it creates trades for each
    expect(res.statusCode).toBe(200);
    const putCalls = ddbMock.commandCalls(PutCommand);
    // First accountId updates existing trade, second triggers a PutCommand
    expect(putCalls).toHaveLength(1);
    const putInput = putCalls[0].args[0].input as any;
    expect(putInput.Item.accountId).toBe('-1');
  });

  // ── DynamoDB edge cases ───────────────────────────────────────

  it('succeeds even when GetCommand returns item without tradeId (malformed data)', async () => {
    const malformed = { userId: 'user-1', symbol: 'AAPL', side: 'BUY', quantity: 100 };
    ddbMock.on(GetCommand).resolves({ Item: { ...malformed } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...malformed, updatedAt: '2024-06-16T00:00:00Z' } });

    const res = await handler(makeEvent('trade-1', { symbol: 'GOOG' }), {} as any, () => {}) as any;

    // Handler checks `current.Item` truthiness, not specific fields — proceeds normally
    expect(res.statusCode).toBe(200);
  });

  it('returns 500 when UpdateCommand fails with throughput exceeded', async () => {
    const error = new Error('Throughput exceeded');
    (error as any).name = 'ProvisionedThroughputExceededException';
    ddbMock.on(UpdateCommand).rejects(error);

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Validation (BE-005) ──────────────────────────────────────

  describe('body validation (BE-005)', () => {
    const rejected = async (body: any) => {
      ddbMock.resetHistory();
      const res = (await handler(makeEvent('trade-1', body), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    };

    it.each([
      ['a month of 13', { openDate: '2026-13-01' }],
      ['garbage text as a date', { openDate: 'garbage' }],
      ['day 32', { closeDate: '2026-01-32T10:00:00Z' }],
      ['hour 25', { openDate: '2026-01-10T25:00:00Z' }],
      ['a text quantity', { quantity: 'abc' }],
      ['zero quantity', { quantity: 0 }],
      ['an unknown side', { side: 'HOLD' }],
      ['an unknown outcome', { outcome: 'WIN' }],
      ['mistakes that are not text', { mistakes: [{}] }],
      ['a text price', { entryPrice: 'x' }],
    ])('400 before reading the item for %s', async (_name, body) => {
      await rejected(body);
    });

    it('accepts date-only, UTC and offset instants', async () => {
      for (const openDate of ['2026-04-10', '2026-04-10T09:30:00Z', '2026-04-10T09:30:00.000Z', '2026-04-10T15:00:00+05:30']) {
        const res = (await handler(makeEvent('trade-1', { openDate }), {} as any, () => {})) as any;
        expect(res.statusCode).toBe(200);
      }
    });
  });

  // ── CONTRACT §6 fields (X-002) ───────────────────────────────

  describe('contract fields (X-002)', () => {
    it('stores edited assetClass, contractMultiplier, fees, grossPnl and option fields', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, fees: 5, assetClass: 'stock' } });
      await handler(makeEvent('trade-1', {
        assetClass: 'options', contractMultiplier: 50, fees: 12, grossPnl: 480, optionType: 'call', strike: 150.5, expiry: '2026-12-31', underlying: 'AAPL',
      }), {} as any, () => {});
      expect(written()).toMatchObject({
        assetClass: 'options', contractMultiplier: 50, fees: 12, grossPnl: 480, optionType: 'call', strike: 150.5, expiry: '2026-12-31', underlying: 'AAPL',
      });
    });

    it('an explicit null removes the stored field; an absent field is left alone', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, fees: 5, assetClass: 'options', strike: 100 } });
      await handler(makeEvent('trade-1', { fees: null, assetClass: null, tradeNotes: 'x' }), {} as any, () => {});
      const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(input.UpdateExpression).toMatch(/REMOVE #fees, #assetClass$/);
      expect(Object.values(input.ExpressionAttributeNames as Record<string, string>)).not.toContain('strike');
      expect(written().fees).toBeUndefined();
    });

    it('rejects an unknown assetClass and a text fee', async () => {
      for (const body of [{ assetClass: 'bond' }, { fees: 'free' }, { optionType: 'straddle' }]) {
        expect(((await handler(makeEvent('trade-1', body), {} as any, () => {})) as any).statusCode).toBe(400);
      }
    });

    it('P&L fallback applies the contract multiplier', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, pnl: null, quantity: 2, entryPrice: 100, exitPrice: 110 } });
      await handler(makeEvent('trade-1', { contractMultiplier: 50 }), {} as any, () => {});
      expect(written().pnl).toBe(1000);
    });
  });

  // ── Concurrency (BE-032) ─────────────────────────────────────

  describe('concurrent change (BE-032)', () => {
    const conflict = (item?: any) => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException', Item: item });

    it('conditions the write on a live trade with the updatedAt that was read', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, updatedAt: '2024-06-15T00:00:00Z' } });
      await handler(makeEvent('trade-1', { tradeNotes: 'x' }), {} as any, () => {});
      const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(input.ConditionExpression).toContain('attribute_not_exists(deletedAt)');
      expect(input.ConditionExpression).toContain('updatedAt = :prevUpdatedAt');
      expect((input.ExpressionAttributeValues as any)[':prevUpdatedAt']).toBe('2024-06-15T00:00:00Z');
    });

    it('a trade without updatedAt is conditioned on the attribute still being absent', async () => {
      await handler(makeEvent('trade-1', { tradeNotes: 'x' }), {} as any, () => {});
      const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(input.ConditionExpression).toContain('attribute_not_exists(updatedAt)');
      expect(Object.keys(input.ExpressionAttributeValues as object)).not.toContain(':prevUpdatedAt');
    });

    it('409 when a live trade was changed by another request, 404 when it was soft-deleted meanwhile', async () => {
      ddbMock.on(UpdateCommand).rejects(conflict({ tradeId: { S: 'trade-1' } }));
      expect(((await handler(makeEvent('trade-1', { tradeNotes: 'x' }), {} as any, () => {})) as any).statusCode).toBe(409);
      ddbMock.on(UpdateCommand).rejects(conflict({ tradeId: { S: 'trade-1' }, deletedAt: { S: '2024-06-16T00:00:00Z' } }));
      expect(((await handler(makeEvent('trade-1', { tradeNotes: 'x' }), {} as any, () => {})) as any).statusCode).toBe(404);
    });
  });

  // ── Copies for extra accounts (BE-031) ───────────────────────

  describe('copies for extra accounts (BE-031)', () => {
    it('copies get their own screenshot objects and no idempotencyKey', async () => {
      const key = 'images/user-1/trade-1/a.png';
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, idempotencyKey: 'k-acc-1', images: [{ id: 'img-a', key }] } });
      s3Mock.on(CopyObjectCommand).resolves({});
      const res = (await handler(makeEvent('trade-1', { accountIds: ['acc-1', 'acc-2'] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      const copy = (ddbMock.commandCalls(PutCommand)[0].args[0].input as any).Item;
      expect(copy.idempotencyKey).toBeUndefined();
      expect(copy.images[0].key).toBe(`images/user-1/${copy.tradeId}/a.png`);
      const copied = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
      expect(copied.CopySource).toBe(`test-bucket/${key}`);
      expect(copied.Key).toBe(copy.images[0].key);
    });

    it('removing an image only deletes objects under this trade or the upload prefix', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, images: [
        { id: 'own', key: 'images/user-1/trade-1/own.png' },
        { id: 'upl', key: 'images/user-1/upload/u.png' },
        { id: 'other', key: 'images/user-1/trade-9/shared.png' },
      ] } });
      await handler(makeEvent('trade-1', { images: [] }), {} as any, () => {});
      const keys = (s3Mock.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete!.Objects as any[]).map((o) => o.Key);
      expect(keys).toEqual(['images/user-1/trade-1/own.png', 'images/user-1/upload/u.png']);
    });
  });

  // ── partialCloses (BE-097) ───────────────────────────────────

  describe('partialCloses (BE-097)', () => {
    it('replaces the stored list, so a retried PUT does not record a close twice', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, partialCloses: [{ quantity: 50, exitPrice: 170, time: 't' }] } });
      const body = { partialCloses: [{ quantity: 50, exitPrice: 170, time: 't' }] };
      await handler(makeEvent('trade-1', body), {} as any, () => {});
      await handler(makeEvent('trade-1', body), {} as any, () => {});
      for (const call of ddbMock.commandCalls(UpdateCommand)) {
        const values = call.args[0].input.ExpressionAttributeValues as any;
        expect(values[':partialCloses']).toBeUndefined();
      }
    });

    it('more than 50 entries are rejected', async () => {
      const many = Array.from({ length: 51 }, () => ({ quantity: 1, exitPrice: 1 }));
      expect(((await handler(makeEvent('trade-1', { partialCloses: many }), {} as any, () => {})) as any).statusCode).toBe(400);
    });
  });

  // ── Ordering and no-op writes (H4, L1) ──────────────────────

  describe('update order and unchanged requests', () => {
    const stored = { ...existingTrade, pnl: 1000, netPnl: 1000, riskRewardRatio: null, riskAmount: 0, images: [], updatedAt: '2024-06-15T00:00:00Z' };
    const conflict = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException', Item: { tradeId: { S: 'trade-1' } } });

    it('the copy for a second account carries the recomputed P&L, net P&L and prices (H4a)', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored, fees: 5, netPnl: 995 } });
      await handler(makeEvent('trade-1', { accountIds: ['acc-1', 'acc-2'], exitPrice: 200 }), {} as any, () => {});
      const copy = (ddbMock.commandCalls(PutCommand)[0].args[0].input as any).Item;
      expect(copy).toMatchObject({ accountId: 'acc-2', exitPrice: 200, pnl: 5000, netPnl: 4995 });
      expect(written()).toMatchObject({ pnl: 5000, netPnl: 4995 });
    });

    it('removed screenshots are deleted after the update is stored, and a 409 leaves them alone (H4b)', async () => {
      const own = { id: 'own', key: 'images/user-1/trade-1/own.png' };
      ddbMock.on(GetCommand).callsFake(() => ({ Item: { ...stored, images: [own] } }));
      let deletedBeforeWrite = true;
      ddbMock.on(UpdateCommand).callsFake(() => {
        deletedBeforeWrite = s3Mock.commandCalls(DeleteObjectsCommand).length > 0;
        return { Attributes: { ...stored, images: [] } };
      });
      await handler(makeEvent('trade-1', { images: [] }), {} as any, () => {});
      expect(deletedBeforeWrite).toBe(false);
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);

      s3Mock.resetHistory();
      ddbMock.on(UpdateCommand).rejects(conflict());
      const res = (await handler(makeEvent('trade-1', { images: [] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(409);
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    });

    it('partial closes are valued with the prices and quantity sent in the same request (H4c)', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored, partialCloses: [] } });
      await handler(makeEvent('trade-1', { entryPrice: 100, partialCloses: [{ quantity: 50, exitPrice: 110, time: 't' }] }), {} as any, () => {});
      expect(written()).toMatchObject({ realizedPartialPnl: 500, remainingQuantity: 50 });
    });

    it('a request that changes nothing writes nothing and returns the stored trade (L1)', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored, tradeNotes: 'x' } });
      const res = (await handler(makeEvent('trade-1', { tradeNotes: 'x', symbol: 'AAPL', quantity: 100, entryPrice: 150, exitPrice: 160 }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(JSON.parse(res.body).data.trade).toMatchObject({ tradeId: 'trade-1', tradeNotes: 'x', updatedAt: '2024-06-15T00:00:00Z' });
    });

    it('a real change still writes, with a new updatedAt', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...stored, tradeNotes: 'x' } });
      await handler(makeEvent('trade-1', { tradeNotes: 'y' }), {} as any, () => {});
      expect(Object.keys(written()).sort()).toEqual(['tradeNotes', 'updatedAt']);
    });
  });

  // ── Clearing optional fields (H5, backend) ───────────────────

  describe('clearing optional fields', () => {
    const options = { ...existingTrade, pnl: 1000, netPnl: 995, fees: 5, contractMultiplier: 50, optionType: 'call', strike: 150, expiry: '2026-12-31' };

    it('null removes fees, strike, expiry, optionType and contractMultiplier', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...options } });
      const res = (await handler(makeEvent('trade-1', { fees: null, strike: null, expiry: null, optionType: null, contractMultiplier: null }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      const removed = String(input.UpdateExpression).split(' REMOVE ')[1].split(', ').sort();
      expect(removed).toEqual(['#contractMultiplier', '#expiry', '#fees', '#optionType', '#strike']);
    });

    it('clearing fees stops them being subtracted from net P&L', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...options } });
      await handler(makeEvent('trade-1', { fees: null }), {} as any, () => {});
      expect(written().netPnl).toBe(1000);
    });
  });

  describe('the reviewed flag (CONTRACT I1)', () => {
    it('sets reviewed and writes only it and updatedAt; the stored value comes back', async () => {
      ddbMock.on(GetCommand).callsFake(() => ({ Item: { ...existingTrade, pnl: 1000, netPnl: 1000 } }));
      ddbMock.on(UpdateCommand).callsFake((input) => ({ Attributes: { ...existingTrade, reviewed: input.ExpressionAttributeValues[':reviewed'] } }));
      const res = (await handler(makeEvent('trade-1', { reviewed: true }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(Object.keys(written()).sort()).toEqual(['reviewed', 'updatedAt']);
      expect(written().reviewed).toBe(true);
      expect(JSON.parse(res.body).data.trade.reviewed).toBe(true);
    });

    it('false clears it, and a request without reviewed leaves the stored value alone', async () => {
      ddbMock.on(GetCommand).callsFake(() => ({ Item: { ...existingTrade, reviewed: true } }));
      await handler(makeEvent('trade-1', { reviewed: false }), {} as any, () => {});
      expect(written().reviewed).toBe(false);

      ddbMock.resetHistory();
      await handler(makeEvent('trade-1', { tradeNotes: 'n' }), {} as any, () => {});
      expect(Object.keys(written())).not.toContain('reviewed');
    });

    it('400 for a reviewed that is not true or false, and nothing is written', async () => {
      const res = (await handler(makeEvent('trade-1', { reviewed: null }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  // ── Screenshots from the upload prefix (H10) ─────────────────

  describe('screenshots uploaded before the trade (H10)', () => {
    const upload = 'images/upload/user-1/a.png';

    it('copies an uploaded key under the trade before the write, stores the copy and leaves the upload for expiry', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});
      let copiedBeforeWrite = false;
      ddbMock.on(UpdateCommand).callsFake(() => {
        copiedBeforeWrite = s3Mock.commandCalls(CopyObjectCommand).length === 1;
        return { Attributes: { ...existingTrade } };
      });
      await handler(makeEvent('trade-1', { images: [{ id: upload, key: upload }] }), {} as any, () => {});
      expect(copiedBeforeWrite).toBe(true);
      const copy = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
      expect(copy).toMatchObject({ CopySource: `test-bucket/${upload}`, Key: 'images/user-1/trade-1/a.png' });
      const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect((input.ExpressionAttributeValues as any)[':images'][0]).toMatchObject({ key: 'images/user-1/trade-1/a.png' });
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    });

    it("drops another user's upload key and copies nothing", async () => {
      await handler(makeEvent('trade-1', { images: [{ id: 'x', key: 'images/upload/user-2/a.png' }] }), {} as any, () => {});
      expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
      expect(written().images).toBeUndefined();
    });

    it('a retried save does not copy again: the stored image is found by the id the client sent', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, images: [{ id: upload, key: 'images/user-1/trade-1/a.png', timeframe: null, description: null }] } });
      await handler(makeEvent('trade-1', { images: [{ id: upload, key: upload }] }), {} as any, () => {});
      expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    });
  });
});
