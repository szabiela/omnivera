/**
 * Example: Using Omnivera in a host application (e.g., mufi)
 *
 * This shows the complete integration — server setup, client usage,
 * and the end-to-end flow a venue operator would experience.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER SIDE — server.ts
// ═══════════════════════════════════════════════════════════════════════════════

import express from 'express';
import { createServer } from 'http';
import { OmniveraServer } from '@omnivera/server';

const app = express();
app.use(express.json());

// Initialize Omnivera
const omnivera = new OmniveraServer({
  browserbase: {
    apiKey: process.env.BROWSERBASE_API_KEY!,
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  playbooksDir: './playbooks/platforms',
  maxConcurrency: 5,
  sessionTimeout: 180_000, // 3 minutes

  // This runs when a platform connection is successfully established
  onConnection: async (result) => {
    console.log(`✅ Connected ${result.platform} for user ${result.userId}`);

    // Store the connection in your database
    // For API token platforms: store the token for future API calls
    // For session scrape platforms: store the session for future scrapes
    await db.connections.create({
      id: result.connectionId,
      userId: result.userId,
      platform: result.platform,
      credentialType: result.credentials.type,
      // Encrypt at rest before storing
      encryptedCredentials: await encrypt(JSON.stringify(result.credentials)),
      metadata: result.metadata,
      status: 'active',
      lastSync: null,
      createdAt: new Date(),
    });

    // Optionally: trigger an initial data sync
    await triggerInitialSync(result);
  },

  onError: async ({ sessionId, platform, userId, error }) => {
    console.error(`❌ Connection failed: ${platform} for ${userId}: ${error}`);
    // Log to your error tracking (Sentry, etc.)
  },
});

// Mount Omnivera routes
app.use('/omnivera', omnivera.router());

// Your own routes
app.get('/api/connections', async (req, res) => {
  const connections = await db.connections.findByUser(req.user.id);
  res.json(connections.map(c => ({
    id: c.id,
    platform: c.platform,
    status: c.status,
    lastSync: c.lastSync,
  })));
});

// Start server with WebSocket support
const server = createServer(app);
omnivera.attachWebSocket(server);

server.listen(3000, () => {
  console.log('Server running on :3000');
  console.log('Omnivera endpoints at /omnivera');
});


// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT SIDE — ConnectPage.tsx (React)
// ═══════════════════════════════════════════════════════════════════════════════

/*
import React, { useState } from 'react';
import { ConnectButton } from '@omnivera/client/react';

// Minimal integration — just drop in ConnectButton components
function ConnectYourTools() {
  const [connections, setConnections] = useState<string[]>([]);

  const handleComplete = (result) => {
    setConnections(prev => [...prev, result.platform]);
    // Refresh your dashboard, show success state, etc.
  };

  return (
    <div>
      <h1>Connect Your Tools</h1>
      <p>Link your existing platforms to see all your data in one place.</p>

      <div className="grid grid-cols-2 gap-4">
        {/* OAuth — one click, no credentials needed *\/}
        <ConnectButton
          platform="square"
          label="Square POS"
          serverUrl="/omnivera"
          userId={currentUser.id}
          onComplete={handleComplete}
        />

        <ConnectButton
          platform="eventbrite"
          label="Eventbrite"
          serverUrl="/omnivera"
          userId={currentUser.id}
          onComplete={handleComplete}
        />

        {/* API key extraction — credentials encrypted client-side *\/}
        <ConnectButton
          platform="dice"
          label="DICE"
          serverUrl="/omnivera"
          userId={currentUser.id}
          onComplete={handleComplete}
        />

        <ConnectButton
          platform="ticket_tailor"
          label="Ticket Tailor"
          serverUrl="/omnivera"
          userId={currentUser.id}
          onComplete={handleComplete}
        />

        <ConnectButton
          platform="sevenrooms"
          label="SevenRooms"
          serverUrl="/omnivera"
          userId={currentUser.id}
          onComplete={handleComplete}
        />

        {/* Session scrape — same UX, different mechanism *\/}
        <ConnectButton
          platform="resident_advisor"
          label="Resident Advisor"
          serverUrl="/omnivera"
          userId={currentUser.id}
          onComplete={handleComplete}
        />
      </div>
    </div>
  );
}
*/


// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT SIDE — Custom UI (vanilla JS, no React)
// ═══════════════════════════════════════════════════════════════════════════════

/*
import { OmniveraClient } from '@omnivera/client';

const omnivera = new OmniveraClient({ serverUrl: '/omnivera' });

// Get DOM elements
const form = document.getElementById('connect-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const tfaSection = document.getElementById('tfa-section');
const tfaInput = document.getElementById('tfa-code');
const tfaSubmit = document.getElementById('tfa-submit');

let activeConnection = null;

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // Hide form, show progress
  form.style.display = 'none';
  progressBar.style.display = 'block';

  // Start connection
  activeConnection = omnivera.connect('dice', { userId: 'venue_123' });

  // Simple status listener
  activeConnection.onStatus((message, progress) => {
    progressText.textContent = message;
    if (progress) {
      progressBar.querySelector('.fill').style.width = `${progress * 100}%`;
    }
  });

  // Handle 2FA
  activeConnection.on('agent.2fa.required', (event) => {
    tfaSection.style.display = 'block';
    progressText.textContent = `Enter the code sent to your ${event.method}`;
  });

  // Handle completion
  activeConnection.on('connection.complete', (event) => {
    progressText.textContent = '✓ Connected!';
    progressBar.querySelector('.fill').style.width = '100%';
    // Redirect or refresh
    setTimeout(() => window.location.reload(), 1500);
  });

  // Handle errors
  activeConnection.on('connection.failed', (event) => {
    progressText.textContent = `Failed: ${event.error}`;
    progressBar.querySelector('.fill').style.backgroundColor = '#ef4444';
  });

  // Start with encrypted credentials
  await activeConnection.start({
    email: emailInput.value,
    password: passwordInput.value,
  });
});

// 2FA submit
tfaSubmit.addEventListener('click', () => {
  if (activeConnection) {
    activeConnection.submit2FA(tfaInput.value);
    tfaSection.style.display = 'none';
  }
});
*/


// ═══════════════════════════════════════════════════════════════════════════════
// POST-CONNECTION — Using extracted credentials for data sync
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * After Omnivera extracts an API token, your app uses it directly.
 * Omnivera's job is done — it got you the credentials.
 * Your app handles the ongoing data sync.
 */

async function triggerInitialSync(connectionResult: any) {
  const { platform, credentials } = connectionResult;

  switch (platform) {
    case 'dice': {
      // Use the extracted DICE API token to query their GraphQL API
      const response = await fetch('https://partners-endpoint.dice.fm/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${credentials.api_token}`,
        },
        body: JSON.stringify({
          query: `{
            events(first: 10) {
              id
              name
              startDatetime
              totalTicketAllocationQty
              tickets { totalCount }
            }
          }`,
        }),
      });
      const data = await response.json();
      console.log(`Synced ${data.data.events.length} events from DICE`);
      break;
    }

    case 'square': {
      // Use the OAuth token to query Square's REST API
      const response = await fetch('https://connect.squareup.com/v2/orders/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${credentials.access_token}`,
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({
          location_ids: [credentials.merchant_id],
          query: {
            filter: {
              date_time_filter: {
                created_at: { start_at: new Date(Date.now() - 30 * 86400000).toISOString() },
              },
            },
          },
        }),
      });
      const data = await response.json();
      console.log(`Synced ${data.orders?.length || 0} orders from Square`);
      break;
    }

    case 'ticket_tailor': {
      // Use the API key to query Ticket Tailor's REST API
      const response = await fetch('https://api.tickettailor.com/v1/events', {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${Buffer.from(credentials.api_token + ':').toString('base64')}`,
        },
      });
      const data = await response.json();
      console.log(`Synced ${data.data?.length || 0} events from Ticket Tailor`);
      break;
    }

    case 'resident_advisor': {
      // For session scrape platforms, the initial data was already extracted
      // Store it and schedule future scrape runs
      console.log('RA data extracted:', Object.keys(connectionResult.metadata));
      // Schedule recurring scrape via PM2/cron
      break;
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// REGISTERING A CUSTOM PLAYBOOK AT RUNTIME
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * You can also register playbooks programmatically instead of from YAML files.
 * Useful if you want to generate playbooks dynamically or store them in a database.
 */

/*
omnivera.registerPlaybook({
  platform: 'custom_platform',
  name: 'My Custom Platform',
  domains: ['app.custom.com'],
  auth_type: 'api_key_extraction',
  login: {
    url: 'https://app.custom.com/login',
    steps: [
      { act: 'enter {email} into the email field' },
      { act: 'enter {password} into the password field' },
      { act: 'click sign in' },
    ],
    success_signal: { url_contains: '/home' },
  },
  extract_credentials: {
    steps: [
      { act: 'go to developer settings' },
      { act: 'create a new API key' },
      { extract: { name: 'api_token', instruction: 'the generated API key' } },
    ],
  },
  result: {
    type: 'api_token',
    fields: ['api_token'],
  },
});
*/


// Placeholder for the example to be syntactically valid
const db: any = {};
const encrypt: any = async (s: string) => s;
const currentUser: any = { id: '1' };
export {};
