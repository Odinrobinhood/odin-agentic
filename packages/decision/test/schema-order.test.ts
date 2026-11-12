import { describe, expect, it } from 'vitest';
import { DECISION_JSON_SCHEMA } from '../src/types.ts';

describe('decision output schema', () => {
  it('asks for the reasoning before the action (models emit fields in order)', () => {
    const keys = Object.keys(DECISION_JSON_SCHEMA.properties);
    expect(keys.indexOf('rationale')).toBe(0);
    expect(keys.indexOf('thesis')).toBeLessThan(keys.indexOf('action'));
    expect(DECISION_JSON_SCHEMA.required.slice(0, 3)).toEqual(['rationale', 'thesis', 'action']);
  });
});
