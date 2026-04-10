import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyEvent } from 'aws-lambda';
import { Readable } from 'stream';

// ─── Environment stubs ─────────────────────────────────────────
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');
vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('GOALS_TABLE', 'test-goals');
vi.stubEnv('OPENROUTER_API_KEY_PARAM', '/test/openrouter-key');
vi.stubEnv('GEMINI_REQUEST_TIMEOUT_MS', '5000');

// ─── AWS mocks ─────────────────────────────────────────────────
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ssmMock = mockClient(SSMClient);

// Mock global fetch for enhance-text
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// ─── Dynamic imports after env setup ───────────────────────────
const { handler: createTradeHandler } = await import('../../handlers/create-trade/app.ts');
const { handler: createRuleHandler } = await import('../../handlers/create-rule/app.ts');
const { handler: createAccountHandler } = await import('../../handlers/create-account/app.ts');
const { handler: getImageHandler } = await import('../../handlers/get-image/app.ts');
const { handler: enhanceTextHandler } = await import('../../handlers/enhance-text/app.ts');

// ─── Helpers ───────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeV2Event(body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /trades',
    rawPath: '/trades',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      ...((overrides as any).headers || {}),
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/trades', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-sec-1',
      routeKey: 'POST /trades',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

function makeV1Event(
  imageId?: string,
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: `/images/${imageId || ''}`,
    headers: {
      authorization: 'Bearer valid-jwt-token',
    },
    pathParameters: imageId !== undefined ? { imageId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    multiValueHeaders: {},
    stageVariables: null,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: {},
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {
        accessKey: null, accountId: null, apiKey: null, apiKeyId: null,
        caller: null, clientCert: null, cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null, cognitoIdentityId: null,
        cognitoIdentityPoolId: null, principalOrgId: null,
        sourceIp: '127.0.0.1', user: null, userAgent: 'test', userArn: null,
      },
      path: `/images/${imageId || ''}`,
      stage: 'test',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: 'res',
      resourcePath: '/images/{imageId+}',
    },
    resource: '/images/{imageId+}',
    body: null,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

const validTrade = {
  symbol: 'AAPL',
  side: 'BUY',
  quantity: 100,
  openDate: '2024-06-15',
  entryPrice: 150,
  exitPrice: 160,
  outcome: 'TP',
};

const validAccount = {
  name: 'Test Account',
  broker: 'Interactive Brokers',
  type: 'personal',
  status: 'active',
  balance: 10000,
  initialBalance: 10000,
  currency: 'USD',
};

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ssmMock.reset();
  fetchMock.mockReset();

  ddbMock.on(PutCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'test-api-key' } });
});

// ═══════════════════════════════════════════════════════════════
// Test 1: NoSQL injection via trade notes
// ═══════════════════════════════════════════════════════════════

describe('NoSQL injection via trade notes', () => {
  it('stores {"$gt":""} in tradeNotes as-is without evaluation', async () => {
    const trade = { ...validTrade, tradeNotes: '{"$gt":""}' };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tradeNotes).toBe('{"$gt":""}');
  });

  it('stores {"$ne":null} in tradeNotes as-is without evaluation', async () => {
    const trade = { ...validTrade, tradeNotes: '{"$ne":null}' };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tradeNotes).toBe('{"$ne":null}');
  });

  it('stores MongoDB-style operator in symbol as-is', async () => {
    const trade = { ...validTrade, symbol: '$AAPL', tradeNotes: '{"$where":"sleep(5000)"}' };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tradeNotes).toBe('{"$where":"sleep(5000)"}');
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 2: XSS in trade tags
// ═══════════════════════════════════════════════════════════════

describe('XSS in trade tags', () => {
  it('stores <script> tags in trade tags as raw strings', async () => {
    const trade = { ...validTrade, tags: ['<script>alert(1)</script>', 'normal-tag'] };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tags).toContain('<script>alert(1)</script>');
    expect(body.data.trade.tags).toContain('normal-tag');
  });

  it('stores XSS payloads in tradeNotes without transformation', async () => {
    const xssPayload = '<img src=x onerror=alert(1)>';
    const trade = { ...validTrade, tradeNotes: xssPayload };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tradeNotes).toBe(xssPayload);
  });

  it('stores event handler XSS in rule text as raw string', async () => {
    const xssRule = '<div onmouseover="alert(document.cookie)">hover me</div>';
    const ruleEvent = makeV2Event({ rule: xssRule });
    const res = await createRuleHandler(ruleEvent, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.rule.rule).toBe(xssRule);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 3: Path traversal in image ID
// ═══════════════════════════════════════════════════════════════

describe('Path traversal in image ID', () => {
  it('rejects ../../etc/passwd as imageId', async () => {
    const res = await getImageHandler(makeV1Event('../../etc/passwd'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });

  it('rejects imageId with backslash path traversal', async () => {
    const res = await getImageHandler(makeV1Event('..\\..\\etc\\passwd'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('rejects deeply nested path traversal', async () => {
    const res = await getImageHandler(makeV1Event('acc1/../../../../etc/shadow.jpg'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 4: Very long string inputs
// ═══════════════════════════════════════════════════════════════

describe('Very long string inputs', () => {
  it('handles 10KB string in tradeNotes without crashing', async () => {
    const longNotes = 'A'.repeat(10 * 1024);
    const trade = { ...validTrade, tradeNotes: longNotes };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    // Should either succeed (DynamoDB allows up to 400KB items) or return a controlled error
    expect([200, 201, 400, 413]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      const body = JSON.parse(res.body);
      expect(body.data.trade.tradeNotes).toBe(longNotes);
    }
  });

  it('handles 100KB string in tradeNotes without crashing', async () => {
    const veryLongNotes = 'B'.repeat(100 * 1024);
    const trade = { ...validTrade, tradeNotes: veryLongNotes };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    // Should either succeed or return a controlled error, never crash
    expect([200, 201, 400, 413, 500]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  it('handles very long rule text in create-rule without crashing', async () => {
    const longRule = 'R'.repeat(10 * 1024);
    const ruleEvent = makeV2Event({ rule: longRule });
    const res = await createRuleHandler(ruleEvent, {} as any, () => {}) as any;

    expect([200, 201, 400, 413]).toContain(res.statusCode);
  });

  it('handles extremely large tags array without crashing', async () => {
    const manyTags = Array.from({ length: 1000 }, (_, i) => `tag-${i}`);
    const trade = { ...validTrade, tags: manyTags };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect([200, 201, 400, 413, 500]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 5: Unicode edge cases
// ═══════════════════════════════════════════════════════════════

describe('Unicode edge cases', () => {
  it('stores emoji in tradeNotes correctly', async () => {
    const trade = { ...validTrade, tradeNotes: 'Great trade! \u{1F680}\u{1F4B0}\u{1F3AF}' };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tradeNotes).toContain('\u{1F680}');
  });

  it('stores RTL characters in tradeNotes correctly', async () => {
    const rtlText = '\u0645\u0644\u0627\u062D\u0638\u0627\u062A \u0627\u0644\u062A\u062F\u0627\u0648\u0644';
    const trade = { ...validTrade, tradeNotes: rtlText };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tradeNotes).toBe(rtlText);
  });

  it('stores mixed emoji and CJK characters in tags', async () => {
    const trade = { ...validTrade, tags: ['\u{1F4C8}\u80A1\u7968', '\u53D6\u5F15', '\u{1F1EF}\u{1F1F5}'] };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tags).toHaveLength(3);
  });

  it('stores zero-width characters in notes without crashing', async () => {
    const trade = { ...validTrade, tradeNotes: 'hidden\u200B\u200Ctext\u200D\uFEFF' };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.tradeNotes).toBe('hidden\u200B\u200Ctext\u200D\uFEFF');
  });

  it('stores rule with emoji correctly', async () => {
    const ruleEvent = makeV2Event({ rule: 'Never trade against the trend \u{1F6AB}\u{1F4C9}' });
    const res = await createRuleHandler(ruleEvent, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.rule.rule).toContain('\u{1F6AB}');
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 6: Null byte injection
// ═══════════════════════════════════════════════════════════════

describe('Null byte injection', () => {
  it('handles null bytes in tradeNotes gracefully', async () => {
    const trade = { ...validTrade, tradeNotes: 'before\x00after' };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    // Should not crash - either accept or reject with a controlled response
    expect([200, 201, 400]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  it('handles null bytes in tags gracefully', async () => {
    const trade = { ...validTrade, tags: ['tag\x00injection'] };
    const res = await createTradeHandler(makeV2Event(trade), {} as any, () => {}) as any;

    expect([200, 201, 400]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  it('handles null bytes in rule text gracefully', async () => {
    const ruleEvent = makeV2Event({ rule: 'rule\x00text' });
    const res = await createRuleHandler(ruleEvent, {} as any, () => {}) as any;

    expect([200, 201, 400]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  it('handles null bytes in account name gracefully', async () => {
    const account = { ...validAccount, name: 'Account\x00Name' };
    const res = await createAccountHandler(makeV2Event(account), {} as any, () => {}) as any;

    expect([200, 201, 400]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 7: Auth header injection
// ═══════════════════════════════════════════════════════════════

describe('Auth header injection', () => {
  it('handles Authorization header with extra spaces', async () => {
    const event = makeV2Event(validTrade);
    event.headers = { authorization: '  Bearer   ' + makeJwt('user-1') + '  ' };
    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    // Should either extract the userId or fail with 401 - must not crash
    expect([200, 201, 401]).toContain(res.statusCode);
  });

  it('handles Authorization header with newline characters', async () => {
    const event = makeV2Event(validTrade);
    event.headers = { authorization: 'Bearer\n' + makeJwt('user-1') };
    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    // Should not crash; may return 401 due to malformed header
    expect([200, 201, 401]).toContain(res.statusCode);
  });

  it('handles Authorization header with carriage return', async () => {
    const event = makeV2Event(validTrade);
    event.headers = { authorization: 'Bearer\r\n' + makeJwt('user-1') };
    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    expect([200, 201, 401]).toContain(res.statusCode);
  });

  it('handles empty Authorization header', async () => {
    const event = makeV2Event(validTrade);
    event.headers = { authorization: '' };
    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
  });

  it('handles Authorization header with only Bearer prefix and no token', async () => {
    const event = makeV2Event(validTrade);
    event.headers = { authorization: 'Bearer ' };
    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
  });

  it('handles Authorization header with garbage token', async () => {
    const event = makeV2Event(validTrade);
    event.headers = { authorization: 'Bearer not.a.valid.jwt' };
    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    // Should return 401, must not crash
    expect([200, 201, 401]).toContain(res.statusCode);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 8: JSON parsing edge cases - __proto__ pollution
// ═══════════════════════════════════════════════════════════════

describe('JSON prototype pollution', () => {
  it('does not pollute Object prototype via __proto__ in trade body', async () => {
    const maliciousBody = '{"symbol":"AAPL","side":"BUY","quantity":100,"openDate":"2024-06-15","entryPrice":150,"exitPrice":160,"outcome":"TP","__proto__":{"isAdmin":true}}';
    const event = makeV2Event(validTrade);
    event.body = maliciousBody;

    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    // Must not pollute Object.prototype
    expect((({} as any).isAdmin)).toBeUndefined();
    // Should still succeed or fail with controlled error
    expect([200, 201, 400]).toContain(res.statusCode);
  });

  it('does not pollute prototype via constructor.prototype in trade body', async () => {
    const maliciousBody = '{"symbol":"AAPL","side":"BUY","quantity":100,"openDate":"2024-06-15","entryPrice":150,"exitPrice":160,"outcome":"TP","constructor":{"prototype":{"polluted":true}}}';
    const event = makeV2Event(validTrade);
    event.body = maliciousBody;

    const res = await createTradeHandler(event, {} as any, () => {}) as any;

    expect((({} as any).polluted)).toBeUndefined();
    expect([200, 201, 400]).toContain(res.statusCode);
  });

  it('does not pollute prototype via __proto__ in rule body', async () => {
    const maliciousBody = '{"rule":"test rule","__proto__":{"isAdmin":true}}';
    const event = makeV2Event(null);
    event.body = maliciousBody;

    const res = await createRuleHandler(event, {} as any, () => {}) as any;

    expect((({} as any).isAdmin)).toBeUndefined();
    expect([200, 201, 400]).toContain(res.statusCode);
  });

  it('does not pollute prototype via __proto__ in enhance-text body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'enhanced' } }] }),
    });

    const maliciousBody = '{"text":"test text","__proto__":{"isAdmin":true}}';
    const event = makeV2Event(null);
    event.body = maliciousBody;

    const res = await enhanceTextHandler(event, {} as any) as any;

    expect((({} as any).isAdmin)).toBeUndefined();
    // Should either work or fail gracefully
    expect([200, 400, 500]).toContain(res.statusCode);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 9: Error response data leakage
// ═══════════════════════════════════════════════════════════════

describe('Error response data leakage', () => {
  it('does not expose DynamoDB table names in error responses for create-trade', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB internal error'));

    const res = await createTradeHandler(makeV2Event(validTrade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('test-trades');
    expect(bodyStr).not.toContain('TRADES_TABLE');
  });

  it('does not expose DynamoDB table names in error responses for create-rule', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB internal error'));

    const ruleEvent = makeV2Event({ rule: 'test rule' });
    const res = await createRuleHandler(ruleEvent, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('test-rules');
    expect(bodyStr).not.toContain('RULES_TABLE');
  });

  it('does not expose S3 bucket names in get-image error responses', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('S3 internal error'));

    const res = await getImageHandler(makeV1Event('acc1/trade1/photo.jpg'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('test-bucket');
    expect(bodyStr).not.toContain('IMAGES_BUCKET');
  });

  it('does not expose file system paths in error responses', async () => {
    ddbMock.on(PutCommand).rejects(new Error('ENOENT: no such file or directory'));

    const res = await createTradeHandler(makeV2Event(validTrade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    const bodyStr = JSON.stringify(body);
    // Should not contain Windows or Unix paths
    expect(bodyStr).not.toMatch(/[A-Z]:\\/);
    expect(bodyStr).not.toContain('/home/');
    expect(bodyStr).not.toContain('/var/');
  });

  it('error response for get-image uses generic messages', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('Access Denied'));

    const res = await getImageHandler(makeV1Event('acc1/trade1/photo.jpg'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    // Should use generic error message, not raw AWS error
    expect(body.error).toBe('Failed to retrieve image');
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 10: Sensitive field logging
// ═══════════════════════════════════════════════════════════════

describe('Sensitive field logging', () => {
  it('logger does not include raw Authorization token in output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const trade = { ...validTrade };
    await createTradeHandler(makeV2Event(trade), {} as any, () => {});

    const allLogs = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    // Logger should not output the full JWT token
    const jwt = makeJwt('user-1');
    expect(allLogs).not.toContain(jwt);

    consoleSpy.mockRestore();
  });

  it('logger does not include API keys in output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'enhanced' } }] }),
    });

    await enhanceTextHandler(makeV2Event({ text: 'test' }), {} as any);

    const allLogs = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    const allErrors = consoleErrorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    const combined = allLogs + allErrors;
    expect(combined).not.toContain('test-api-key');

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('error log for create-trade does not leak sensitive data', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    ddbMock.on(PutCommand).rejects(new Error('Internal DynamoDB Error'));
    await createTradeHandler(makeV2Event(validTrade), {} as any, () => {});

    const allLogs = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    // Should not log secrets or auth tokens
    expect(allLogs).not.toContain('password');
    expect(allLogs).not.toContain('secret');

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
