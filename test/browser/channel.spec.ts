import { expect, test } from '@playwright/test';

test('the ESM build supports synchronous and asynchronous calls across origins', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/parent.html');
	await expect(page.frameLocator('iframe').locator('#result')).toHaveText('[5,14]');
	expect(errors).toEqual([]);
});

test('RPC errors survive real postMessage serialization', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/parent.html?mode=errors');
	await expect(page.frameLocator('iframe').locator('#result')).toHaveText('[-32601,-32603]');
	expect(errors).toEqual([]);
});

test('an iframe outside the allowlist is rejected and its request times out', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/parent.html?mode=deny');
	await expect(page.frameLocator('iframe').locator('#result')).toHaveText('[-32000]');
	expect(errors).toHaveLength(1);
	expect(errors[0]).toContain('Invalid origin');
});
