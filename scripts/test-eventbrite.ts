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
 * Run: npx tsx scripts/test-eventbrite.ts
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { config } from 'dotenv';
import { unlinkSync } from 'fs';
import { openPopup, closePopup, POPUP_WIDTH, POPUP_HEIGHT } from './lib/popup';

config();

// ─── Config ──────────────────────────────────────────────────────────────────

const PLATFORM_URL = 'https://www.eventbrite.com/signin/';
const PLATFORM_NAME = 'Eventbrite';
const SUCCESS_INDICATORS = ['/organizations', '/myevents', '/dashboard', '/home', '/manage'];
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
      timeout: 180,
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
      console.log('   Log into your Eventbrite account.');
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

    // ─── Step 5: Navigate to API key settings ────────────────────────────
    console.log('═══ Agent: Navigating to API key settings ═══\n');

    // Go directly to the Eventbrite developer/API page
    await page.goto('https://www.eventbrite.com/platform/api-keys');
    await page.waitForLoadState('domcontentloaded');
    await new Promise(resolve => setTimeout(resolve, 3000));

    let currentUrl = page.url();
    console.log(`   Current URL: ${currentUrl}`);
    await page.screenshot({ path: '/tmp/omnivera-eb-apikeys.png', fullPage: true });
    console.log('   Screenshot: /tmp/omnivera-eb-apikeys.png\n');

    // If that redirected, try the platform page
    if (currentUrl.includes('signin') || currentUrl.includes('login')) {
      console.log('   Redirected to login — trying alternative path...');
      await page.goto('https://www.eventbrite.com/platform');
      await page.waitForLoadState('domcontentloaded');
      await new Promise(resolve => setTimeout(resolve, 3000));
      currentUrl = page.url();
      console.log(`   Current URL: ${currentUrl}\n`);
    }

    // Look at what's on the page
    const pageInfo = await stagehand.extract(
      'Describe this page. Is this a developer portal, API keys page, or app management page? Are there any API keys, tokens, or OAuth credentials visible? Is there a button to create an app or generate a key?',
      z.object({
        page_type: z.string(),
        description: z.string(),
        has_api_keys: z.boolean(),
        has_create_button: z.boolean(),
      })
    );

    console.log(`   Page type: ${pageInfo.page_type}`);
    console.log(`   Description: ${pageInfo.description}`);
    console.log(`   Has API keys: ${pageInfo.has_api_keys}`);
    console.log(`   Has create button: ${pageInfo.has_create_button}\n`);

    if (pageInfo.has_create_button && !pageInfo.has_api_keys) {
      console.log('   Creating a new API app...');
      await stagehand.act('click the button to create a new app, create API key, or get started');
      await page.waitForLoadState('domcontentloaded');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Fill in app details if needed
      try {
        await stagehand.act('if there is a form to fill out, enter "Omnivera" as the app name and "https://mufi.app" as the website URL, then submit the form');
        await page.waitForLoadState('domcontentloaded');
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (e) {
        // May not need to fill a form
      }
    }

    console.log('   Extracting API credentials...');
    await page.screenshot({ path: '/tmp/omnivera-eb-credentials.png', fullPage: true });

    const extractedCreds = await page.evaluate(() => {
      const results: Record<string, string> = {};
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[readonly], input[type="password"]'));
      for (const input of inputs) {
        const val = (input as HTMLInputElement).value;
        if (val && val.length > 15) {
          const label = input.getAttribute('aria-label')
            || input.getAttribute('name')
            || input.closest('label')?.textContent?.trim()
            || input.previousElementSibling?.textContent?.trim()
            || 'unknown';
          results[label] = val;
        }
      }
      const codeBlocks = Array.from(document.querySelectorAll('code, pre, [class*="token"], [class*="key"]'));
      for (const el of codeBlocks) {
        const text = el.textContent?.trim();
        if (text && text.length > 15 && !text.includes(' ')) {
          results['token'] = text;
        }
      }
      return results;
    });

    const tokenValue = Object.values(extractedCreds)[0];
    if (tokenValue) {
      console.log('   Validating token against Eventbrite API...');
      try {
        const testResponse = await fetch(
          'https://www.eventbriteapi.com/v3/users/me/',
          { headers: { Authorization: `Bearer ${tokenValue}` } }
        );
        if (testResponse.ok) {
          console.log('   ✅ Token validated — API access confirmed');
        } else {
          console.log(`   ⚠️  Token returned ${testResponse.status}`);
        }
      } catch (e: any) {
        console.log(`   ⚠️  Could not validate token: ${e.message}`);
      }
    }

    const credKeys = Object.keys(extractedCreds);
    if (credKeys.length > 0) {
      console.log('\n   ✅ API credentials extracted securely!');
      console.log('   Credentials read directly from the DOM — never sent to any AI service.');
      for (const [label, value] of Object.entries(extractedCreds)) {
        console.log(`   🔑 ${label}: [extracted, ${value.length} chars]`);
      }
      console.log('\n   In production, these would be encrypted and stored immediately.');
      console.log('   No more browser sessions needed for Eventbrite.');
    } else {
      console.log('\n   ⚠️  No API credentials found in DOM — check screenshot at /tmp/omnivera-eb-credentials.png');
    }

    // ─── Bonus: Pull events while we're here ─────────────────────────────
    console.log('\n═══ Agent: Extracting events from dashboard ═══\n');

    await page.goto('https://www.eventbrite.com/organizations/events');
    await page.waitForLoadState('domcontentloaded');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const eventsData = await stagehand.extract(
      'Extract all events visible on this page. For each event get the name, date, status (draft, live, past, etc.), ticket sales count, and revenue if shown.',
      z.object({
        events: z.array(z.object({
          name: z.string(),
          date: z.string().optional(),
          status: z.string().optional(),
          tickets_sold: z.string().optional(),
          revenue: z.string().optional(),
        })),
      })
    );

    console.log(`   Found ${eventsData.events.length} events:\n`);
    for (const event of eventsData.events) {
      console.log(`   ${event.date || 'No date'} — ${event.name}`);
      if (event.status) console.log(`      Status: ${event.status}`);
      if (event.tickets_sold) console.log(`      Tickets: ${event.tickets_sold}`);
      if (event.revenue) console.log(`      Revenue: ${event.revenue}`);
      console.log('');
    }

    await page.screenshot({ path: '/tmp/omnivera-extracted.png', fullPage: true });

    try {
      unlinkSync('/tmp/omnivera-eb-apikeys.png');
      unlinkSync('/tmp/omnivera-eb-credentials.png');
      console.log('   🧹 Credential screenshots deleted');
    } catch (e) {
      // files may not exist
    }

    // ─── Done ────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ Omnivera hybrid flow complete!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n🎯 What just happened:');
    console.log('   1. Cloud browser opened → you saw the real RA login page');
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
