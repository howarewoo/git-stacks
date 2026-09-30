import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshUserAccessToken, requestDeviceCode } from '../src/main/github-app'

/**
 * The device flow's requests carry a client secret and, on renewal, a refresh
 * token. A 307 or 308 from a token endpoint would resend that body to whatever
 * the response names, so the exchange refuses redirects instead of following
 * them, and the secret never reaches the other origin.
 */
test('a token endpoint that redirects is refused, and the body never leaves for it', async () => {
  const asked: string[] = []
  const bodies: (string | null)[] = []
  const fetchDouble = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push(url)
    bodies.push(typeof init?.body === 'string' ? init.body : null)
    assert.equal(init?.redirect, 'error', 'the exchange must refuse redirects')
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 500 })
  }) as typeof globalThis.fetch

  await assert.rejects(
    refreshUserAccessToken({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      host: 'ghe.example.com',
      refreshToken: 'refresh-token-value',
      fetch: fetchDouble,
    } as never),
    (error: unknown) => (error as { code?: string }).code !== undefined,
  )
  await assert.rejects(
    requestDeviceCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      host: 'ghe.example.com',
      fetch: fetchDouble,
    } as never),
    (error: unknown) => (error as { code?: string }).code !== undefined,
  )
  assert.equal(asked.length, 2)
  for (const body of bodies) {
    assert.ok(body)
    assert.ok(
      !/github\.com/u.test(body as string),
      `a github.com credential was addressed elsewhere: ${String(body)}`,
    )
  }
  // The renewal body carries the refresh token and the device-code request the
  // client id; both were addressed to the configured host only.
  assert.ok(bodies.some((body) => String(body).includes('refresh-token-value')))
  assert.ok(bodies.some((body) => String(body).includes('client_id=client-id')))
  assert.ok(asked.every((url) => url.startsWith('https://ghe.example.com/')))
})
