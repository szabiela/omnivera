# Omnivera SDK — Architecture

## Overview

Omnivera is an open SDK for securely connecting to any SaaS platform using AI-driven browser agents — even platforms without APIs. It implements a zero-knowledge credential relay pattern where the host application never has access to user credentials in plaintext.

Think of it as **Plaid for everything**: the user enters credentials, a browser agent logs in on their behalf inside an ephemeral cloud container, extracts an API token or session data, and returns structured results. The host application only ever handles encrypted blobs it cannot decrypt.

## Design Principles

1. **Zero-knowledge by default.** The host application (your SaaS) never holds plaintext credentials. Encryption happens client-side; decryption happens inside an ephemeral container that the host cannot access.

2. **Platform-agnostic.** Omnivera works with any web-based SaaS platform. Developers define "playbooks" that describe how to navigate a platform — the agent executes them using AI-driven browser control.

3. **Graceful degradation.** OAuth platforms get a redirect flow (no browser needed). API-key platforms get a guided + automated flow. No-API platforms get the full agent flow. The consumer-facing UX is identical.

4. **Ephemeral execution.** Every connection attempt runs in a fresh container with a fresh keypair. Nothing persists after the job completes. The container, the private key, and any plaintext credentials are destroyed.

5. **Observable but opaque.** The host gets real-time progress events (status updates, 2FA prompts) via WebSocket without ever seeing the underlying credentials or browser session.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     HOST APPLICATION                         │
│                                                              │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────────┐  │
│  │  @omnivera/    │    │  @omnivera/     │    │  Host        │  │
│  │  client       │◄──►│  server        │◄──►│  Backend     │  │
│  │  (browser)    │    │  (node.js)     │    │              │  │
│  └──────┬───────┘    └───────┬───────┘    └──────────────┘  │
│         │                    │                               │
│         │  encrypted blob    │  relay only                   │
│         │  (can't decrypt)   │  (can't decrypt)              │
└─────────┼────────────────────┼───────────────────────────────┘
          │                    │
          │                    ▼
          │         ┌─────────────────────┐
          │         │   BROWSERBASE       │
          │         │   (cloud browser)   │
          │         │                     │
          │         │  ┌───────────────┐  │
          │         │  │ @omnivera/     │  │
          │         │  │ agent         │  │
          │         │  │               │  │
          │         │  │ • keypair gen │  │
          │         │  │ • decrypt     │  │
          │         │  │ • stagehand   │  │
          │         │  │ • playbook    │  │
          │         │  │ • extract     │  │
          │         │  └───────────────┘  │
          │         └─────────────────────┘
          │                    │
          │                    ▼
          │         ┌─────────────────────┐
          │         │  TARGET PLATFORM    │
          │         │  (Dice, RA, etc.)   │
          │         └─────────────────────┘
          │
          ▼
    ┌──────────────┐
    │ WebSocket     │  Real-time events:
    │ (progress,    │  • status updates
    │  2FA relay)   │  • 2FA prompts
    └──────────────┘  • completion + results
```

---

## Security Model

### The Zero-Knowledge Credential Relay

The core innovation is that credentials are encrypted in the user's browser before leaving the client, and can only be decrypted inside the ephemeral Browserbase container. The host's backend acts as a relay for data it cannot read.

```
Phase 1: Session Init
  Host Backend → Browserbase: "Create session"
  Browserbase Container: generates RSA-OAEP keypair
  Browserbase → Host Backend: { sessionId, publicKey }
  Host Backend → Client: { sessionId, publicKey }

Phase 2: Credential Encryption
  Client: encrypts { email, password } with publicKey
  Client → Host Backend: { sessionId, encryptedBlob }
  (Host Backend CANNOT decrypt — no private key)

Phase 3: Agent Execution
  Host Backend → Browserbase: { sessionId, encryptedBlob }
  Container: decrypts with privateKey → plaintext credentials
  Container: Stagehand types credentials into real platform login
  Container: navigates, extracts API token or data
  Container: purges plaintext from memory
  Container → Host Backend: { apiToken, extractedData }

Phase 4: Cleanup
  Container is destroyed
  Private key ceases to exist
  Plaintext credentials no longer exist anywhere
```

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Host backend compromised | Attacker only finds encrypted blobs they can't decrypt. Private keys never exist on host infrastructure. |
| Browserbase compromised | Each session uses a unique keypair in an ephemeral container. Compromising one session yields one credential set, and the container is destroyed within ~90 seconds. |
| Man-in-the-middle | All transport is TLS. The public key is delivered over HTTPS. Client verifies session integrity. |
| Credential reuse needed (no-API platforms) | For platforms requiring persistent sessions (RA, Shotgun), credentials are re-encrypted with a KMS-managed key and stored in the host's encrypted vault. Only the agent runtime (in a container) can request decryption via KMS. |
| 2FA interception | 2FA codes follow the same encryption path: encrypted client-side, relayed, decrypted only in the container. |

---

## Package Architecture

### @omnivera/client

Browser-side library. Handles:
- RSA-OAEP encryption of credentials using Web Crypto API
- WebSocket connection for real-time progress updates
- 2FA relay (encrypts and sends 2FA codes mid-flow)
- Optional pre-built UI components (React)

Zero dependencies for the core. Optional React peer dependency for UI components.

### @omnivera/server

Node.js orchestration library. Handles:
- Session lifecycle management (create, monitor, destroy)
- Browserbase API integration (session provisioning)
- Encrypted credential relay (receives blob, forwards to container)
- WebSocket server for client communication
- Result handling and callback dispatch
- Connection state management

### @omnivera/agent

Runs inside the Browserbase container. Handles:
- RSA-OAEP keypair generation
- Credential decryption
- Stagehand (AI browser control) execution
- Playbook loading and interpretation
- Data extraction and normalization
- Progress event emission

### @omnivera/playbooks

Platform-specific navigation definitions. Each playbook defines:
- Platform metadata (name, domains, auth type)
- Login flow steps
- Token/credential extraction steps  
- Data extraction steps (optional)
- 2FA handling instructions
- Error recovery patterns

---

## Playbook Format

Playbooks are the developer-facing API for adding new platform support. They use a declarative format that Stagehand interprets via LLM:

```yaml
platform: dice
name: DICE (MIO)
domains:
  - mio.dice.fm
  - dice.fm
auth_type: api_key_extraction

login:
  url: https://mio.dice.fm/login
  steps:
    - act: "enter {email} into the email field"
    - act: "enter {password} into the password field"
    - act: "click the login or sign in button"
  success_signal:
    - url_contains: "/dashboard"
    - element_exists: "navigation or sidebar menu"
  tfa:
    detect: "2FA or verification code or one-time"
    input: "enter {tfa_code} into the verification code field"
    submit: "click verify or submit"

extract_credentials:
  steps:
    - act: "navigate to settings or account settings"
    - act: "find API settings or developer settings or integrations"
    - act: "click generate new token or create API key"
    - extract:
        name: api_token
        instruction: "the API token or key that was just generated"
  
  fallback:
    - act: "look for an existing API token or key"
    - extract:
        name: api_token
        instruction: "any visible API token or key value"

result:
  type: api_token
  fields:
    - api_token
```

---

## Connection Lifecycle

### State Machine

```
IDLE → INITIALIZING → AWAITING_AUTH → AGENT_RUNNING → [AWAITING_2FA] → EXTRACTING → VALIDATING → CONNECTED
                                                            ↑      |
                                                            └──────┘ (2FA retry)
  
Any state → FAILED (with error details)
Any state → CANCELLED (user-initiated)
```

### Events

The WebSocket connection emits events that the client can use for UI updates:

```typescript
type OmniveraEvent =
  | { type: 'session.created'; sessionId: string }
  | { type: 'session.ready'; sessionId: string }
  | { type: 'agent.login.start' }
  | { type: 'agent.login.success' }
  | { type: 'agent.login.failed'; error: string }
  | { type: 'agent.2fa.required'; method: 'sms' | 'email' | 'totp' | 'unknown' }
  | { type: 'agent.2fa.success' }
  | { type: 'agent.navigating'; step: string }
  | { type: 'agent.extracting' }
  | { type: 'agent.extract.success'; preview: object }
  | { type: 'agent.extract.failed'; error: string; fallback: 'manual' | 'retry' }
  | { type: 'connection.validating' }
  | { type: 'connection.complete'; result: ConnectionResult }
  | { type: 'connection.failed'; error: string }
```

---

## Integration Patterns

### Pattern 1: Full Agent Flow (No-API platforms)

Used when the platform has no API and the agent must navigate the dashboard.

```
User → Omnivera Client → encrypt credentials → Server relay → Agent in container
Agent → login → navigate → extract data → return structured results
Container destroyed → credentials gone
```

### Pattern 2: API Key Extraction (API platforms with manual key generation)

Used when the platform has an API but requires the user to manually generate a key in their dashboard.

```
User → Omnivera Client → encrypt credentials → Server relay → Agent in container
Agent → login → navigate to API settings → generate token → extract token
Container destroyed → credentials gone
Host stores only the API token → uses it for all future API calls
```

### Pattern 3: OAuth Passthrough

Used when the platform supports OAuth. No browser agent needed.

```
User → Omnivera Client → redirect to platform OAuth page
Platform → redirect back with auth code
Host Backend → exchange code for token → store token
```

Omnivera provides this as a convenience so developers use a single interface regardless of the underlying auth mechanism.

---

## Scaling Considerations

### Concurrent Sessions
- Each connection attempt = 1 Browserbase session
- Sessions are independent and stateless
- Horizontal scaling is inherent — no shared state between sessions

### Cost Model
- Browserbase: ~$0.10–0.30 per session (60-90 seconds)
- Stagehand/Claude API: ~$0.05–0.15 per session (3-8 LLM calls)
- Total per connection: ~$0.15–0.45
- This is a one-time cost per platform connection, not recurring

### Rate Limiting
- Browserbase has concurrent session limits per plan
- Omnivera server implements a job queue with configurable concurrency
- Sessions that timeout (>3 minutes) are automatically destroyed

### Reliability
- Playbooks include retry logic and fallback paths
- Failed extractions surface clear error messages to guide manual fallback
- Each platform playbook includes health check steps to detect UI changes
