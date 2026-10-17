import {
  ACTION_POLICY,
  actionHashInput,
  actionStatuses,
  actionTypes,
  canMoveAction,
  canonicalJson,
  describeAction,
  ProposeActionRequest,
  roleAtLeast,
  type ActionStatus,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const id = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60';
const id2 = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61';

describe('action proposals', () => {
  it('accepts each type with exactly its payload', () => {
    const good = [
      { type: 'rerun_validation', payload: { ruleId: id } },
      { type: 'retry_import', payload: { uploadId: id } },
      { type: 'send_notification', payload: { destinationId: id }, note: 'Telling on-call.' },
      { type: 'create_github_issue', payload: { destinationId: id } },
      { type: 'trigger_n8n', payload: { destinationId: id } },
    ];
    for (const proposal of good) {
      assert.equal(ProposeActionRequest.safeParse(proposal).success, true, proposal.type);
    }
    assert.equal(good.length, actionTypes.length);
  });

  it('rejects unknown types, wrong or extra payload fields, and non-ids', () => {
    for (const bad of [
      { type: 'run_sql', payload: { query: 'drop table x' } },
      { type: 'rerun_validation', payload: { ruleId: id, extra: 1 } },
      { type: 'rerun_validation', payload: { uploadId: id } },
      { type: 'rerun_validation', payload: { ruleId: 'not-an-id' } },
      { type: 'send_notification', payload: { destinationId: id, message: 'free text' } },
      { type: 'send_notification', payload: { destinationId: id }, approved: true },
      { type: 'retry_import', payload: {} },
      { payload: { ruleId: id } },
      { type: 'rerun_validation', payload: { ruleId: id }, note: 'x'.repeat(301) },
    ]) {
      assert.equal(ProposeActionRequest.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe('who may do what', () => {
  it('has a policy for every type, and approval is never below proposing', () => {
    for (const type of actionTypes) {
      const policy = ACTION_POLICY[type];
      assert.ok(policy, type);
      assert.equal(roleAtLeast(policy.approve, policy.propose), true, type);
    }
    // External issue creation and webhook calls need an admin to approve.
    assert.equal(ACTION_POLICY.create_github_issue.approve, 'admin');
    assert.equal(ACTION_POLICY.trigger_n8n.approve, 'admin');
    assert.equal(ACTION_POLICY.rerun_validation.propose, 'analyst');
  });

  it('orders roles and refuses unknown ones', () => {
    assert.equal(roleAtLeast('owner', 'admin'), true);
    assert.equal(roleAtLeast('engineer', 'admin'), false);
    assert.equal(roleAtLeast('viewer', 'analyst'), false);
    assert.equal(roleAtLeast('stranger', 'viewer'), false);
  });
});

describe('payload hash input', () => {
  it('is the same for the same payload in any key order, and nested', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }),
      canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }),
    );
    assert.equal(canonicalJson({ a: undefined, b: 1 }), canonicalJson({ b: 1 }));
    assert.equal(canonicalJson([1, 2]), '[1,2]');
  });

  it('changes with the type, workspace, incident, or any payload value', () => {
    const base = {
      type: 'rerun_validation',
      workspaceId: id,
      incidentId: id,
      payload: { ruleId: id },
    };
    const text = actionHashInput(base);
    const variants = [
      { ...base, type: 'retry_import' },
      { ...base, workspaceId: id2 },
      { ...base, incidentId: id2 },
      { ...base, payload: { ruleId: id2 } },
      { ...base, payload: { ruleId: id, extra: true } },
    ];
    for (const variant of variants) assert.notEqual(actionHashInput(variant), text);
    assert.equal(actionHashInput({ ...base, payload: { ruleId: id } }), text);
  });
});

describe('action status moves', () => {
  it('only moves forward, and terminal states stay put', () => {
    const allowed: [ActionStatus, ActionStatus][] = [
      ['proposed', 'approved'],
      ['proposed', 'rejected'],
      ['proposed', 'expired'],
      ['approved', 'running'],
      ['running', 'succeeded'],
      ['running', 'failed'],
      ['running', 'approved'],
    ];
    for (const [from, to] of allowed) assert.equal(canMoveAction(from, to), true, `${from}>${to}`);
    for (const done of ['succeeded', 'failed', 'rejected', 'expired', 'cancelled'] as const) {
      for (const to of actionStatuses)
        assert.equal(canMoveAction(done, to), false, `${done}>${to}`);
    }
    assert.equal(canMoveAction('proposed', 'running'), false, 'cannot skip approval');
    assert.equal(canMoveAction('proposed', 'succeeded'), false);
    assert.equal(canMoveAction('approved', 'proposed'), false);
  });
});

describe('action preview', () => {
  it('says plainly what will happen and whether anything leaves DataSentinel', () => {
    const rerun = describeAction('rerun_validation', {
      ruleName: 'Orders fresh',
      datasetName: 'orders',
    });
    assert.match(rerun.title, /Orders fresh/);
    assert.equal(rerun.leavesDataSentinel, false);
    assert.match(rerun.steps.join(' '), /Nothing is changed in the source/);

    const retry = describeAction('retry_import', { uploadFilename: 'orders.csv' });
    assert.equal(retry.leavesDataSentinel, false);
    assert.match(retry.steps.join(' '), /Nothing is written to any source database/);

    for (const [type, extra] of [
      ['send_notification', { destinationName: 'On call', destinationType: 'email' }],
      ['create_github_issue', { destinationName: 'Issues', repository: 'acme/alerts' }],
      ['trigger_n8n', { destinationName: 'Flow', webhookHost: 'n8n.example.com' }],
    ] as const) {
      const preview = describeAction(type, extra);
      assert.equal(preview.leavesDataSentinel, true, type);
      assert.match(preview.steps.join(' '), /No table rows or secrets/);
    }
    assert.match(
      describeAction('create_github_issue', { repository: 'acme/alerts' }).title,
      /acme\/alerts/,
    );
    assert.match(
      describeAction('trigger_n8n', { webhookHost: 'n8n.example.com' }).steps.join(' '),
      /n8n\.example\.com/,
    );
  });
});
