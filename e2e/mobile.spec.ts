import { expect, test, type Page } from '@playwright/test';

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe('mobile (375px)', () => {
  test('the bottom tab bar reaches every section without horizontal scrolling', async ({ page }) => {
    await page.goto('/?window=7d');
    const tabs = page.getByRole('navigation', { name: 'Primary' }).last();
    for (const [name, heading] of [
      ['Research', 'Research'],
      ['Watchlist', 'Watchlist'],
      ['Alert settings', 'Alert settings'],
      ['Signals', 'Signals'],
    ] as const) {
      await tabs.getByRole('link', { name }).click();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      expect(await noHorizontalOverflow(page), `overflow on ${name}`).toBe(true);
      const box = await tabs.getByRole('link', { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('the top signal leads, and its detail opens as a sheet that closes', async ({ page }) => {
    await page.goto('/?window=7d');
    const lead = page.getByRole('region', { name: 'Most important signal' });
    await expect(lead).toBeVisible();
    await lead.getByRole('button').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Reported' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close signal detail' }).click();
    await expect(dialog).toBeHidden();
  });

  test('research on a phone: report fits, later sections start closed, change company is always reachable', async ({ page }) => {
    await page.goto('/research?company=nse%3Areliance');
    await expect(page.getByText('Recorded demo report')).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await expect(page.getByRole('button', { name: /Narrative vs numbers/ })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: /Narrative vs numbers/ }).click();
    await expect(page.getByRole('button', { name: /Narrative vs numbers/ })).toHaveAttribute('aria-expanded', 'true');
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.mouse.wheel(0, 4000);
    const change = page.getByRole('button', { name: 'Change company' });
    await expect(change).toBeInViewport();
    await change.click();
    await expect(page.getByRole('textbox', { name: /Company/ })).toBeFocused();
  });
});
