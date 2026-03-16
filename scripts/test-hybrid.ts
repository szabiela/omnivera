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
 * Run: npx tsx scripts/test-hybrid.ts
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { config } from 'dotenv';
import { exec } from 'child_process';
import { writeFileSync } from 'fs';

config();

// ─── Config ──────────────────────────────────────────────────────────────────

const PLATFORM_URL = 'https://ra.co/login';
const PLATFORM_NAME = 'Resident Advisor';
const SUCCESS_INDICATORS = ['/feed', '/promoter', '/profile', '/events', '/pro'];
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
    verbose: 0, // Quiet during user login
    browserbaseSessionCreateParams: {
      proxies: true,
    },
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    console.log('✅ Cloud browser ready\n');

    // ─── Step 2: Navigate to login page ──────────────────────────────────
    console.log(`📍 Navigating to ${PLATFORM_NAME} login...`);
    await page.goto(PLATFORM_URL);
    await page.waitForLoadState('networkidle');
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
      console.log('🔓 LOG IN NOW — A browser window will open.');
      console.log('   Log into your RA account manually.');
      console.log('   Handle any CAPTCHAs or 2FA yourself.');
      console.log('   The agent will take over once you\'re logged in.');
      console.log('═══════════════════════════════════════════════════════════\n');

      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Omnivera — Connect to ${PLATFORM_NAME}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a1a; font-family: system-ui, -apple-system, sans-serif; }
    .header {
      height: 80px;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header-left h1 { color: #fff; font-size: 18px; font-weight: 600; }
    .header-left p { color: #888; font-size: 13px; margin-top: 4px; }
    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #4ade80;
      font-size: 13px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background: #4ade80;
      border-radius: 50%;
    }
    iframe { width: 100%; height: calc(100vh - 80px); border: none; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Connect to ${PLATFORM_NAME}</h1>
      <p>Log in below. The agent will take over once you're authenticated.</p>
    </div>
    <div class="status"><div class="status-dot"></div>Live session</div>
  </div>
  <iframe src="${liveViewUrl}"></iframe>
</body>
</html>`;

      writeFileSync('/tmp/omnivera-connect.html', htmlContent);

      if (process.platform === 'darwin') {
        exec(`open -a "Google Chrome" --args --app=file:///tmp/omnivera-connect.html --window-size=500,700`, (err) => {
          if (err) {
            exec('open /tmp/omnivera-connect.html');
          }
        });
      } else if (process.platform === 'win32') {
        exec('start /tmp/omnivera-connect.html');
      } else {
        exec('xdg-open /tmp/omnivera-connect.html');
      }

      console.log(`   Live view: ${liveViewUrl}\n`);
    } else {
      console.log('\n⚠️  Could not get live view URL.');
      console.log('   Go to browserbase.com/sessions to find the active session');
      console.log('   and interact with it manually.\n');
    }

    // ─── Step 4: Wait for user to log in ─────────────────────────────────
    console.log('⏳ Waiting for you to log in...');

    const loggedIn = await waitForLogin(page, SUCCESS_INDICATORS, LOGIN_TIMEOUT_MS);

    if (!loggedIn) {
      console.error('\n❌ Login timeout — did not detect a successful login within 2 minutes.');
      console.error('   The agent needs you to be on a dashboard/feed page to continue.');
      return;
    }

    const currentUrl = page.url();
    console.log(`\n✅ Login detected! Current URL: ${currentUrl}`);
    console.log('\n🤖 Agent taking over...\n');

    // Small pause to let the page settle
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ─── Step 5: Agent explores the dashboard ────────────────────────────
    console.log('═══ Agent: Exploring dashboard ═══\n');

    // First, understand what page we're on and what's available
    const pageOverview = await stagehand.extract(
      'Describe this page. What is visible? List all navigation links, menu items, and any data shown. Is this a feed, dashboard, profile, or something else?',
      z.object({
        page_type: z.string(),
        description: z.string(),
        navigation_items: z.array(z.string()),
        visible_data_types: z.array(z.string()),
      })
    );

    if (!pageOverview) {
      console.log('   Could not extract page data');
    }

    console.log(`   Page type: ${pageOverview.page_type}`);
    console.log(`   Description: ${pageOverview.description}`);
    console.log(`   Navigation: ${pageOverview.navigation_items?.join(', ')}`);
    console.log(`   Visible data: ${pageOverview.visible_data_types?.join(', ')}\n`);

    // ─── Step 6: Navigate to promoter/events area ────────────────────────
    console.log('═══ Agent: Looking for promoter/events data ═══\n');

    try {
      await stagehand.act('look for and click on a link to promoter dashboard, my events, RA Pro, event management, or any section related to managing events — check the main navigation, user menu, profile dropdown, or sidebar');
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (e) {
      console.log('   No promoter link found in nav, trying direct URL...');
      await page.goto('https://ra.co/promoter');
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const afterNavUrl = page.url();
    console.log(`   Now at: ${afterNavUrl}\n`);

    // ─── Step 7: Extract whatever data is available ──────────────────────
    console.log('═══ Agent: Extracting data ═══\n');

    const pageData = await stagehand.extract(
      'Extract ALL data visible on this page. Include: any events listed (with names, dates, venues, ticket counts, revenue), any analytics or statistics, any guest/attendee information, any financial data. Be thorough — capture every data point you can see.',
      z.object({
        page_url: z.string(),
        page_type: z.string(),
        events: z.array(z.object({
          name: z.string(),
          date: z.string().optional(),
          venue: z.string().optional(),
          tickets_sold: z.string().optional(),
          revenue: z.string().optional(),
          status: z.string().optional(),
        })).optional(),
        statistics: z.array(z.object({
          label: z.string(),
          value: z.string(),
        })).optional(),
        other_data: z.array(z.object({
          type: z.string(),
          content: z.string(),
        })).optional(),
      })
    );

    if (!pageData) {
      console.log('   Could not extract page data');
    }

    console.log(`   Page: ${pageData.page_type} (${pageData.page_url})\n`);

    if (pageData.events && pageData.events.length > 0) {
      console.log(`   📅 Events found: ${pageData.events.length}`);
      for (const event of pageData.events) {
        console.log(`      - ${event.name}`);
        if (event.date) console.log(`        Date: ${event.date}`);
        if (event.venue) console.log(`        Venue: ${event.venue}`);
        if (event.tickets_sold) console.log(`        Tickets: ${event.tickets_sold}`);
        if (event.revenue) console.log(`        Revenue: ${event.revenue}`);
        if (event.status) console.log(`        Status: ${event.status}`);
      }
    }

    if (pageData.statistics && pageData.statistics.length > 0) {
      console.log(`\n   📊 Statistics:`);
      for (const stat of pageData.statistics) {
        console.log(`      ${stat.label}: ${stat.value}`);
      }
    }

    if (pageData.other_data && pageData.other_data.length > 0) {
      console.log(`\n   📋 Other data:`);
      for (const item of pageData.other_data) {
        console.log(`      ${item.type}: ${item.content}`);
      }
    }

    // Save a screenshot of what we extracted
    await page.screenshot({ path: '/tmp/omnivera-extracted.png', fullPage: true });
    console.log('\n   Screenshot saved to /tmp/omnivera-extracted.png');

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
    if (!currentUrl.includes('/login') && !currentUrl.includes('verification') && currentUrl !== 'about:blank') {
      // Give it a moment to settle, then check again
      await new Promise(resolve => setTimeout(resolve, 2000));
      const settledUrl = page.url();
      if (!settledUrl.includes('/login') && !settledUrl.includes('verification')) {
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
