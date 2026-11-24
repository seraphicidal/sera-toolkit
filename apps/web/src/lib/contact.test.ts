import { describe, expect, it } from 'vitest';
import { cleanEmail, cleanEnvValue } from './contact';

describe('contact env helpers', () => {
  it('trims valid env strings and rejects blank values', () => {
    expect(cleanEnvValue('  SERA Operator  ')).toBe('SERA Operator');
    expect(cleanEnvValue('   ')).toBeUndefined();
    expect(cleanEnvValue(undefined)).toBeUndefined();
  });

  it('accepts safe email addresses and rejects malformed or query-injected mailto values', () => {
    expect(cleanEmail(' legal@example.org ')).toBe('legal@example.org');
    expect(cleanEmail('abuse+dsa@sub.example.de')).toBe('abuse+dsa@sub.example.de');
    expect(cleanEmail('legal@example.org?subject=injected')).toBeUndefined();
    expect(cleanEmail('not an email')).toBeUndefined();
    expect(cleanEmail('user@localhost')).toBeUndefined();
    expect(cleanEmail('')).toBeUndefined();
  });
});
