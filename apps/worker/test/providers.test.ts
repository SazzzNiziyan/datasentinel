import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { geminiProvider } from '../src/ai/gemini-provider.js';
import { LlmError } from '../src/ai/llm.js';
import { classifySmtpError, smtpTransport } from '../src/delivery/smtp-transport.js';

const message = { to: ['a@example.test'], subject: 'S', text: 't', html: '<p>t</p>' };

describe('SMTP transport', () => {
  it('sends the message from the configured sender', async () => {
    let sent: Record<string, unknown> = {};
    const t = smtpTransport('smtp://u:p@h:587', 'DataSentinel <noreply@example.test>', {
      sendMail: (m) => {
        sent = m;
        return Promise.resolve({ messageId: 'id-1' });
      },
    });
    assert.deepEqual(await t.send(message), { ok: true, messageId: 'id-1' });
    assert.equal(sent.from, 'DataSentinel <noreply@example.test>');
    assert.deepEqual(sent.to, ['a@example.test']);
  });

  it('classifies failures by code and never keeps the server text', async () => {
    assert.deepEqual(classifySmtpError({ code: 'EAUTH' }), {
      retryable: false,
      reason: 'email_auth_failed',
    });
    assert.deepEqual(classifySmtpError({ responseCode: 550 }), {
      retryable: false,
      reason: 'email_rejected',
    });
    assert.deepEqual(classifySmtpError({ code: 'ETIMEDOUT' }), {
      retryable: true,
      reason: 'email_unavailable',
    });
    const t = smtpTransport('smtp://u:secret@h:587', 'x@example.test', {
      sendMail: () =>
        Promise.reject(Object.assign(new Error('bad password secret'), { code: 'EAUTH' })),
    });
    const result = await t.send(message);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});

describe('Gemini provider', () => {
  const request = { system: 'sys', user: 'usr', maxOutputTokens: 100 };
  const signal = new AbortController().signal;
  const reply = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('sends the key in a header and reads text and token counts', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const p = geminiProvider('KEY', 'gemini-test', (url, init) => {
      seen = { url, headers: init.headers as Record<string, string>, body: init.body as string };
      return reply(200, {
        candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
        modelVersion: 'gemini-test-001',
      })();
    });
    assert.deepEqual(await p.complete(request, signal), {
      text: '{"a":1}',
      model: 'gemini-test-001',
      inputTokens: 7,
      outputTokens: 3,
    });
    assert.equal(seen?.headers['x-goog-api-key'], 'KEY');
    assert.equal(seen?.url.includes('KEY'), false);
    assert.ok(seen?.url.includes('gemini-test:generateContent'));
  });

  it('maps failures to codes without provider text', async () => {
    const code = async (status: number) => {
      const p = geminiProvider('KEY', 'm', reply(status, { error: { message: 'KEY leaked' } }));
      try {
        await p.complete(request, signal);
      } catch (e) {
        assert.ok(e instanceof LlmError);
        assert.equal(e.message.includes('KEY'), false);
        return [e.code, e.retryable];
      }
      return null;
    };
    assert.deepEqual(await code(429), ['rate_limited', true]);
    assert.deepEqual(await code(503), ['unavailable', true]);
    assert.deepEqual(await code(403), ['rejected', false]);
    const empty = geminiProvider('KEY', 'm', reply(200, { candidates: [] }));
    await assert.rejects(empty.complete(request, signal), { code: 'invalid_response' });
    const down = geminiProvider('KEY', 'm', () => Promise.reject(new Error('offline')));
    await assert.rejects(down.complete(request, signal), { code: 'unavailable' });
  });
});
