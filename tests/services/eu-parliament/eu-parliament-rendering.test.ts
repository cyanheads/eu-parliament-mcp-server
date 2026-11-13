/** @fileoverview Lossless field-path paragraphs and complete nested arrays. */
import { describe, expect, it } from 'vitest';
import { fieldPathText } from '../../../src/services/eu-parliament/eu-parliament-rendering.js';
import { expectLinearCpu } from '../../helpers/cpu-growth.js';

describe('Parliament field-path rendering', () => {
  it('renders complete paragraphs beyond any client output budget', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
    const text = fieldPathText({ rows });
    expect(text.length).toBeGreaterThan(100_000);
    expect(text).toContain('result.rows[1499].id: 1499');
    expect(text).toContain('result.rows[1499].text:');
  });

  it('carries multi-paragraph upstream text on one line that decodes to the whole value', () => {
    const value =
      'R&D <b>bold</b> "quoted" \'single\'\n\n``fenced`` `code` and \\ backslash\n\nhttps://example.org/a';
    const text = fieldPathText({ text: { value } });
    expect(text).toBe(`result.text.value: \`\`\` ${JSON.stringify(value)} \`\`\``);
    expect(JSON.parse(/``` (".*") ```/.exec(text)?.[1] ?? '')).toBe(value);
  });

  it.each([
    ['backtick runs', (n: number) => '`'.repeat(n)],
    ['spaced backticks', (n: number) => '` '.repeat(n / 2)],
    ['a link-like value broken at its end', (n: number) => `https://${'a'.repeat(n)} x`],
    ['escapes throughout', (n: number) => '"\\\n<&'.repeat(n / 5)],
  ])('rendering upstream text of %s stays linear', { timeout: 0 }, (_, shape) => {
    expectLinearCpu((value) => fieldPathText({ text: value }), shape);
  });
});
