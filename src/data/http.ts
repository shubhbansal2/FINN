import { err, ok, type Result } from '@/domain/result';

/**
 * The single outbound HTTP path for provider calls.
 * - Identifies itself truthfully; never impersonates a browser, replays
 *   cookies, or works around bot checks. A provider that requires that is
 *   treated as unavailable.
 * - Retries only transient failures (network, 429, 5xx) with backoff.
 * - Enforces a timeout and a response size cap.
 */
export const USER_AGENT = 'FINN-prototype/0.1 (investment research prototype; non-commercial)';

export type HttpError =
  | { kind: 'network'; message: string }
  | { kind: 'timeout' }
  | { kind: 'status'; status: number }
  | { kind: 'too_large'; limit: number };

export type HttpResponse = { status: number; contentType: string; finalUrl: string; body: Buffer };

export type HttpDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type HttpOptions = {
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  /** Treat these statuses as final answers rather than errors (e.g. Yahoo's 404 for unknown symbols). */
  passStatuses?: number[];
};

const RETRYABLE = (status: number) => status === 429 || status >= 500;

async function readCapped(res: Response, maxBytes: number): Promise<Result<Buffer, HttpError>> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    return err({ kind: 'too_large', limit: maxBytes });
  }
  if (!res.body) return ok(Buffer.alloc(0));
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return err({ kind: 'too_large', limit: maxBytes });
    }
    chunks.push(value);
  }
  return ok(Buffer.concat(chunks));
}

export async function httpGet(url: string, options: HttpOptions = {}, deps: HttpDeps = defaultHttpDeps): Promise<Result<HttpResponse, HttpError>> {
  const { accept = '*/*', timeoutMs = 20_000, maxBytes = 5 * 1024 * 1024, retries = 2, passStatuses = [] } = options;
  let lastError: HttpError = { kind: 'network', message: 'not attempted' };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const retryAfter = lastError.kind === 'status' && lastError.status === 429 ? 5_000 : 0;
      await deps.sleep(Math.max(retryAfter, 500 * 2 ** (attempt - 1)));
    }
    let res: Response;
    try {
      res = await deps.fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      // undici reports "fetch failed" with the real reason (ECONNRESET, ENOTFOUND, TLS…) in `cause`.
      const cause = e instanceof Error && e.cause instanceof Error ? ` (${(e.cause as NodeJS.ErrnoException).code ?? e.cause.message})` : '';
      lastError = isTimeout ? { kind: 'timeout' } : { kind: 'network', message: `${e instanceof Error ? e.message : String(e)}${cause}` };
      continue;
    }

    if (!res.ok && !passStatuses.includes(res.status)) {
      await res.body?.cancel();
      lastError = { kind: 'status', status: res.status };
      if (RETRYABLE(res.status)) continue;
      return err(lastError);
    }

    const body = await readCapped(res, maxBytes);
    if (!body.ok) return body;
    return ok({ status: res.status, contentType: res.headers.get('content-type') ?? '', finalUrl: res.url || url, body: body.value });
  }
  return err(lastError);
}

export function describeHttpError(e: HttpError): string {
  switch (e.kind) {
    case 'network':
      return `network error: ${e.message}`;
    case 'timeout':
      return 'request timed out';
    case 'status':
      return `HTTP ${e.status}`;
    case 'too_large':
      return `response exceeded ${Math.round(e.limit / 1024 / 1024)} MB limit`;
  }
}
