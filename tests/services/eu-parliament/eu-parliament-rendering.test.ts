/** @fileoverview Field-path text and the row sizes budgeted pages charge for it. */
import { describe, expect, it } from 'vitest';
import {
  fieldPathText,
  renderedChars,
} from '../../../src/services/eu-parliament/eu-parliament-rendering.js';

describe('Parliament field-path rendering', () => {
  it('charges a row its blank-line-separated paragraphs plus the separator before them', () => {
    expect(fieldPathText({ decision_id: 'D-1', document_ids: [] }, 'result.decisions[0]')).toBe(
      'result.decisions[0].decision_id: ` "D-1" `\n\nresult.decisions[0].document_ids: []',
    );
    expect(renderedChars({ decision_id: 'D-1', document_ids: [] }, 'result.decisions[0]')).toBe(82);
  });

  it('sums row charges to exactly the rows of a rendered page, past single-digit indices', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      decision_id: `D-${index}`,
      label: { value: '`'.repeat(index % 4), language: 'en' },
      document_ids: Array.from({ length: index % 3 }, (_, item) => `A-${item}`),
      source_url: `https://data.europarl.europa.eu/eli/dl/event/D-${index}`,
    }));
    const head = { mode: 'decisions', sitting_id: 'MTG-PL-2025-12-17' };
    const page = { offset: 0, limit: 12, returned: 12, has_more: false };
    const full = fieldPathText({ ...head, decisions: rows, page }).length;
    const empty = fieldPathText({ ...head, decisions: [], page }).length;
    const charged = rows.reduce(
      (sum, row, index) => sum + renderedChars(row, `result.decisions[${index}]`),
      0,
    );
    expect(full - empty).toBe(charged - 'result.decisions: []'.length - 2);
  });
});
