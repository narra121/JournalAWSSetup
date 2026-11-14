import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = vi.fn(async (cmd: { input: { Name: string } }) => ({ Parameter: { Value: `key-for-${cmd.input.Name}` } }));
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { generateText, __resetSharedAiKeyCache } from '../gemini';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fail = (status: number) => ({ ok: false, status, statusText: 'x', text: async () => 'err', json: async () => ({}) }) as unknown as Response;
const call = () => generateText({ parts: [{ text: 'Improve this' }], maxOutputTokens: 100, temperature: 0, timeoutMs: 5000 });

beforeEach(() => {
  __resetSharedAiKeyCache();
  vi.stubEnv('OPENROUTER_API_KEY_PARAM', '/tradequt/openrouterApiKey');
  vi.stubEnv('GEMINI_API_KEY_PARAM', '/tradequt/geminiApiKey');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('generateText returns the model that answered (for logAiCall), next to the existing fields', () => {
  it('OpenRouter: the extraction model', async () => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ choices: [{ finish_reason: 'stop', message: { content: 'Better text' } }] })));
    expect(await call()).toEqual({ text: 'Better text', finishReason: 'STOP', model: 'google/gemini-3.5-flash-lite' });
  });

  it('direct Gemini: the fallback model when the first one is unavailable', async () => {
    vi.stubEnv('AI_PROVIDER', 'gemini');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(okJson({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Better text' }] } }] })),
    );
    expect(await call()).toEqual({ text: 'Better text', finishReason: 'STOP', model: 'gemini-3.5-flash-lite' });
  });
});
