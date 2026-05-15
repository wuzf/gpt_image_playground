// Cloudflare Worker entry: serve static assets via the ASSETS binding,
// and expose a same-origin /api-proxy/* route that forwards requests
// to the upstream API configured via env.API_PROXY_URL. This mirrors
// the nginx-based proxy in deploy/nginx.conf so the front-end's
// "API 代理" toggle works on Workers deployments.
//
// Extra behavior: if the upstream answers with an OpenAI Responses API
// SSE stream (text/event-stream), this Worker folds the stream into a
// single JSON response shaped like a non-streaming ResponsesApiResponse,
// so the unmodified front-end (which calls response.json()) keeps working.

export interface Env {
  ASSETS: Fetcher
  API_PROXY_URL?: string
}

const API_PROXY_PREFIX = '/api-proxy'

const ALLOWED_PROXY_PATHS = [
  /^\/(?:v1\/)?images\/generations\/?$/,
  /^\/(?:v1\/)?images\/edits\/?$/,
  /^\/(?:v1\/)?responses\/?$/,
]

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

function stripHopByHop(headers: Headers): Headers {
  const out = new Headers()
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.append(key, value)
  })
  return out
}

interface ParsedSseEvent {
  event: string
  data: string
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  let event = ''
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (!event && !dataLines.length) return null
  return { event, data: dataLines.join('\n') }
}

interface FoldResult {
  status: number
  body: unknown
}

async function foldResponsesSse(upstream: Response): Promise<FoldResult> {
  if (!upstream.body) {
    return { status: 502, body: { error: { message: 'Upstream returned an SSE response without a body.' } } }
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed: unknown = null
  let failedResponse: unknown = null
  let errorPayload: unknown = null

  const handleEvent = (evt: ParsedSseEvent): boolean => {
    if (!evt.data) return false
    let payload: any
    try {
      payload = JSON.parse(evt.data)
    } catch {
      return false
    }
    switch (evt.event) {
      case 'response.completed':
        completed = payload?.response ?? payload
        return true
      case 'response.failed':
        failedResponse = payload?.response ?? payload
        return false
      case 'error':
        errorPayload = payload
        return false
      default:
        return false
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      if (done) {
        buffer += decoder.decode()
      }

      let sepIdx: number
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)
        const evt = parseSseBlock(block)
        if (evt && handleEvent(evt)) {
          // Got response.completed — we have everything we need.
          try { await reader.cancel() } catch { /* ignore */ }
          return { status: 200, body: completed }
        }
      }

      if (done) {
        // Drain a trailing block that wasn't terminated by a blank line.
        if (buffer.trim().length) {
          const evt = parseSseBlock(buffer)
          if (evt && handleEvent(evt)) return { status: 200, body: completed }
        }
        break
      }
    }
  } catch (err) {
    return {
      status: 502,
      body: {
        error: {
          message: `Failed to read SSE stream: ${err instanceof Error ? err.message : String(err)}`,
          type: 'sse_proxy_error',
        },
      },
    }
  }

  if (errorPayload) {
    return {
      status: 502,
      body: { error: (errorPayload as any)?.error ?? errorPayload },
    }
  }
  if (failedResponse) {
    return {
      status: 502,
      body: { error: (failedResponse as any)?.error ?? { message: 'Upstream response.failed', detail: failedResponse } },
    }
  }
  return {
    status: 502,
    body: { error: { message: 'Upstream SSE stream ended without response.completed.', type: 'sse_proxy_error' } },
  }
}

async function handleApiProxy(request: Request, env: Env): Promise<Response> {
  const target = env.API_PROXY_URL
  if (!target) {
    return new Response('API proxy is not configured (set API_PROXY_URL).', { status: 503 })
  }

  if (request.method !== 'POST' && request.method !== 'OPTIONS') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } })
  }

  const url = new URL(request.url)
  const subPath = url.pathname.slice(API_PROXY_PREFIX.length) || '/'
  if (!ALLOWED_PROXY_PATHS.some((re) => re.test(subPath))) {
    return new Response('Forbidden: API Proxy path restricted', { status: 403 })
  }

  const normalizedSubPath = subPath.startsWith('/v1/') ? subPath : `/v1${subPath}`
  const upstreamUrl = new URL(target.replace(/\/+$/, '') + normalizedSubPath)
  upstreamUrl.search = url.search

  const headers = stripHopByHop(request.headers)
  const init: RequestInit = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'follow',
  }

  const upstream = await fetch(upstreamUrl.toString(), init)
  const contentType = upstream.headers.get('content-type') || ''

  if (contentType.toLowerCase().includes('text/event-stream')) {
    const folded = await foldResponsesSse(upstream)
    return new Response(JSON.stringify(folded.body ?? null), {
      status: folded.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  return upstream
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === API_PROXY_PREFIX || url.pathname.startsWith(API_PROXY_PREFIX + '/')) {
      return handleApiProxy(request, env)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
