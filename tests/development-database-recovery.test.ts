import { describe, expect, test } from 'bun:test';
import { withDatabaseRecovery, DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION } from '../src/services/development-database-recovery-policy.ts';

describe('development database recovery', () => {
  test('healthy databases need no agent', async () => {
    let repairs = 0;
    expect(await withDatabaseRecovery({ ensure: async () => 'ready', repair: async () => { repairs++; }, progress: () => {} })).toBe('ready');
    expect(repairs).toBe(0);
  });
  test('uses actual errors and checks again after each repair', async () => {
    const errors = ['port is allocated', 'password authentication failed'];
    const evidence: [string, number][] = [];
    let checks = 0;
    const result = await withDatabaseRecovery({
      ensure: async () => { const error = errors[checks++]; if (error) throw new Error(error); return 'authenticated'; },
      repair: async (error, attempt) => { evidence.push([error, attempt]); }, progress: () => {},
    });
    expect(result).toBe('authenticated');
    expect(evidence).toEqual([['port is allocated', 1], ['password authentication failed', 2]]);
    expect(checks).toBe(3);
  });
  test('agent completion alone cannot declare success', async () => {
    let repairs = 0;
    await expect(withDatabaseRecovery({ ensure: async () => { throw new Error('still broken'); }, repair: async () => { repairs++; }, progress: () => {} })).rejects.toThrow('after two repair attempts');
    expect(repairs).toBe(2);
  });
  test('agent failure is surfaced without blindly starting another repair', async () => {
    let checks = 0;
    await expect(withDatabaseRecovery({ ensure: async () => { checks++; throw new Error('db down'); }, repair: async () => { throw new Error('agent timed out'); }, progress: () => {} })).rejects.toThrow('agent timed out');
    expect(checks).toBe(1);
  });
  test('cancellation after a failed check prevents repair', async () => {
    let cancelled = false, repairs = 0;
    await expect(withDatabaseRecovery({ ensure: async () => { cancelled = true; throw new Error('db down'); }, repair: async () => { repairs++; }, cancelled: () => cancelled, progress: () => {} })).rejects.toThrow('__CANCELLED__');
    expect(repairs).toBe(0);
  });
  test.each(['Multiple active sandbox jobs', 'disk ownership is unresolved', 'creation is unresolved', 'Automatic replacement is blocked'])('does not repair provider ownership failure: %s', async error => {
    let repairs = 0;
    await expect(withDatabaseRecovery({ ensure: async () => { throw new Error(error); }, repair: async () => { repairs++; }, progress: () => {} })).rejects.toThrow(error);
    expect(repairs).toBe(0);
  });
  test('shared policy covers restoration, authorized fresh fallback and scope', () => {
    expect(DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION).toContain('Prefer restoring a usable backup');
    expect(DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION).toContain('create a fresh development database without asking');
    expect(DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION).toContain('Preserve the old files');
    expect(DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION).toContain('external/production database');
    expect(DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION).toContain('Ticket agents must keep changes scoped');
  });
});
