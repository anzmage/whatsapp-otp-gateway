import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
const setupToken = 'test-only-setup-token-not-for-production';
const credentials = { email: 'owner@example.test', password: 'correct-horse-battery-staple' };
let server, origin;
const adapter = { sent: [] };
test.beforeAll(async () => {
  server = fork(new URL('./fixture-server.mjs', import.meta.url), { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  origin = await new Promise((resolve, reject) => {
    server.on('message', (message) => {
      if (message.type === 'ready') resolve(message.origin);
      if (message.type === 'sent') adapter.sent.push(message.message);
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Fixture exited early: ${code}`)));
  });
});
test.afterAll(async () => {
  if (server?.connected) { const exited = once(server, 'exit'); server.send('stop'); await exited; }
});

test('real HTTP dashboard workflow and mobile/desktop layout with a fake transport only', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Make it yours.' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByLabel('Installation setup token').fill(setupToken);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Your verification workspace.' })).toBeVisible();
  await page.getByLabel('Label', { exact: true }).fill('Portfolio test number');
  await page.getByLabel('WhatsApp number', { exact: true }).fill('+628123451234');
  await page.getByRole('button', { name: '+ Add number', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio test number' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair QR', exact: true }).click();
  await expect(page.locator('#stat-devices')).toHaveText('1');
  await page.getByLabel('Application name').fill('Browser integration');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const key = await page.locator('#new-key').inputValue();
  expect(key).toMatch(/^wotp_[a-f0-9]{64}$/);
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page.locator('#new-key')).toHaveValue('');
  await page.locator('#playground-key').fill(key);
  await page.locator('#playground-device').selectOption({ label: 'Portfolio test number · +62••••1234' });
  await page.getByLabel('Recipient', { exact: true }).fill('+628987654321');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Send real OTP', exact: false }).click();
  await expect(page.locator('#api-result')).toContainText('accepted');
  expect(adapter.sent).toHaveLength(1);
  const code = adapter.sent[0].text.match(/code is (\d{6})/)[1];
  await page.getByLabel('Received OTP').fill(code);
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.locator('#api-result')).toContainText('"verified": true');
  await expect(page.getByLabel('Received OTP')).toHaveValue('');
  await expect(page.locator('#stat-verified')).toHaveText('1');
  const docs = await context.newPage();
  docs.on('pageerror', (err) => errors.push(err.message));
  docs.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await docs.goto(`${origin}/docs/`);
  await expect(docs.locator('.swagger-ui .info .title')).toContainText('WhatsApp OTP Gateway');
  await docs.getByRole('button', { name: 'Authorize', exact: false }).first().click();
  await docs.locator('.auth-container input').fill(key);
  await docs.locator('.modal-ux').getByRole('button', { name: 'Apply credentials', exact: true }).click();
  await docs.locator('.modal-ux').getByRole('button', { name: 'Close', exact: true }).click();
  const operation = docs.locator('.opblock-get').filter({ hasText: '/v1/devices' });
  await operation.locator('.opblock-summary').click();
  await operation.getByRole('button', { name: 'Try it out', exact: true }).click();
  await operation.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(operation.locator('.live-responses-table').getByRole('cell', { name: '200', exact: true })).toBeVisible();
  await expect(operation.locator('.live-responses-table')).toContainText('Portfolio test number');
  expect((await docs.request.get(`${origin}/openapi.json`)).status()).toBe(200);
  await docs.close();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/dashboard-${width}.png`, fullPage: true });
  }
  // A harmless label stays text, never executable markup.
  await page.getByLabel('Label', { exact: true }).fill('<img src=x onerror=alert(1)>');
  await page.getByLabel('WhatsApp number', { exact: true }).fill('+628111111111');
  await page.getByRole('button', { name: '+ Add number', exact: true }).click();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true })).toBeVisible();
  expect(await page.locator('.device-list img').count()).toBe(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('#playground-key')).toHaveValue('');
  expect((await page.request.get(`${origin}/openapi.json`)).status()).toBe(401);
  expect(errors).toEqual([]);
});
