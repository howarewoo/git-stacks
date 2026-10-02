import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectGitHubTransport, GitHubTransportError } from '../src/main/github-transport'
import { FaultInjectingTransport, LiveRequestPacing } from './live/transport'

function clock() {
  let now = 0
  const waits: number[] = []
  const pacing = new LiveRequestPacing(
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds)
      now += milliseconds
    },
  )
  return { pacing, waits, now: () => now }
}

test('authorized content writes are serialized at no more than 60 per minute', async () => {
  const { pacing, waits, now } = clock()
  const sent: number[] = []
  await Promise.all(
    Array.from({ length: 100 }, () => pacing.run(true, async () => sent.push(now()))),
  )
  assert.equal(sent.length, 100)
  assert.equal(sent[99], 99_000)
  assert.ok(waits.every((milliseconds) => milliseconds === 1_000))
  await pacing.run(false, async () => assert.equal(now(), 99_000))
})

test('a host rate limit delays following requests without replaying the refused write', async () => {
  for (const [kind, retryAfterSeconds, remaining, reset, expected] of [
    ['secondary-rate-limit', 5, 1, 90_000, 5_000],
    ['rate-limited', 5, 0, 90_000, 90_000],
    ['secondary-rate-limit', undefined, null, null, 60_000],
  ] as const) {
    const { pacing, waits, now } = clock()
    const error = new GitHubTransportError({
      kind,
      status: 403,
      detail: 'host rate limit',
      rateLimit: {
        limit: 5_000,
        remaining,
        reset: reset === null ? null : new Date(reset),
        resource: 'core',
        retryAfterSeconds: retryAfterSeconds ?? null,
      },
    })
    let sends = 0
    const refused = pacing.run(true, async () => {
      sends += 1
      throw error
    })
    const next = pacing.run(false, async () => now())
    await assert.rejects(refused, (caught) => caught === error)
    assert.equal(await next, expected)
    assert.equal(sends, 1)
    assert.deepEqual(waits, [expected])
  }
})

test('uncertain writes are not replayed and do not poison the pacing queue', async () => {
  const { pacing, now } = clock()
  const error = new GitHubTransportError({ kind: 'network', detail: 'lost answer' })
  let sends = 0
  await assert.rejects(
    pacing.run(true, async () => {
      sends += 1
      throw error
    }),
    (caught) => caught === error,
  )
  await pacing.run(true, async () => assert.equal(now(), 1_000))
  assert.equal(sends, 1)
})

test('the decorator paces REST and GraphQL mutations across actors, but not reads', async () => {
  const { pacing, now } = clock()
  const sent: number[] = []
  const inner = new DirectGitHubTransport({
    token: 'synthetic-pacing-token',
    fetch: async () => {
      sent.push(now())
      return new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const primary = new FaultInjectingTransport(inner, pacing)
  const reviewer = new FaultInjectingTransport(inner, pacing)
  assert.equal(primary.destinationHost, inner.destinationHost)
  assert.equal(await primary.credentialAuthority(), await inner.credentialAuthority())
  await primary.rest({ method: 'POST', path: 'repos/example/disposable/pulls/1/reviews' })
  await reviewer.graphql('mutation Example { ok }')
  await primary.graphql('query Example { ok }')
  await primary.rest({ path: 'repos/example/disposable' })
  await reviewer.rest({ method: 'DELETE', path: 'repos/example/disposable' })
  assert.deepEqual(sent, [0, 1_000, 1_000, 1_000, 2_000])
})
