import { describe, expect, it } from 'vitest';

// Loaded through a variable so the untyped .mjs is not part of the TypeScript program.
const path = '../../scripts/lib/deploy-args.mjs';
const lib: any = await import(path);
const { parseDeployArgs, assertDeclared, prodParamProblems, formatParamTable } = lib;

const argv = (s: string) => s.split(' ');

describe('parseDeployArgs', () => {
  it('reads the stage, flags and repeatable --param Key=Value', () => {
    const r = parseDeployArgs(argv('--stage prod --dry-run --param AlarmEmail=ops@example.com --param AdminSecretParamName=/tradequt/prod/adminSecret'));
    expect(r.stage).toBe('prod');
    expect(r.flags.has('dry-run')).toBe(true);
    expect(r.params).toEqual({ AlarmEmail: 'ops@example.com', AdminSecretParamName: '/tradequt/prod/adminSecret' });
  });

  it('keeps "=" inside a value and allows an empty value', () => {
    expect(parseDeployArgs(argv('--stage dev --param A=b=c')).params.A).toBe('b=c');
    expect(parseDeployArgs(argv('--stage dev --param AlarmEmail=')).params.AlarmEmail).toBe('');
  });

  it.each([
    ['no stage', '--dry-run'],
    ['an unknown stage', '--stage staging'],
    ['--param without a value', '--stage dev --param'],
    ['--param without "="', '--stage dev --param AlarmEmail'],
    ['--param with an empty key', '--stage dev --param =x'],
    ['--param with a bad key', '--stage dev --param bad-key=1'],
    ['the same --param twice', '--stage dev --param A=1 --param A=2'],
    ['a stray positional argument', '--stage dev oops'],
  ])('rejects %s', (_n, a) => {
    expect(() => parseDeployArgs(argv(a))).toThrow();
  });

  it('refuses to override the parameters the script computes', () => {
    for (const key of ['CodeBucket', 'WebCodeKey', 'WebCodeVersion', 'EventsCodeKey', 'EventsCodeVersion']) {
      expect(() => parseDeployArgs(['--stage', 'dev', '--param', `${key}=x`])).toThrow(/cannot be overridden/);
    }
  });
});

describe('assertDeclared', () => {
  it('rejects a --param the template does not declare', () => {
    expect(() => assertDeclared({ Nope: '1' }, new Set(['AlarmEmail']))).toThrow(/Nope/);
    expect(() => assertDeclared({ AlarmEmail: 'a@b.co' }, new Set(['AlarmEmail']))).not.toThrow();
  });
});

describe('prodParamProblems', () => {
  const good = { AlarmEmail: 'ops@example.com', AdminSecretParamName: '/tradequt/prod/adminSecret', AdminJwtSecretParamName: '/tradequt/prod/adminJwtSecret' };

  it('accepts a complete prod configuration', () => {
    expect(prodParamProblems(good)).toEqual([]);
  });

  it('refuses an empty or missing AlarmEmail and a malformed one', () => {
    expect(prodParamProblems({ ...good, AlarmEmail: '' })[0]).toMatch(/AlarmEmail is empty/);
    expect(prodParamProblems({ ...good, AlarmEmail: '   ' })[0]).toMatch(/AlarmEmail is empty/);
    expect(prodParamProblems({ ...good, AlarmEmail: undefined })[0]).toMatch(/AlarmEmail is empty/);
    expect(prodParamProblems({ ...good, AlarmEmail: 'not-an-address' })[0]).toMatch(/not an e-mail/);
  });

  it('refuses the shared admin secrets and any name outside /tradequt/prod/', () => {
    const shared = prodParamProblems({ ...good, AdminSecretParamName: '/tradequt/adminSecret', AdminJwtSecretParamName: '/tradequt/dev/adminJwtSecret' });
    expect(shared).toHaveLength(2);
    expect(shared[0]).toMatch(/AdminSecretParamName.*\/tradequt\/prod\//);
    expect(prodParamProblems({ ...good, AdminJwtSecretParamName: undefined })).toHaveLength(1);
    expect(prodParamProblems({ ...good, AdminSecretParamName: '/tradequt/production/x' })).toHaveLength(1);
  });

  it('reports every problem at once', () => {
    expect(prodParamProblems({})).toHaveLength(3);
  });
});

describe('formatParamTable', () => {
  it('lists name, value and source, and masks NoEcho values', () => {
    const table = formatParamTable([
      { name: 'AlarmEmail', value: 'ops@example.com', source: 'explicit --param' },
      { name: 'GoogleClientSecret', value: 'super-secret', source: 'previous value', noEcho: true },
    ]);
    expect(table).toContain('ops@example.com');
    expect(table).toContain('explicit --param');
    expect(table).toContain('****');
    expect(table).not.toContain('super-secret');
    expect(table.split('\n')[0]).toMatch(/PARAMETER\s+VALUE\s+SOURCE/);
  });
});
