# Playbook Authoring Guide

Playbooks tell Omnivera how to connect to a platform. They're YAML files with natural language instructions — no CSS selectors, no XPaths, no brittle DOM queries.

## How Playbooks Work

Under the hood, Omnivera uses [Stagehand](https://github.com/browserbase/stagehand) — an AI browser control SDK. When a playbook says `act: "click the login button"`, Stagehand uses an LLM with vision to look at the page and figure out which element to click. This means playbooks survive UI redesigns far better than traditional selectors.

## Playbook Structure

```yaml
# ─── Required ───────────────────────────────────────────────────────

platform: my_platform          # Unique identifier (lowercase, underscores)
name: My Platform              # Human-readable name
domains:                        # Domains this playbook handles
  - app.myplatform.com
  - myplatform.com
auth_type: api_key_extraction  # oauth | api_key_extraction | session_scrape

# ─── Login Flow ─────────────────────────────────────────────────────

login:
  url: https://app.myplatform.com/login
  steps:
    - act: "enter {email} into the email field"
    - act: "enter {password} into the password field"
    - act: "click the sign in button"
  success_signal:
    url_contains: "/dashboard"    # How to verify login worked
  tfa:                             # Optional: 2FA handling
    detect: "verification code or two-factor"
    input: "enter {tfa_code} into the code field"
    submit: "click verify"

# ─── Credential Extraction (api_key_extraction only) ────────────────

extract_credentials:
  steps:
    - act: "navigate to settings"
    - act: "click API or developer settings"
    - act: "generate a new API key"
    - extract:
        name: api_token
        instruction: "the API key that was just generated"
  fallback:                        # Optional: try if primary fails
    - extract:
        name: api_token
        instruction: "any existing API key on this page"

# ─── Data Extraction (session_scrape only) ──────────────────────────

extract_data:
  steps:
    - act: "navigate to sales reports"
    - extract:
        name: sales_data
        instruction: "the sales figures table with dates and amounts"

# ─── Result Definition ──────────────────────────────────────────────

result:
  type: api_token              # api_token | session | oauth_token
  fields:                       # Fields that MUST be extracted
    - api_token
```

## Auth Types

### `oauth`

For platforms with OAuth2/OIDC support. No browser agent needed — Omnivera handles the redirect flow.

```yaml
auth_type: oauth

oauth:
  authorize_url: https://platform.com/oauth/authorize
  token_url: https://platform.com/oauth/token
  scopes:
    - read:orders
    - read:customers
  params:
    response_type: code

result:
  type: oauth_token
  fields:
    - access_token
    - refresh_token
```

### `api_key_extraction`

For platforms that have an API but require manual key generation in their dashboard. The agent logs in, navigates to the API settings page, generates a key, and extracts it.

```yaml
auth_type: api_key_extraction

extract_credentials:
  steps:
    - act: "go to API settings"
    - act: "create a new key"
    - extract:
        name: api_token
        instruction: "the new API key"

result:
  type: api_token
  fields:
    - api_token
```

### `session_scrape`

For platforms with no API. The agent logs in and scrapes data directly from the dashboard. Sessions may need to be maintained for recurring data pulls.

```yaml
auth_type: session_scrape

extract_data:
  steps:
    - act: "go to the reports page"
    - extract:
        name: revenue_data
        instruction: "the revenue summary table"

result:
  type: session
  fields:
    - revenue_data
```

## Step Types

### `act`

Tell the agent to do something. Use natural language. The LLM figures out what to click/type.

```yaml
- act: "click the settings gear icon in the top right"
- act: "enter {email} into the email or username field"
- act: "scroll down to the API section"
- act: "select 'Read Only' from the permissions dropdown"
```

**Tips:**
- Be descriptive but not overly specific. "Click the blue button that says Save" is better than "click button" but worse than writing a CSS selector.
- Include context: "click the API settings link in the left sidebar" beats "click API settings" because it tells the agent where to look.
- Use `{variable}` for credential interpolation. Available variables: `{email}`, `{password}`, `{tfa_code}`.

### `extract`

Tell the agent to read something from the page and return it.

```yaml
- extract:
    name: api_token          # Variable name for the extracted value
    instruction: "the API token displayed in the green box — a long alphanumeric string"
```

**Tips:**
- Describe what the value looks like: "a long alphanumeric string starting with sk_" helps the LLM distinguish the token from other text on the page.
- The `name` must match one of the fields in `result.fields`.

### `wait`

Pause for a specified number of milliseconds. Use after actions that trigger loading states.

```yaml
- act: "click generate new token"
- wait: 3000                  # Wait 3 seconds for token generation
- extract:
    name: api_token
    instruction: "the newly generated token"
```

### `assert`

Verify something about the current page state. If the assertion fails, the agent raises an error.

```yaml
- assert: "the page shows API settings or developer configuration"
```

## Login Flow Details

### Success Signals

After login steps, the agent needs to verify that login succeeded. Use one or both:

```yaml
success_signal:
  url_contains: "/dashboard"        # Check if URL changed to expected path
  element_exists: "user menu or avatar in the top navigation"  # Check for a logged-in indicator
```

### 2FA Handling

If the platform might show a 2FA challenge, define how to detect and handle it:

```yaml
tfa:
  detect: "two-factor authentication, verification code, one-time password, or SMS code"
  input: "enter {tfa_code} into the verification code or authentication code field"
  submit: "click verify, confirm, or submit"
```

The `detect` string is used by the agent to determine whether 2FA is being requested. Be broad — list all the possible phrasings the platform might use. The agent will use vision + LLM to check if any of these concepts appear on the current page.

When 2FA is detected, the agent pauses and the client receives a `2fa.required` event. The user enters their code in the host application's UI, it's encrypted and relayed to the agent, and execution continues.

## Fallbacks

Primary extraction can fail if the platform's UI is different from expected. Define fallback steps as an alternative path:

```yaml
extract_credentials:
  steps:
    - act: "click Generate New API Key"
    - extract:
        name: api_token
        instruction: "the new key"

  fallback:
    - act: "look for any existing API keys"
    - extract:
        name: api_token
        instruction: "the most recent API key value"
```

## Testing Playbooks

Use the Omnivera CLI to test a playbook against a real platform:

```bash
# Test login flow only (uses your real credentials — be careful)
npx omnivera test playbooks/platforms/my_platform.yaml --step login

# Test full flow
npx omnivera test playbooks/platforms/my_platform.yaml --step all

# Test with screenshots saved for debugging
npx omnivera test playbooks/platforms/my_platform.yaml --screenshots ./debug/
```

## Examples

See the `platforms/` directory for complete playbook examples:

- `dice.yaml` — API key extraction with 2FA support
- `ticket_tailor.yaml` — Simple API key extraction
- `square.yaml` — OAuth passthrough
- `sevenrooms.yaml` — Multi-field credential extraction (client ID + secret + venue ID)
- `resident_advisor.yaml` — Session scrape (no API)
