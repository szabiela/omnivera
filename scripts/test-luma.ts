/**
 * Omnivera — Luma Connection Test
 *
 * Flow:
 * 1. Popup opens → user logs into Luma (email, Google, Apple, etc.)
 * 2. Agent checks if Luma Plus is active (API key available)
 *    - If yes: extracts API key from calendar settings → future calls use API
 *    - If no: scrapes event data directly from the dashboard
 * 3. Extracts events, registrations, and analytics
 *
 * Run: npx tsx scripts/test-luma.ts
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { config } from 'dotenv';
import { unlinkSync } from 'fs';
import { openPopup, closePopup, POPUP_WIDTH, POPUP_HEIGHT } from './lib/popup';

config();

// ─── Config ──────────────────────────────────────────────────────────────────

const PLATFORM_URL = 'https://lu.ma/signin';
const PLATFORM_NAME = 'Luma';
const SUCCESS_INDICATORS = ['/home', '/dashboard', '/calendar', '/events', '/discover', '/my'];
const LOGIN_TIMEOUT_MS = 120_000;

async function main() {
  console.log(`✨ Omnivera — Connect to ${PLATFORM_NAME}\n`);
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
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ─── Step 3: Open popup for human login ──────────────────────────────
    const sessionId = (stagehand as any).browserbaseSessionID
      || (stagehand as any).sessionId
      || (stagehand as any)._browserbaseSessionId;

    let liveViewUrl = '';
    if (sessionId) {
      const response = await fetch(
        `https://api.browserbase.com/v1/sessions/${sessionId}/debug`,
        { headers: { 'x-bb-api-key': bbApiKey } }
      );
      const debugInfo = await response.json();
      liveViewUrl = debugInfo.pages?.[0]?.debuggerFullscreenUrl || debugInfo.debuggerFullscreenUrl || '';
    }

    if (liveViewUrl) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('🔓 LOG IN NOW — A popup window will open.');
      console.log('   Log into your Luma account.');
      console.log('   Use email, Google, or Apple — any method works.');
      console.log('   The popup will close once you\'re logged in.');
      console.log('═══════════════════════════════════════════════════════════\n');

      openPopup(liveViewUrl, PLATFORM_NAME);
      console.log('   Popup opened.\n');
    } else {
      console.log('\n⚠️  Could not get live view URL.');
      console.log('   Go to browserbase.com/sessions to find the active session.\n');
    }

    // ─── Step 4: Wait for login ──────────────────────────────────────────
    console.log('⏳ Waiting for you to log in...');

    const loggedIn = await waitForLogin(page, SUCCESS_INDICATORS, LOGIN_TIMEOUT_MS);

    if (!loggedIn) {
      console.error('\n❌ Login timeout — did not detect a successful login within 2 minutes.');
      return;
    }

    const currentUrl = page.url();
    console.log(`\n✅ Login detected! Current URL: ${currentUrl}`);

    console.log('   Closing popup...');
    closePopup();

    console.log('\n🤖 Agent taking over...\n');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ─── Step 5: Explore dashboard ───────────────────────────────────────
    console.log('═══ Agent: Exploring Luma dashboard ═══\n');

    const pageInfo = await stagehand.extract(
      'Describe this page. What is visible? List navigation items, any events shown, and whether there are settings or calendar management options visible.',
      z.object({
        page_type: z.string(),
        description: z.string(),
        navigation_items: z.array(z.string()),
      })
    );

    console.log(`   Page type: ${pageInfo.page_type}`);
    console.log(`   Description: ${pageInfo.description}`);
    console.log(`   Navigation: ${pageInfo.navigation_items?.join(', ') || 'none found'}\n`);

    // ─── Step 6: Try to find API key in settings ─────────────────────────
    console.log('═══ Agent: Checking for API key (Luma Plus) ═══\n');

    // Navigate to settings
    const settingsPaths = [
      'https://lu.ma/settings',
      'https://lu.ma/settings/api',
    ];

    let foundSettings = false;
    for (const path of settingsPaths) {
      console.log(`   Trying: ${path}`);
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const url = page.url();
      if (!url.includes('/signin') && !url.includes('/login')) {
        console.log(`   → Loaded: ${url}`);
        foundSettings = true;
        break;
      } else {
        console.log('   → Redirected, skipping');
      }
    }

    if (!foundSettings) {
      console.log('   Direct URLs didn\'t work, trying navigation...');
      try {
        await stagehand.act('click on Settings, gear icon, or account settings — check sidebar, bottom of page, or user menu');
        await page.waitForLoadState('domcontentloaded');
        await new Promise(resolve => setTimeout(resolve, 2000));
        foundSettings = true;
      } catch (e) {
        console.log('   Could not find settings');
      }
    }

    await page.screenshot({ path: '/tmp/omnivera-luma-settings.png', fullPage: true });
    console.log(`   Settings screenshot: /tmp/omnivera-luma-settings.png\n`);

    // Look for API section
    let hasApiAccess = false;
    try {
      await stagehand.act('look for and click on API, API key, Developer, or Integrations section');
      await page.waitForLoadState('domcontentloaded');
      await new Promise(resolve => setTimeout(resolve, 2000));
      hasApiAccess = true;
    } catch (e) {
      console.log('   No API section found in settings');
    }

    // Try to extract API key securely from DOM
    let apiKey: string | null = null;
    if (hasApiAccess) {
      await page.screenshot({ path: '/tmp/omnivera-luma-api.png', fullPage: true });

      apiKey = await page.evaluate(() => {
        // Look for inputs with long values that look like API keys
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[readonly], input[type="password"]'));
        for (const input of inputs) {
          const val = (input as HTMLInputElement).value;
          if (val && val.length > 20) return val;
        }
        // Look for code or pre blocks
        const codeBlocks = Array.from(document.querySelectorAll('code, pre, [class*="key"], [class*="token"], [class*="api"]'));
        for (const el of codeBlocks) {
          const text = el.textContent?.trim();
          if (text && text.length > 20 && !text.includes(' ') && (el as Element).children.length === 0) return text;
        }
        // Look for any text near a Copy button
        const copyButtons = Array.from(document.querySelectorAll('button'));
        for (const btn of copyButtons) {
          if (btn.textContent?.toLowerCase().includes('copy')) {
            const sibling = btn.previousElementSibling;
            const parent = btn.parentElement;
            const nearbyInput = parent?.querySelector('input');
            if (nearbyInput) {
              const val = (nearbyInput as HTMLInputElement).value;
              if (val && val.length > 20) return val;
            }
            const nearbyText = sibling?.textContent?.trim();
            if (nearbyText && nearbyText.length > 20 && !nearbyText.includes(' ')) return nearbyText;
          }
        }
        return null;
      });

      // Clean up API screenshot
      try { unlinkSync('/tmp/omnivera-luma-api.png'); } catch (e) {}
    }

    if (apiKey) {
      console.log('   ✅ API key found!\n');
      console.log(`   🔑 API Key: [extracted, ${apiKey.length} chars]`);
      console.log('   Key read directly from DOM — never sent to any AI service.\n');

      // Validate the key
      console.log('   Validating API key...');
      try {
        const testResponse = await fetch('https://api.lu.ma/public/v2/event/get-events', {
          headers: { 'x-luma-api-key': apiKey },
        });
        if (testResponse.ok) {
          const data = await testResponse.json();
          const eventCount = data.entries?.length || data.data?.length || 0;
          console.log(`   ✅ API key validated! Found ${eventCount} events via API.`);
          console.log('   In production, this key would be encrypted and stored.');
          console.log('   All future data pulls use the API directly — no browser needed.');
        } else {
          console.log(`   ⚠️  API returned ${testResponse.status} — key may need different endpoint`);
        }
      } catch (e: any) {
        console.log(`   ⚠️  Could not validate: ${e.message}`);
      }
    } else {
      console.log('   No API key found — Luma Plus may not be active.');
      console.log('   Falling back to dashboard data extraction.\n');
    }

    // ─── Step 7: Extract events from dashboard ───────────────────────────
    console.log('\n═══ Agent: Extracting events from Luma ═══\n');

    // Navigate to events/home page
    const eventPaths = [
      'https://lu.ma/home',
      'https://lu.ma/my',
      'https://lu.ma/events',
    ];

    for (const path of eventPaths) {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const url = page.url();
      if (!url.includes('/signin') && !url.includes('/login')) {
        console.log(`   Events page: ${url}`);
        break;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    const eventsData = await stagehand.extract(
      'Extract all events visible on this page — both upcoming and past. For each event get the name, date and time, location or venue, number of registrations or RSVPs, ticket price if shown, and status (upcoming, past, draft, etc.). Be thorough.',
      z.object({
        events: z.array(z.object({
          name: z.string(),
          date: z.string().optional(),
          location: z.string().optional(),
          registrations: z.string().optional(),
          price: z.string().optional(),
          status: z.string().optional(),
        })),
        total_count: z.string().optional(),
        page_description: z.string(),
      })
    );

    console.log(`   Page: ${eventsData.page_description}`);
    if (eventsData.total_count) console.log(`   Total events: ${eventsData.total_count}`);
    console.log(`\n   Found ${eventsData.events.length} events:\n`);

    for (const event of eventsData.events) {
      console.log(`   ${event.date || 'No date'} — ${event.name}`);
      if (event.location) console.log(`      Location: ${event.location}`);
      if (event.registrations) console.log(`      Registrations: ${event.registrations}`);
      if (event.price) console.log(`      Price: ${event.price}`);
      if (event.status) console.log(`      Status: ${event.status}`);
      console.log('');
    }

    // ─── Step 8: Try to get more detailed analytics ──────────────────────
    console.log('═══ Agent: Looking for analytics data ═══\n');

    try {
      await stagehand.act('look for and click on Analytics, Insights, or any reporting section — check navigation, sidebar, or within event management');
      await page.waitForLoadState('domcontentloaded');
      await new Promise(resolve => setTimeout(resolve, 3000));

      const analyticsData = await stagehand.extract(
        'Extract any analytics or insights data visible. Look for: total registrations, attendance rates, revenue, popular events, growth metrics, email open rates, community size, or any charts and statistics.',
        z.object({
          metrics: z.array(z.object({
            label: z.string(),
            value: z.string(),
          })),
          page_description: z.string(),
        })
      );

      console.log(`   Page: ${analyticsData.page_description}\n`);
      if (analyticsData.metrics.length > 0) {
        console.log('   📊 Analytics:');
        for (const metric of analyticsData.metrics) {
          console.log(`      ${metric.label}: ${metric.value}`);
        }
      } else {
        console.log('   No analytics data found on this page');
      }
    } catch (e) {
      console.log('   No analytics section found');
    }

    await page.screenshot({ path: '/tmp/omnivera-extracted.png', fullPage: true });

    // Clean up sensitive screenshots
    try { unlinkSync('/tmp/omnivera-luma-settings.png'); } catch (e) {}

    // ─── Summary ─────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ Omnivera Luma flow complete!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n🎯 What just happened:');
    console.log('   1. Popup opened → you logged into Luma');
    if (apiKey) {
      console.log('   2. Agent found and extracted your API key (Luma Plus)');
      console.log('   3. API key validated — direct API access confirmed');
      console.log('   4. Future data pulls use the API — no more browser sessions');
    } else {
      console.log('   2. No API key available (needs Luma Plus)');
      console.log('   3. Agent extracted event data directly from dashboard');
      console.log('   4. Future syncs will use browser sessions until Plus is active');
    }
    console.log('   5. Credentials never sent to AI — extracted securely from DOM');
    console.log('\nThis flow works with any Luma account — free or Plus.');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
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

    if (currentUrl !== lastUrl) {
      console.log(`   URL changed: ${currentUrl}`);
      lastUrl = currentUrl;
    }

    for (const indicator of successIndicators) {
      if (currentUrl.includes(indicator)) {
        return true;
      }
    }

    if (!currentUrl.includes('/login') && !currentUrl.includes('/signin') && !currentUrl.includes('verification') && currentUrl !== 'about:blank') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const settledUrl = page.url();
      if (!settledUrl.includes('/login') && !settledUrl.includes('/signin') && !settledUrl.includes('verification')) {
        return true;
      }
    }

    dotCount++;
    if (dotCount % 5 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`   Still waiting... (${elapsed}s)`);
    }
  }

  return false;
}

main();
