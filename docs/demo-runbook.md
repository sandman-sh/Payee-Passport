# Payee Passport Product Demonstration Runbook (2–3 minutes)

This runbook provides a structured walkthrough for demonstrating Payee Passport's pre-flight payment verification pipeline.

---

## Pre-Flight Checklist

1. **Environment Configuration**:
   - Ensure the server `.env` contains valid credentials for Tatum Sui gRPC, Walrus Memory, and OpenRouter AI.
   - Run `npm run dev` and confirm that `/api/health` reports all necessary services as configured.
   - Do not display `.env` files, API keys, or private seed phrases during demonstrations.
2. **Dedicated Testnet Wallet**:
   - Use a dedicated Sui Testnet wallet with an initial SUI balance for testing.
   - Prepare a known recipient address and a clean transaction purpose.
3. **Decentralized Memory**:
   - Confirm that the wallet's Walrus namespace is reachable and reflects live records.

---

## Walkthrough Sequence

### 0:00–0:25 — The Moment Before Send
- Introduce the core problem: Web3 payments are final and irreversible; address poisoning and clipboard substitution pose persistent risks.
- Introduce **Payee Passport** as a wallet-gated, non-custodial pre-flight safety desk.
- Highlight the real-time Sui Testnet network indicator and backend service integration status strip.

### 0:25–0:50 — Non-Custodial Personal Message Sign-In
- Connect the Sui wallet.
- Trigger the **Sign in with wallet** flow.
- Clarify that the personal message signature authenticates the session via cryptographic challenge without requesting token allowances, executing transactions, or incurring gas fees.

### 0:50–1:15 — User-Confirmed Address Passport
- Navigate to the **Saved Recipients** tab or trigger **Add Recipient**.
- Save a verified counterparty with a confirmation note (e.g., *"Vendor invoice verified via secure channel"*).
- Observe the immediate local device cache update and the asynchronous confirmation written to **Walrus Memory**.

### 1:15–1:50 — Live Pre-Flight Safety Review
- Navigate to the **Review Payment** desk.
- Enter a target recipient address and a payment purpose (e.g., *"Consulting retainer payment"*).
- Click **Run live safety review**:
  - Show the **exact address comparison** against saved passports (identifying matches or discrepancies).
  - Review the **live on-chain telemetry** returned via Tatum gRPC (current SUI balance and outgoing transaction counts).
  - Emphasize the **OpenRouter AI synthesis**, which explains the chain context and confirms that on-chain activity alone does not prove real-world legal identity.

### 1:50–2:15 — The Adaptive Memory Feedback Loop
- Demonstrate saving post-review feedback: select **Expected recipient** or **Needs follow-up**.
- Re-run or refresh the review for the same address to illustrate the recalled historical assessment: previous flags are prominently surfaced to prevent hasty transfers.

### 2:15–2:45 — Walrus Memory Recall & Conclusion
- Switch to the **Memory Recall** tab.
- Search for recorded notes or counterparty names to demonstrate deterministic, wallet-scoped retrieval from Walrus.
- Conclude by emphasizing:
  - Non-custodial operation (the user's wallet retains final authority).
  - Zero browser secret exposure.
  - Open-source, production-ready pre-flight verification on Sui.
