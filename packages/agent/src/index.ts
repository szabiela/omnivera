/**
 * @omnivera/agent
 *
 * The agent runtime that executes inside an ephemeral Browserbase container.
 * This is the ONLY component that handles plaintext credentials.
 *
 * Lifecycle:
 * 1. Container starts, agent generates RSA keypair
 * 2. Public key is sent to the server (and forwarded to client)
 * 3. Agent receives encrypted credentials from server
 * 4. Agent decrypts credentials using private key
 * 5. Agent executes playbook (login, navigate, extract)
 * 6. Agent returns results, purges all sensitive data
 * 7. Container is destroyed
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Anthropic API key for Stagehand LLM calls */
  anthropicApiKey: string;
  /** The playbook to execute */
  playbook: Playbook;
  /** Callback for emitting progress events to the server */
  onEvent: (event: AgentEvent) => void;
}

export interface Playbook {
  platform: string;
  name: string;
  domains: string[];
  auth_type: 'oauth' | 'api_key_extraction' | 'session_scrape';
  login: {
    url: string;
    steps: PlaybookStep[];
    success_signal: Record<string, string>;
    tfa?: {
      detect: string;
      input: string;
      submit: string;
    };
  };
  extract_credentials?: {
    steps: PlaybookStep[];
    fallback?: PlaybookStep[];
  };
  extract_data?: {
    steps: PlaybookStep[];
  };
  result: {
    type: string;
    fields: string[];
  };
}

export interface PlaybookStep {
  act?: string;
  extract?: {
    name: string;
    instruction: string;
  };
  wait?: number;
  assert?: string;
}

export type AgentEvent =
  | { type: 'ready'; publicKeyJwk: JsonWebKey }
  | { type: 'agent.login.start' }
  | { type: 'agent.login.success' }
  | { type: 'agent.login.failed'; error: string }
  | { type: 'agent.2fa.required'; method: 'sms' | 'email' | 'totp' | 'unknown' }
  | { type: 'agent.2fa.success' }
  | { type: 'agent.navigating'; step: string; progress: number }
  | { type: 'agent.extracting' }
  | { type: 'agent.extract.success'; preview: Record<string, any> }
  | { type: 'agent.extract.failed'; error: string; fallback: 'manual' | 'retry' }
  | { type: 'connection.validating' }
  | { type: 'connection.complete'; result: any }
  | { type: 'connection.failed'; error: string };

// ─── Crypto ──────────────────────────────────────────────────────────────────

class AgentCrypto {
  private keyPair: CryptoKeyPair | null = null;

  /**
   * Generate a fresh RSA-OAEP keypair.
   * The private key stays in this process. The public key is exported for the client.
   */
  async generateKeyPair(): Promise<JsonWebKey> {
    this.keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      false, // private key is NOT extractable — cannot leave this process
      ['encrypt', 'decrypt']
    );

    // Export only the public key
    return crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
  }

  /**
   * Decrypt credentials using the private key.
   * Returns the plaintext credentials object.
   */
  async decrypt(encryptedBase64: string): Promise<Record<string, string>> {
    if (!this.keyPair) throw new Error('Keypair not initialized');

    const encrypted = base64ToArrayBuffer(encryptedBase64);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      this.keyPair.privateKey,
      encrypted
    );

    const plaintext = new TextDecoder().decode(decrypted);
    return JSON.parse(plaintext);
  }

  /**
   * Destroy the keypair. Called after execution completes.
   */
  destroy(): void {
    this.keyPair = null;
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ─── Playbook Executor ───────────────────────────────────────────────────────

/**
 * Executes a playbook using Stagehand for AI-driven browser control.
 *
 * Stagehand uses natural language instructions to navigate web pages.
 * Instead of fragile CSS selectors, each step describes what to do
 * in plain English, and the LLM figures out which element to interact with.
 */
class PlaybookExecutor {
  private stagehand: any; // Stagehand instance
  private playbook: Playbook;
  private onEvent: (event: AgentEvent) => void;
  private extractedData: Record<string, any> = {};

  constructor(stagehand: any, playbook: Playbook, onEvent: (event: AgentEvent) => void) {
    this.stagehand = stagehand;
    this.playbook = playbook;
    this.onEvent = onEvent;
  }

  /**
   * Execute the login flow.
   * Credentials are injected into the step templates.
   */
  async login(credentials: Record<string, string>): Promise<void> {
    this.onEvent({ type: 'agent.login.start' });

    // Navigate to login page
    await this.stagehand.page.goto(this.playbook.login.url);
    await this.stagehand.page.waitForLoadState('networkidle');

    // Execute login steps with credential interpolation
    for (const step of this.playbook.login.steps) {
      if (step.act) {
        const instruction = this.interpolate(step.act, credentials);
        await this.stagehand.act({ action: instruction });
      }
      if (step.wait) {
        await new Promise(resolve => setTimeout(resolve, step.wait));
      }
    }

    // Wait for navigation after login
    await this.stagehand.page.waitForLoadState('networkidle');

    // Check for 2FA
    if (this.playbook.login.tfa) {
      const has2FA = await this.stagehand.extract({
        instruction: `Check if the page is showing a ${this.playbook.login.tfa.detect}. Return "yes" if a 2FA/verification code input is visible, "no" otherwise.`,
        schema: { type: 'object', properties: { has_2fa: { type: 'string' } } },
      });

      if (has2FA?.has_2fa === 'yes') {
        this.onEvent({ type: 'agent.2fa.required', method: 'unknown' });
        // Execution pauses here — resumed via handle2FA()
        return;
      }
    }

    // Verify login success
    await this.verifyLogin();
  }

  /**
   * Handle 2FA code submission.
   */
  async handle2FA(tfaCode: string): Promise<void> {
    if (!this.playbook.login.tfa) throw new Error('No 2FA configured for this playbook');

    const inputInstruction = this.interpolate(this.playbook.login.tfa.input, { tfa_code: tfaCode });
    await this.stagehand.act({ action: inputInstruction });

    await this.stagehand.act({ action: this.playbook.login.tfa.submit });

    await this.stagehand.page.waitForLoadState('networkidle');

    this.onEvent({ type: 'agent.2fa.success' });
    await this.verifyLogin();
  }

  /**
   * Execute the credential extraction flow (for api_key_extraction type).
   */
  async extractCredentials(): Promise<Record<string, any>> {
    if (!this.playbook.extract_credentials) {
      throw new Error('No credential extraction steps in playbook');
    }

    this.onEvent({ type: 'agent.extracting' });

    const totalSteps = this.playbook.extract_credentials.steps.length;

    for (let i = 0; i < totalSteps; i++) {
      const step = this.playbook.extract_credentials.steps[i];
      const progress = 0.5 + (i / totalSteps) * 0.4; // 50% to 90%

      if (step.act) {
        this.onEvent({
          type: 'agent.navigating',
          step: step.act,
          progress,
        });
        await this.stagehand.act({ action: step.act });
        await this.stagehand.page.waitForLoadState('networkidle');
      }

      if (step.extract) {
        const result = await this.stagehand.extract({
          instruction: step.extract.instruction,
          schema: {
            type: 'object',
            properties: {
              [step.extract.name]: { type: 'string' },
            },
          },
        });

        if (result?.[step.extract.name]) {
          this.extractedData[step.extract.name] = result[step.extract.name];
        }
      }
    }

    // If primary extraction failed, try fallback
    const requiredFields = this.playbook.result.fields;
    const missingFields = requiredFields.filter(f => !this.extractedData[f]);

    if (missingFields.length > 0 && this.playbook.extract_credentials.fallback) {
      for (const step of this.playbook.extract_credentials.fallback) {
        if (step.act) {
          await this.stagehand.act({ action: step.act });
          await this.stagehand.page.waitForLoadState('networkidle');
        }
        if (step.extract) {
          const result = await this.stagehand.extract({
            instruction: step.extract.instruction,
            schema: {
              type: 'object',
              properties: {
                [step.extract.name]: { type: 'string' },
              },
            },
          });
          if (result?.[step.extract.name]) {
            this.extractedData[step.extract.name] = result[step.extract.name];
          }
        }
      }
    }

    // Final check
    const stillMissing = requiredFields.filter(f => !this.extractedData[f]);
    if (stillMissing.length > 0) {
      this.onEvent({
        type: 'agent.extract.failed',
        error: `Could not extract: ${stillMissing.join(', ')}`,
        fallback: 'manual',
      });
      throw new Error(`Failed to extract required fields: ${stillMissing.join(', ')}`);
    }

    this.onEvent({
      type: 'agent.extract.success',
      preview: this.redactPreview(this.extractedData),
    });

    return this.extractedData;
  }

  /**
   * Execute data extraction flow (for session_scrape type).
   */
  async extractData(): Promise<Record<string, any>> {
    if (!this.playbook.extract_data) {
      throw new Error('No data extraction steps in playbook');
    }

    this.onEvent({ type: 'agent.extracting' });

    for (const step of this.playbook.extract_data.steps) {
      if (step.act) {
        await this.stagehand.act({ action: step.act });
        await this.stagehand.page.waitForLoadState('networkidle');
      }
      if (step.extract) {
        const result = await this.stagehand.extract({
          instruction: step.extract.instruction,
          schema: {
            type: 'object',
            properties: {
              [step.extract.name]: { type: 'string' },
            },
          },
        });
        if (result?.[step.extract.name]) {
          this.extractedData[step.extract.name] = result[step.extract.name];
        }
      }
    }

    return this.extractedData;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async verifyLogin(): Promise<void> {
    const signal = this.playbook.login.success_signal;

    if (signal.url_contains) {
      const url = this.stagehand.page.url();
      if (!url.includes(signal.url_contains)) {
        this.onEvent({ type: 'agent.login.failed', error: 'Login may have failed — unexpected page after login' });
        throw new Error('Login verification failed: unexpected URL');
      }
    }

    if (signal.element_exists) {
      const found = await this.stagehand.extract({
        instruction: `Check if "${signal.element_exists}" exists on the page. Return "yes" or "no".`,
        schema: { type: 'object', properties: { exists: { type: 'string' } } },
      });

      if (found?.exists !== 'yes') {
        this.onEvent({ type: 'agent.login.failed', error: 'Could not verify login success' });
        throw new Error('Login verification failed: expected element not found');
      }
    }

    this.onEvent({ type: 'agent.login.success' });
  }

  private interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || `{${key}}`);
  }

  private redactPreview(data: Record<string, any>): Record<string, any> {
    const preview: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.length > 8) {
        preview[key] = value.slice(0, 4) + '...' + value.slice(-4);
      } else {
        preview[key] = value;
      }
    }
    return preview;
  }
}

// ─── Main Agent ──────────────────────────────────────────────────────────────

/**
 * The Omnivera Agent. Runs inside an ephemeral Browserbase container.
 *
 * Usage (inside the container):
 *
 *   const agent = new OmniveraAgent({
 *     anthropicApiKey: process.env.ANTHROPIC_API_KEY,
 *     playbook: loadedPlaybook,
 *     onEvent: (event) => sendToServer(event),
 *   });
 *
 *   const publicKeyJwk = await agent.init();
 *   // ... send publicKeyJwk to server ...
 *
 *   const result = await agent.execute(encryptedCredentialsBlob);
 *   // ... send result to server ...
 *
 *   await agent.destroy();
 */
export class OmniveraAgent {
  private config: AgentConfig;
  private agentCrypto: AgentCrypto;
  private stagehand: any = null;
  private executor: PlaybookExecutor | null = null;
  private credentials: Record<string, string> | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.agentCrypto = new AgentCrypto();
  }

  /**
   * Initialize the agent: generate keypair, launch browser.
   * Returns the public key JWK for client-side encryption.
   */
  async init(): Promise<JsonWebKey> {
    // 1. Generate keypair (private key stays in this process)
    const publicKeyJwk = await this.agentCrypto.generateKeyPair();

    // 2. Initialize Stagehand
    // In production, import from @browserbasehq/stagehand
    // const { Stagehand } = require('@browserbasehq/stagehand');
    // this.stagehand = new Stagehand({
    //   env: 'BROWSERBASE',
    //   apiKey: process.env.BROWSERBASE_API_KEY,
    //   projectId: process.env.BROWSERBASE_PROJECT_ID,
    //   modelName: 'claude-sonnet-4-20250514',
    //   modelClientOptions: { apiKey: this.config.anthropicApiKey },
    // });
    // await this.stagehand.init();

    this.config.onEvent({ type: 'ready', publicKeyJwk });
    return publicKeyJwk;
  }

  /**
   * Execute the playbook with encrypted credentials.
   *
   * This is the only moment plaintext credentials exist — inside this
   * ephemeral container, in memory, for the duration of the login.
   */
  async execute(encryptedCredentials: string): Promise<any> {
    try {
      // 1. Decrypt credentials (only this container can do this)
      this.credentials = await this.agentCrypto.decrypt(encryptedCredentials);

      // 2. Create executor
      this.executor = new PlaybookExecutor(
        this.stagehand,
        this.config.playbook,
        this.config.onEvent
      );

      // 3. Login
      await this.executor.login(this.credentials);

      // 4. Purge credentials from memory IMMEDIATELY after login
      this.purgeCredentials();

      // 5. Extract based on auth type
      let extracted: Record<string, any>;

      if (this.config.playbook.auth_type === 'api_key_extraction') {
        extracted = await this.executor.extractCredentials();
      } else if (this.config.playbook.auth_type === 'session_scrape') {
        extracted = await this.executor.extractData();
      } else {
        throw new Error(`Unsupported auth type: ${this.config.playbook.auth_type}`);
      }

      // 6. Build result
      const result = {
        platform: this.config.playbook.platform,
        connectionId: crypto.randomUUID(),
        credentials: {
          type: this.config.playbook.result.type,
          ...extracted,
        },
        metadata: {},
      };

      this.config.onEvent({ type: 'connection.complete', result });
      return result;

    } catch (error: any) {
      this.purgeCredentials();
      this.config.onEvent({ type: 'connection.failed', error: error.message });
      throw error;
    }
  }

  /**
   * Submit a 2FA code (encrypted, relayed from client via server).
   */
  async submit2FA(encrypted2FA: string): Promise<void> {
    const decrypted = await this.agentCrypto.decrypt(encrypted2FA);
    const tfaCode = decrypted.tfa_code;

    if (!this.executor) throw new Error('No active executor');
    await this.executor.handle2FA(tfaCode);

    // Purge 2FA code from memory
    // (The variable goes out of scope, but we're explicit about it)
  }

  /**
   * Destroy the agent. Purge all sensitive data.
   * After this, the container should be destroyed by Browserbase.
   */
  async destroy(): Promise<void> {
    this.purgeCredentials();
    this.agentCrypto.destroy();

    if (this.stagehand) {
      await this.stagehand.close();
      this.stagehand = null;
    }

    this.executor = null;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private purgeCredentials(): void {
    if (this.credentials) {
      // Overwrite credential values before nulling
      for (const key of Object.keys(this.credentials)) {
        this.credentials[key] = '';
      }
      this.credentials = null;
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { AgentCrypto, PlaybookExecutor };
export default OmniveraAgent;
