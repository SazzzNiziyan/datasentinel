import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectorFailure, failureCodes, isConnectorFailure } from '@datasentinel/connectors';

describe('ConnectorFailure', () => {
  it('carries a fixed, actionable message and never the raw cause', () => {
    const raw = new Error('password authentication failed for user "app" at 10.0.0.5:5432');
    const failure = new ConnectorFailure('auth_failed', { cause: raw });
    assert.equal(failure.message, 'The source rejected the username or password.');
    assert.match(failure.hint, /Check the credentials/);
    assert.equal(failure.retryable, false);
    assert.doesNotMatch(JSON.stringify(failure.toJSON()), /10\.0\.0\.5|password authentication/);
    // The cause stays available to server code for logging after scrubbing.
    assert.equal(failure.cause, raw);
  });

  it('marks network trouble as retryable', () => {
    assert.equal(new ConnectorFailure('unreachable').retryable, true);
    assert.equal(new ConnectorFailure('timeout').retryable, true);
    assert.equal(new ConnectorFailure('malformed').retryable, false);
  });

  it('has a message and hint for every code', () => {
    for (const code of failureCodes) {
      const failure = new ConnectorFailure(code);
      assert.ok(failure.message.length > 0 && failure.hint.length > 0, code);
    }
  });

  it('recognises failures across package copies by shape', () => {
    assert.equal(isConnectorFailure(new ConnectorFailure('timeout')), true);
    assert.equal(isConnectorFailure(new Error('timeout')), false);
  });
});
