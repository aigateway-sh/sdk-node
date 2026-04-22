// packages/sdk-node/src/index.ts — Official AIgateway Node SDK.
// Thin typed wrapper over the non-OpenAI surface of AIgateway. For chat,
// embeddings, images, STT, TTS, and moderation, use the `openai` package
// directly with { baseURL: 'https://api.aigateway.sh/v1' } — AIgateway is
// drop-in. This SDK covers the aggregator-native endpoints and the async
// job flow that OpenAI doesn't model.

export const VERSION = '0.1.2';
export const DEFAULT_BASE_URL = 'https://api.aigateway.sh';
export const DEFAULT_MEDIA_BASE_URL = 'https://media.aigateway.sh';

// ============ TYPES ============

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  modality: string;
  model?: string;
  created_at: number;
  updated_at: number;
  result_url?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface VideoRequest {
  prompt: string;
  model?: string;
  duration?: number;
  aspect_ratio?: string;
  resolution?: string;
  image_url?: string;
  webhook_url?: string;
}

export interface MusicRequest {
  prompt: string;
  model?: string;
  duration?: number;
  webhook_url?: string;
}

export interface ThreeDRequest {
  prompt: string;
  model?: string;
  image_url?: string;
  webhook_url?: string;
}

export interface SubAccount {
  id: string;
  name: string;
  external_ref?: string;
  spend_cap_cents: number;
  rate_limit_rpm: number;
  default_tag?: string;
  created_at: number;
}

export interface EvalRun {
  id: string;
  name: string;
  candidate_models: string[];
  metric: 'quality' | 'cost' | 'speed';
  status: 'queued' | 'running' | 'completed' | 'failed';
  winning_model?: string;
  alias: string;
}

export interface ReplayRecord {
  id: string;
  source_request_id: string;
  target_model: string;
  diff: Record<string, unknown>;
}

export class AIgatewayError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly type: string) {
    super(message);
    this.name = 'AIgatewayError';
  }
}

// ============ CLIENT ============

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Override the media host for file downloads. Defaults to https://media.aigateway.sh. */
  mediaBaseUrl?: string;
  tag?: string; // Default x-aig-tag for every request from this client.
  fetch?: typeof fetch;
}

export class AIgateway {
  readonly baseUrl: string;
  readonly mediaBaseUrl: string;
  readonly apiKey: string;
  readonly tag?: string;
  private readonly fetchImpl: typeof fetch;

  readonly jobs: JobsAPI;
  readonly subAccounts: SubAccountsAPI;
  readonly evals: EvalsAPI;
  readonly replays: ReplaysAPI;
  readonly files: FilesAPI;
  readonly webhookSecret: WebhookSecretAPI;
  readonly models: ModelsAPI;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error('apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.mediaBaseUrl = (opts.mediaBaseUrl ?? DEFAULT_MEDIA_BASE_URL).replace(/\/+$/, '');
    this.tag = opts.tag;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch);
    if (!this.fetchImpl) {
      throw new Error('fetch is not available — pass opts.fetch or upgrade to Node 18+');
    }

    this.jobs = new JobsAPI(this);
    this.subAccounts = new SubAccountsAPI(this);
    this.evals = new EvalsAPI(this);
    this.replays = new ReplaysAPI(this);
    this.files = new FilesAPI(this);
    this.webhookSecret = new WebhookSecretAPI(this);
    this.models = new ModelsAPI(this);
  }

  // Exposed so resource classes can issue authed requests against the gateway.
  async request<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined>; tag?: string } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json',
      'User-Agent': `aigateway-node/${VERSION}`,
    };
    const tag = opts.tag ?? this.tag;
    if (tag) headers['x-aig-tag'] = tag;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const resp = await this.fetchImpl(url.toString(), { method, headers, body });
    const text = await resp.text();
    const parsed = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!resp.ok) {
      const err = (parsed as any)?.error ?? {};
      throw new AIgatewayError(
        err.message ?? `HTTP ${resp.status}`,
        resp.status,
        err.type ?? 'api_error',
      );
    }
    return parsed as T;
  }
}

// ============ RESOURCE: JOBS ============

class JobsAPI {
  constructor(private client: AIgateway) {}

  createVideo(req: VideoRequest): Promise<Job> {
    return this.client.request<Job>('POST', '/v1/videos/generations', { body: req });
  }
  createMusic(req: MusicRequest): Promise<Job> {
    return this.client.request<Job>('POST', '/v1/audio/music', { body: req });
  }
  create3D(req: ThreeDRequest): Promise<Job> {
    return this.client.request<Job>('POST', '/v1/3d/generations', { body: req });
  }
  get(jobId: string): Promise<Job> {
    return this.client.request<Job>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
  }
  cancel(jobId: string): Promise<Job> {
    return this.client.request<Job>('DELETE', `/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  /**
   * Poll a job until it reaches a terminal state (completed / failed) or the
   * timeout expires. Backs off from 2s → 30s.
   */
  async wait(jobId: string, opts: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {}): Promise<Job> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const start = Date.now();
    let delay = opts.pollIntervalMs ?? 2_000;
    while (true) {
      if (opts.signal?.aborted) throw new Error('Aborted');
      const job = await this.get(jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      if (Date.now() - start > timeoutMs) {
        throw new AIgatewayError(`Job ${jobId} did not complete within ${timeoutMs}ms`, 408, 'timeout_error');
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 30_000);
    }
  }
}

// ============ RESOURCE: SUB-ACCOUNTS ============

class SubAccountsAPI {
  constructor(private client: AIgateway) {}

  create(opts: {
    name: string;
    external_ref?: string;
    spend_cap_cents?: number;
    rate_limit_rpm?: number;
    default_tag?: string;
  }): Promise<SubAccount & { key: string }> {
    return this.client.request('POST', '/v1/sub-accounts', { body: opts });
  }
  list(): Promise<{ object: 'list'; data: SubAccount[] }> {
    return this.client.request('GET', '/v1/sub-accounts');
  }
  get(id: string): Promise<SubAccount> {
    return this.client.request('GET', `/v1/sub-accounts/${encodeURIComponent(id)}`);
  }
  delete(id: string): Promise<{ status: 'ok' }> {
    return this.client.request('DELETE', `/v1/sub-accounts/${encodeURIComponent(id)}`);
  }
}

// ============ RESOURCE: EVALS ============

class EvalsAPI {
  constructor(private client: AIgateway) {}

  create(opts: {
    name: string;
    candidate_models: string[];
    dataset: Array<{ input: unknown; expected?: unknown }>;
    metric?: 'quality' | 'cost' | 'speed';
  }): Promise<EvalRun> {
    return this.client.request('POST', '/v1/evals', { body: opts });
  }
  list(): Promise<{ object: 'list'; data: EvalRun[] }> {
    return this.client.request('GET', '/v1/evals');
  }
  get(id: string): Promise<EvalRun> {
    return this.client.request('GET', `/v1/evals/${encodeURIComponent(id)}`);
  }
}

// ============ RESOURCE: REPLAYS ============

class ReplaysAPI {
  constructor(private client: AIgateway) {}

  run(opts: { source_request_id: string; target_model: string; shadow?: boolean }): Promise<ReplayRecord> {
    return this.client.request('POST', '/v1/replays', { body: opts });
  }
  list(limit = 50): Promise<{ object: 'list'; data: ReplayRecord[] }> {
    return this.client.request('GET', '/v1/replays', { query: { limit } });
  }
  get(id: string): Promise<ReplayRecord> {
    return this.client.request('GET', `/v1/replays/${encodeURIComponent(id)}`);
  }
}

// ============ RESOURCE: FILES ============

class FilesAPI {
  constructor(private client: AIgateway) {}

  /**
   * Fetch the binary result of a completed async job. Returns a Response so
   * callers can pipe to disk, read as ArrayBuffer, etc. Served from
   * `media.aigateway.sh` — never from the API host.
   */
  download(jobId: string, filename: string): Promise<Response> {
    const url = `${this.client.mediaBaseUrl}/v1/files/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
    return fetch(url, { headers: { Authorization: `Bearer ${this.client.apiKey}` } });
  }

  /** Mint a 1h (by default) signed URL that doesn't require the gateway key. */
  async signedUrl(jobId: string, filename: string, expiresInSeconds = 3600): Promise<{ url: string; expires_at: number }> {
    return this.client.request(
      'GET',
      `/v1/files/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}/signed`,
      { query: { expires_in: expiresInSeconds } },
    );
  }
}

// ============ RESOURCE: WEBHOOK SECRET ============

class WebhookSecretAPI {
  constructor(private client: AIgateway) {}

  get(): Promise<{ secret: string | null }> {
    return this.client.request('GET', '/v1/webhook-secret');
  }
  rotate(): Promise<{ secret: string }> {
    return this.client.request('POST', '/v1/webhook-secret/rotate');
  }
}

// ============ RESOURCE: MODELS ============

class ModelsAPI {
  constructor(private client: AIgateway) {}

  list(opts: { modality?: string; provider?: string } = {}): Promise<{ object: 'list'; data: any[] }> {
    return this.client.request('GET', '/v1/models', { query: opts });
  }
  get(id: string): Promise<any> {
    return this.client.request('GET', `/v1/models/${encodeURIComponent(id)}`);
  }
}

// ============ WEBHOOK VERIFICATION ============
// Use this inside your webhook handler to confirm a callback really came
// from AIgateway and hasn't been replayed.

const textEncoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const subtle = (globalThis.crypto ?? (await import('node:crypto')).webcrypto).subtle;
  const key = await subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, textEncoder.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify an AIgateway webhook signature.
 * @param secret — your key's webhook secret (fetch via `client.webhookSecret.get()`).
 * @param body — the raw request body (string, exactly as received).
 * @param header — the `X-Gateway-Signature` request header.
 * @param toleranceSeconds — reject if `t` is outside this window (default 5m).
 */
export async function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 5 * 60,
): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const idx = kv.indexOf('=');
    if (idx > 0) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return timingSafeEqual(expected, v1);
}

export default AIgateway;
