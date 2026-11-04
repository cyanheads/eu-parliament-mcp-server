/** @fileoverview Lossless field-path paragraphs and complete nested arrays. */
import { describe, expect, it } from 'vitest';
import { fieldPathText } from '../../../src/services/eu-parliament/eu-parliament-rendering.js';

describe('Parliament field-path rendering', () => {
  it('renders complete paragraphs beyond any client output budget', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
    const text = fieldPathText({ rows });
    expect(text.length).toBeGreaterThan(100_000);
    expect(text).toContain('result.rows[1499].id: 1499');
    expect(text).toContain('result.rows[1499].text:');
  });
});
