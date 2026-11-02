import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/** Expected values come from the committed recording, not from the rendered page. */
type Recorded = {
  report: {
    modules: {
      trajectory: { data: { tables: { basis: string; columns: { label: string }[] }[] } | null };
      scorecard: { data: { calls: { callLabel: string }[] } | null };
    };
  };
};
const reliance = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures', 'research', 'nse_reliance.json'), 'utf8')) as Recorded;

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe('signals', () => {
  test('home loads the ranked feed, labelled as demo data with its demo clock', async ({ page }) => {
    await page.goto('/?window=7d');
    await expect(page.getByRole('heading', { level: 1, name: 'Signals' })).toBeVisible();
    await expect(page.getByText('Demo clock fixed at').first()).toBeVisible();
    await expect(page.getByText('Demo data').first()).toBeVisible();
    await expect(page.getByText(/\d+ material signals?/)).toBeVisible();
    const rows = page.getByRole('list', { name: 'Signals, most significant first' }).getByRole('article');
    expect(await rows.count()).toBeGreaterThan(3);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test('a signal opens its detail, its exchange source and its company research', async ({ page }) => {
    await page.goto('/?window=7d');
    const first = page.getByRole('list', { name: 'Signals, most significant first' }).getByRole('article').first();
    await first.getByRole('heading').getByRole('button').click();
    const detail = page.getByRole('complementary', { name: 'Signal detail' });
    await expect(detail.getByRole('heading', { name: 'Reported' })).toBeVisible();
    await expect(detail.getByRole('heading', { name: "FINN's assessment" })).toBeVisible();
    const source = detail.getByRole('link', { name: /Open the filing/ });
    if (await source.count()) await expect(source.first()).toHaveAttribute('href', /^https:\/\/www\.bseindia\.com\//);
    const research = detail.getByRole('link', { name: /^Research / });
    const href = await research.getAttribute('href');
    expect(href).toMatch(/^\/research\?company=nse%3A/);
    await research.click();
    await expect(page).toHaveURL(/\/research\?company=/);
    await expect(page.getByRole('textbox', { name: /Company/ })).not.toHaveValue('');
  });

  test('filters narrow the feed and an impossible combination explains itself', async ({ page }) => {
    await page.goto('/?window=7d');
    const filters = page.getByRole('group', { name: 'Filter the feed' });
    await filters.getByLabel('Company').selectOption('nse:trent');
    const rows = page.getByRole('list', { name: 'Signals, most significant first' }).getByRole('article');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) await expect(rows.nth(i)).toContainText('TRENT');
    await filters.getByRole('button', { name: /Price moves/ }).click();
    await filters.getByRole('button', { name: /Volume/ }).click();
    await filters.getByRole('button', { name: /Filings/ }).click();
    await expect(page.getByText('No signals match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(rows.first()).toBeVisible();
  });
});

test.describe('research', () => {
  test('company search by name resolves and renders the recorded report with its trajectory', async ({ page }) => {
    await page.goto('/research');
    await page.getByRole('textbox', { name: /Company/ }).fill('Reliance');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await expect(page.getByText('Recorded demo report')).toBeVisible();
    await expect(page.getByRole('article', { name: 'Research report: Reliance Industries' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Financial trajectory/ })).toBeVisible();
    const headline = page.getByRole('list', { name: /Headline figures/ }).or(page.locator('dl[aria-label^="Headline figures"]'));
    await expect(headline.getByText('Revenue', { exact: true })).toBeVisible();
  });

  test('table periods and guidance calls match the recording', async ({ page }) => {
    await page.goto('/research?company=nse%3Areliance');
    const table = reliance.report.modules.trajectory.data?.tables[0];
    const quarters = (table?.columns ?? []).filter((c) => c.label.startsWith('Q'));
    const cumulative = (table?.columns ?? []).filter((c) => !c.label.startsWith('Q'));
    for (const col of quarters) await expect(page.getByRole('columnheader', { name: new RegExp(col.label) }).first()).toBeVisible();
    for (const col of cumulative) await expect(page.getByRole('columnheader', { name: new RegExp(col.label) })).toHaveCount(0);
    await page.getByRole('radio', { name: 'H1 / 9M / FY' }).click();
    for (const col of cumulative) await expect(page.getByRole('columnheader', { name: new RegExp(col.label) }).first()).toBeVisible();
    for (const col of quarters) await expect(page.getByRole('columnheader', { name: new RegExp(col.label) })).toHaveCount(0);
    for (const call of reliance.report.modules.scorecard.data?.calls ?? []) await expect(page.getByRole('heading', { level: 3, name: new RegExp(call.callLabel) }).first()).toBeAttached();
  });

  test('evidence shows the printed figure, its unit and the conversion', async ({ page }) => {
    await page.goto('/research?company=nse%3Areliance');
    await page.locator('dl[aria-label^="Headline figures"]').getByRole('button', { name: /Results, p\./ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('As printed')).toBeVisible();
    await expect(dialog.getByText('₹ crore')).toBeVisible();
    await expect(dialog.getByRole('link', { name: /Open document at page/ })).toHaveAttribute('href', /^https:\/\/www\.bseindia\.com\/.*#page=\d+$/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('sections open and close', async ({ page }) => {
    await page.goto('/research?company=nse%3Areliance');
    const toggle = page.getByRole('button', { name: /Bull and bear case/ }).or(page.getByRole('button', { name: /Sources and evidence/ })).first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('partial research names the missing sections (no results filing)', async ({ page }) => {
    await page.goto('/research?company=nse%3Alt');
    await expect(page.getByText(/Partial research/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Financial trajectory: not available' })).toBeVisible();
  });

  test('an unknown company and an unreachable server each get their own message', async ({ page }) => {
    await page.goto('/research');
    await page.getByRole('textbox', { name: /Company/ }).fill('NOSUCHCO');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await expect(page.getByText('Company not verified')).toBeVisible();
    await expect(page.getByText(/not in the registry, and live verification is off/)).toBeVisible();

    await page.route('**/api/research', (route) => route.abort('connectionrefused'));
    await page.getByRole('textbox', { name: /Company/ }).fill('RELIANCE');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await expect(page.getByText(/Could not reach the server/)).toBeVisible();
  });

  test('a company with no recording offers the recorded ones instead of failing', async ({ page }) => {
    await page.goto('/research?company=nse%3Ahdfcbank');
    await expect(page.getByText('No recorded report for this company')).toBeVisible();
    await page.getByRole('button', { name: /RELIANCE · Reliance Industries/ }).click();
    await expect(page.getByText('Recorded demo report')).toBeVisible();
  });
});

test.describe('watchlist and alert settings', () => {
  test('an unavailable price source is shown per company while the rest of the row still works', async ({ page }) => {
    await page.goto('/watchlist');
    const row = page.locator('li[id="nse:asianpaint"]');
    await expect(row.getByText('No price data for this listing')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Research' })).toBeVisible();
    await expect(page.locator('li[id="nse:reliance"]').getByText(/Recorded · \d{4}-\d{2}-\d{2}/)).toBeVisible();
  });

  test('adding and removing a company persists across reloads', async ({ page }) => {
    await page.goto('/watchlist');
    await page.getByLabel('Add a company').selectOption('nse:kaynes');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('li[id="nse:kaynes"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('li[id="nse:kaynes"]')).toBeVisible();
    await page.getByRole('button', { name: 'Remove KAYNES from the watchlist' }).click();
    await expect(page.locator('li[id="nse:kaynes"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('li[id="nse:kaynes"]')).toHaveCount(0);
  });

  test('a failed watchlist write is reported and changes nothing', async ({ page }) => {
    await page.goto('/watchlist');
    await page.route('**/api/watchlist', (route) => route.fulfill({ status: 500, json: { error: { kind: 'database', message: "Updating the watchlist failed in FINN's local database. Nothing was changed; try again." } } }));
    await expect(page.locator('li[id="nse:reliance"]')).toBeVisible();
    const before = await page.getByRole('list', { name: 'Watchlist companies' }).getByRole('listitem').count();
    await page.getByRole('button', { name: 'Remove RELIANCE from the watchlist' }).click();
    await expect(page.getByText(/Updating the watchlist failed/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Watchlist companies' }).getByRole('listitem')).toHaveCount(before);
  });

  test('an alert rule change saves, survives a reload and states its condition', async ({ page }) => {
    await page.goto('/alerts');
    const form = page.getByRole('form', { name: /Edit rule Daily move/ });
    await form.getByLabel('Threshold (%)').fill('4');
    await expect(form.getByText(/by 4% or more/)).toBeVisible();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved "Daily move beyond ±4%"/)).toBeVisible();
    await page.reload();
    await expect(page.getByRole('form', { name: /Edit rule Daily move beyond ±4%/ })).toBeVisible();
    const after = page.locator('form').filter({ has: page.getByText('Price move', { exact: true }) });
    await expect(after.getByLabel('Threshold (%)')).toHaveValue('4');
    await after.getByLabel('Threshold (%)').fill('5');
    await after.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved "Daily move beyond ±5%"/)).toBeVisible();
  });

  test('the chosen signal window is remembered', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: /^30d/ }).click();
    await expect(page).toHaveURL(/window=30d/);
    await page.goto('/');
    await expect(page.getByText('Last 30 days').first()).toBeVisible();
    await page.getByRole('radio', { name: /^24h/ }).click();
    await expect(page).toHaveURL(/window=24h/);
  });
});
