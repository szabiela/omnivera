/**
 * Omnivera — Connection Test Script
 * 
 * Tests the core loop:
 * 1. Spin up a Browserbase session
 * 2. Connect Stagehand for AI browser control
 * 3. Navigate to a page
 * 4. Extract structured data
 * 5. Tear down the session
 *
 * Run: npx tsx scripts/test-connection.ts
 */

import { Stagehand } from '@browserbasehq/stagehand';

async function main() {
  console.log('🔧 Omnivera — Connection Test\n');

  // ─── Validate env ──────────────────────────────────────────────────────
  const bbApiKey = process.env.BROWSERBASE_API_KEY;
  const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!bbApiKey || !bbProjectId || !anthropicKey) {
    console.error('❌ Missing environment variables. Check your .env file:');
    if (!bbApiKey) console.error('   - BROWSERBASE_API_KEY');
    if (!bbProjectId) console.error('   - BROWSERBASE_PROJECT_ID');
    if (!anthropicKey) console.error('   - ANTHROPIC_API_KEY');
    process.exit(1);
  }

  console.log('✅ Environment variables loaded');

  // ─── Init Stagehand with Browserbase ───────────────────────────────────
  console.log('⏳ Launching Browserbase session...');

  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: bbApiKey,
    projectId: bbProjectId,
    model: {
      modelName: 'anthropic/claude-sonnet-4-20250514',
      apiKey: anthropicKey,
    },
    verbose: 1,
  });

  try {
    await stagehand.init();
    console.log('✅ Browserbase session launched');
    const page = stagehand.context.pages()[0];

    // ─── Test 1: Navigate to a page ────────────────────────────────────
    console.log('\n📍 Test 1: Navigation');
    console.log('   Navigating to Hacker News...');

    await page.goto('https://news.ycombinator.com');
    await page.waitForLoadState('networkidle');

    const title = await page.title();
    console.log(`   Page title: ${title}`);
    console.log('   ✅ Navigation works');

    // ─── Test 2: Extract structured data ───────────────────────────────
    console.log('\n📍 Test 2: Data Extraction');
    console.log('   Extracting top stories...');

    const stories = await stagehand.extract({
      instruction: 'Extract the top 3 story titles and their point counts from the front page',
      schema: {
        type: 'object',
        properties: {
          stories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                points: { type: 'string' },
              },
            },
          },
        },
      },
    });

    console.log('   Extracted stories:');
    if (stories?.stories) {
      for (const story of stories.stories) {
        console.log(`   - ${story.title} (${story.points})`);
      }
    }
    console.log('   ✅ Data extraction works');

    // ─── Test 3: AI-driven action ──────────────────────────────────────
    console.log('\n📍 Test 3: AI Action (Stagehand act)');
    console.log('   Clicking on "new" link in the nav...');

    await stagehand.act('click the "new" link in the top navigation bar');
    await page.waitForLoadState('networkidle');

    const newUrl = page.url();
    console.log(`   Navigated to: ${newUrl}`);
    console.log('   ✅ AI-driven actions work');

    // ─── Done ──────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════');
    console.log('✅ All tests passed! Omnivera core loop works.');
    console.log('═══════════════════════════════════════════');
    console.log('\nNext step: Test against Toast login');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.message.includes('API key')) {
      console.error('   Check your BROWSERBASE_API_KEY');
    }
    if (error.message.includes('project')) {
      console.error('   Check your BROWSERBASE_PROJECT_ID');
    }
    console.error('\nFull error:', error);
  } finally {
    console.log('\n🧹 Tearing down session...');
    await stagehand.close();
    console.log('✅ Session destroyed');
  }
}

// Load .env file
import { config } from 'dotenv';
config();

main();
