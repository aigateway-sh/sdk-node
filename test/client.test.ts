// packages/sdk-node/test/client.test.ts — SDK smoke tests.
// We stub fetch and assert on the request shape + webhook signing round-trip.

import { describe, it, expect, vi } from 'vitest';
import { AIgateway, verifyWebhook, AIgatewayError } from '../src/index';

function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const out = handler(url, init ?? {});
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('AIgateway client', () => {
  it('sends Authorization + x-aig-tag headers and JSON body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = stubFetch((url, init) => {
      calls.push({ url, init });
      return { status: 202, body: { id: 'job_1', status: 'queued', modality: 'video', created_at: 1, updated_at: 1 } };
    });
    const client = new AIgateway({
      apiKey: 'sk-aig-test',
      baseUrl: 'https://api.example.com',
      tag: 'feature-summarize',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const job = await client.jobs.createVideo({ prompt: 'a cat' });
    expect(job.id).toBe('job_1');
    expect(calls).toHaveLength(1);
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-aig-test');
    expect(headers['x-aig-tag']).toBe('feature-summarize');
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.url).toBe('https://api.example.com/v1/videos/generations');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ prompt: 'a cat' });
  });

  it('maps non-2xx responses to AIgatewayError', async () => {
    const fetchMock = stubFetch(() => ({
      status: 404,
      body: { error: { message: 'Model not found', type: 'model_not_found', code: 404 } },
    }));
    const client = new AIgateway({ apiKey: 'k', fetch: fetchMock as unknown as typeof fetch });
    await expect(client.models.get('nope/nope')).rejects.toMatchObject({
      name: 'AIgatewayError',
      statusCode: 404,
      type: 'model_not_found',
    });
  });

  it('jobs.wait polls until terminal and returns the completed job', async () => {
    const responses: Array<{ status: number; body: any }> = [
      { status: 200, body: { id: 'j', status: 'queued', modality: 'video', created_at: 0, updated_at: 0 } },
      { status: 200, body: { id: 'j', status: 'processing', modality: 'video', created_at: 0, updated_at: 0 } },
      { status: 200, body: { id: 'j', status: 'completed', modality: 'video', created_at: 0, updated_at: 0, result_url: 'https://r2/x.mp4' } },
    ];
    const fetchMock = stubFetch(() => responses.shift()!);
    const client = new AIgateway({ apiKey: 'k', fetch: fetchMock as unknown as typeof fetch });
    const job = await client.jobs.wait('j', { pollIntervalMs: 1, timeoutMs: 5_000 });
    expect(job.status).toBe('completed');
    expect(job.result_url).toBe('https://r2/x.mp4');
  });

  it('query params are URL-encoded', async () => {
    let capturedUrl = '';
    const fetchMock = stubFetch((url) => {
      capturedUrl = url;
      return { status: 200, body: { object: 'list', data: [] } };
    });
    const client = new AIgateway({ apiKey: 'k', baseUrl: 'https://api.example.com', fetch: fetchMock as unknown as typeof fetch });
    await client.models.list({ modality: 'image', provider: 'bfl' });
    expect(capturedUrl).toContain('modality=image');
    expect(capturedUrl).toContain('provider=bfl');
  });
});

describe('verifyWebhook', () => {
  async function signManually(secret: string, body: string, t: number): Promise<string> {
    const enc = new TextEncoder();
    const { webcrypto } = await import('node:crypto');
    const key = await webcrypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await webcrypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`));
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return `t=${t},v1=${hex}`;
  }

  it('accepts a correctly signed payload', async () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ id: 'job_1', status: 'completed' });
    const t = Math.floor(Date.now() / 1000);
    const header = await signManually(secret, body, t);
    expect(await verifyWebhook(secret, body, header)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const secret = 'whsec_test';
    const body = 'hello';
    const t = Math.floor(Date.now() / 1000);
    const header = await signManually(secret, body, t);
    expect(await verifyWebhook(secret, 'hello-tampered', header)).toBe(false);
  });

  it('rejects wrong secret', async () => {
    const body = 'hello';
    const t = Math.floor(Date.now() / 1000);
    const header = await signManually('whsec_a', body, t);
    expect(await verifyWebhook('whsec_b', body, header)).toBe(false);
  });

  it('rejects stale timestamp past tolerance', async () => {
    const secret = 'whsec_test';
    const body = 'hello';
    const t = Math.floor(Date.now() / 1000) - 3600;
    const header = await signManually(secret, body, t);
    expect(await verifyWebhook(secret, body, header, 60)).toBe(false);
  });

  it('rejects malformed header', async () => {
    expect(await verifyWebhook('whsec_test', 'body', 'garbage')).toBe(false);
    expect(await verifyWebhook('whsec_test', 'body', 't=abc,v1=xyz')).toBe(false);
  });
});
