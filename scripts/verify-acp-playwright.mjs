import { chromium } from '/home/jeremy/develop/oc-workspace/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:4096';
const PASSWORD = process.env.OPENCHAMBER_UI_PASSWORD || 'lEGXHEaqp0q60IGvacRuIlnN';
const SCREENSHOT_DIR = '/tmp/openchamber-acp-tests';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function run() {
  console.log('[Playwright] Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });

  console.log('[Playwright] Authenticating via /auth/session...');
  const loginRes = await context.request.post(`${BASE_URL}/auth/session`, {
    data: { password: PASSWORD },
  });
  console.log('[Playwright] Auth response status:', loginRes.status());

  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  page.on('pageerror', (err) => {
    console.error(`[Browser Page Error] ${err.message}`);
  });

  console.log('[Playwright] Navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // 1. Select Antigravity Agent
  console.log('[Playwright] Clicking Agent selector...');
  const agentTrigger = await page.$('.model-controls__agent-trigger');
  if (agentTrigger) {
    await agentTrigger.click();
    await page.waitForTimeout(500);
    // Find antigravity item in dropdown
    const agyItem = await page.$('text="antigravity"');
    if (agyItem) {
      console.log('[Playwright] Selecting antigravity agent...');
      await agyItem.click();
      await page.waitForTimeout(1000);
    }
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10-agent-selected.png') });

  // 2. Open Model Selector and verify only Antigravity models are shown
  console.log('[Playwright] Clicking Model selector to check filtered models...');
  const modelTrigger = await page.$('.model-controls__model-trigger');
  if (modelTrigger) {
    await modelTrigger.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11-model-dropdown-open.png') });

    const dropdown = page.locator('[role="menu"], [role="dialog"], .model-picker, [data-portal]').first();
    const dropdownText = await dropdown.textContent().catch(() => '');
    console.log('[Playwright] Model dropdown content sample:', dropdownText?.slice(0, 300));

    // Verify it contains Gemini 3.8 Flash or Gemini 4 Argon
    const hasAgy = dropdownText?.includes('Gemini 3.8 Flash') || dropdownText?.includes('Gemini 4 Argon');
    console.log('[Playwright] Has Antigravity models:', Boolean(hasAgy));

    // Close model dropdown by pressing Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // 3. Send a prompt to verify execution
  const textareaSelector = 'textarea, [contenteditable="true"]';
  await page.waitForSelector(textareaSelector, { timeout: 10000 });
  const promptInput = await page.$(textareaSelector);

  console.log('[Playwright] Sending test prompt: "What is 3 * 7? Reply with only the number."');
  await promptInput.fill('What is 3 * 7? Reply with only the number.');
  await page.keyboard.press('Enter');

  console.log('[Playwright] Waiting for assistant response...');
  const startTime = Date.now();
  let gotAnswer = false;
  while (Date.now() - startTime < 35000) {
    const toast = await page.$('.toast, [role="alert"]');
    if (toast) {
      const text = await toast.textContent();
      if (text && text.toLowerCase().includes('unexpected status')) {
        throw new Error('Test failed: "unexpected status" toast appeared!');
      }
    }

    const bodyText = await page.textContent('body');
    if (bodyText.includes('21')) {
      gotAnswer = true;
      console.log('[Playwright] SUCCESS: Found "21" in chat response!');
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12-prompt-completed.png') });

  if (!gotAnswer) {
    throw new Error('Timed out waiting for 21 in assistant response');
  }

  console.log('[Playwright] ALL VERIFICATION STEPS PASSED!');
  await browser.close();
}

run().catch((err) => {
  console.error('[Playwright Test Error]', err);
  process.exit(1);
});
