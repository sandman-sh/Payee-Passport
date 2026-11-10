import 'dotenv/config'
import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { MemWal } from '@mysten-incubation/memwal'
import { isValidPersonalMessageSignature } from '@mysten/sui/verify'

const require = createRequire(import.meta.url)
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')

const app = express()
const port = Number(process.env.PORT || 3001)
const tatumKey = process.env.TATUM_API_KEY
const openRouterKey = process.env.OPENROUTER_API_KEY
const walrusAccountId = process.env.WALRUS_MEMORY_ACCOUNT_ID
const walrusDelegateKey = process.env.WALRUS_MEMORY_DELEGATE_KEY
const walrusServerUrl = process.env.WALRUS_MEMORY_SERVER_URL || 'https://relayer.memory.walrus.xyz'
const tatumRpc = process.env.TATUM_RPC_URL || 'https://sui-testnet-grpc.gateway.tatum.io'
const network = 'Sui Testnet'
const sessions = new Map()
const challenges = new Map()
let sharedTatumClients = null

app.use(express.json({ limit: '32kb' }))

function normalizeAddress(value) {
  const input = String(value || '').trim()
  if (/\.sui$/i.test(input)) return input.toLowerCase()
  if (!/^0x[\da-f]{1,64}$/i.test(input)) return null
  return `0x${input.slice(2).toLowerCase().padStart(64, '0')}`
}

function ownerNamespace(owner) {
  const digest = createHash('sha256').update(owner).digest('hex').slice(0, 24)
  return `passport-${digest}`
}

function createMemory(owner) {
  if (!walrusAccountId || !walrusDelegateKey) throw Object.assign(new Error('Walrus Memory is not configured on the server.'), { status: 503 })
  return MemWal.create({
    key: walrusDelegateKey,
    accountId: walrusAccountId,
    serverUrl: walrusServerUrl,
    namespace: ownerNamespace(owner),
  })
}

function createTatumClients() {
  if (!tatumKey) throw Object.assign(new Error('Tatum is not configured on the server.'), { status: 503 })
  if (sharedTatumClients) return sharedTatumClients
  const definition = protoLoader.loadSync(fileURLToPath(new URL('./proto/payee_passport.proto', import.meta.url)), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true })
  const services = grpc.loadPackageDefinition(definition).sui.rpc.v2
  const endpoint = new URL(tatumRpc)
  const target = `${endpoint.hostname}:${endpoint.port || '443'}`
  const credentials = grpc.credentials.createSsl()
  const state = new services.StateService(target, credentials)
  const ledger = new services.LedgerService(target, credentials)
  const metadata = new grpc.Metadata()
  metadata.set('x-api-key', tatumKey)
  sharedTatumClients = { state, ledger, metadata }
  return sharedTatumClients
}

function unaryCall(call, request, metadata) {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + 12_000)
    const rpcCall = call(request, metadata, { deadline }, (error, response) => error ? reject(error) : resolve(response))
    const timeout = setTimeout(() => rpcCall.cancel(), 12_100)
    rpcCall.on('status', () => clearTimeout(timeout))
  })
}

function countTransactions(streamCall, request, metadata) {
  return new Promise((resolve, reject) => {
    let count = 0
    const stream = streamCall(request, metadata)
    const timeout = setTimeout(() => stream.cancel(), 12_100)
    stream.on('data', (frame) => { if (frame.transaction) count += 1 })
    stream.on('error', (error) => { clearTimeout(timeout); reject(error) })
    stream.on('end', () => { clearTimeout(timeout); resolve(count) })
  })
}

function formatMist(value) {
  const mist = BigInt(value || 0)
  const whole = mist / 1_000_000_000n
  const fraction = (mist % 1_000_000_000n).toString().padStart(9, '0').slice(0, 4)
  return `${whole}.${fraction}`
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';')
  const value = cookies.find((item) => item.trim().startsWith(`${name}=`))?.split('=').slice(1).join('=')
  return value ? decodeURIComponent(value) : null
}

function sessionOwner(req) {
  const token = readCookie(req, 'passport_session')
  const session = token ? sessions.get(token) : null
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token)
    return null
  }
  return session.owner
}

function requireWalletSession(req, res, next) {
  const owner = sessionOwner(req)
  if (!owner) return res.status(401).json({ error: 'Sign in with your connected Sui wallet first.' })
  req.walletOwner = owner
  next()
}

async function inspectAddress(rawAddress) {
  const originalAddress = String(rawAddress || '').trim()
  let address = normalizeAddress(originalAddress)
  if (!address) throw Object.assign(new Error('Enter a valid Sui address (0x…).'), { status: 400 })
  let resolvedName = null
  if (/\.sui$/i.test(address)) {
    throw Object.assign(new Error('Use the resolved 0x Sui address. SuiNS lookup is not enabled in this build.'), { status: 400 })
  }
  const client = createTatumClients()
  const [balanceResult, transactionResult] = await Promise.allSettled([
    unaryCall(client.state.getBalance.bind(client.state), { owner: address, coin_type: '0x2::sui::SUI' }, client.metadata),
    countTransactions(client.ledger.listTransactions.bind(client.ledger), {
      filter: { terms: [{ literals: [{ sender: { address } }] }] },
      options: { limit: 10, ordering: 'ORDERING_DESCENDING' },
    }, client.metadata),
  ])
  if (balanceResult.status === 'rejected' && transactionResult.status === 'rejected') throw balanceResult.reason
  const balance = balanceResult.status === 'fulfilled' ? balanceResult.value.balance : null
  const recentTransactionCount = transactionResult.status === 'fulfilled' ? transactionResult.value : null
  const partial = balanceResult.status === 'rejected' || transactionResult.status === 'rejected'
  return {
    network,
    input: originalAddress,
    address,
    resolvedName,
    balanceSui: balance?.balance == null ? null : formatMist(balance.balance),
    recentTransactionCount,
    checkedAt: new Date().toISOString(),
    partial,
  }
}

async function askOpenRouter({ owner, recipient, purpose, chain, savedAddress, memories }) {
  if (!openRouterKey) throw new Error('OpenRouter is not configured on the server.')
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_ORIGIN || 'http://localhost:5173',
      'X-Title': 'Payee Passport',
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openrouter/free',
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: 'You are Payee Passport, a cautious Sui payment-address reviewer. Use only the supplied on-chain facts and user-confirmed memory. Treat user-revoked-payee-passport entries as inactive. Treat payee-passport-review-feedback as the user’s prior assessment, not proof of identity or safety. If a prior assessment for this same recipient says needs-follow-up, call that out and recommend pausing to check it. A prior expected assessment is only the user’s historical opinion and never a safety guarantee. Do not infer identity or safety from balance/activity. Be explicit that chain activity cannot prove identity. If addresses differ, state this prominently and recommend pausing. If there is no active saved address, say it is unverified. Give concise plain language, no markdown tables, no fabricated facts.',
        },
        {
          role: 'user',
          content: JSON.stringify({ connectedWallet: owner, proposedRecipient: recipient, intendedPurpose: purpose, userConfirmedSavedAddress: savedAddress || null, testnetChainData: chain, recalledWalrusMemory: memories }),
        },
      ],
    }),
    signal: AbortSignal.timeout(35_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error?.message || `OpenRouter returned HTTP ${response.status}`)
  const choice = body?.choices?.[0]
  const rawContent = choice?.message?.content ?? choice?.text
  const answer = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('\n')
      : ''
  if (!answer.trim()) {
    const finish = choice?.finish_reason ? ` (finish reason: ${choice.finish_reason})` : ''
    const providerError = typeof body?.error?.message === 'string' ? `: ${body.error.message}` : ''
    throw new Error(`OpenRouter returned no review text${finish}${providerError}.`)
  }
  return answer.trim()
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    network,
    services: {
      tatum: { configured: Boolean(tatumKey), endpoint: tatumRpc },
      walrus: { configured: Boolean(walrusAccountId && walrusDelegateKey), serverUrl: walrusServerUrl },
      ai: { configured: Boolean(openRouterKey), model: process.env.OPENROUTER_MODEL || 'openrouter/free' },
    },
  })
})

app.get('/api/auth/session', (req, res) => {
  const owner = sessionOwner(req)
  if (!owner) return res.status(401).json({ authenticated: false })
  res.json({ authenticated: true, owner })
})

app.post('/api/auth/challenge', (req, res) => {
  const owner = normalizeAddress(req.body?.owner)
  if (!owner || owner.endsWith('.sui')) return res.status(400).json({ error: 'Connect a valid Sui wallet address.' })
  const challengeId = randomBytes(24).toString('hex')
  const origin = process.env.APP_ORIGIN || 'http://localhost:5173'
  const message = `Payee Passport wallet sign-in\n\nOrigin: ${origin}\nNetwork: Sui Testnet\nWallet: ${owner}\nNonce: ${randomBytes(18).toString('hex')}\nIssued At: ${new Date().toISOString()}\n\nSigning this message proves control of this wallet. It does not create a transaction.`
  challenges.set(challengeId, { owner, message, expiresAt: Date.now() + 5 * 60_000 })
  res.json({ challengeId, message })
})

app.post('/api/auth/verify', async (req, res) => {
  const challengeId = String(req.body?.challengeId || '')
  const challenge = challenges.get(challengeId)
  challenges.delete(challengeId)
  if (!challenge || challenge.expiresAt < Date.now()) return res.status(400).json({ error: 'Wallet sign-in challenge expired. Start again.' })
  const signature = String(req.body?.signature || '')
  try {
    const valid = await isValidPersonalMessageSignature(new TextEncoder().encode(challenge.message), signature, { address: challenge.owner })
    if (!valid) return res.status(401).json({ error: 'The connected wallet did not verify this sign-in message.' })
    const token = randomBytes(32).toString('hex')
    sessions.set(token, { owner: challenge.owner, expiresAt: Date.now() + 7 * 24 * 60 * 60_000 })
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
    res.setHeader('Set-Cookie', `passport_session=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`)
    res.json({ authenticated: true, owner: challenge.owner, expiresIn: 604800 })
  } catch (error) {
    res.status(400).json({ error: error.message || 'Wallet signature could not be verified.' })
  }
})

app.post('/api/auth/logout', (req, res) => {
  const token = readCookie(req, 'passport_session')
  if (token) sessions.delete(token)
  res.setHeader('Set-Cookie', 'passport_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0')
  res.json({ loggedOut: true })
})

app.post('/api/chain/inspect', requireWalletSession, async (req, res) => {
  try {
    const result = await inspectAddress(req.body?.address)
    res.json({ mode: 'live', ...result })
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'The live Testnet lookup failed.' })
  }
})

app.get('/api/memory/status', requireWalletSession, async (req, res) => {
  const owner = req.walletOwner
  try {
    const memory = createMemory(owner)
    const namespace = ownerNamespace(owner)
    let cursor
    let memoryCount = 0
    let pages = 0
    let hasMore = true
    let complete = true
    while (hasMore && pages < 100) {
      const page = await memory.listMemories({ namespace, limit: 500, ...(cursor ? { cursor } : {}) })
      memoryCount += page.memories.length
      hasMore = page.has_more
      cursor = page.next_cursor || undefined
      pages += 1
      if (hasMore && !cursor) { complete = false; break }
    }
    const inventoryComplete = complete && !hasMore
    res.json({ memoryCount, submissionTarget: 10, targetMet: inventoryComplete && memoryCount >= 10, complete: inventoryComplete })
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'Walrus Memory inventory failed.' })
  }
})

app.post('/api/memory/recall', requireWalletSession, async (req, res) => {
  const owner = req.walletOwner
  const query = String(req.body?.query || '').trim().slice(0, 400)
  if (!owner || owner.endsWith('.sui')) return res.status(400).json({ error: 'A connected Sui wallet address is required.' })
  if (!query) return res.status(400).json({ error: 'Enter what to recall.' })
  try {
    const result = await createMemory(owner).recall({ query, limit: 5 })
    res.json({ memories: (result.results || []).map((item) => item.text), network })
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'Walrus Memory recall failed.' })
  }
})

app.post('/api/memory/remember', requireWalletSession, async (req, res) => {
  const owner = req.walletOwner
  const text = String(req.body?.text || '').trim().slice(0, 1200)
  if (!owner || owner.endsWith('.sui')) return res.status(400).json({ error: 'A connected Sui wallet address is required.' })
  if (text.length < 8) return res.status(400).json({ error: 'Add a useful confirmed note before saving.' })
  try {
    const saved = await createMemory(owner).rememberAndWait(text, undefined, { timeoutMs: 30_000, dedupe: true })
    res.json({ saved: true, blobId: saved.blob_id, namespace: ownerNamespace(owner) })
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'Walrus Memory write failed.' })
  }
})

app.post('/api/memory/revoke-passport', requireWalletSession, async (req, res) => {
  const owner = req.walletOwner
  const name = String(req.body?.name || '').trim().slice(0, 100)
  const address = normalizeAddress(req.body?.address)
  if (!name || !address || address.endsWith('.sui')) return res.status(400).json({ error: 'A saved contact name and Sui address are required.' })
  try {
    const saved = await createMemory(owner).rememberAndWait(JSON.stringify({
      type: 'user-revoked-payee-passport',
      name,
      address,
      revokedAt: new Date().toISOString(),
      instruction: 'The user removed this passport. Do not treat it as a trusted saved recipient.',
    }), undefined, { timeoutMs: 30_000, dedupe: true })
    res.json({ revoked: true, blobId: saved.blob_id, storageNote: 'Walrus Memory does not delete the previous blob through this SDK; the revocation marker prevents this app from treating it as active.' })
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'Walrus Memory revocation failed.' })
  }
})

app.post('/api/agent/review', requireWalletSession, async (req, res) => {
  const owner = req.walletOwner
  const recipient = normalizeAddress(req.body?.recipient)
  const purpose = String(req.body?.purpose || '').trim().slice(0, 300)
  const payeeName = String(req.body?.payeeName || '').trim().slice(0, 100)
  if (!owner || owner.endsWith('.sui')) return res.status(400).json({ error: 'Connect a Sui Testnet wallet first.' })
  if (!recipient || recipient.endsWith('.sui')) return res.status(400).json({ error: 'Enter a valid Sui address.' })
  if (!purpose) return res.status(400).json({ error: 'Describe what this payment is for.' })
  if (!tatumKey || !openRouterKey || !walrusAccountId || !walrusDelegateKey) {
    return res.status(503).json({ error: 'Agent review needs Tatum, OpenRouter, and Walrus Memory configured in the server .env. No review was simulated.' })
  }
  try {
    const [chain, recall] = await Promise.all([
      inspectAddress(recipient),
      createMemory(owner).recall({ query: `user-confirmed-payee-passport user-revoked-payee-passport payee-passport-review-feedback ${payeeName} ${recipient}`.trim(), limit: 20, sort: 'recent' }),
    ])
    const recalledItems = recall.results || []
    const memories = recalledItems.map((item) => item.text)
    const passportEntries = recalledItems.flatMap((item) => {
      try {
        const entry = JSON.parse(item.text)
        if (entry.type !== 'user-confirmed-payee-passport' || !entry.name || !entry.address) return []
        const address = normalizeAddress(entry.address)
        return address ? [{ name: String(entry.name).trim(), address, createdAt: item.created_at || entry.confirmedAt || '' }] : []
      } catch { return [] }
    })
    const revokedEntries = recalledItems.flatMap((item) => {
      try {
        const entry = JSON.parse(item.text)
        if (entry.type !== 'user-revoked-payee-passport' || !entry.name || !entry.address) return []
        const address = normalizeAddress(entry.address)
        return address ? [{ name: String(entry.name).trim(), address, createdAt: item.created_at || entry.revokedAt || '' }] : []
      } catch { return [] }
    })
    const priorAssessment = recalledItems.flatMap((item) => {
      try {
        const entry = JSON.parse(item.text)
        if (entry.type !== 'payee-passport-review-feedback' || !['expected', 'needs-follow-up'].includes(entry.userAssessment)) return []
        if (normalizeAddress(entry.recipientAddress) !== recipient) return []
        return [{ assessment: entry.userAssessment, purpose: String(entry.purpose || ''), reviewedAt: String(entry.recordedAt || item.created_at || '') }]
      } catch { return [] }
    }).sort((a, b) => (Date.parse(b.reviewedAt) || 0) - (Date.parse(a.reviewedAt) || 0))[0] || null
    const revocationTime = new Map()
    for (const entry of revokedEntries) {
      const key = `${entry.name.toLowerCase()}:${entry.address}`
      const timestamp = Date.parse(entry.createdAt) || 0
      if (timestamp > (revocationTime.get(key) || 0)) revocationTime.set(key, timestamp)
    }
    const candidateEntries = passportEntries.filter((entry) =>
      (payeeName && entry.name.toLowerCase() === payeeName.toLowerCase()) || entry.address === recipient,
    ).filter((entry) => (Date.parse(entry.createdAt) || 0) > (revocationTime.get(`${entry.name.toLowerCase()}:${entry.address}`) || 0))
    const uniqueAddresses = [...new Set(candidateEntries.map((entry) => entry.address))]
    const savedAddress = uniqueAddresses.length === 1 ? uniqueAddresses[0] : null
    const passportMatch = uniqueAddresses.length > 1 ? 'ambiguous' : !savedAddress ? 'unverified' : savedAddress === recipient ? 'match' : 'mismatch'
    const answer = await askOpenRouter({ owner, recipient: { name: payeeName || 'Unnamed recipient', address: recipient }, purpose, chain, savedAddress, memories })
    res.json({ answer, chain, memoryCount: memories.length, passportMatch, savedAddress, priorAssessment, reviewedAt: new Date().toISOString(), mode: 'live' })
  } catch (error) {
    res.status(502).json({ error: error.message || 'The agent review failed.' })
  }
})

app.listen(port, () => console.log(`Payee Passport API listening on http://localhost:${port} (${network})`))
