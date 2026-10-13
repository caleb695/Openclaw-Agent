import { test, expect } from '@playwright/test';
async function connect(page, context) {
  // Real cross-origin popup/relay; only the GitHub tunnel is substituted. Web
  // security stays enabled, so Origin, source, CSP, and postMessage really apply.
  await context.route('https://test-agent-3000.app.github.dev/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const response = await route.fetch({
      url: `http://127.0.0.1:4180${url.pathname}`,
      headers: { ...req.headers(), host: 'test-agent-3000.app.github.dev' },
    });
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Connect Agent' }).click();
  await page.getByLabel('Private companion URL').fill('https://test-agent-3000.app.github.dev');
  const pending = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open private companion' }).click();
  const popup = await pending;
  await expect(page.locator('#status')).toHaveText('Awaiting approval');
  await popup.getByRole('button', { name: 'Allow this session' }).click();
  await expect(page.locator('#status')).toHaveText('Connected');
  return popup;
}
test('all routes work offline, responsive layout, no script errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  for (const [route, title] of Object.entries({
    chat: 'Agent chat',
    models: 'Models & providers',
    channels: 'Messaging channels',
    skills: 'Skills',
    plugins: 'Plugins',
    credentials: 'Credentials',
    operations: 'Operations',
    settings: 'Configuration',
    updates: 'Updates',
  })) {
    await page.locator(`[data-page="${route}"]`).click();
    await expect(page.locator('h1')).toHaveText(title);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#overview');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('private popup: approval, chat, provider patch, vault isolation, close detection', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const popup = await connect(page, context);
  await page.locator('[data-page="chat"]').click();
  await page.locator('#message').fill('Hello from the browser');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#messages')).toContainText('Fixture reply: Hello from the browser');
  await popup.getByLabel('Credential name').fill('BROWSER_TEST_KEY');
  await popup.getByLabel('Secret value').fill('synthetic-secret-not-for-pages');
  await popup.getByRole('button', { name: 'Save securely' }).click();
  await expect(popup.locator('#result')).toContainText('/BROWSER_TEST_KEY');
  await page.locator('[data-page="credentials"]').click();
  await expect(page.locator('#inventory')).toContainText('BROWSER_TEST_KEY');
  expect(await page.locator('body').innerText()).not.toContain('synthetic-secret-not-for-pages');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    'synthetic-secret',
  );
  await page.locator('[data-page="models"]').click();
  await expect(page.locator('#inventory')).toContainText('models');
  await page.getByLabel('Provider ID', { exact: true }).fill('custom');
  await page.getByLabel('Model ID', { exact: true }).fill('custom-model');
  await page.getByLabel('API base URL').fill('https://example.test/v1');
  await page.getByLabel('Credential name (optional)').fill('BROWSER_TEST_KEY');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.locator('#notice')).toContainText('Validated patch accepted');
  await popup.close();
  await page.getByRole('button', { name: 'Refresh', exact: false }).click();
  await expect(page.locator('#status')).toHaveText('Offline');
});
test('spoofed ready message cannot authorize a dashboard', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() =>
    window.postMessage({ kind: 'openclaw', type: 'ready', channel: 'fake' }, location.origin),
  );
  await expect(page.locator('#status')).toHaveText('Offline');
});
