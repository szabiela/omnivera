# Omnivera

Securely connect to any SaaS platform using AI browser agents — even platforms without APIs.

## How It Works

Users enter credentials → encrypted in their browser → relayed to an ephemeral cloud container → agent logs in, extracts data → container destroyed. Your app never sees plaintext credentials.

## Packages

- `@omnivera/client` — Browser-side encryption + WebSocket progress
- `@omnivera/server` — Session orchestration + credential relay (can't decrypt)
- `@omnivera/agent` — Runs inside Browserbase, decrypts + executes playbooks

## Quick Start

```bash
cp .env.example .env
# Fill in BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, ANTHROPIC_API_KEY
npm install
npm run build
```

## Playbooks

Platform connectors are YAML files in `playbooks/platforms/`. Each playbook uses natural language instructions — no CSS selectors needed.

```yaml
platform: toast
name: Toast POS
auth_type: session_scrape

login:
  url: https://pos.toasttab.com/login
  steps:
    - act: "enter {email} into the email field"
    - act: "enter {password} into the password field"
    - act: "click the sign in button"
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
