import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './llm.js';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface GeminiBody {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

/** Maps an HTTP status to an error code; the body is never read into the
 * error (D-101). */
function statusError(status: number): LlmError {
  if (status === 429) return new LlmError('rate_limited', true);
  if (status === 408) return new LlmError('timeout', true);
  if (status >= 500) return new LlmError('unavailable', true);
  return new LlmError('rejected', false);
}

/** Google Gemini over its REST API (Google AI Studio key). The key goes in a
 * header, never in the URL, and nothing the provider says is kept in errors.
 * The free tier may use prompts to improve Google's models: say so in
 * AI_RETENTION_NOTE and use it with synthetic data only. */
export function geminiProvider(
  apiKey: string,
  model: string,
  doFetch: Fetch = (url, init) => fetch(url, init),
): LlmProvider {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return {
    async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: 'user', parts: [{ text: request.user }] }],
            generationConfig: {
              maxOutputTokens: request.maxOutputTokens,
              responseMimeType: 'application/json',
            },
          }),
        });
      } catch (error) {
        const name = (error as { name?: unknown }).name;
        throw new LlmError(
          name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'unavailable',
          true,
        );
      }
      if (!res.ok) throw statusError(res.status);
      let body: GeminiBody;
      try {
        body = (await res.json()) as GeminiBody;
      } catch {
        throw new LlmError('invalid_response', false);
      }
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (text === '') throw new LlmError('invalid_response', false);
      return {
        text,
        model: body.modelVersion ?? model,
        inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}
