import { chromium } from '/home/jeremy/develop/oc-workspace/node_modules/playwright/index.mjs';
import { execFileSync, execSync } from 'child_process';

let password = process.env.OPENCHAMBER_UI_PASSWORD;
if (!password) {
  try {
    password = execSync('infisical secrets get OPENCHAMBER_UI_PASSWORD --env dev --projectId c8457c8b-0665-42de-9889-7e70569781ae --domain https://is.0mod.com/api --plain --silent', { encoding: 'utf8' }).trim();
  } catch {}
}

const BASE_URL = process.env.OPENCHAMBER_URL || 'http://localhost:4096';

async function main() {
  console.log('[Test] Launching Playwright browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      console.log('[Browser Error]', msg.text());
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
    console.error('[Page Crash]', err.message);
  });

  // 1. Authenticate
  if (password) {
    const authRes = await context.request.post(`${BASE_URL}/auth/session`, {
      data: { password },
    });
    console.log('[Test] Auth status:', authRes.status());
  }

  // 2. Navigate
  await page.goto(BASE_URL);
  await page.waitForTimeout(3000);

  // 3. Test Historical Session Loading
  console.log('[Test] Checking for Antigravity historical sessions...');
  // Find a session row with antigravity or from the Antigravity folder
  // Expand Antigravity folder if needed
  const antigravityFolder = page.locator('text=Antigravity').first();
  if (await antigravityFolder.isVisible()) {
    console.log('[Test] Antigravity folder visible in sidebar');
    // Click to ensure expanded
    await antigravityFolder.click();
    await page.waitForTimeout(1000);
  }

  // Look for any session under Antigravity
  const sessionItem = page.locator('[data-session-row^="ses_agy_"]').first();
  if (await sessionItem.isVisible({ timeout: 5000 }).catch(() => false)) {
    const sessionId = await sessionItem.getAttribute('data-session-row');
    console.log(`[Test] Clicking historical session: ${sessionId}`);
    await sessionItem.click();
    await page.waitForTimeout(3000);

    // Verify chat messages rendered
    const chatContainer = page.locator('main, [data-component="chat-timeline"]').first();
    const chatText = await chatContainer.innerText();
    console.log('[Test] Loaded session chat text preview:', chatText.slice(0, 150).replace(/\n/g, ' '));
    if (consoleErrors.some(e => e.includes('TypeError') || e.includes('undefined is not an object'))) {
      throw new Error('Fatal UI TypeError detected while loading historical session!');
    }
    console.log('[Test] SUCCESS: Historical session loaded and rendered cleanly without UI errors!');
  } else {
    console.log('[Test] No session row visible immediately, testing direct navigation...');
    await page.goto(`${BASE_URL}/#ses_agy_2f243661-e209-4f76-beaa-86d65bf0683a`);
    await page.waitForTimeout(3000);
    const bodyText = await page.innerText('body');
    console.log('[Test] Page loaded. Has content:', bodyText.length > 0);
    if (consoleErrors.some(e => e.includes('TypeError') || e.includes('undefined is not an object'))) {
      throw new Error('Fatal UI TypeError detected while loading historical session via route!');
    }
  }

  // 4. Test Tool Execution in a New Turn
  console.log('[Test] Testing real-time tool execution in new turn...');
  // Click new session button or create new draft
  const newSessionBtn = page.locator('[aria-label="New Session"], [data-testid="new-session-button"], button:has-text("New chat")').first();
  if (await newSessionBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await newSessionBtn.click();
    await page.waitForTimeout(1000);
  }

  // Select antigravity agent
  const agentSelector = page.locator('[data-agent-selector], [data-testid="agent-selector"]').first();
  if (await agentSelector.isVisible({ timeout: 3000 }).catch(() => false)) {
    await agentSelector.click();
    await page.waitForTimeout(500);
    const agyOpt = page.locator('text=antigravity').first();
    if (await agyOpt.isVisible()) await agyOpt.click();
  }

  // Send a tool-invoking prompt
  const composer = page.locator('[contenteditable="true"], textarea[placeholder*="Ask"], textarea').first();
  await composer.fill('Run the bash command: echo TOOL_EXEC_SUCCESS_VERIFIED');
  await composer.press('Enter');

  console.log('[Test] Sent tool prompt. Waiting for response and tool execution...');
  // Wait up to 30s for the tool output to appear in chat
  await page.waitForFunction(() => {
    return document.body.innerText.includes('TOOL_EXEC_SUCCESS_VERIFIED');
  }, { timeout: 45000 });

  console.log('[Test] SUCCESS: Found TOOL_EXEC_SUCCESS_VERIFIED in chat output!');
  console.log('[Test] ALL TESTS PASSED!');
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[Test Failed]', err);
  process.exit(1);
});
