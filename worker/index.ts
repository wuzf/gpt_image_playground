// 静态资源与 API 代理共用同一个 Worker，避免浏览器跨域请求上游。

interface AssetsBinding {
  fetch(request: Request): Promise<Response>
}

export interface Env {
  ASSETS: AssetsBinding
  API_PROXY_URL?: string
}

const API_PROXY_PREFIX = '/api-proxy'

const ALLOWED_PROXY_PATHS = [
  /^\/(?:v1\/)?images\/generations\/?$/,
  /^\/(?:v1\/)?images\/edits\/?$/,
  /^\/(?:v1\/)?responses\/?$/,
]

const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
])

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

function createUpstreamHeaders(headers: Headers): Headers {
  const out = new Headers()
  headers.forEach((value, key) => {
    if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) out.append(key, value)
  })
  return out
}

function createResponseHeaders(headers: Headers): Headers {
  const out = new Headers()
  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase()
    if (!HOP_BY_HOP.has(normalizedKey) && normalizedKey !== 'set-cookie') out.append(key, value)
  })
  return out
}

async function handleApiProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const subPath = url.pathname.slice(API_PROXY_PREFIX.length) || '/'
  if (!ALLOWED_PROXY_PATHS.some((re) => re.test(subPath))) {
    return new Response('Forbidden: API Proxy path restricted', { status: 403 })
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } })
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } })
  }

  if (!env.API_PROXY_URL) {
    return new Response('API proxy is not configured (set API_PROXY_URL).', { status: 503 })
  }

  let upstreamUrl: URL
  try {
    upstreamUrl = new URL(env.API_PROXY_URL)
  } catch {
    return new Response('API proxy target is invalid.', { status: 503 })
  }

  const basePath = upstreamUrl.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  const endpointPath = subPath.replace(/^\/(?:v1\/)?/, '')
  upstreamUrl.pathname = `${basePath}/v1/${endpointPath}`
  upstreamUrl.search = url.search
  upstreamUrl.hash = ''

  const init: RequestInit = {
    method: 'POST',
    headers: createUpstreamHeaders(request.headers),
    body: request.body,
    redirect: 'manual',
    signal: request.signal,
  }

  try {
    const upstream = await fetch(upstreamUrl, init)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: createResponseHeaders(upstream.headers),
    })
  } catch (err) {
    console.error('API 代理请求失败', err)
    return new Response('Upstream request failed.', { status: 502 })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === API_PROXY_PREFIX || url.pathname.startsWith(API_PROXY_PREFIX + '/')) {
      return handleApiProxy(request, env)
    }
    return env.ASSETS.fetch(request)
  },
}
