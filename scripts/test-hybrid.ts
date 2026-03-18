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
import { openPopup, closePopup, POPUP_WIDTH, POPUP_HEIGHT } from './lib/popup';

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
    verbose: 0,
    browserbaseSessionCreateParams: {
      proxies: true,
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
      console.log('🔓 LOG IN NOW — A popup window will open.');
      console.log('   Log into your RA account manually.');
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

    const currentUrl = page.url();
    console.log(`\n✅ Login detected! Current URL: ${currentUrl}`);

    console.log('   Closing popup...');
    closePopup();

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

    // ─── Step 6: Navigate to RA Pro events list ──────────────────────────
    console.log('═══ Agent: Finding RA Pro events list ═══\n');

    const proPages = [
      'https://ra.co/pro/events',
      'https://ra.co/pro',
      'https://ra.co/pro/events/past',
    ];

    let eventsListUrl = '';
    for (const url of proPages) {
      console.log(`   Trying: ${url}`);
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 3000));

      const currentUrl = page.url();
      if (currentUrl.includes('404') || currentUrl === 'https://ra.co/') {
        console.log('   → 404 or redirect, skipping\n');
        continue;
      }

      console.log(`   → Loaded: ${currentUrl}\n`);
      eventsListUrl = currentUrl;
      break;
    }

    // Debug: screenshot the events list page and dump link info
    await page.screenshot({ path: '/tmp/omnivera-ra-events-list.png', fullPage: true });
    console.log('   Screenshot saved to /tmp/omnivera-ra-events-list.png');

    const allLinks = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      return anchors.map(a => ({
        href: a.getAttribute('href') || '',
        text: (a.textContent || '').trim().substring(0, 100),
      }));
    });
    console.log(`\n   All links on page (${allLinks.length}):`);
    for (const link of allLinks) {
      if (link.href) {
        console.log(`   [${link.href}] → ${link.text}`);
      }
    }
    console.log('');

    if (!eventsListUrl) {
      console.log('   Could not find RA Pro events list. Trying to navigate from RA Pro...');
      await page.goto('https://ra.co/pro');
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 3000));

      try {
        await stagehand.act('click on Events or My Events or any link to event management');
        await page.waitForLoadState('networkidle');
        await new Promise(resolve => setTimeout(resolve, 3000));
        eventsListUrl = page.url();
        console.log(`   → Navigated to: ${eventsListUrl}\n`);
      } catch (e) {
        console.log('   Could not find events list');
      }
    }

    // ─── Step 7: Extract all event data directly from the list page ──────
    console.log('═══ Agent: Extracting event data from list page ═══\n');

    const eventsData = await stagehand.extract(
      'Extract every event listed on this page. For each event get: the event name/title, the full date, the venue name, the city, and the number of tickets sold (shown as "X tickets sold"). There should be about 13 events spanning from 2016 to 2025.',
      z.object({
        total_events_submitted: z.string().optional(),
        total_revisions: z.string().optional(),
        access_level: z.string().optional(),
        events: z.array(z.object({
          name: z.string(),
          date: z.string(),
          venue: z.string(),
          city: z.string(),
          tickets_sold: z.string(),
        })),
      })
    );

    console.log(`   Account stats:`);
    if (eventsData.total_events_submitted) console.log(`   Events submitted: ${eventsData.total_events_submitted}`);
    if (eventsData.total_revisions) console.log(`   Revisions: ${eventsData.total_revisions}`);
    if (eventsData.access_level) console.log(`   Access level: ${eventsData.access_level}`);

    console.log(`\n   📅 Found ${eventsData.events.length} events:\n`);
    for (const event of eventsData.events) {
      console.log(`   ${event.date} — ${event.name}`);
      console.log(`      Venue: ${event.venue}, ${event.city}`);
      console.log(`      Tickets sold: ${event.tickets_sold}`);
      console.log('');
    }

    // ─── Step 8: Click into first event for detailed data ────────────────
    console.log('═══ Agent: Getting detailed data for first event ═══\n');

    try {
      await stagehand.act('click on the first "Event management" link on the page');
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 3000));

      const detailUrl = page.url();
      console.log(`   Navigated to: ${detailUrl}\n`);

      // Try to find and click overview tab
      try {
        await stagehand.act('click on Overview tab or link if visible');
        await page.waitForLoadState('networkidle');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        // may already be on overview
      }

      await page.screenshot({ path: '/tmp/omnivera-ra-event-detail.png', fullPage: true });
      console.log('   Detail page screenshot: /tmp/omnivera-ra-event-detail.png');

      const detailData = await stagehand.extract(
        'Extract ALL data from this event management/overview page. Look for: event name, date, time, venue, full address, ticket types with prices, tickets sold per type, total tickets sold, total revenue, gross revenue, net revenue, fees, guest list count, attendance, lineup/artists, event description, event status, any charts or graphs, and any other data or statistics visible.',
        z.object({
          event_name: z.string(),
          date: z.string().optional(),
          venue: z.string().optional(),
          status: z.string().optional(),
          total_tickets_sold: z.string().optional(),
          total_revenue: z.string().optional(),
          net_revenue: z.string().optional(),
          guest_list_count: z.string().optional(),
          attendance: z.string().optional(),
          lineup: z.array(z.string()).optional(),
          ticket_types: z.array(z.object({
            name: z.string(),
            price: z.string().optional(),
            sold: z.string().optional(),
          })).optional(),
          all_visible_data: z.array(z.object({
            label: z.string(),
            value: z.string(),
          })).optional(),
          page_description: z.string(),
        })
      );

      console.log(`\n   Event: ${detailData.event_name}`);
      console.log(`   Page: ${detailData.page_description}`);
      if (detailData.date) console.log(`   Date: ${detailData.date}`);
      if (detailData.venue) console.log(`   Venue: ${detailData.venue}`);
      if (detailData.status) console.log(`   Status: ${detailData.status}`);
      if (detailData.total_tickets_sold) console.log(`   Tickets sold: ${detailData.total_tickets_sold}`);
      if (detailData.total_revenue) console.log(`   Revenue: ${detailData.total_revenue}`);
      if (detailData.net_revenue) console.log(`   Net revenue: ${detailData.net_revenue}`);
      if (detailData.guest_list_count) console.log(`   Guest list: ${detailData.guest_list_count}`);
      if (detailData.lineup && detailData.lineup.length > 0) console.log(`   Lineup: ${detailData.lineup.join(', ')}`);
      if (detailData.ticket_types && detailData.ticket_types.length > 0) {
        console.log(`   Ticket types:`);
        for (const tt of detailData.ticket_types) {
          console.log(`      - ${tt.name}: ${tt.price || 'N/A'} (sold: ${tt.sold || '?'})`);
        }
      }
      if (detailData.all_visible_data && detailData.all_visible_data.length > 0) {
        console.log(`   All data points:`);
        for (const item of detailData.all_visible_data) {
          console.log(`      ${item.label}: ${item.value}`);
        }
      }
    } catch (e: any) {
      console.log(`   Could not access event detail: ${e.message}`);
    }

    await page.screenshot({ path: '/tmp/omnivera-extracted.png', fullPage: true });

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
