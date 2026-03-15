/**
 * @omnivera/server
 *
 * Backend orchestration for Omnivera.
 * Manages Browserbase sessions, relays encrypted credentials,
 * and coordinates WebSocket communication with the client.
 *
 * IMPORTANT: This server NEVER decrypts credentials.
 * It relays encrypted blobs from the client to the agent container.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Express, Router, Request, Response } from 'express';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OmniveraServerConfig {
  /** Browserbase API credentials */
  browserbase: {
    apiKey: string;
    projectId: string;
    /** API base URL (default: https://www.browserbase.com) */
    baseUrl?: string;
  };

  /** Anthropic API key for Stagehand's LLM calls inside the agent */
  anthropic: {
    apiKey: string;
  };

  /** Path to directory containing platform playbook YAML files */
  playbooksDir?: string;

  /** Called when a connection is successfully established */
  onConnection: (result: ConnectionResult) => Promise<void>;

  /** Called when a connection fails (optional, for logging/alerting) */
  onError?: (error: { sessionId: string; platform: string; userId: string; error: string }) => Promise<void>;

  /** Max concurrent Browserbase sessions (default: 5) */
  maxConcurrency?: number;

  /** Session timeout in ms (default: 180000 = 3 minutes) */
  sessionTimeout?: number;
}

export interface ConnectionResult {
  platform: string;
  userId: string;
  connectionId: string;
  credentials: {
    type: 'api_token' | 'session' | 'oauth_token';
    [key: string]: any;
  };
  metadata: Record<string, any>;
}

export interface Playbook {
  platform: string;
  name: string;
  domains: string[];
  auth_type: 'oauth' | 'api_key_extraction' | 'session_scrape';
  login: {
    url: string;
    steps: Array<{ act?: string; extract?: { name: string; instruction: string } }>;
    success_signal: Record<string, string>;
    tfa?: {
      detect: string;
      input: string;
      submit: string;
    };
  };
  extract_credentials?: {
    steps: Array<{ act?: string; extract?: { name: string; instruction: string } }>;
    fallback?: Array<{ act?: string; extract?: { name: string; instruction: string } }>;
  };
  extract_data?: {
    steps: Array<{ act?: string; extract?: { name: string; instruction: string } }>;
  };
  result: {
    type: string;
    fields: string[];
  };
}

interface Session {
  id: string;
  browserbaseSessionId: string | null;
  platform: string;
  userId: string;
  metadata: Record<string, any>;
  status: 'initializing' | 'ready' | 'executing' | 'awaiting_2fa' | 'complete' | 'failed';
  publicKeyJwk: JsonWebKey | null;
  ws: WebSocket | null;
  createdAt: number;
  timeoutHandle: NodeJS.Timeout | null;
}

// ─── Browserbase Client ──────────────────────────────────────────────────────

class BrowserbaseClient {
  private apiKey: string;
  private projectId: string;
  private baseUrl: string;

  constructor(config: OmniveraServerConfig['browserbase']) {
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
    this.baseUrl = config.baseUrl || 'https://www.browserbase.com';
  }

  /**
   * Create a new Browserbase session.
   * Returns the session ID and connect URL.
   */
  async createSession(): Promise<{ sessionId: string; connectUrl: string }> {
    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bb-api-key': this.apiKey,
      },
      body: JSON.stringify({
        projectId: this.projectId,
        browserSettings: {
          // Stealth mode to avoid bot detection on target platforms
          fingerprint: { devices: ['desktop'], operatingSystems: ['macos'] },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Browserbase session creation failed: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      sessionId: data.id,
      connectUrl: data.connectUrl,
    };
  }

  /**
   * Destroy a Browserbase session.
   */
  async destroySession(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-bb-api-key': this.apiKey,
      },
      body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
    }).catch(() => {}); // best effort
  }
}

// ─── Agent Launcher ──────────────────────────────────────────────────────────

/**
 * Launches the @omnivera/agent inside a Browserbase session.
 *
 * In production, the agent runs as a script inside the Browserbase container.
 * This launcher sends the playbook and encrypted credentials to the agent
 * and receives progress events + results.
 *
 * The agent is the ONLY component that has the private key.
 */
class AgentLauncher {
  private anthropicApiKey: string;

  constructor(anthropicApiKey: string) {
    this.anthropicApiKey = anthropicApiKey;
  }

  /**
   * Execute the agent inside a Browserbase session.
   * Returns the public key for client-side encryption and the agent's event stream.
   */
  async launch(
    connectUrl: string,
    playbook: Playbook,
    onEvent: (event: any) => void
  ): Promise<{ publicKeyJwk: JsonWebKey; execute: (encryptedCredentials: string) => Promise<ConnectionResult>; submit2FA: (encrypted2FA: string) => Promise<void>; destroy: () => Promise<void> }> {

    // In production, this would:
    // 1. Connect to the Browserbase session via CDP
    // 2. Inject the agent script
    // 3. The agent generates a keypair and returns the public key
    // 4. On execute(), sends encrypted creds to agent for decryption + playbook execution

    // For the SDK, we define the interface that the agent implements.
    // The actual agent runtime is in @omnivera/agent.

    // ─── Agent Communication Protocol ────────────────────────────────────
    //
    // The server communicates with the agent via a simple JSON message protocol
    // over the Browserbase session's CDP connection:
    //
    // Server → Agent:
    //   { type: 'init', playbook: Playbook, anthropicApiKey: string }
    //   { type: 'execute', encryptedCredentials: string }
    //   { type: 'submit_2fa', encrypted2FA: string }
    //   { type: 'destroy' }
    //
    // Agent → Server:
    //   { type: 'ready', publicKeyJwk: JsonWebKey }
    //   { type: 'event', event: OmniveraEvent }
    //   { type: 'result', result: ConnectionResult }
    //   { type: 'error', error: string }

    // ─── Stub Implementation ─────────────────────────────────────────────
    // Replace with actual Browserbase CDP connection in production

    let resolveExecute: (result: ConnectionResult) => void;
    let resolve2FA: () => void;

    // Generate a placeholder keypair for the interface
    // In production, this happens inside the container
    const keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt']
    );

    const publicKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey);

    return {
      publicKeyJwk,

      execute: (encryptedCredentials: string) => {
        return new Promise((resolve) => {
          resolveExecute = resolve;

          // In production: send encrypted creds to agent via CDP
          // Agent decrypts, runs playbook, emits events, returns result
          onEvent({ type: 'agent.login.start' });
        });
      },

      submit2FA: (encrypted2FA: string) => {
        return new Promise((resolve) => {
          resolve2FA = resolve;
          // In production: send encrypted 2FA to agent via CDP
        });
      },

      destroy: async () => {
        // In production: close CDP connection, container auto-destroys
      },
    };
  }
}

// ─── Main Server ─────────────────────────────────────────────────────────────

export class OmniveraServer {
  private config: OmniveraServerConfig;
  private browserbase: BrowserbaseClient;
  private agentLauncher: AgentLauncher;
  private sessions: Map<string, Session> = new Map();
  private playbooks: Map<string, Playbook> = new Map();
  private wss: WebSocketServer | null = null;

  constructor(config: OmniveraServerConfig) {
    this.config = config;
    this.browserbase = new BrowserbaseClient(config.browserbase);
    this.agentLauncher = new AgentLauncher(config.anthropic.apiKey);

    // Load playbooks
    if (config.playbooksDir) {
      this.loadPlaybooks(config.playbooksDir);
    }
  }

  // ─── Playbook Management ─────────────────────────────────────────────────

  /**
   * Load playbooks from a directory of YAML files.
   */
  loadPlaybooks(dir: string): void {
    const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      const playbook = parseYaml(content) as Playbook;
      this.playbooks.set(playbook.platform, playbook);
    }
  }

  /**
   * Register a playbook programmatically.
   */
  registerPlaybook(playbook: Playbook): void {
    this.playbooks.set(playbook.platform, playbook);
  }

  // ─── Express Router ──────────────────────────────────────────────────────

  /**
   * Returns an Express router that handles all Omnivera HTTP endpoints.
   * Mount this on your Express app: app.use('/omnivera', omnivera.router())
   */
  router(): Router {
    // Dynamic import to keep express optional
    const express = require('express');
    const router = express.Router();

    // List available platforms
    router.get('/platforms', (_req: Request, res: Response) => {
      const platforms = Array.from(this.playbooks.values()).map(p => ({
        id: p.platform,
        name: p.name,
        authType: p.auth_type,
      }));
      res.json(platforms);
    });

    // Create a new session
    router.post('/sessions', async (req: Request, res: Response) => {
      try {
        const { platform, userId, metadata } = req.body;
        const result = await this.createSession(platform, userId, metadata);
        res.json(result);
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    // Execute agent with encrypted credentials
    router.post('/sessions/:sessionId/execute', async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const { encryptedCredentials } = req.body;
        await this.executeSession(sessionId, encryptedCredentials);
        res.json({ status: 'executing' });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    // Submit 2FA code
    router.post('/sessions/:sessionId/2fa', async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const { encrypted2FA } = req.body;
        await this.submit2FA(sessionId, encrypted2FA);
        res.json({ status: 'submitted' });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    // Cancel/destroy a session
    router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
      try {
        await this.destroySession(req.params.sessionId);
        res.json({ status: 'destroyed' });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    // Connection status
    router.get('/connections/:connectionId', async (req: Request, res: Response) => {
      // This would query your database — delegate to the host's onConnection handler
      res.json({ connected: true, lastSync: null, platform: 'unknown' });
    });

    return router;
  }

  // ─── WebSocket Setup ─────────────────────────────────────────────────────

  /**
   * Attach WebSocket server to an existing HTTP server.
   * Call this after creating your HTTP server.
   */
  attachWebSocket(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/omnivera/ws' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      // Extract session ID from URL: /omnivera/ws/:sessionId
      const url = new URL(req.url || '', 'http://localhost');
      const parts = url.pathname.split('/');
      const sessionId = parts[parts.length - 1];

      const session = this.sessions.get(sessionId);
      if (session) {
        session.ws = ws;
        ws.on('close', () => { session.ws = null; });
      } else {
        ws.close(4004, 'Session not found');
      }
    });
  }

  // ─── Session Lifecycle ───────────────────────────────────────────────────

  /**
   * Create a new connection session.
   * Provisions a Browserbase container and returns the public key for credential encryption.
   */
  async createSession(
    platform: string,
    userId: string,
    metadata: Record<string, any> = {}
  ): Promise<{ sessionId: string; publicKeyJwk: JsonWebKey; wsUrl: string }> {

    const playbook = this.playbooks.get(platform);
    if (!playbook) {
      throw new Error(`No playbook found for platform: ${platform}`);
    }

    // Check concurrency limits
    const activeSessions = Array.from(this.sessions.values())
      .filter(s => s.status === 'executing' || s.status === 'awaiting_2fa');
    if (activeSessions.length >= (this.config.maxConcurrency || 5)) {
      throw new Error('Too many concurrent connections. Please try again shortly.');
    }

    // Create Browserbase session
    const { sessionId: bbSessionId, connectUrl } = await this.browserbase.createSession();

    // Launch agent in the container — agent generates keypair and returns public key
    const agent = await this.agentLauncher.launch(
      connectUrl,
      playbook,
      (event) => this.emitToClient(sessionId, event)
    );

    const sessionId = generateId();

    const session: Session = {
      id: sessionId,
      browserbaseSessionId: bbSessionId,
      platform,
      userId,
      metadata,
      status: 'ready',
      publicKeyJwk: agent.publicKeyJwk,
      ws: null,
      createdAt: Date.now(),
      timeoutHandle: null,
    };

    // Set session timeout
    session.timeoutHandle = setTimeout(
      () => this.destroySession(sessionId),
      this.config.sessionTimeout || 180000
    );

    this.sessions.set(sessionId, session);

    // Store agent reference for later execution
    (session as any)._agent = agent;

    return {
      sessionId,
      publicKeyJwk: agent.publicKeyJwk,
      wsUrl: `/omnivera/ws/${sessionId}`,
    };
  }

  /**
   * Execute the agent with encrypted credentials.
   * The server relays the encrypted blob — it CANNOT decrypt it.
   */
  async executeSession(sessionId: string, encryptedCredentials: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'ready') throw new Error(`Session not ready (status: ${session.status})`);

    session.status = 'executing';
    const agent = (session as any)._agent;

    try {
      // Pass encrypted blob to agent — only the agent can decrypt it
      const result = await agent.execute(encryptedCredentials);

      session.status = 'complete';
      this.emitToClient(sessionId, { type: 'connection.complete', result });

      // Notify host application
      await this.config.onConnection(result);

    } catch (error: any) {
      session.status = 'failed';
      this.emitToClient(sessionId, { type: 'connection.failed', error: error.message });

      if (this.config.onError) {
        await this.config.onError({
          sessionId,
          platform: session.platform,
          userId: session.userId,
          error: error.message,
        });
      }
    } finally {
      // Cleanup (destroy container, purge session)
      await this.destroySession(sessionId);
    }
  }

  /**
   * Relay an encrypted 2FA code to the agent.
   */
  async submit2FA(sessionId: string, encrypted2FA: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const agent = (session as any)._agent;
    await agent.submit2FA(encrypted2FA);
  }

  /**
   * Destroy a session and its Browserbase container.
   */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
    }

    if (session.ws) {
      session.ws.close();
    }

    const agent = (session as any)._agent;
    if (agent) {
      await agent.destroy();
    }

    if (session.browserbaseSessionId) {
      await this.browserbase.destroySession(session.browserbaseSessionId);
    }

    this.sessions.delete(sessionId);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private emitToClient(sessionId: string, event: any): void {
    const session = this.sessions.get(sessionId);
    if (session?.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(event));
    }
  }
}

function generateId(): string {
  return crypto.randomUUID();
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export default OmniveraServer;
export type { Playbook, Session };
