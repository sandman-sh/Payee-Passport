# Payee Passport: Pre-Flight Safety Layer for Sui Payments

A payment screen asks one question that is easy to rush past: **is this still the address I meant to pay?**

Payee Passport is an open-source, pre-flight recipient verification protocol for the Sui blockchain. Before a user dispatches funds in their wallet, they can compare a proposed recipient with a confirmed contact record, inspect live Testnet telemetry through Tatum gRPC, and evaluate relevant historical context recalled from their wallet's Walrus Memory space. The application does not create or sign payment transactions—it provides actionable, verifiable context so users can make informed transfer decisions.

---

## 1. User-Confirmed Address Passports

The user creates a recipient passport containing a contact name, Sui address, and optional verification note. Payee Passport maintains a wallet-scoped local copy for instant exact-match comparisons and writes an immutable record to the user's Walrus Memory namespace. Addresses are strictly normalized into canonical 64-character hexadecimal format (`0x` padded) to prevent false mismatches.

If a saved contact name is presented with a differing address, Payee Passport flags the conflict and blocks silent overwrites: the user must explicitly revoke the old passport before confirming the new address.

---

## 2. On-Chain Telemetry via Tatum gRPC

The review engine queries the target address's live SUI balance and up to 10 recent outgoing transactions through Tatum's native Sui Testnet gRPC gateway. 

These indicators provide immediate context on whether an account is freshly initialized or regularly active. However, on-chain activity alone cannot establish real-world legal identity or guarantee counterparty safety.

---

## 3. Decentralized Contextual Memory

Following any review, the user can record an explicit assessment: **"Expected recipient"** or **"Needs follow-up."** This choice is committed as a structured JSON record into Walrus Memory, scoped deterministically to the connected wallet (`passport-${sha256(owner)}`).

On subsequent reviews of that address, the system recalls the earlier note and surfaces it prominently. A previous *"needs follow-up"* flag prompts an immediate caution warning, while an *"expected recipient"* note serves as the user's historical record.

---

## 4. Privacy, Security & Non-Custodial Operation

- **Personal Message Sign-In**: Authentication is established through a short-lived personal-message challenge verified by `@mysten/sui/verify`. The app never requests seed phrases or private keys.
- **Backend Credential Isolation**: Tatum, Walrus, and OpenRouter API credentials remain secured in the server-side environment.
- **Zero Financial Authority**: The app cannot initiate or authorize financial transfers. The user's wallet retains final authority.
