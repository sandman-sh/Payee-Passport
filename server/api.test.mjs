import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { after, before, test } from 'node:test'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

let serverProcess
let baseUrl
let cookie
let owner

before(async () => {
  const portServer = createServer()
  portServer.listen(0, '127.0.0.1')
  await once(portServer, 'listening')
  const { port } = portServer.address()
  await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()))
  baseUrl = `http://127.0.0.1:${port}`
  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      TATUM_API_KEY: '',
      OPENROUTER_API_KEY: '',
      WALRUS_MEMORY_ACCOUNT_ID: '',
      WALRUS_MEMORY_DELEGATE_KEY: '',
    },
    stdio: 'ignore',
  })
  serverProcess.once('error', (error) => { throw error })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {}
    if (serverProcess.exitCode !== null) throw new Error(`API exited early with ${serverProcess.exitCode}`)
    await delay(200)
  }
  throw new Error('API did not become ready in time')
})

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return
  serverProcess.kill('SIGTERM')
  await Promise.race([once(serverProcess, 'exit'), delay(3_000)])
  if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL')
})

async function json(path, { method = 'GET', body, withSession = true } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(withSession && cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, data: await response.json().catch(() => ({})) }
}

test('health reports the real Testnet and unconfigured services without exposing credentials', async () => {
  const { response, data } = await json('/api/health', { withSession: false })
  assert.equal(response.status, 200)
  assert.equal(data.network, 'Sui Testnet')
  assert.equal(data.services.tatum.configured, false)
  assert.equal(data.services.walrus.configured, false)
  assert.equal(data.services.ai.configured, false)
  assert.equal(JSON.stringify(data).includes('API_KEY'), false)
})

test('protected routes reject requests without a wallet session', async () => {
  const { response } = await json('/api/memory/status', { withSession: false })
  assert.equal(response.status, 401)
})

test('one-time challenge authenticates only the wallet that signed it', async () => {
  const rightful = new Ed25519Keypair()
  const impostor = new Ed25519Keypair()
  owner = rightful.getPublicKey().toSuiAddress()

  const challengeResult = await json('/api/auth/challenge', { method: 'POST', body: { owner }, withSession: false })
  assert.equal(challengeResult.response.status, 200)
  const signature = await rightful.signPersonalMessage(new TextEncoder().encode(challengeResult.data.message))
  const verified = await json('/api/auth/verify', {
    method: 'POST',
    body: { challengeId: challengeResult.data.challengeId, signature: signature.signature },
    withSession: false,
  })
  assert.equal(verified.response.status, 200)
  assert.equal(verified.data.authenticated, true)
  cookie = verified.response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)

  const replay = await json('/api/auth/verify', {
    method: 'POST',
    body: { challengeId: challengeResult.data.challengeId, signature: signature.signature },
    withSession: false,
  })
  assert.equal(replay.response.status, 400)

  const otherChallenge = await json('/api/auth/challenge', { method: 'POST', body: { owner }, withSession: false })
  const wrongSignature = await impostor.signPersonalMessage(new TextEncoder().encode(otherChallenge.data.message))
  const rejected = await json('/api/auth/verify', {
    method: 'POST',
    body: { challengeId: otherChallenge.data.challengeId, signature: wrongSignature.signature },
    withSession: false,
  })
  assert.equal(rejected.response.status, 401)
})

test('invalid address validation runs before the missing Tatum credential check', async () => {
  const { response, data } = await json('/api/chain/inspect', { method: 'POST', body: { address: 'not-a-sui-address' } })
  assert.equal(response.status, 400)
  assert.match(data.error, /valid Sui address/i)
})

test('real memory and agent routes fail clearly instead of returning simulated content', async () => {
  const requests = [
    ['/api/memory/status', 'GET'],
    ['/api/memory/recall', 'POST', { query: 'verified contact' }],
    ['/api/memory/remember', 'POST', { text: 'verified contact note' }],
    ['/api/memory/revoke-passport', 'POST', { name: 'Test', address: owner }],
    ['/api/agent/review', 'POST', { recipient: owner, purpose: 'verify the requested payment' }],
  ]
  for (const [path, method, body] of requests) {
    const { response, data } = await json(path, { method, body })
    assert.equal(response.status, 503, `${method} ${path}: ${JSON.stringify(data)}`)
    assert.match(data.error, /not configured|needs .* configured/i)
    if (path === '/api/agent/review') assert.match(data.error, /no review was simulated/i)
    else assert.doesNotMatch(JSON.stringify(data), /mock|simulat/i)
  }
})

test('logout invalidates the server session', async () => {
  const logout = await json('/api/auth/logout', { method: 'POST', body: {} })
  assert.equal(logout.response.status, 200)
  const session = await json('/api/auth/session', { withSession: false })
  assert.equal(session.response.status, 401)
})
