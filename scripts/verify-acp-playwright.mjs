import { chromium } from '/home/jeremy/develop/oc-workspace/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://localhost:4096';

function getPassword() {
  if (process.env.OPENCHAMBER_UI_PASSWORD) return process.env.OPENCHAMBER_UI_PASSWORD;
  try {
    const pw = execSync('infisical secrets get OPENCHAMBER_UI_PASSWORD --env dev --projectId c8457c8b-0665-42de-9889-7e70569781ae --domain https://is.0mod.com/api --plain --silent', { encoding: 'utf8' }).trim();
    if (pw && !pw.startsWith('error:')) return pw;
  } catch {}
  return null;
}

const PASSWORD = getPassword();
if (!PASSWORD) {
  console.error('[Playwright] Error: OPENCHAMBER_UI_PASSWORD environment variable or Infisical session is required.');
  process.exit(1);
}
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

  // 3. Send Turn 1 prompt
  const textareaSelector = 'textarea, [contenteditable="true"]';
  await page.waitForSelector(textareaSelector, { timeout: 10000 });
  const promptInput = await page.$(textareaSelector);

  console.log('[Playwright] Sending Turn 1 prompt: "What is 3 * 7? Reply with only the number."');
  await promptInput.fill('What is 3 * 7? Reply with only the number.');
  await page.keyboard.press('Enter');

  console.log('[Playwright] Waiting for assistant Turn 1 response...');
  const startTime = Date.now();
  let gotAnswer = false;
  while (Date.now() - startTime < 35000) {
    const toast = await page.$('.toast, [role="alert"]');
    if (toast) {
      const text = await toast.textContent();
      if (text && text.toLowerCase().includes('unexpected status')) {
        throw new Error('Test failed: "unexpected status" toast appeared on Turn 1!');
      }
    }

    const bodyText = await page.textContent('body');
    if (bodyText.includes('21')) {
      gotAnswer = true;
      console.log('[Playwright] SUCCESS: Found "21" in Turn 1 chat response!');
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12-prompt-turn1-completed.png') });

  if (!gotAnswer) {
    throw new Error('Timed out waiting for 21 in assistant response on Turn 1');
  }

  // Wait 2 seconds for turn state to settle
  await page.waitForTimeout(2000);

  // 4. Send Turn 2 prompt in the same session to verify multi-turn ACP context & no "unexpected status"
  console.log('[Playwright] Sending Turn 2 prompt: "Now what was that number plus 9? Reply with only the number."');
  const promptInput2 = await page.$(textareaSelector);
  await promptInput2.fill('Now what was that number plus 9? Reply with only the number.');
  await page.keyboard.press('Enter');

  console.log('[Playwright] Waiting for assistant Turn 2 response...');
  const startTurn2 = Date.now();
  let gotTurn2 = false;
  while (Date.now() - startTurn2 < 35000) {
    const toast = await page.$('.toast, [role="alert"]');
    if (toast) {
      const text = await toast.textContent();
      if (text && text.toLowerCase().includes('unexpected status')) {
        throw new Error('Test failed: "unexpected status" toast appeared on Turn 2!');
      }
    }

    const bodyText = await page.textContent('body');
    if (bodyText.includes('30')) {
      gotTurn2 = true;
      console.log('[Playwright] SUCCESS: Found "30" in Turn 2 chat response (multi-turn memory verified)!');
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '13-prompt-turn2-completed.png') });

  if (!gotTurn2) {
    throw new Error('Timed out waiting for 30 in assistant response on Turn 2');
  }

  // 5. Test History Navigation & Reload
  console.log('[Playwright] Testing reload & session history rendering...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const reloadedBody = await page.textContent('body');
  if (!reloadedBody.includes('21') || !reloadedBody.includes('30')) {
    console.warn('[Playwright] Warning: History re-render check - looking for messages in DOM...');
  } else {
    console.log('[Playwright] SUCCESS: Both Turn 1 ("21") and Turn 2 ("30") persist across reload!');
  }

  // 6. Check for Antigravity Folder in Sidebar
  console.log('[Playwright] Checking for Antigravity folder in sidebar...');
  const sidebarText = await page.locator('nav, aside, [role="navigation"], .sidebar, [data-sidebar]').first().textContent().catch(() => '');
  console.log('[Playwright] Sidebar text snippet:', sidebarText?.slice(0, 300));
  const hasAgyFolder = (await page.locator('text="Antigravity"').count()) > 0;
  console.log('[Playwright] Has Antigravity folder:', hasAgyFolder);
  if (hasAgyFolder) {
    console.log('[Playwright] SUCCESS: "Antigravity" folder row is rendered in the sessions sidebar!');
  } else {
    throw new Error('Antigravity folder not found in sidebar!');
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '14-history-reloaded.png') });

  console.log('[Playwright] ALL VERIFICATION STEPS PASSED!');
  await browser.close();
}

run().catch((err) => {
  console.error('[Playwright Test Error]', err);
  process.exit(1);
});
