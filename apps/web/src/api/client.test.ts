import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchApi, PaymentRequiredError, setCurrentConnectionId } from './client';

describe('fetchApi error handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCurrentConnectionId(null);
  });

  it('extracts nested license activation error messages from JSON payloads', async () => {
    const nestedErrorPayload = {
      statusCode: 400,
      message: {
        tier: 'community',
        valid: false,
        error: 'Invalid license key',
      },
      error: 'Bad Request',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(nestedErrorPayload), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      fetchApi('/license/activate', {
        method: 'POST',
        body: JSON.stringify({ key: 'test-key' }),
      }),
    ).rejects.toThrow('Invalid license key');
  });

  it('throws PaymentRequiredError for valid 402 payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Upgrade required',
          feature: 'advanced-analytics',
          currentTier: 'community',
          requiredTier: 'pro',
          upgradeUrl: '/billing',
        }),
        {
          status: 402,
          statusText: 'Payment Required',
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(fetchApi('/premium/feature')).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it('falls back to generic status message when response has no body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 400,
        statusText: 'Bad Request',
      }),
    );

    await expect(fetchApi('/license/activate')).rejects.toThrow('API error: 400 Bad Request');
  });
});

describe('fetchApi timeoutMs', () => {
  const jsonResponse = (body: string) =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    vi.restoreAllMocks();
    setCurrentConnectionId(null);
  });

  it('applies no timeout when timeoutMs is omitted', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse('{"a":1}')), 300)),
      );

    await expect(fetchApi('/slow')).resolves.toEqual({ a: 1 });
    expect(fetchSpy.mock.calls[0][1]?.signal).toBeUndefined();
  }, 5000);

  it('applies no timeout for non-numeric timeoutMs values', async () => {
    for (const timeoutMs of [undefined, null, NaN] as unknown as number[]) {
      vi.restoreAllMocks();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse('{"a":1}')), 100)),
        );

      await expect(fetchApi('/slow', { timeoutMs })).resolves.toEqual({ a: 1 });
      expect(fetchSpy.mock.calls[0][1]?.signal).toBeUndefined();
    }
  }, 5000);

  it('aborts a hung request with TimeoutError when timeoutMs is provided', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
          );
        }),
    );

    await expect(fetchApi('/hung', { timeoutMs: 1000 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  }, 8000);

  it('clamps out-of-range timeoutMs instead of rejecting', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse('{"ok":true}')));

    await expect(fetchApi('/x', { timeoutMs: 1 })).resolves.toEqual({ ok: true });
    await expect(fetchApi('/x', { timeoutMs: 999_999_999 })).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // A clamped timer was armed: fetch received a live (non-aborted) signal.
    for (const call of fetchSpy.mock.calls) {
      const signal = call[1]?.signal as AbortSignal | undefined;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });
});
