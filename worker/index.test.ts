import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from './index'

const createEnv = (apiProxyUrl = 'https://sub2api.guts.eu.org'): Env => ({
  ASSETS: {
    fetch: vi.fn(async () => new Response('asset')),
  },
  API_PROXY_URL: apiProxyUrl,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Cloudflare API proxy', () => {
  it('forwards an allowed request without browser credentials and preserves SSE', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('event: response.completed\n\n', {
      headers: {
        'Content-Type': 'text/event-stream',
        'Set-Cookie': 'session=upstream',
      },
    }))
    const request = new Request('https://app.example.com/api-proxy/images/generations?preview=true', {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
        Cookie: 'session=frontend',
        Origin: 'https://app.example.com',
        Referer: 'https://app.example.com/',
      },
      body: '{}',
    })

    const response = await worker.fetch(request, createEnv())

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://sub2api.guts.eu.org/v1/images/generations?preview=true')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('origin')).toBe(false)
    expect(headers.has('referer')).toBe(false)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(await response.text()).toBe('event: response.completed\n\n')
  })

  it('does not duplicate an existing v1 target path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const request = new Request('https://app.example.com/api-proxy/v1/responses', {
      method: 'POST',
      body: '{}',
    })

    await worker.fetch(request, createEnv('https://sub2api.guts.eu.org/v1'))

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://sub2api.guts.eu.org/v1/responses')
  })

  it('handles preflight locally and rejects paths outside the allowlist', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const env = createEnv()

    const preflight = await worker.fetch(new Request('https://app.example.com/api-proxy/v1/responses', {
      method: 'OPTIONS',
    }), env)
    const forbidden = await worker.fetch(new Request('https://app.example.com/api-proxy/v1/models', {
      method: 'POST',
    }), env)

    expect(preflight.status).toBe(204)
    expect(preflight.headers.has('access-control-allow-origin')).toBe(false)
    expect(forbidden.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves non-proxy requests from the assets binding', async () => {
    const env = createEnv()
    const response = await worker.fetch(new Request('https://app.example.com/settings'), env)

    expect(await response.text()).toBe('asset')
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })
})
