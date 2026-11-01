/** @fileoverview Server environment parsing for the limit clamp switch. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampLimits, initServerConfig } from '../../src/config/server-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  initServerConfig();
});

describe('server config', () => {
  it.each([
    [undefined, true],
    ['', true],
    [`\${user_config.EUPARL_CLAMP_LIMITS}`, true],
    ['true', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['off', false],
  ])('parses EUPARL_CLAMP_LIMITS=%j as clamping %s', (value, expected) => {
    vi.stubEnv('EUPARL_CLAMP_LIMITS', value);
    expect(initServerConfig()).toEqual({ clampLimits: expected });
    expect(clampLimits()).toBe(expected);
  });
  it('fails setup on an unrecognized switch value, naming the variable', () => {
    vi.stubEnv('EUPARL_CLAMP_LIMITS', 'maybe');
    expect(() => initServerConfig()).toThrow(/EUPARL_CLAMP_LIMITS/);
  });
});
