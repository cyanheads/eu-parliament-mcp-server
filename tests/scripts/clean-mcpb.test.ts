/** @fileoverview Bundle cleanup preserves SDK runtime skill modules. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

describe('MCPB agent documentation cleanup', () => {
  it('keeps runtime skill modules while removing package-root agent documentation', () => {
    const entries = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'node_modules/nested/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/example/skills/research/SKILL.md',
      'node_modules/example/skills/research/assets/diagram.png',
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/nested/node_modules/@scope/example/skills/research/helper.py',
      'node_modules/example/.claude/config.json',
      'node_modules/example/.agents/skills/research/SKILL.md',
      'node_modules/example/docs/SKILL.md',
      'skills/research/SKILL.md',
    ];
    const removed = [
      'node_modules/example/skills/research/SKILL.md',
      'node_modules/example/skills/research/assets/diagram.png',
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/nested/node_modules/@scope/example/skills/research/helper.py',
      'node_modules/example/.claude/config.json',
      'node_modules/example/.agents/skills/research/SKILL.md',
      'node_modules/example/docs/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(removed);
    const linter = readFileSync(
      new URL('../../scripts/lint-packaging.ts', import.meta.url),
      'utf8',
    );
    expect(linter).toContain(`export const AGENT_DOC_ENTRY =\n  ${AGENT_DOC_ENTRY};`);
  });

  it.each([
    (size: number) => '1'.repeat(size),
    (size: number) => `${'1'.repeat(size)}\nend`,
    (size: number) => '  \r\n'.repeat(size / 4),
  ])('bounds matching CPU over long non-documentation paths', (suffix) => {
    for (let warmup = 0; warmup < 100; warmup++)
      AGENT_DOC_ENTRY.test(`node_modules/example/dist/${suffix(5120)}`);
    const cpuUs: number[] = [];
    for (let size = 5120; size <= 327680; size *= 2) {
      const entry = `node_modules/example/dist/${suffix(size)}`;
      expect(AGENT_DOC_ENTRY.test(entry)).toBe(false);
      const start = process.threadCpuUsage();
      for (let iteration = 0; iteration < 64; iteration++) AGENT_DOC_ENTRY.test(entry);
      const used = process.threadCpuUsage(start);
      const elapsed = used.user + used.system;
      expect(elapsed).toBeLessThan(250000);
      cpuUs.push(elapsed);
    }
    expect(cpuUs[0]).toBeGreaterThan(0);
    expect(cpuUs.at(-1)!).toBeLessThan(cpuUs[0]! * 256);
  });
});
