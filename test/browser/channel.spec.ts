import { expect, test } from '@playwright/test';
import type { ChannelTraceEvent } from '../../src';

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

test('keeps iframe payloads out of debug logs while exposing them through per-window traces', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(() => {
		localStorage.setItem('channel-rpc-debug', '1');
		const logs: unknown[][] = [];
		Object.assign(window, { debugLogs: logs });
		const originalLog = console.log;
		console.log = (...args) => {
			logs.push(args);
			originalLog(...args);
		};
	});
	await page.goto('/parent.html?mode=trace');
	const value = { nested: [{ value: 'redacted-wallet-token' }] };
	await expect(page.frameLocator('iframe').locator('#result')).toHaveText(JSON.stringify([value, -32603]));
	for (const frame of page.frames()) {
		const { traces, logs } = await frame.evaluate(() => {
			const state = window as unknown as { traceEvents: ChannelTraceEvent[]; debugLogs: unknown[][] };
			return {
				traces: state.traceEvents.map((event) => ({
					...event,
					error: event.error instanceof Error ? event.error.message : event.error
				})),
				logs: state.debugLogs
			};
		});
		expect(logs.length).toBeGreaterThan(0);
		expect(JSON.stringify(logs)).not.toContain('redacted-wallet-token');
		expect(JSON.stringify(logs)).not.toContain('redacted-session-secret');
		const parent = frame === page.mainFrame();
		expect(traces.map((event) => event.event)).toEqual(
			parent
				? ['receive_request', 'send_response', 'receive_request', 'handler_error', 'send_response']
				: ['send_request', 'receive_response', 'send_request', 'receive_response']
		);
		expect((traces[0].payload as { params: unknown[] }).params).toEqual([value]);
		expect((traces[1].payload as { result: unknown }).result).toEqual(value);
		if (parent) expect(traces[3].error).toBe('redacted-session-secret');
	}
	expect(errors).toEqual([]);
});
