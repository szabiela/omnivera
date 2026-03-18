/**
 * Omnivera — Human Auth + Agent Extraction
 *
 * THE CORE PRODUCT FLOW:
 * 1. Opens a cloud browser and navigates to the platform login
 * 2. Opens a live view URL — user logs in manually (handles CAPTCHAs, 2FA, etc.)
 * 3. Detects when login succeeds
 * 4. Agent takes over — navigates dashboard, extracts data
 *
 * This is the "Plaid for everything" flow.
 *
 * Run: npx tsx scripts/test-shotgun.ts
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { config } from 'dotenv';
import { openPopup, closePopup, POPUP_WIDTH, POPUP_HEIGHT } from './lib/popup';

config();

// ─── Config ──────────────────────────────────────────────────────────────────

const PLATFORM_URL = 'https://smartboard.shotgun.live/login';
const PLATFORM_NAME = 'Shotgun';
const SUCCESS_INDICATORS = ['/events', '/settings', '/dashboard', '/analytics', '/marketing'];
const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes for user to log in

async function main() {
  console.log(`🔗 Omnivera — Connect to ${PLATFORM_NAME}\n`);
  console.log('This is the hybrid flow: YOU log in, then the AGENT extracts data.\n');

  const bbApiKey = process.env.BROWSERBASE_API_KEY!;
  const bbProjectId = process.env.BROWSERBASE_PROJECT_ID!;
  const anthropicKey = process.env.ANTHROPIC_API_KEY!;

  // ─── Step 1: Create Browserbase session ──────────────────────────────────
  console.log('⏳ Creating cloud browser session...');

  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: bbApiKey,
    projectId: bbProjectId,
    model: {
      modelName: 'anthropic/claude-sonnet-4-20250514',
      apiKey: anthropicKey,
    },
    verbose: 0,
    browserbaseSessionCreateParams: {
      browserSettings: {
        viewport: {
          width: POPUP_WIDTH,
          height: POPUP_HEIGHT,
        },
      },
    },
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    console.log('✅ Cloud browser ready\n');

    // ─── Step 2: Navigate to login page ──────────────────────────────────
    console.log(`📍 Navigating to ${PLATFORM_NAME} login...`);
    await page.goto(PLATFORM_URL);
    await page.waitForLoadState('domcontentloaded');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // ─── Step 3: Get live view URL and open it ───────────────────────────
    // The session ID is in the Stagehand internals — extract it
    // We'll use the Browserbase debug endpoint
    const sessionId = (stagehand as any).browserbaseSessionID
      || (stagehand as any).sessionId
      || (stagehand as any)._browserbaseSessionId;

    let liveViewUrl: string;

    if (sessionId) {
      // Fetch the debug URLs from Browserbase API
      const response = await fetch(
        `https://api.browserbase.com/v1/sessions/${sessionId}/debug`,
        {
          headers: { 'x-bb-api-key': bbApiKey },
        }
      );
      const debugInfo = await response.json();
      liveViewUrl = debugInfo.pages?.[0]?.debuggerFullscreenUrl || debugInfo.debuggerFullscreenUrl;
    } else {
      // Fallback: check if stagehand exposes it
      console.log('⚠️  Could not find session ID automatically.');
      console.log('   Check the Browserbase dashboard for the live view URL.');
      console.log('   Or look at the session URL in the logs above.');
      liveViewUrl = '';
    }

    if (liveViewUrl) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('🔓 LOG IN NOW — A popup window will open.');
      console.log('   Log into your Shotgun account.');
      console.log('   Handle any CAPTCHAs or 2FA yourself.');
      console.log('   The popup will close once you\'re logged in.');
      console.log('═══════════════════════════════════════════════════════════\n');

      openPopup(liveViewUrl, PLATFORM_NAME);
      console.log('   Popup opened.\n');
    }

    // ─── Step 4: Wait for user to log in ─────────────────────────────────
    console.log('⏳ Waiting for you to log in...');

    const loggedIn = await waitForLogin(page, SUCCESS_INDICATORS, LOGIN_TIMEOUT_MS);

    if (!loggedIn) {
      console.error('\n❌ Login timeout — did not detect a successful login within 2 minutes.');
      console.error('   The agent needs you to be on a dashboard/feed page to continue.');
      return;
    }

    const loginUrl = page.url();
    console.log(`\n✅ Login detected! Current URL: ${loginUrl}`);

    console.log('   Closing popup...');
    closePopup();

    console.log('\n🤖 Agent taking over...\n');

    // Small pause to let the page settle
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ─── Step 5: Navigate to integrations settings ───────────────────────
    console.log('═══ Agent: Navigating to Shotgun API settings ═══\n');

    await page.goto('https://smartboard.shotgun.live/settings/integrations');
    await page.waitForLoadState('domcontentloaded');
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log(`   Current URL: ${page.url()}`);
    await page.screenshot({ path: '/tmp/omnivera-shotgun-integrations.png', fullPage: true });
    console.log('   Screenshot: /tmp/omnivera-shotgun-integrations.png\n');

    // ─── Step 6: Open the Shotgun APIs panel ─────────────────────────────
    console.log('   Opening Shotgun APIs panel...');
    await stagehand.act('click the "Connect" button next to "Shotgun APIs"');
    await new Promise(resolve => setTimeout(resolve, 2000));

    await page.screenshot({ path: '/tmp/omnivera-shotgun-api-panel.png', fullPage: true });
    console.log('   API panel screenshot: /tmp/omnivera-shotgun-api-panel.png\n');

    // ─── Step 7: Extract Organizer ID ────────────────────────────────────
    console.log('   Extracting Organizer ID...');
    const organizerId = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const input of inputs) {
        const val = (input as HTMLInputElement).value;
        if (val && /^\d{4,}$/.test(val)) return val;
      }
      const textElements = Array.from(document.querySelectorAll('div, span, p'));
      for (const el of textElements) {
        const text = el.textContent?.trim();
        if (text && /^\d{4,}$/.test(text) && el.children.length === 0) return text;
      }
      return null;
    });
    console.log(`   🏢 Organizer ID: ${organizerId}\n`);

    // ─── Step 8: Issue API token ─────────────────────────────────────────
    console.log('   Issuing API token...');
    await stagehand.act('click the "Issue token" button');
    await new Promise(resolve => setTimeout(resolve, 5000));

    await page.screenshot({ path: '/tmp/omnivera-shotgun-token.png', fullPage: true });
    console.log('   Token screenshot: /tmp/omnivera-shotgun-token.png\n');

    // ─── Step 9: Extract the token ───────────────────────────────────────
    console.log('   Extracting API token...');
    const apiToken = await page.evaluate(() => {
      // Try all inputs first
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const input of inputs) {
        const val = (input as HTMLInputElement).value;
        if (val && val.length > 20 && val.startsWith('ey')) return val;
      }
      // Try text content of any element that looks like a JWT or long token
      const allElements = Array.from(document.querySelectorAll('div, span, p, textarea, code, pre'));
      for (const el of allElements) {
        const text = el.textContent?.trim();
        if (text && text.length > 20 && text.startsWith('ey') && el.children.length === 0) return text;
      }
      // Last resort: check all elements with a title or data attribute containing the token
      const withAttrs = Array.from(document.querySelectorAll('[title], [data-value], [data-token]'));
      for (const el of withAttrs) {
        const val = el.getAttribute('title') || el.getAttribute('data-value') || el.getAttribute('data-token');
        if (val && val.length > 20) return val;
      }
      return null;
    });

    if (apiToken) {
      console.log(`   🔑 API Token: ${apiToken.substring(0, 8)}...${apiToken.substring(apiToken.length - 4)}`);
      console.log(`   🏢 Organizer ID: ${organizerId}`);
      console.log('\n   ✅ Shotgun credentials extracted securely!');
      console.log('   Token was read directly from the DOM — never sent to any AI service.');
      console.log('   In production, this would be encrypted and stored immediately.');
    } else {
      console.log('\n   ⚠️  Token not found in DOM — check screenshot at /tmp/omnivera-shotgun-token.png');
    }

    // ─── Bonus: Pull events data while we're here ────────────────────────
    console.log('\n═══ Agent: Extracting events from Smartboard ═══\n');

    await page.goto('https://smartboard.shotgun.live/events');
    await page.waitForLoadState('domcontentloaded');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const eventsData = await stagehand.extract(
      'Extract all events visible on this page. For each event get the name, date, venue/location, ticket sales count, revenue, and status (draft, live, past, etc.).',
      z.object({
        events: z.array(z.object({
          name: z.string(),
          date: z.string().optional(),
          venue: z.string().optional(),
          tickets_sold: z.string().optional(),
          revenue: z.string().optional(),
          status: z.string().optional(),
        })),
      })
    );

    console.log(`   Found ${eventsData.events.length} events:\n`);
    for (const event of eventsData.events) {
      console.log(`   ${event.date || 'No date'} — ${event.name}`);
      if (event.venue) console.log(`      Venue: ${event.venue}`);
      if (event.tickets_sold) console.log(`      Tickets: ${event.tickets_sold}`);
      if (event.revenue) console.log(`      Revenue: ${event.revenue}`);
      if (event.status) console.log(`      Status: ${event.status}`);
      console.log('');
    }

    await page.screenshot({ path: '/tmp/omnivera-extracted.png', fullPage: true });

    // ─── Done ────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ Omnivera hybrid flow complete!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n🎯 What just happened:');
    console.log('   1. Cloud browser opened → you saw the real Shotgun login page');
    console.log('   2. YOU logged in (handled CAPTCHA, 2FA, whatever)');
    console.log('   3. Agent detected login success');
    console.log('   4. Agent navigated the dashboard and extracted data');
    console.log('   5. No credentials were stored — your login session was ephemeral');
    console.log('\nThis flow works on ANY platform. No API needed. No bot detection issues.');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);

    // Try to save a screenshot for debugging
    try {
      const page = stagehand.context.pages()[0];
      await page.screenshot({ path: '/tmp/omnivera-error.png', fullPage: true });
      console.error('   Debug screenshot: /tmp/omnivera-error.png');
    } catch (_) {}

  } finally {
    console.log('\n🧹 Closing session...');
    await stagehand.close();
    console.log('✅ Session destroyed');
  }
}

// ─── Helper: Wait for login ──────────────────────────────────────────────────

async function waitForLogin(
  page: any,
  successIndicators: string[],
  timeoutMs: number
): Promise<boolean> {
  const startTime = Date.now();
  let lastUrl = page.url();
  let dotCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const currentUrl = page.url();

    // Check if URL changed to a logged-in page
    if (currentUrl !== lastUrl) {
      console.log(`   URL changed: ${currentUrl}`);
      lastUrl = currentUrl;
    }

    // Check against success indicators
    for (const indicator of successIndicators) {
      if (currentUrl.includes(indicator)) {
        return true;
      }
    }

    // Also check if we're no longer on the login page
    if (!currentUrl.includes('/login') && !currentUrl.includes('/signin') && !currentUrl.includes('verification') && currentUrl !== 'about:blank') {
      // Give it a moment to settle, then check again
      await new Promise(resolve => setTimeout(resolve, 2000));
      const settledUrl = page.url();
      if (!settledUrl.includes('/login') && !settledUrl.includes('/signin') && !settledUrl.includes('verification')) {
        return true;
      }
    }

    // Progress dots
    dotCount++;
    if (dotCount % 5 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`   Still waiting... (${elapsed}s)`);
    }
  }

  return false;
}

main();
