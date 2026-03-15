#!/bin/bash
# Omnivera — Repo Setup Script
# Run from /opt/omnivera after git init

set -e

echo "🔧 Setting up Omnivera..."

# ─── Root Config ────────────────────────────────────────────────────────────

cat > package.json << 'EOF'
{
  "name": "omnivera",
  "private": true,
  "version": "0.1.0",
  "description": "Securely connect to any SaaS platform using AI browser agents",
  "workspaces": [
    "packages/client",
    "packages/server",
    "packages/agent"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "dev": "npm run dev --workspaces --if-present",
    "test": "vitest",
    "lint": "eslint packages/*/src/**/*.ts"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.11.0",
    "eslint": "^8.57.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
EOF

cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022", "DOM"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "moduleResolution": "node"
  }
}
EOF

cat > .gitignore << 'EOF'
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
.turbo
coverage/
EOF

cat > .env.example << 'EOF'
# Browserbase — https://www.browserbase.com
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=

# Anthropic — for Stagehand's LLM calls
ANTHROPIC_API_KEY=

# Optional: for testing
TEST_TOAST_EMAIL=
TEST_TOAST_PASSWORD=
EOF

# ─── Directory Structure ────────────────────────────────────────────────────

mkdir -p packages/client/src
mkdir -p packages/server/src
mkdir -p packages/agent/src
mkdir -p playbooks/platforms
mkdir -p docs
mkdir -p scripts

echo "📁 Directory structure created"

# ─── Package: @omnivera/client ──────────────────────────────────────────────

cat > packages/client/package.json << 'EOF'
{
  "name": "@omnivera/client",
  "version": "0.1.0",
  "description": "Browser-side SDK — encrypted credential capture and real-time connection status",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./react": {
      "import": "./dist/react.mjs",
      "require": "./dist/react.js",
      "types": "./dist/react.d.ts"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts src/react.tsx --format cjs,esm --dts",
    "dev": "tsup src/index.ts src/react.tsx --format cjs,esm --dts --watch"
  },
  "peerDependencies": {
    "react": ">=18.0.0"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "react": "^18.0.0",
    "@types/react": "^18.0.0",
    "typescript": "^5.4.0"
  }
}
EOF

cat > packages/client/tsconfig.json << 'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
EOF

# ─── Package: @omnivera/server ──────────────────────────────────────────────

cat > packages/server/package.json << 'EOF'
{
  "name": "@omnivera/server",
  "version": "0.1.0",
  "description": "Backend orchestration — session management, credential relay, agent coordination",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "ws": "^8.16.0",
    "yaml": "^2.4.0"
  },
  "peerDependencies": {
    "express": ">=4.0.0"
  },
  "peerDependenciesMeta": {
    "express": { "optional": true }
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "@types/express": "^4.17.0",
    "typescript": "^5.4.0"
  }
}
EOF

cat > packages/server/tsconfig.json << 'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
EOF

# ─── Package: @omnivera/agent ───────────────────────────────────────────────

cat > packages/agent/package.json << 'EOF'
{
  "name": "@omnivera/agent",
  "version": "0.1.0",
  "description": "Agent runtime — runs inside ephemeral Browserbase containers",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "@browserbasehq/stagehand": "^2.0.0",
    "playwright-core": "^1.44.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
EOF

cat > packages/agent/tsconfig.json << 'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
EOF

echo "📦 Package configs created"

# ─── Toast Playbook ─────────────────────────────────────────────────────────

cat > playbooks/platforms/toast.yaml << 'PLAYBOOKEOF'
platform: toast
name: Toast POS
domains:
  - pos.toasttab.com
  - www.toasttab.com
auth_type: session_scrape

login:
  url: https://pos.toasttab.com/login
  steps:
    - act: "enter {email} into the email or username field"
    - act: "enter {password} into the password field"
    - act: "click the login or sign in button"
  success_signal:
    url_contains: "/restaurants"
    element_exists: "dashboard navigation or sidebar menu"
  tfa:
    detect: "verification code, two-factor authentication, or security code"
    input: "enter {tfa_code} into the verification code field"
    submit: "click verify or continue"

extract_data:
  steps:
    - act: "navigate to the reporting or analytics section"
    - act: "look for sales summary, sales report, or revenue overview"
    - extract:
        name: sales_summary
        instruction: "the sales summary data visible on the page — total sales, net sales, number of orders, and any date range shown. Return as structured data."
    - act: "navigate to orders or order history"
    - extract:
        name: recent_orders
        instruction: "the most recent orders with their order numbers, totals, timestamps, and payment methods. Return as a structured list."
    - act: "navigate to the menu or menu performance section if available"
    - extract:
        name: menu_data
        instruction: "menu item performance data — item names, quantities sold, and revenue per item if visible"
    - act: "navigate to payment or payout reports if available"
    - extract:
        name: payout_data
        instruction: "recent payout or deposit information — dates, amounts, and status"

result:
  type: session
  fields:
    - sales_summary
    - recent_orders
    - menu_data
    - payout_data
PLAYBOOKEOF

cat > playbooks/platforms/resident_advisor.yaml << 'PLAYBOOKEOF'
platform: resident_advisor
name: Resident Advisor (RA)
domains:
  - ra.co
  - www.residentadvisor.net
auth_type: session_scrape

login:
  url: https://ra.co/login
  steps:
    - act: "enter {email} into the email field"
    - act: "enter {password} into the password field"
    - act: "click the login or sign in button"
  success_signal:
    url_contains: "/promoter"
  tfa:
    detect: "verification code, confirmation email, or two-factor authentication"
    input: "enter {tfa_code} into the verification code field"
    submit: "click verify or confirm"

extract_data:
  steps:
    - act: "navigate to the promoter dashboard or RA Pro dashboard"
    - act: "find and click on events, event management, or my events"
    - extract:
        name: events_list
        instruction: "all visible events with their names, dates, venues, and ticket sales numbers"
    - act: "navigate to reports, analytics, or sales data section"
    - extract:
        name: sales_summary
        instruction: "sales summary or revenue overview — total tickets sold, total revenue, and any per-event breakdown"
    - act: "navigate to guest list, attendee data, or customer data if available"
    - extract:
        name: guest_data
        instruction: "any visible guest or attendee data — names, emails, ticket types, purchase dates"

result:
  type: session
  fields:
    - events_list
    - sales_summary
    - guest_data
PLAYBOOKEOF

echo "📋 Playbooks created"

# ─── README ─────────────────────────────────────────────────────────────────

cat > README.md << 'EOF'
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
EOF

echo "📝 README created"

# ─── Done ───────────────────────────────────────────────────────────────────

echo ""
echo "✅ Omnivera scaffolded!"
echo ""
echo "Next steps:"
echo "  1. npm install"
echo "  2. Copy the source files (see next step in chat)"
echo "  3. git add -A && git commit -m 'initial scaffold'"
echo "  4. git push -u origin main"
echo ""
