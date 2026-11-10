import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ConnectButton } from '@mysten/dapp-kit-react/ui'
import { useCurrentAccount, useCurrentNetwork, useDAppKit } from '@mysten/dapp-kit-react'
import { fromBase64 } from '@mysten/sui/utils'
import { SuiSignMessage, SuiSignPersonalMessage, getWallets } from '@mysten/wallet-standard'
import type { SuiSignMessageFeature } from '@mysten/wallet-standard'
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, BadgeCheck, Check, ChevronDown, CircleHelp,
  Clock3, ExternalLink, Fingerprint, Globe2, LockKeyhole, Menu, Plus, Search,
  Shield, ShieldAlert, ShieldCheck, Sparkles, Wallet, X,
} from 'lucide-react'

type Passport = { id: string; name: string; address: string; note: string; createdAt: string }
type Services = {
  tatum: { configured: boolean; endpoint: string }
  walrus: { configured: boolean; serverUrl: string }
  ai: { configured: boolean; model: string }
}
type Chain = { network: string; input: string; address: string; resolvedName: string | null; balanceSui: string | null; recentTransactionCount: number | null; checkedAt: string; partial: boolean }
type PriorAssessment = { assessment: 'expected' | 'needs-follow-up'; purpose: string; reviewedAt: string } | null
type Review = { answer: string; chain: Chain; memoryCount: number; passportMatch: 'match' | 'mismatch' | 'unverified' | 'ambiguous'; savedAddress: string | null; priorAssessment: PriorAssessment; reviewedAt: string; mode: 'live' }
type MemoryInventory = { owner: string; memoryCount: number; submissionTarget: number; targetMet: boolean; complete: boolean; error?: string }

const STORAGE = 'payee-passport.passports.v2'
const trimAddress = (value: string) => value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
const readPassports = (key: string): Passport[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter((item): item is Passport => Boolean(
      item && typeof item === 'object' &&
      typeof item.id === 'string' && typeof item.name === 'string' &&
      typeof item.address === 'string' && /^0x[\da-f]{64}$/i.test(item.address) &&
      typeof item.note === 'string' && typeof item.createdAt === 'string',
    ))
  } catch { return [] }
}
const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('passport:auth-expired'))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data as T
}

function Brand({ small = false }: { small?: boolean }) {
  return <a className={`brand ${small ? 'brand-small' : ''}`} href="#top" aria-label="Payee Passport home"><span className="brand-mark"><Fingerprint size={small ? 17 : 20} strokeWidth={1.8} /></span><span>payee<span className="brand-light">passport</span></span></a>
}

function App() {
  const account = useCurrentAccount()
  const walletAddress = account?.address
  const network = useCurrentNetwork()
  const dAppKit = useDAppKit()
  const [authOwner, setAuthOwner] = useState<string | null>(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [services, setServices] = useState<Services | null>(null)
  const passportKey = account ? `${STORAGE}:${account.address.toLowerCase()}` : null
  const [passportSnapshots, setPassportSnapshots] = useState<Record<string, Passport[]>>({})
  const passports = useMemo(() => passportKey ? passportSnapshots[passportKey] ?? readPassports(passportKey) : [], [passportKey, passportSnapshots])
  const [tab, setTab] = useState<'review' | 'passports' | 'activity'>('review')
  const [payeeName, setPayeeName] = useState('')
  const [recipient, setRecipient] = useState('')
  const [purpose, setPurpose] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [reviewMemorySaved, setReviewMemorySaved] = useState(false)
  const [reviewMemoryBusy, setReviewMemoryBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveAddress, setSaveAddress] = useState('')
  const [saveNote, setSaveNote] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [forgetBusyId, setForgetBusyId] = useState<string | null>(null)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [recallQuery, setRecallQuery] = useState('')
  const [recallResult, setRecallResult] = useState<string[]>([])
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryInventory, setMemoryInventory] = useState<MemoryInventory | null>(null)

  useEffect(() => { api<{ services: Services }>('/api/health').then((data) => setServices(data.services)).catch(() => setServices(null)) }, [])
  useEffect(() => { api<{ owner: string }>('/api/auth/session').then((data) => setAuthOwner(data.owner)).catch(() => setAuthOwner(null)).finally(() => setAuthChecking(false)) }, [])
  useEffect(() => {
    const onExpired = () => { setAuthOwner(null); setReview(null); setMemoryInventory(null); setAuthError('Your wallet session expired. Sign in again to continue.') }
    window.addEventListener('passport:auth-expired', onExpired)
    return () => window.removeEventListener('passport:auth-expired', onExpired)
  }, [])
  useEffect(() => {
    if (!walletAddress || authChecking || authOwner !== walletAddress) return
    let active = true
    api<Omit<MemoryInventory, 'owner'>>('/api/memory/status').then((status) => {
      if (active) setMemoryInventory({ ...status, owner: walletAddress })
    }).catch((reason) => {
      if (active) setMemoryInventory({ owner: walletAddress, memoryCount: 0, submissionTarget: 10, targetMet: false, complete: false, error: reason instanceof Error ? reason.message : 'Memory count unavailable.' })
    })
    return () => { active = false }
  }, [walletAddress, authChecking, authOwner])
  useEffect(() => {
    if (passportKey && Object.hasOwn(passportSnapshots, passportKey)) localStorage.setItem(passportKey, JSON.stringify(passportSnapshots[passportKey]))
  }, [passportKey, passportSnapshots])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3300); return () => window.clearTimeout(timer) }, [toast])

  const passportMatch = useMemo(() => {
    const normalizedName = payeeName.trim().toLocaleLowerCase()
    const normalizedAddress = recipient.trim().toLocaleLowerCase()
    return passports.find((p) => p.name.toLocaleLowerCase() === normalizedName && normalizedName)
      ?? passports.find((p) => p.address.toLocaleLowerCase() === normalizedAddress && normalizedAddress)
      ?? null
  }, [payeeName, recipient, passports])

  function updatePassports(update: (current: Passport[]) => Passport[]) {
    if (!passportKey) return
    setPassportSnapshots((current) => {
      const existing = current[passportKey] ?? readPassports(passportKey)
      return { ...current, [passportKey]: update(existing) }
    })
  }

  async function refreshMemoryInventory() {
    if (!account) return
    try {
      const status = await api<Omit<MemoryInventory, 'owner'>>('/api/memory/status')
      setMemoryInventory({ ...status, owner: account.address })
    } catch (reason) {
      setMemoryInventory({ owner: account.address, memoryCount: 0, submissionTarget: 10, targetMet: false, complete: false, error: reason instanceof Error ? reason.message : 'Memory count unavailable.' })
    }
  }

  async function signIn() {
    if (!account) { setAuthError('Connect a Sui Testnet wallet first.'); return }
    setAuthError(''); setAuthBusy(true)
    try {
      if (!account.chains.includes('sui:testnet')) throw new Error('This wallet account is not enabled for Sui Testnet. Switch to a Testnet account and try again.')
      const challenge = await api<{ challengeId: string; message: string }>('/api/auth/challenge', { owner: account.address })
      const message = new TextEncoder().encode(challenge.message)
      let signature: string | undefined
      let personalSigningUnavailable = !account.features.includes(SuiSignPersonalMessage)
      if (!personalSigningUnavailable) {
        try {
          const signed = await dAppKit.signPersonalMessage({ message, account, network: 'testnet' })
          signature = signed.signature
        } catch (reason) {
          const messageText = reason instanceof Error ? reason.message : String(reason)
          // Some wallets advertise the standard feature but their signer only
          // implements the legacy Sui message method. Fall back only for that
          // capability mismatch; preserve user rejection and other errors.
          if (messageText.includes('sui:signPersonalMessage') && account.features.includes(SuiSignMessage)) {
            personalSigningUnavailable = true
          } else {
            throw reason
          }
        }
      }
      if (personalSigningUnavailable && account.features.includes(SuiSignMessage)) {
        const wallet = getWallets().get().find((candidate) => candidate.accounts.some((walletAccount) => walletAccount.address === account.address))
        const walletAccount = wallet?.accounts.find((candidate) => candidate.address === account.address)
        const legacyFeature = wallet?.features[SuiSignMessage] as SuiSignMessageFeature[typeof SuiSignMessage] | undefined
        if (!walletAccount || !legacyFeature) throw new Error('This wallet advertises message signing, but its signer is unavailable. Reconnect the wallet and try again.')
        const signed = await legacyFeature.signMessage({ message, account: walletAccount })
        const signedBytes = fromBase64(signed.messageBytes)
        if (signedBytes.length !== message.length || signedBytes.some((value, index) => value !== message[index])) {
          throw new Error('The wallet signed a different login challenge. No session was created.')
        }
        signature = signed.signature
      } else if (personalSigningUnavailable) {
        throw new Error('This account can connect, but it cannot sign a Sui login message. Choose a wallet account that supports personal-message signing.')
      }
      if (!signature) throw new Error('The wallet did not return a login signature.')
      const session = await api<{ owner: string }>('/api/auth/verify', { challengeId: challenge.challengeId, signature })
      setAuthOwner(session.owner)
    } catch (reason) { setAuthError(reason instanceof Error ? reason.message : 'Wallet sign-in failed.') }
    finally { setAuthBusy(false) }
  }

  async function signOut() {
    try {
      await api('/api/auth/logout', {})
    } catch (reason) {
      setAuthError(reason instanceof Error ? `Signed out locally; server logout failed: ${reason.message}` : 'Signed out locally; the server could not be reached.')
    } finally {
      setAuthOwner(null)
      setReview(null)
      setMemoryInventory(null)
    }
  }

  async function reviewRecipient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setReview(null); setReviewMemorySaved(false)
    if (!account?.address) { setError('Connect your Sui Testnet wallet to start a review.'); return }
    if (!/^0x[\da-f]{1,64}$/i.test(recipient.trim())) { setError('Enter a valid Sui address beginning with 0x.'); return }
    if (!purpose.trim()) { setError('Add the payment purpose so the agent has context.'); return }
    setBusy(true)
    try {
      const result = await api<Review>('/api/agent/review', { recipient: recipient.trim(), payeeName: payeeName.trim(), purpose: purpose.trim() })
      setReview(result)
      setTab('review')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Agent review failed.') }
    finally { setBusy(false) }
  }

  async function rememberReview(assessment: 'expected' | 'needs-follow-up') {
    if (!account || !review || reviewMemoryBusy || reviewMemorySaved) return
    setError(''); setReviewMemoryBusy(true)
    const memory = {
      type: 'payee-passport-review-feedback',
      recipientName: payeeName.trim() || null,
      recipientAddress: review.chain.address,
      purpose: purpose.trim(),
      userAssessment: assessment,
      passportMatch: review.passportMatch,
      observedBalanceSui: review.chain.balanceSui,
      recentOutgoingTransactions: review.chain.recentTransactionCount,
      checkedAt: review.reviewedAt,
      recordedAt: new Date().toISOString(),
    }
    try {
      await api('/api/memory/remember', { text: JSON.stringify(memory) })
      setReviewMemorySaved(true)
      setToast('Your feedback was saved to Walrus Memory for future reviews.')
      void refreshMemoryInventory()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this review to Walrus Memory.') }
    finally { setReviewMemoryBusy(false) }
  }

  async function savePassport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    if (!account?.address) { setError('Connect your wallet before saving a passport.'); return }
    if (!saveName.trim() || !/^0x[\da-f]{1,64}$/i.test(saveAddress.trim())) { setError('Enter a contact name and valid Sui address.'); return }
    setSaveBusy(true)
    const entry: Passport = { id: crypto.randomUUID(), name: saveName.trim(), address: `0x${saveAddress.trim().slice(2).toLowerCase().padStart(64, '0')}`, note: saveNote.trim(), createdAt: new Date().toISOString() }
    const existing = passports.find((item) => item.name.toLowerCase() === entry.name.toLowerCase())
    if (existing && existing.address !== entry.address) {
      setError('That name already has a different passport. Revoke it first, then save the new address.')
      setSaveBusy(false)
      return
    }
    try {
      const memoryText = JSON.stringify({ type: 'user-confirmed-payee-passport', name: entry.name, address: entry.address, note: entry.note || 'No note added', confirmedAt: entry.createdAt })
      const saved = await api<{ saved: boolean; blobId: string }>('/api/memory/remember', { text: memoryText })
      updatePassports((current) => [entry, ...current.filter((item) => item.name.toLowerCase() !== entry.name.toLowerCase())])
      setSaveOpen(false); setSaveName(''); setSaveAddress(''); setSaveNote('')
      setToast(`Saved to this device and Walrus Memory · ${trimAddress(saved.blobId)}`)
      void refreshMemoryInventory()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the passport to Walrus Memory.') }
    finally { setSaveBusy(false) }
  }

  async function recallMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    if (!account?.address) { setError('Connect your Sui wallet to access its memory space.'); return }
    if (!recallQuery.trim()) { setError('Type something to search in your memory.'); return }
    setMemoryBusy(true); setRecallResult([])
    try { const result = await api<{ memories: string[] }>('/api/memory/recall', { query: recallQuery.trim() }); setRecallResult(result.memories); if (!result.memories.length) setToast('Walrus returned no matching memories.') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Walrus recall failed.') }
    finally { setMemoryBusy(false) }
  }

  async function forgetPassport(item: Passport) {
    setForgetBusyId(item.id)
    try {
      const result = await api<{ storageNote: string }>('/api/memory/revoke-passport', { name: item.name, address: item.address })
      updatePassports((current) => current.filter((entry) => entry.id !== item.id))
      setToast(`Passport revoked for future app reviews. ${result.storageNote}`)
      void refreshMemoryInventory()
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : 'Could not revoke this passport in Walrus Memory.')
    } finally { setForgetBusyId(null) }
  }

  if (!account || authChecking || authOwner !== account.address) return <Landing services={services} account={account} authBusy={authBusy} authError={authError} onSignIn={signIn} />

  return <div className="app-shell" id="top">
    <header className="app-topbar"><Brand small /><div className="topbar-right"><span className="network-pill"><span className="live-dot" /> Sui Testnet</span><button className="signout-button" onClick={signOut}>Sign out</button><ConnectButton /></div></header>
    <div className="workspace">
      <aside className={`sidebar ${showMobileMenu ? 'sidebar-open' : ''}`}>
        <div className="wallet-chip"><div className="wallet-avatar"><Wallet size={17} /></div><div className="wallet-meta"><strong>{trimAddress(account.address)}</strong><span>Connected wallet</span></div><ChevronDown size={15} /></div>
        <div className="nav-label">PASSPORT</div>
        <button className={`side-link ${tab === 'review' ? 'active' : ''}`} onClick={() => { setTab('review'); setShowMobileMenu(false) }}><Shield size={17} />Review payment</button>
        <button className={`side-link ${tab === 'passports' ? 'active' : ''}`} onClick={() => { setTab('passports'); setShowMobileMenu(false) }}><BadgeCheck size={17} />Saved recipients<span className="side-count">{passports.length}</span></button>
        <button className={`side-link ${tab === 'activity' ? 'active' : ''}`} onClick={() => { setTab('activity'); setShowMobileMenu(false) }}><Sparkles size={17} />Memory recall</button>
        <div className="sidebar-bottom"><div className="privacy-note"><LockKeyhole size={15} /><div><strong>Your keys stay yours</strong><span>App secrets live on the server. Wallet actions stay in your wallet.</span></div></div><div className="sidebar-service"><span className="service-indicator" /> Connected to {network === 'testnet' ? 'Sui Testnet' : network}</div></div>
      </aside>

      <main className="main-area">
        <button className="mobile-menu" onClick={() => setShowMobileMenu((value) => !value)} aria-label="Toggle menu"><Menu size={19} /></button>
        <div className="main-heading"><div><div className="eyebrow"><span className="eyebrow-line" />PAYMENT SAFETY DESK</div><h1>{tab === 'review' ? 'Pause before you pay.' : tab === 'passports' ? 'People you trust.' : 'Your memory, recalled.'}</h1><p>{tab === 'review' ? 'Check the address, the chain, and what you already know.' : tab === 'passports' ? 'Your saved addresses are confirmed by you and scoped to this wallet.' : 'Search the Walrus Memory namespace for this connected wallet.'}</p></div><button className="quiet-button" onClick={() => setSaveOpen(true)}><Plus size={17} />Add recipient</button></div>

        <div className="services-strip">{serviceStatus('Tatum RPC', services?.tatum.configured)}{serviceStatus('Walrus Memory', services?.walrus.configured)}{serviceStatus('OpenRouter AI', services?.ai.configured)}<span className="service-caption">Key presence only · live calls report their own result</span></div>

        {tab === 'review' && <div className="review-grid">
          <section className="panel review-panel"><div className="panel-title"><div><span className="panel-kicker">01 / NEW CHECK</span><h2>Who are you paying?</h2></div><div className="secure-badge"><LockKeyhole size={13} />WALLET SESSION</div></div>
            <form className="review-form" onSubmit={reviewRecipient}>
              <label>Recipient name <span>optional</span><input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Who should receive it?" autoComplete="off" /></label>
              <label>Sui wallet address<input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" required /></label>
              {passportMatch && <div className={`match-banner ${passportMatch.address.toLowerCase() === recipient.toLowerCase() ? 'match-good' : 'match-bad'}`}>{passportMatch.address.toLowerCase() === recipient.toLowerCase() ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}<span><strong>{passportMatch.address.toLowerCase() === recipient.toLowerCase() ? 'Address matches your saved passport' : 'Address differs from your saved passport'}</strong><small>{passportMatch.name} · saved {new Date(passportMatch.createdAt).toLocaleDateString()}</small></span></div>}
              <label>What is this payment for?<textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Invoice, rent, splitting dinner…" rows={2} required /></label>
              {error && <div className="form-error"><CircleHelp size={15} />{error}</div>}
              <button className="primary-button" type="submit" disabled={busy}>{busy ? <><span className="spinner" />Checking live sources…</> : <>Run live safety review <ArrowRight size={17} /></>}</button>
              <div className="form-footnote"><LockKeyhole size={13} />Your wallet address, recipient, purpose, chain facts, and recalled memories are sent to OpenRouter for review. No transaction is created or signed.</div>
            </form>
          </section>

          <section className="panel readout-panel"><div className="panel-title"><div><span className="panel-kicker">LIVE REVIEW</span><h2>{review ? 'Review complete' : 'Your safety readout'}</h2></div><div className={`readout-orb ${review ? 'orb-active' : ''}`}><Fingerprint size={21} /></div></div>
            {!review ? <div className="empty-readout"><div className="radar"><span className="radar-ring ring-a" /><span className="radar-ring ring-b" /><span className="radar-ring ring-c" /><span className="radar-core"><Shield size={21} /></span><i className="radar-node node-a" /><i className="radar-node node-b" /><i className="radar-node node-c" /></div><p>Run a review to bring together<br /><b>your passport + live chain + memory</b></p><div className="readout-checks"><span><Check size={13} />Address match</span><span><Check size={13} />Testnet activity</span><span><Check size={13} />Wallet memory</span></div></div> : <div className="live-result"><div className="result-tag"><span className="live-dot" />LIVE · {review.chain.network}</div><div className={`match-banner ${review.passportMatch === 'match' ? 'match-good' : review.passportMatch === 'unverified' ? '' : 'match-bad'}`}><Shield size={15} /><span><strong>{review.passportMatch === 'match' ? 'Exact match in Walrus Memory' : review.passportMatch === 'mismatch' ? 'Saved recipient has a different address' : review.passportMatch === 'ambiguous' ? 'Conflicting saved addresses found' : 'No matching saved passport found'}</strong><small>{review.savedAddress ? trimAddress(review.savedAddress) : 'Live evidence does not prove recipient identity'}</small></span></div>{review.priorAssessment && <div className={`prior-assessment ${review.priorAssessment.assessment === 'needs-follow-up' ? 'prior-assessment-warning' : ''}`}><Clock3 size={14} /><span><strong>Previous note: {review.priorAssessment.assessment === 'needs-follow-up' ? 'you flagged this payee for follow-up' : 'you previously expected this recipient'}</strong><small>{review.priorAssessment.purpose ? `Earlier purpose: ${review.priorAssessment.purpose} · ` : ''}Your past assessment is context, not identity proof.</small></span></div>}<p className="ai-answer">{review.answer}</p><div className="review-feedback"><span>{reviewMemorySaved ? 'Saved to your memory' : 'Help future reviews learn from this one'}</span><div><button type="button" onClick={() => void rememberReview('expected')} disabled={reviewMemoryBusy || reviewMemorySaved}>{reviewMemoryBusy ? 'Saving…' : 'Expected recipient'}</button><button type="button" onClick={() => void rememberReview('needs-follow-up')} disabled={reviewMemoryBusy || reviewMemorySaved}>Needs follow-up</button></div></div><div className="chain-summary"><div><span>RECIPIENT BALANCE</span><strong>{review.chain.balanceSui == null ? 'Unavailable' : `${review.chain.balanceSui} SUI`}</strong></div><div><span>RECENT OUTGOING (UP TO 10)</span><strong><ArrowUpRight size={13} /> {review.chain.recentTransactionCount == null ? 'Unavailable' : `${review.chain.recentTransactionCount} returned`}</strong></div></div><div className="result-foot"><span><Clock3 size={13} />{new Date(review.reviewedAt).toLocaleTimeString()}</span><span><Sparkles size={13} />{review.memoryCount} memory matches</span>{review.chain.partial && <b>Partial chain data</b>}</div></div>}
            <div className="readout-seal"><span className="seal-icon"><ShieldCheck size={15} /></span><span>ADDRESS CHECKS ARE SIGNALS, NOT IDENTITY PROOF</span></div>
          </section>
        </div>}

        {tab === 'passports' && <section className="panel collection-panel"><div className="collection-heading"><div><span className="panel-kicker">WALRUS MEMORY + THIS DEVICE</span><h2>Saved recipients</h2><p>Saving requires Walrus Memory. This device keeps an exact-address copy for fast comparisons.</p></div><button className="primary-button compact" onClick={() => setSaveOpen(true)}><Plus size={16} />Save a recipient</button></div>{passports.length ? <div className="passport-list">{passports.map((entry) => <article className="passport-row" key={entry.id}><div className="contact-avatar">{entry.name.slice(0, 1).toUpperCase()}</div><div className="contact-info"><strong>{entry.name}</strong><span>{entry.address}</span>{entry.note && <small>{entry.note}</small>}</div><span className="confirmed"><Check size={13} />YOU CONFIRMED</span><button className="icon-button" aria-label={`Revoke ${entry.name}`} disabled={forgetBusyId === entry.id} onClick={() => void forgetPassport(entry)}>{forgetBusyId === entry.id ? <span className="spinner" /> : <X size={16} />}</button></article>)}</div> : <div className="collection-empty"><div className="empty-icon"><Fingerprint size={24} /></div><h3>Your passport is empty.</h3><p>Save a recipient you independently trust. Payee Passport never picks trusted addresses for you.</p><button className="quiet-button" onClick={() => setSaveOpen(true)}><Plus size={16} />Add your first recipient</button></div>}</section>}

        {tab === 'activity' && <section className="panel memory-panel"><div className="collection-heading"><div><span className="panel-kicker">WALRUS MEMORY</span><h2>Recall useful context</h2><p>Memory access is scoped to this connected wallet address on the server.</p></div><button className="memory-lock refresh-memory" onClick={() => void refreshMemoryInventory()}><LockKeyhole size={14} /><span>Refresh count</span></button></div><div className={`memory-count ${memoryInventory?.owner === account.address && memoryInventory.targetMet ? 'memory-count-met' : ''}`}><div><span>REAL WALRUS RECORDS IN THIS WALLET NAMESPACE</span><strong>{memoryInventory?.owner === account.address ? memoryInventory.error ? 'Unavailable' : `${memoryInventory.memoryCount} / ${memoryInventory.submissionTarget}` : 'Checking…'}</strong></div><span>{memoryInventory?.owner === account.address ? memoryInventory.error || (memoryInventory.targetMet ? 'Submission memory target met' : `${Math.max(0, memoryInventory.submissionTarget - memoryInventory.memoryCount)} more writes needed`) : 'Reading live memory inventory'}</span></div><form className="memory-search" onSubmit={recallMemory}><Search size={17} /><input value={recallQuery} onChange={(e) => setRecallQuery(e.target.value)} placeholder="Search a name, address, or note…" /><button type="submit" className="primary-button compact" disabled={memoryBusy}>{memoryBusy ? <span className="spinner" /> : <>Recall <ArrowRight size={15} /></>}</button></form>{error && <div className="form-error"><CircleHelp size={15} />{error}</div>}{recallResult.length > 0 ? <div className="memory-results">{recallResult.map((memory, i) => <article key={`${i}-${memory.slice(0, 10)}`}><span className="memory-index">0{i + 1}</span><p>{memory}</p></article>)}</div> : <div className="collection-empty compact-empty"><div className="empty-icon"><Sparkles size={22} /></div><h3>No recall yet.</h3><p>Search your Walrus Memory account. Only actual results from Walrus will appear here.</p></div>}</section>}

        <footer className="app-footer"><span><Globe2 size={13} />Sui Testnet</span><span><LockKeyhole size={13} />No browser API secrets</span><a href="https://docs.wal.app/walrus-memory" target="_blank" rel="noreferrer">About Walrus Memory <ExternalLink size={12} /></a></footer>
      </main>
    </div>

    {saveOpen && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setSaveOpen(false) }}><section className="save-modal"><button className="modal-close" onClick={() => setSaveOpen(false)} aria-label="Close"><X size={18} /></button><div className="modal-mark"><BadgeCheck size={22} /></div><span className="panel-kicker">USER CONFIRMED RECORD</span><h2>Add to your passport</h2><p>Save only an address you verified independently. We’ll write this note to Walrus Memory using server-held credentials.</p><form onSubmit={savePassport}><label>Contact name<input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Studio invoice" required /></label><label>Sui address<input value={saveAddress} onChange={(e) => setSaveAddress(e.target.value)} placeholder="0x…" spellCheck={false} required /></label><label>How did you confirm it?<textarea value={saveNote} onChange={(e) => setSaveNote(e.target.value)} placeholder="A note for your future self" rows={2} /></label>{error && <div className="form-error"><CircleHelp size={15} />{error}</div>}<button className="primary-button" type="submit" disabled={saveBusy}>{saveBusy ? <><span className="spinner" />Saving to Walrus…</> : <>Confirm and save <ArrowRight size={16} /></>}</button></form><div className="modal-privacy"><LockKeyhole size={13} />Your browser never receives the Walrus delegate key.</div></section></div>}
    {toast && <div className="toast"><Check size={15} />{toast}<button onClick={() => setToast('')} aria-label="Dismiss"><X size={14} /></button></div>}
  </div>
}

function serviceStatus(name: string, configured?: boolean) {
  return <span className={`service-pill ${configured ? 'service-ready' : configured === false ? 'service-missing' : ''}`} key={name} title="This reports server credential presence, not a live service check."><i />{name}<b>{configured ? 'KEY SET' : configured === false ? 'NO KEY' : '…'}</b></span>
}

function Landing({ services, account, authBusy, authError, onSignIn }: { services: Services | null; account: ReturnType<typeof useCurrentAccount>; authBusy: boolean; authError: string; onSignIn: () => void }) {
  return <div className="landing" id="top">
    <div className="landing-grain" />
    <header className="landing-nav"><Brand /><nav><a href="#how">How it works</a><a href="#privacy">Privacy</a></nav><div className="nav-connect"><span className="network-pill"><span className="live-dot" /> TESTNET</span><ConnectButton /></div></header>
    <main>
      <section className="hero"><div className="hero-copy"><div className="hero-eyebrow"><span className="status-pulse" />THE LAST CHECK BEFORE SEND</div><h1>Know who’s<br />on the <em>other</em><br /><span>side.</span></h1><p className="hero-description">A wallet address can change in one copied character. Payee Passport checks the chain, remembers the people you trust, and gives you a clear reason to pause.</p><div className="hero-actions">{account ? <button className="wallet-login-button" onClick={onSignIn} disabled={authBusy}>{authBusy ? <span className="spinner" /> : <Fingerprint size={16} />}{authBusy ? 'Waiting for wallet…' : 'Sign in with wallet'}<ArrowRight size={15} /></button> : <ConnectButton />}<a className="text-link" href="#how">See how it works <ArrowDownLeft size={15} /></a></div>{authError && <div className="login-error">{authError}</div>}<div className="hero-foot"><div className="avatar-stack"><span><ShieldCheck size={12} /></span><span><LockKeyhole size={11} /></span><span><Wallet size={11} /></span></div><span><b>Your wallet. Your call.</b><br />We never sign a transfer for you.</span></div></div>
        <div className="hero-art" aria-label="Illustration of a personal address passport"><div className="art-glow" /><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="float-dot dot-one" /><div className="float-dot dot-two" /><div className="float-dot dot-three" /><div className="passport-card"><div className="card-top"><div className="card-brand"><div className="mini-mark"><Fingerprint size={14} /></div><span>PAYEE PASSPORT</span></div><span className="testnet-chip"><i />SUI TESTNET</span></div><div className="card-identity"><div className="card-identicon"><span /><span /><span /><span /></div><div><small>RECIPIENT PASSPORT</small><strong>Address check</strong></div><span className="verified-seal"><ShieldCheck size={19} /></span></div><div className="card-address-label">YOUR REVIEW WILL APPEAR HERE</div><div className="card-address">Connect a wallet <Fingerprint size={13} /></div><div className="card-divider" /><div className="card-facts"><div><span>NETWORK</span><b>Sui Testnet</b></div><div><span>MEMORY</span><b><i className="fact-dot" />Wallet scoped</b></div></div><div className="card-verdict"><div className="verdict-icon"><ShieldCheck size={16} /></div><div><b>Check before you trust</b><span>Chain facts · your memory · AI review</span></div><ArrowRight size={16} /></div></div><div className="orbit-label label-left"><span className="orbit-icon"><Fingerprint size={15} /></span><span>YOUR MEMORY<small>wallet-scoped context</small></span></div><div className="orbit-label label-right"><span className="orbit-icon"><Globe2 size={15} /></span><span>LIVE CHAIN<small>Sui Testnet</small></span></div><div className="orbit-cross">+</div></div>
        <div className="hero-bottom"><span>DESIGNED FOR THE MOMENT BEFORE “SEND”</span><span>01 — ADDRESS <i /> 02 — MEMORY <i /> 03 — DECIDE</span></div></section>
      <section className="intro-band" id="how"><div><span className="panel-kicker">WHY A PASSPORT?</span><h2>Every payment starts<br />with a question.</h2></div><p>“Is this still the right address?” Payee Passport brings your own confirmed contacts together with live Sui Testnet facts and relevant Walrus memory, then asks an AI reviewer to explain what it can and cannot verify.</p><div className="intro-index">01<span> / 03</span></div></section>
      <section className="feature-row"><article><span className="feature-num">01</span><div className="feature-icon"><BadgeCheck size={19} /></div><h3>Your confirmed people</h3><p>Build a wallet-specific address book from addresses you verify yourself. Exact comparisons surface a mismatch before you act.</p><span className="feature-rule" /></article><article><span className="feature-num">02</span><div className="feature-icon"><Globe2 size={19} /></div><h3>Facts from the chain</h3><p>Read the recipient’s SUI balance and recent Testnet activity through Tatum RPC. Chain activity never proves identity.</p><span className="feature-rule" /></article><article><span className="feature-num">03</span><div className="feature-icon"><Sparkles size={19} /></div><h3>Context that remembers</h3><p>Recall your wallet-scoped Walrus Memory and get a concise OpenRouter AI review based on the live evidence.</p><span className="feature-rule" /></article></section>
      <section className="privacy-band" id="privacy"><div className="privacy-emblem"><LockKeyhole size={26} /><span /></div><div><span className="panel-kicker">YOUR KEYS STAY YOURS</span><h2>Wallet connection is not custody.</h2><p>Connect a wallet on Sui Testnet. The app never asks for a seed phrase or private key. Tatum, Walrus, and OpenRouter credentials stay in the server’s <code>.env</code>. You decide what to save, and your wallet is the final authority for every transaction.</p></div><a href="#top" className="backtop">BACK TO TOP <ArrowRight size={14} /></a></section>
    </main>
    <footer className="landing-footer"><Brand small /><span>AN INDEPENDENT SECOND LOOK FOR SUI PAYMENTS</span><span className="footer-network"><i className="live-dot" />SUI TESTNET</span></footer>
    <div className="sr-only">{services ? 'Server integrations status loaded.' : 'Loading integration status.'}</div>
  </div>
}

export default App

