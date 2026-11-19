import { describe, expect, it } from 'vitest';
import { citedLearningIds } from '../memory-citations';

describe('learning citations', () => {
  it('recognizes exact identifiers without confusing prefixes', () => {
    const output = JSON.stringify({ summary: 'Applied learning #10; see LEARNING #12 and learning #10.' });
    expect([...citedLearningIds(output)]).toEqual([10, 12]);
    expect(citedLearningIds(output).has(1)).toBe(false);
  });

  it('ignores malformed or unsafe identifiers', () => {
    const output = 'learning #01, learning #10suffix, learning #0, learning #9007199254740992';
    expect([...citedLearningIds(output)]).toEqual([]);
  });
});
