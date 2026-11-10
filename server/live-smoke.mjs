import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

const baseUrl = process.env.PAYEE_PASSPORT_API_URL || 'http://localhost:3001'
let cookie
const checks = []

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data, setCookie: response.headers.get('set-cookie') }
}

function assertStatus(name, result, expected = 200) {
  checks.push({ name, status: result.status, passed: result.status === expected })
  if (result.status !== expected) {
    const reason = typeof result.data?.error === 'string'
      ? result.data.error.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/0x[\da-f]{64}/gi, '[address]')
      : ''
    throw new Error(`${name} returned HTTP ${result.status}${reason ? `: ${reason}` : ''}`)
  }
}

try {
  const health = await request('/api/health')
  assertStatus('API health', health)
  if (!health.data.services?.tatum?.configured || !health.data.services?.walrus?.configured || !health.data.services?.ai?.configured) {
    throw new Error('Tatum, Walrus Memory, and OpenRouter must all be configured in the running API.')
  }

  const keypair = new Ed25519Keypair()
  const owner = keypair.getPublicKey().toSuiAddress()
  const challenge = await request('/api/auth/challenge', { method: 'POST', body: { owner } })
  assertStatus('wallet challenge', challenge)
  const signature = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.data.message))
  const verified = await request('/api/auth/verify', {
    method: 'POST',
    body: { challengeId: challenge.data.challengeId, signature: signature.signature },
  })
  assertStatus('Sui personal-message login', verified)
  cookie = verified.setCookie?.split(';')[0]
  if (!cookie) throw new Error('Wallet login succeeded but the API did not set a session cookie.')

  const session = await request('/api/auth/session')
  assertStatus('authenticated wallet session', session)

  const memory = await request('/api/memory/status')
  assertStatus('Walrus Memory account and inventory', memory)

  const chain = await request('/api/chain/inspect', { method: 'POST', body: { address: owner } })
  assertStatus('Tatum Sui Testnet balance and activity', chain)

  const review = await request('/api/agent/review', {
    method: 'POST',
    body: {
      recipient: owner,
      payeeName: 'Temporary smoke-test recipient',
      purpose: 'Automated Testnet connectivity check; no payment will be sent.',
    },
  })
  assertStatus('Walrus recall + OpenRouter agent review', review)

  await request('/api/auth/logout', { method: 'POST', body: {} })
  const afterLogout = await request('/api/auth/session')
  assertStatus('logout invalidates session', afterLogout, 401)
  cookie = undefined
  console.log(JSON.stringify({ network: health.data.network, checks, note: 'Used a throwaway signer; made no memory writes and no transactions.' }))
} finally {
  if (cookie) await request('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {})
}
