import { test, expect } from 'bun:test';
import { isResourceFailure, validationStepFailure } from '../src/services/validation-step-failure.ts';
import { ValidationEnvironmentFailure } from '../src/services/validation-contract.ts';

test('compiler exit 137 during acceptance tests uses environment repair', () => {
  const error = validationStepFailure({ id: 'test-0', phase: 'verify', label: 'Acceptance/regression test', command: 'dotnet build app.csproj --no-restore', status: 'failed', error: 'error MSB6006: "csc.dll" exited with code 137.' }, false, 'candidate', 'evidence');
  expect(error).toBeInstanceOf(ValidationEnvironmentFailure);
  expect(error.failureKind).toBe('environment');
  expect(error.message).toContain('not confirmed');
  expect(error.evidenceId).toBe('evidence');
});

test('ordinary compiler and package warnings are not resource failures', () => {
  expect(isResourceFailure('error CS0137: invalid expression')).toBe(false);
  expect(isResourceFailure('warning NU1701: Package was restored using .NETFramework')).toBe(false);
  expect(isResourceFailure('Command exited 137')).toBe(true);
  expect(isResourceFailure('System.OutOfMemoryException')).toBe(true);
});
