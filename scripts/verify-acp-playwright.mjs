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

  // Monitor console & toast errors
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  page.on('pageerror', (err) => {
    console.error(`[Browser Page Error] ${err.message}`);
  });

  page.on('response', (res) => {
    if (res.status() >= 400) {
      console.log(`[HTTP Error] ${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  console.log('[Playwright] Navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-logged-in.png') });
  console.log('[Playwright] Logged in. Screenshot saved.');

  // Part 1: Test the user session ses_e523fda89ffeEo2gqKe2Z43xhQ
  console.log('[Playwright] Navigating to existing user session ses_e523fda89ffeEo2gqKe2Z43xhQ...');
  await page.goto(`${BASE_URL}/session/ses_e523fda89ffeEo2gqKe2Z43xhQ`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-existing-session-loaded.png') });

  // Find the chat textarea / contenteditable
  const textareaSelector = 'textarea, [contenteditable="true"]';
  await page.waitForSelector(textareaSelector, { timeout: 10000 });
  console.log('[Playwright] Chat input found.');

  // Type Prompt 2: "What is 15 + 27? Reply with only the number."
  console.log('[Playwright] Sending Turn 2 prompt...');
  const promptInput = await page.$(textareaSelector);
  await promptInput.fill('What is 15 + 27? Reply with only the number.');
  await page.keyboard.press('Enter');

  // Monitor for error toast
  let sawUnexpectedStatus = false;
  page.on('dialog', async (dialog) => {
    console.log('[Dialog]', dialog.message());
    await dialog.dismiss();
  });

  // Check if error toast appears
  const checkToast = async () => {
    const toast = await page.$('.toast, [role="alert"], .notification');
    if (toast) {
      const text = await toast.textContent();
      if (text && text.toLowerCase().includes('unexpected status')) {
        sawUnexpectedStatus = true;
        console.error('[FAILED] Detected "unexpected status" error toast!');
      }
    }
  };

  // Wait for streaming / completion
  console.log('[Playwright] Waiting for assistant response...');
  const startTime = Date.now();
  let gotAnswer = false;
  while (Date.now() - startTime < 30000) {
    await checkToast();
    if (sawUnexpectedStatus) {
      throw new Error('Test failed: "unexpected status" toast appeared on prompt submit!');
    }
    const bodyText = await page.textContent('body');
    if (bodyText.includes('42')) {
      gotAnswer = true;
      console.log('[Playwright] SUCCESS: Found "42" in chat response!');
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-turn2-response.png') });

  if (!gotAnswer) {
    throw new Error('Timed out waiting for 42 in assistant response');
  }

  // Part 2: Send Turn 3 in the same session
  console.log('[Playwright] Sending Turn 3 prompt in the same session...');
  await page.waitForSelector(textareaSelector, { timeout: 5000 });
  const promptInput3 = await page.$(textareaSelector);
  await promptInput3.fill('Now multiply that by 2. Reply with only the number.');
  await page.keyboard.press('Enter');

  const startTime3 = Date.now();
  let gotAnswer3 = false;
  while (Date.now() - startTime3 < 30000) {
    await checkToast();
    if (sawUnexpectedStatus) {
      throw new Error('Test failed: "unexpected status" toast appeared on Turn 3!');
    }
    const bodyText = await page.textContent('body');
    if (bodyText.includes('84')) {
      gotAnswer3 = true;
      console.log('[Playwright] SUCCESS: Found "84" in Turn 3 response!');
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-turn3-response.png') });

  if (!gotAnswer3) {
    throw new Error('Timed out waiting for 84 in Turn 3 response');
  }

  console.log('[Playwright] ALL TESTS PASSED! Multi-turn ACP session works perfectly in OpenChamber!');
  await browser.close();
}

run().catch((err) => {
  console.error('[Playwright Test Error]', err);
  process.exit(1);
});
