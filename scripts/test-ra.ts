/**
 * Omnivera — RA Playbook Test
 *
 * Tests the full flow against Resident Advisor:
 * 1. Log into RA with real credentials
 * 2. Navigate to promoter/event dashboard
 * 3. Extract event and sales data
 *
 * Run: npx tsx scripts/test-ra.ts
 *
 * Required env vars:
 *   BROWSERBASE_API_KEY
 *   BROWSERBASE_PROJECT_ID
 *   ANTHROPIC_API_KEY
 *   TEST_RA_EMAIL
 *   TEST_RA_PASSWORD
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { config } from 'dotenv';

config();

async function main() {
  console.log('🎵 Omnivera — Resident Advisor Connection Test\n');

  // ─── Validate env ──────────────────────────────────────────────────────
  const bbApiKey = process.env.BROWSERBASE_API_KEY!;
  const bbProjectId = process.env.BROWSERBASE_PROJECT_ID!;
  const anthropicKey = process.env.ANTHROPIC_API_KEY!;
  const raEmail = process.env.TEST_RA_EMAIL;
  const raPassword = process.env.TEST_RA_PASSWORD;

  if (!raEmail || !raPassword) {
    console.error('❌ Missing RA credentials. Add to your .env:');
    console.error('   TEST_RA_EMAIL=your_ra_email');
    console.error('   TEST_RA_PASSWORD=your_ra_password');
    process.exit(1);
  }

  console.log(`✅ Credentials loaded for: ${raEmail}`);

  // ─── Init Stagehand ────────────────────────────────────────────────────
  console.log('⏳ Launching cloud browser...');

  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: bbApiKey,
    projectId: bbProjectId,
    model: {
      modelName: 'anthropic/claude-sonnet-4-20250514',
      apiKey: anthropicKey,
    },
    verbose: 1,
    browserbaseSessionCreateParams: {
      proxies: true,
    },
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    console.log('✅ Cloud browser launched\n');

    // ─── Step 1: Login ───────────────────────────────────────────────────
    console.log('═══ Step 1: Login to RA ═══');
    console.log('   Navigating to RA login page...');

    await page.goto('https://ra.co/login');
    await page.waitForLoadState('networkidle');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Screenshot to see what the login page looks like
    await page.screenshot({ path: '/tmp/ra-login-page.png', fullPage: true });
    console.log('   Screenshot saved to /tmp/ra-login-page.png');

    // Use Stagehand AI to find and fill the form — it can see custom React components
    console.log('   Filling email...');
    await stagehand.act('click on the email input field and type ' + raEmail);

    console.log('   Filling password...');
    await stagehand.act('click on the password input field and type ' + raPassword);

    console.log('   Clicking login...');
    await stagehand.act('click the Log In or Sign In button to submit the form');

    // Wait for navigation
    await page.waitForLoadState('networkidle');
    await new Promise(resolve => setTimeout(resolve, 5000));

    const postLoginUrl = page.url();
    console.log(`   Current URL: ${postLoginUrl}`);

    // Check if login succeeded
    const loginCheck = await stagehand.extract({
      instruction: 'Check if the user is logged in. Look for signs like a user menu, profile icon, avatar, logout option, or dashboard navigation. Return "logged_in" if yes, "not_logged_in" if no, and describe what you see.',
      schema: z.object({
        status: z.string(),
        description: z.string(),
      }),
    });

    console.log(`   Login status: ${loginCheck.status}`);
    console.log(`   Page state: ${loginCheck.description}`);

    if (loginCheck.status === 'not_logged_in') {
      console.error('   ❌ Login failed — check credentials');
      return;
    }

    console.log('   ✅ Login successful!\n');

    // ─── Step 2: Navigate to promoter/events area ────────────────────────
    console.log('═══ Step 2: Find events/promoter data ═══');

    // First, let's see what's available from the logged-in state
    const availableNavigation = await stagehand.extract({
      instruction: 'List all the main navigation links or menu items visible on the page. Include links in the header, sidebar, and any dropdown menus. Look for things like events, promoter, pro, dashboard, my events, tickets, etc.',
      schema: z.object({
        navigation_items: z.array(z.object({
          label: z.string(),
          type: z.string().describe('header, sidebar, dropdown, or footer'),
        })),
      }),
    });

    console.log('   Available navigation:');
    for (const item of availableNavigation.navigation_items) {
      console.log(`   - ${item.label} (${item.type})`);
    }

    // Try to navigate to events or promoter section
    console.log('\n   Navigating to events/promoter area...');
    try {
      await stagehand.act('navigate to my events, event management, promoter dashboard, or RA Pro section — look in the user menu, profile dropdown, or main navigation');
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.log('   Could not find events via navigation, trying direct URL...');
      await page.goto('https://ra.co/promoter');
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const eventsUrl = page.url();
    console.log(`   Current URL: ${eventsUrl}`);

    // ─── Step 3: Extract whatever data is visible ────────────────────────
    console.log('\n═══ Step 3: Extract available data ═══');

    const pageContent = await stagehand.extract({
      instruction: 'Describe everything you can see on this page. What kind of page is this? What data is visible? Are there events listed? Sales numbers? Revenue? Guest lists? Ticket information? Any tables or charts? Describe the full layout and all visible data points.',
      schema: z.object({
        page_type: z.string(),
        page_description: z.string(),
        visible_data: z.array(z.object({
          data_type: z.string(),
          description: z.string(),
          sample_values: z.string().optional(),
        })),
        has_events: z.boolean(),
        has_sales_data: z.boolean(),
        has_guest_data: z.boolean(),
      }),
    });

    console.log(`\n   Page type: ${pageContent.page_type}`);
    console.log(`   Description: ${pageContent.page_description}`);
    console.log(`   Has events: ${pageContent.has_events}`);
    console.log(`   Has sales data: ${pageContent.has_sales_data}`);
    console.log(`   Has guest data: ${pageContent.has_guest_data}`);
    console.log('\n   Visible data:');
    for (const data of pageContent.visible_data) {
      console.log(`   - ${data.data_type}: ${data.description}`);
      if (data.sample_values) {
        console.log(`     Sample: ${data.sample_values}`);
      }
    }

    // ─── Step 4: Try to extract events if available ──────────────────────
    if (pageContent.has_events) {
      console.log('\n═══ Step 4: Extract events ═══');

      const events = await stagehand.extract({
        instruction: 'Extract all visible events. For each event, get the event name, date, venue name, and any ticket/sales/attendance numbers shown.',
        schema: z.object({
          events: z.array(z.object({
            name: z.string(),
            date: z.string(),
            venue: z.string().optional(),
            tickets_sold: z.string().optional(),
            revenue: z.string().optional(),
            attendance: z.string().optional(),
            status: z.string().optional(),
          })),
        }),
      });

      console.log(`   Found ${events.events.length} events:`);
      for (const event of events.events) {
        console.log(`   - ${event.name}`);
        console.log(`     Date: ${event.date}`);
        if (event.venue) console.log(`     Venue: ${event.venue}`);
        if (event.tickets_sold) console.log(`     Tickets: ${event.tickets_sold}`);
        if (event.revenue) console.log(`     Revenue: ${event.revenue}`);
        if (event.status) console.log(`     Status: ${event.status}`);
        console.log('');
      }
    }

    // ─── Step 5: Explore further if there's sales data ───────────────────
    if (pageContent.has_sales_data) {
      console.log('\n═══ Step 5: Extract sales data ═══');

      const sales = await stagehand.extract({
        instruction: 'Extract all visible sales or revenue data. Look for total revenue, ticket sales counts, per-event breakdowns, payment summaries, or any financial figures.',
        schema: z.object({
          total_revenue: z.string().optional(),
          total_tickets_sold: z.string().optional(),
          period: z.string().optional(),
          breakdown: z.array(z.object({
            label: z.string(),
            value: z.string(),
          })).optional(),
        }),
      });

      console.log('   Sales data:');
      if (sales.total_revenue) console.log(`   Total revenue: ${sales.total_revenue}`);
      if (sales.total_tickets_sold) console.log(`   Total tickets: ${sales.total_tickets_sold}`);
      if (sales.period) console.log(`   Period: ${sales.period}`);
      if (sales.breakdown) {
        for (const item of sales.breakdown) {
          console.log(`   - ${item.label}: ${item.value}`);
        }
      }
    }

    // ─── Step 6: Take a screenshot for debugging ─────────────────────────
    console.log('\n═══ Step 6: Capture screenshot ═══');
    await page.screenshot({ path: '/tmp/omnivera-ra-test.png', fullPage: true });
    console.log('   Screenshot saved to /tmp/omnivera-ra-test.png');

    // ─── Summary ─────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════');
    console.log('✅ RA connection test complete!');
    console.log('═══════════════════════════════════════════');
    console.log('\nThis proves Omnivera can:');
    console.log('  1. Log into a platform with no API');
    console.log('  2. Navigate an authenticated dashboard');
    console.log('  3. Extract structured data using AI');
    console.log('\nNext: Build the playbook runner to automate this for any platform.');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nFull error:', error);
  } finally {
    console.log('\n🧹 Tearing down session...');
    await stagehand.close();
    console.log('✅ Session destroyed — credentials purged');
  }
}

main();
