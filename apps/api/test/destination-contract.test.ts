import {
  CreateDestinationRequest,
  SlackWebhookUrl,
  UpdateDestinationRequest,
  WebhookUrl,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const slack = 'https://hooks.slack.com/services/T0123/B0456/abcDEF123';

describe('destination contract', () => {
  it('accepts only real Slack incoming-webhook URLs', () => {
    assert.equal(SlackWebhookUrl.safeParse(slack).success, true);
    for (const bad of [
      'http://hooks.slack.com/services/T0123/B0456/abc',
      'https://evil.example/services/T0123/B0456/abc',
      'https://hooks.slack.com.evil.example/services/T0123/B0456/abc',
      'https://user:pw@hooks.slack.com/services/T0123/B0456/abc',
      'https://hooks.slack.com:8443/services/T0123/B0456/abc',
      'https://hooks.slack.com/services/T0123/B0456/abc?x=1',
      'https://hooks.slack.com/other/T0123/B0456/abc',
      'not a url',
    ]) {
      assert.equal(SlackWebhookUrl.safeParse(bad).success, false, bad);
    }
  });

  it('accepts https webhook addresses without credentials or query strings', () => {
    assert.equal(WebhookUrl.safeParse('https://hooks.example.com/ds/incidents').success, true);
    for (const bad of [
      'http://hooks.example.com/x',
      'https://u:p@hooks.example.com/x',
      'https://hooks.example.com/x?token=abc',
      'https://hooks.example.com/x#frag',
      'ftp://hooks.example.com/x',
      '',
    ]) {
      assert.equal(WebhookUrl.safeParse(bad).success, false, bad);
    }
  });

  it('creates typed destinations with every event by default and no stray fields', () => {
    const email = CreateDestinationRequest.parse({
      type: 'email',
      name: ' On call ',
      recipients: ['A@Example.com', 'a@example.com', 'b@example.com'],
    });
    assert.equal(email.name, 'On call');
    assert.deepEqual(email.type === 'email' && email.recipients, [
      'a@example.com',
      'b@example.com',
    ]);
    assert.deepEqual('events' in email && email.events, [
      'incident_opened',
      'incident_reopened',
      'incident_assigned',
    ]);

    assert.equal(
      CreateDestinationRequest.safeParse({ type: 'slack', name: 's', webhookUrl: slack }).success,
      true,
    );
    const hook = CreateDestinationRequest.parse({
      type: 'webhook',
      name: 'w',
      url: 'https://hooks.example.com/x',
      events: ['incident_opened', 'incident_opened'],
    });
    assert.deepEqual('events' in hook && hook.events, ['incident_opened']);
  });

  it('refuses bad shapes', () => {
    for (const bad of [
      { type: 'sms', name: 'x' },
      { type: 'email', name: 'x', recipients: [] },
      { type: 'email', name: 'x', recipients: ['nope'] },
      { type: 'email', name: 'x', recipients: Array.from({ length: 11 }, (_, i) => `u${i}@x.io`) },
      { type: 'email', name: '   ', recipients: ['a@x.io'] },
      { type: 'email', name: 'x', recipients: ['a@x.io'], events: [] },
      { type: 'email', name: 'x', recipients: ['a@x.io'], events: ['incident_resolved'] },
      { type: 'email', name: 'x', recipients: ['a@x.io'], url: 'https://x.io' },
      { type: 'slack', name: 'x', webhookUrl: 'https://hooks.example.com/x' },
      { type: 'webhook', name: 'x' },
    ]) {
      assert.equal(CreateDestinationRequest.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it('updates need at least one allowed change', () => {
    assert.equal(UpdateDestinationRequest.safeParse({}).success, false);
    assert.equal(UpdateDestinationRequest.safeParse({ type: 'slack' }).success, false);
    assert.equal(UpdateDestinationRequest.safeParse({ status: 'archived' }).success, false);
    assert.equal(UpdateDestinationRequest.safeParse({ status: 'paused' }).success, true);
    assert.equal(UpdateDestinationRequest.safeParse({ name: 'new' }).success, true);
  });

  it('accepts GitHub and n8n destinations with their own rules', () => {
    const token = `github_pat_${'A'.repeat(30)}`;
    const gh = CreateDestinationRequest.parse({
      type: 'github',
      name: 'Issues',
      owner: 'acme',
      repo: 'data-alerts',
      token,
      labels: ['data-quality'],
    });
    assert.equal(gh.type === 'github' && gh.labels.length, 1);
    assert.equal(
      CreateDestinationRequest.parse({ type: 'github', name: 'x', owner: 'a', repo: 'b', token })
        .type === 'github',
      true,
    );
    assert.equal(
      CreateDestinationRequest.safeParse({
        type: 'n8n',
        name: 'flow',
        url: 'https://n8n.example.com/webhook/abc',
      }).success,
      true,
    );
    for (const bad of [
      { type: 'github', name: 'x', owner: 'a', repo: 'b', token: 'ghp_short' },
      { type: 'github', name: 'x', owner: '../etc', repo: 'b', token },
      { type: 'github', name: 'x', owner: 'a', repo: '..', token },
      { type: 'github', name: 'x', owner: 'a/b', repo: 'c', token },
      { type: 'github', name: 'x', owner: 'a', repo: 'b', token, events: ['incident_opened'] },
      { type: 'github', name: 'x', owner: 'a', repo: 'b', token, labels: Array(6).fill('l') },
      { type: 'n8n', name: 'x', url: 'http://n8n.example.com/x' },
    ]) {
      assert.equal(CreateDestinationRequest.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});
