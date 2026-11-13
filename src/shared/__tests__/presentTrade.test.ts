import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.stubEnv('IMAGES_BUCKET', 'test-bucket');
const { presentTrade } = await import('../presentTrade');

describe('presentTrade (BE-095)', () => {
  it('image ids become the S3 keys, like the list, create and update responses', () => {
    const t = presentTrade({ tradeId: 't', images: [{ id: 'uuid-1', key: 'images/u/t/a.png' }, { id: 'uuid-2', url: 'https://test-bucket.s3.amazonaws.com/images/u/t/b.png' }, { id: 'legacy', url: 'https://example.com/x.png' }] });
    expect(t.images[0]).toMatchObject({ id: 'images/u/t/a.png', key: 'images/u/t/a.png' });
    expect(t.images[1].id).toBe(t.images[1].key);
    expect(t.images[2]).toMatchObject({ id: 'legacy' });
  });

  it('drops the legacy accountIds list, defaults achievedRiskRewardRatio to null and does not touch the input', () => {
    const stored = { tradeId: 't', accountIds: ['a'], accountId: 'a', images: [{ id: 'x', key: 'k' }] };
    const t = presentTrade(stored);
    expect(t).not.toHaveProperty('accountIds');
    expect((t as any).achievedRiskRewardRatio).toBeNull();
    expect(stored.accountIds).toEqual(['a']);
    expect(stored.images[0].id).toBe('x');
  });
});
