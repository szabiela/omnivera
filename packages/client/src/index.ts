/**
 * @omnivera/client
 *
 * Browser-side SDK for securely connecting to SaaS platforms via AI browser agents.
 * Handles credential encryption, WebSocket communication, and 2FA relay.
 */

import { importPublicKey, encryptCredentials, encrypt2FACode } from './crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OmniveraClientConfig {
  /** URL of your backend's Omnivera server endpoint */
  serverUrl: string;
}

export interface ConnectOptions {
  /** Unique identifier for the user in your application */
  userId: string;
  /** Any additional metadata to associate with this connection */
  metadata?: Record<string, any>;
}

export interface ConnectionCredentials {
  email: string;
  password: string;
}

export type OmniveraEvent =
  | { type: 'session.created'; sessionId: string }
  | { type: 'session.ready' }
  | { type: 'agent.login.start' }
  | { type: 'agent.login.success' }
  | { type: 'agent.login.failed'; error: string }
  | { type: 'agent.2fa.required'; method: 'sms' | 'email' | 'totp' | 'unknown' }
  | { type: 'agent.2fa.submitted' }
  | { type: 'agent.2fa.success' }
  | { type: 'agent.2fa.failed'; error: string }
  | { type: 'agent.navigating'; step: string; progress: number }
  | { type: 'agent.extracting' }
  | { type: 'agent.extract.success'; preview: Record<string, any> }
  | { type: 'agent.extract.failed'; error: string; fallback?: 'manual' | 'retry' }
  | { type: 'connection.validating' }
  | { type: 'connection.complete'; result: ConnectionResult }
  | { type: 'connection.failed'; error: string };

export interface ConnectionResult {
  platform: string;
  userId: string;
  connectionId: string;
  credentials: {
    type: 'api_token' | 'session' | 'oauth_token';
    [key: string]: any;
  };
  metadata: {
    summary?: string;
    [key: string]: any;
  };
}

type EventType = OmniveraEvent['type'];
type EventCallback<T extends EventType> = (
  event: Extract<OmniveraEvent, { type: T }>
) => void;

// ─── Connection Handle ───────────────────────────────────────────────────────

/**
 * Represents an in-progress connection attempt.
 * Provides event listeners and methods to interact with the agent.
 */
export class OmniveraConnection {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<Function>> = new Map();
  private sessionId: string | null = null;
  private publicKey: CryptoKey | null = null;
  private serverUrl: string;
  private platform: string;
  private options: ConnectOptions;

  constructor(serverUrl: string, platform: string, options: ConnectOptions) {
    this.serverUrl = serverUrl;
    this.platform = platform;
    this.options = options;
  }

  /**
   * Register an event listener.
   */
  on<T extends EventType>(type: T, callback: EventCallback<T>): this {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);
    return this;
  }

  /**
   * Convenience: listen for any status/progress event with a simple message.
   */
  onStatus(callback: (message: string, progress?: number) => void): this {
    const statusTypes: EventType[] = [
      'session.created', 'session.ready', 'agent.login.start',
      'agent.login.success', 'agent.navigating', 'agent.extracting',
      'connection.validating', 'connection.complete',
    ];
    for (const type of statusTypes) {
      this.on(type as any, (event: any) => {
        const messages: Record<string, string> = {
          'session.created': 'Preparing secure environment...',
          'session.ready': 'Ready to connect...',
          'agent.login.start': 'Logging in...',
          'agent.login.success': 'Login successful...',
          'agent.navigating': event.step || 'Navigating...',
          'agent.extracting': 'Extracting credentials...',
          'connection.validating': 'Validating connection...',
          'connection.complete': 'Connected!',
        };
        callback(messages[type] || type, event.progress);
      });
    }
    return this;
  }

  /**
   * Start the connection flow with the user's credentials.
   * Credentials are encrypted client-side before being sent.
   */
  async start(credentials: ConnectionCredentials): Promise<void> {
    try {
      // 1. Initialize session — get public key from ephemeral container
      const initResponse = await fetch(`${this.serverUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: this.platform,
          userId: this.options.userId,
          metadata: this.options.metadata,
        }),
      });

      if (!initResponse.ok) {
        throw new Error(`Session init failed: ${initResponse.statusText}`);
      }

      const { sessionId, publicKeyJwk, wsUrl } = await initResponse.json();
      this.sessionId = sessionId;
      this.emit({ type: 'session.created', sessionId });

      // 2. Import the container's public key
      this.publicKey = await importPublicKey(publicKeyJwk);

      // 3. Encrypt credentials client-side
      const encryptedBlob = await encryptCredentials(this.publicKey, {
        email: credentials.email,
        password: credentials.password,
      });

      // 4. Open WebSocket for real-time progress
      this.connectWebSocket(wsUrl || `${this.serverUrl.replace('http', 'ws')}/ws/${sessionId}`);

      // 5. Send encrypted credentials to server (server CANNOT decrypt)
      const execResponse = await fetch(`${this.serverUrl}/sessions/${sessionId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedCredentials: encryptedBlob }),
      });

      if (!execResponse.ok) {
        throw new Error(`Execution failed: ${execResponse.statusText}`);
      }

      // Agent is now running — progress comes via WebSocket

    } catch (error: any) {
      this.emit({ type: 'connection.failed', error: error.message });
    }
  }

  /**
   * Submit a 2FA code mid-flow. Code is encrypted before sending.
   */
  async submit2FA(code: string): Promise<void> {
    if (!this.publicKey || !this.sessionId) {
      throw new Error('No active session');
    }

    const encryptedCode = await encrypt2FACode(this.publicKey, code);

    await fetch(`${this.serverUrl}/sessions/${this.sessionId}/2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encrypted2FA: encryptedCode }),
    });

    this.emit({ type: 'agent.2fa.submitted' });
  }

  /**
   * Cancel the connection attempt.
   */
  async cancel(): Promise<void> {
    if (this.sessionId) {
      await fetch(`${this.serverUrl}/sessions/${this.sessionId}`, {
        method: 'DELETE',
      }).catch(() => {}); // best effort
    }
    this.cleanup();
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private connectWebSocket(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.onmessage = (event) => {
      try {
        const data: OmniveraEvent = JSON.parse(event.data);
        this.emit(data);

        // Auto-cleanup on terminal events
        if (data.type === 'connection.complete' || data.type === 'connection.failed') {
          this.cleanup();
        }
      } catch (e) {
        // ignore malformed messages
      }
    };

    this.ws.onerror = () => {
      this.emit({ type: 'connection.failed', error: 'WebSocket connection lost' });
    };

    this.ws.onopen = () => {
      this.emit({ type: 'session.ready' });
    };
  }

  private emit(event: OmniveraEvent): void {
    const callbacks = this.listeners.get(event.type);
    if (callbacks) {
      for (const cb of callbacks) {
        try { cb(event); } catch (e) { console.error('Omnivera event handler error:', e); }
      }
    }

    // Also emit to wildcard listeners
    const wildcards = this.listeners.get('*');
    if (wildcards) {
      for (const cb of wildcards) {
        try { cb(event); } catch (e) { console.error('Omnivera event handler error:', e); }
      }
    }
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ─── Main Client ─────────────────────────────────────────────────────────────

/**
 * Omnivera client. Create one instance per application.
 */
export class OmniveraClient {
  private config: OmniveraClientConfig;

  constructor(config: OmniveraClientConfig) {
    this.config = config;
  }

  /**
   * Start a connection flow for a specific platform.
   * Returns a OmniveraConnection handle for event listening and interaction.
   */
  connect(platform: string, options: ConnectOptions): OmniveraConnection {
    return new OmniveraConnection(this.config.serverUrl, platform, options);
  }

  /**
   * List available platforms that have playbooks configured.
   */
  async listPlatforms(): Promise<Array<{ id: string; name: string; authType: string }>> {
    const response = await fetch(`${this.config.serverUrl}/platforms`);
    return response.json();
  }

  /**
   * Check the status of an existing connection.
   */
  async getConnectionStatus(connectionId: string): Promise<{
    connected: boolean;
    lastSync: string | null;
    platform: string;
  }> {
    const response = await fetch(`${this.config.serverUrl}/connections/${connectionId}`);
    return response.json();
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { importPublicKey, encryptCredentials, encrypt2FACode } from './crypto';
export default OmniveraClient;
