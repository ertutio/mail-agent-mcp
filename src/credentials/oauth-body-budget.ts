/**
 * Shared byte budget for OAuth HTTP response bodies (T19 / BUG-SEC-05).
 * Token endpoints return kilobyte-scale JSON; anything larger is hostile
 * (a drip-feed or padding attack on the parser) and is rejected mid-stream.
 */
export const MAX_OAUTH_BODY_BYTES = 64 * 1024;

/** Thrown mid-stream when a response body blows the byte budget. */
export class OAuthBodyBudgetError extends Error {}

interface BoundedJsonResponse {
  /** Real fetch Responses expose a stream; test doubles may only have json(). */
  body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

/**
 * Reads a JSON response body under a hard byte budget. When the response
 * exposes a stream the budget is enforced while reading (an oversized or
 * drip-fed body is cut off instead of buffered in full); without a stream the
 * call falls back to response.json() for test doubles.
 *
 * The caller's abort signal (wired to the response) still applies: an aborted
 * request rejects the reader read, so a deadline covers the body too.
 */
export async function readBoundedJson(
  response: BoundedJsonResponse,
  maxBytes: number = MAX_OAUTH_BODY_BYTES,
): Promise<unknown> {
  if (!response.body) return await response.json();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new OAuthBodyBudgetError(`OAuth response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or aborted; the original error wins.
    }
    throw error;
  }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
}
