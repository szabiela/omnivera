/**
 * @omnivera/client/react
 *
 * Pre-built React components for Omnivera connection flows.
 * Drop-in ConnectButton and ConnectModal for any platform.
 */

import React, { useState, useCallback, useRef } from 'react';
import { OmniveraClient, OmniveraConnection, ConnectionResult, OmniveraEvent } from './index';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConnectButtonProps {
  /** Platform identifier matching a playbook (e.g., 'dice', 'square') */
  platform: string;
  /** Display name override (defaults to playbook name) */
  label?: string;
  /** URL of your backend's Omnivera server endpoint */
  serverUrl: string;
  /** User ID in your application */
  userId: string;
  /** Called when connection completes successfully */
  onComplete?: (result: ConnectionResult) => void;
  /** Called when connection fails */
  onError?: (error: string) => void;
  /** Additional metadata to attach to the connection */
  metadata?: Record<string, any>;
  /** Custom className for the button */
  className?: string;
}

type FlowState =
  | { step: 'idle' }
  | { step: 'credentials' }
  | { step: 'connecting'; message: string; progress: number }
  | { step: '2fa'; method: string }
  | { step: 'complete'; result: ConnectionResult }
  | { step: 'error'; message: string };

// ─── ConnectButton ───────────────────────────────────────────────────────────

export function ConnectButton({
  platform,
  label,
  serverUrl,
  userId,
  onComplete,
  onError,
  metadata,
  className,
}: ConnectButtonProps) {
  const [state, setState] = useState<FlowState>({ step: 'idle' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tfaCode, setTfaCode] = useState('');
  const connectionRef = useRef<OmniveraConnection | null>(null);

  const startConnection = useCallback(async () => {
    const client = new OmniveraClient({ serverUrl });
    const connection = client.connect(platform, { userId, metadata });
    connectionRef.current = connection;

    connection.on('agent.login.start', () => {
      setState({ step: 'connecting', message: 'Logging in...', progress: 0.2 });
    });

    connection.on('agent.login.success', () => {
      setState({ step: 'connecting', message: 'Login successful...', progress: 0.4 });
    });

    connection.on('agent.navigating', (e) => {
      setState({ step: 'connecting', message: e.step, progress: e.progress || 0.6 });
    });

    connection.on('agent.extracting', () => {
      setState({ step: 'connecting', message: 'Extracting credentials...', progress: 0.8 });
    });

    connection.on('connection.validating', () => {
      setState({ step: 'connecting', message: 'Validating connection...', progress: 0.9 });
    });

    connection.on('agent.2fa.required', (e) => {
      setState({ step: '2fa', method: e.method });
    });

    connection.on('connection.complete', (e) => {
      setState({ step: 'complete', result: e.result });
      onComplete?.(e.result);
    });

    connection.on('connection.failed', (e) => {
      setState({ step: 'error', message: e.error });
      onError?.(e.error);
    });

    connection.on('agent.login.failed', (e) => {
      setState({ step: 'error', message: e.error });
      onError?.(e.error);
    });

    setState({ step: 'connecting', message: 'Preparing secure environment...', progress: 0.1 });

    await connection.start({ email, password });
  }, [platform, serverUrl, userId, metadata, email, password, onComplete, onError]);

  const submit2FA = useCallback(async () => {
    if (connectionRef.current && tfaCode) {
      setState({ step: 'connecting', message: 'Verifying code...', progress: 0.5 });
      await connectionRef.current.submit2FA(tfaCode);
    }
  }, [tfaCode]);

  const reset = useCallback(() => {
    connectionRef.current?.cancel();
    connectionRef.current = null;
    setState({ step: 'idle' });
    setEmail('');
    setPassword('');
    setTfaCode('');
  }, []);

  // ─── Render States ───────────────────────────────────────────────────────

  if (state.step === 'idle') {
    return (
      <button
        className={className}
        onClick={() => setState({ step: 'credentials' })}
        type="button"
      >
        {label || `Connect ${platform}`}
      </button>
    );
  }

  if (state.step === 'credentials') {
    return (
      <div data-omnivera-modal role="dialog">
        <div data-omnivera-modal-header>
          <h3>Connect to {label || platform}</h3>
          <p>
            Your credentials are encrypted in your browser and used once to establish
            the connection. They are never stored.
          </p>
        </div>
        <div data-omnivera-modal-body>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            data-omnivera-input
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            data-omnivera-input
          />
        </div>
        <div data-omnivera-modal-footer>
          <button onClick={reset} data-omnivera-btn-secondary type="button">Cancel</button>
          <button
            onClick={startConnection}
            disabled={!email || !password}
            data-omnivera-btn-primary
            type="button"
          >
            Connect securely
          </button>
        </div>
      </div>
    );
  }

  if (state.step === 'connecting') {
    return (
      <div data-omnivera-progress>
        <div data-omnivera-progress-bar>
          <div
            data-omnivera-progress-fill
            style={{ width: `${state.progress * 100}%` }}
          />
        </div>
        <p data-omnivera-progress-message>{state.message}</p>
      </div>
    );
  }

  if (state.step === '2fa') {
    return (
      <div data-omnivera-modal role="dialog">
        <div data-omnivera-modal-header>
          <h3>Two-factor authentication</h3>
          <p>Enter the verification code sent to your {state.method}.</p>
        </div>
        <div data-omnivera-modal-body>
          <input
            type="text"
            placeholder="Verification code"
            value={tfaCode}
            onChange={(e) => setTfaCode(e.target.value)}
            autoComplete="one-time-code"
            inputMode="numeric"
            data-omnivera-input
          />
        </div>
        <div data-omnivera-modal-footer>
          <button onClick={reset} data-omnivera-btn-secondary type="button">Cancel</button>
          <button
            onClick={submit2FA}
            disabled={!tfaCode}
            data-omnivera-btn-primary
            type="button"
          >
            Verify
          </button>
        </div>
      </div>
    );
  }

  if (state.step === 'complete') {
    return (
      <div data-omnivera-success>
        <p>Connected to {label || platform}!</p>
        {state.result.metadata.summary && (
          <p data-omnivera-summary>{state.result.metadata.summary}</p>
        )}
      </div>
    );
  }

  if (state.step === 'error') {
    return (
      <div data-omnivera-error>
        <p>{state.message}</p>
        <button onClick={reset} data-omnivera-btn-secondary type="button">Try again</button>
      </div>
    );
  }

  return null;
}

export default ConnectButton;
