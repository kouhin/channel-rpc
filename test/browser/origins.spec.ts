import { expect, type Page, test } from '@playwright/test';
import { ChannelErrors } from '../../src';
import './origins';

async function openWindows(page: Page, options: { sameOrigin?: boolean; sandbox?: boolean } = {}) {
	await page.goto('/origins.html');
	await page.waitForFunction(() => Boolean(window.rpcTest));
	const parentOrigin = new URL(page.url()).origin;
	const childURL = new URL('/origins.html', page.url());
	if (!options.sameOrigin) childURL.port = String(Number(childURL.port) + 1);
	await page.evaluate(
		({ src, sandbox }) => {
			const iframe = document.createElement('iframe');
			iframe.name = 'peer';
			iframe.src = src;
			if (sandbox) iframe.sandbox.add('allow-scripts');
			document.body.append(iframe);
		},
		{ src: childURL.href, sandbox: options.sandbox }
	);
	await expect
		.poll(() =>
			page
				.frames()
				.find((frame) => frame.name() === 'peer')
				?.url()
		)
		.toBe(childURL.href);
	const peer = page.frame({ name: 'peer' });
	if (!peer) throw new Error('Peer frame not found');
	await peer.waitForFunction(() => Boolean(window.rpcTest));
	return { peer, parentOrigin, childOrigin: childURL.origin };
}

for (const mode of ['exact', 'wildcard', 'same-origin'] as const) {
	test(`delivers real iframe calls with ${mode} targetOrigin`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const { peer, parentOrigin, childOrigin } = await openWindows(page, { sameOrigin: mode === 'same-origin' });
		await peer.evaluate((origin) => window.rpcTest.startServer([origin]), parentOrigin);
		await page.evaluate(
			(targetOrigin) => {
				window.rpcTest.startClient(window.frames[0], targetOrigin);
				window.rpcTest.call('echo', { nested: ['round trip'] });
			},
			mode === 'same-origin' ? '/' : mode === 'wildcard' ? '*' : `${childOrigin}/path?query=1`
		);
		await expect.poll(() => page.evaluate(() => window.rpcTest.result)).toEqual({ nested: ['round trip'] });
		expect(errors).toEqual([]);
	});
}

test('a wrong targetOrigin prevents request delivery and ends in the existing timeout', async ({ page }) => {
	const { peer, parentOrigin } = await openWindows(page);
	await peer.evaluate(() => window.rpcTest.startServer());
	await page.evaluate((origin) => {
		window.rpcTest.startClient(window.frames[0], origin, 100);
		window.rpcTest.call('echo', 'must not arrive');
	}, parentOrigin);
	await expect.poll(() => page.evaluate(() => window.rpcTest.result)).toEqual(ChannelErrors.Timeout);
	expect(await peer.evaluate(() => window.rpcTest.messages)).toEqual([]);
	expect(await peer.evaluate(() => window.rpcTest.events)).toEqual([]);
});

test('ignores forged replies from a same-origin sibling before tracing or handling their bodies', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const { peer, childOrigin } = await openWindows(page);
	await peer.evaluate(() => window.rpcTest.startServer());
	await page.evaluate((origin) => {
		const sibling = document.createElement('iframe');
		sibling.name = 'sibling';
		sibling.src = `${origin}/origins.html`;
		document.body.append(sibling);
		window.rpcTest.startClient(window.frames[0], origin);
		window.rpcTest.call('wait');
	}, childOrigin);
	await peer.waitForFunction(() => window.rpcTest.waiting);
	await expect.poll(() => page.frame({ name: 'sibling' })?.url()).toBe(`${childOrigin}/origins.html`);
	const sibling = page.frame({ name: 'sibling' });
	if (!sibling) throw new Error('Sibling frame not found');
	await sibling.waitForFunction(() => Boolean(window.rpcTest));
	const id = await page.evaluate(() => window.rpcTest.requestId);
	await sibling.evaluate(async (requestId) => {
		for (const payload of [{ jsonrpc: '2.0', id: requestId, result: 'forged' }, null]) {
			parent.postMessage({ type: '@channel-rpc/RESPONSE', channelId: 'origins', payload }, '*');
		}
		await window.rpcTest.flush(parent);
	}, id);
	expect(await page.evaluate(() => window.rpcTest.done)).toBe(false);
	expect(await page.evaluate(() => window.rpcTest.events.map((event) => event.event))).toEqual(['send_request']);
	await peer.evaluate(() => window.rpcTest.release('legitimate'));
	await expect.poll(() => page.evaluate(() => window.rpcTest.result)).toBe('legitimate');
	expect(errors).toEqual([]);
});

test('checks the origin even when a navigated target retains the same window identity', async ({ page }) => {
	const { peer, parentOrigin, childOrigin } = await openWindows(page);
	await peer.evaluate(() => window.rpcTest.startServer());
	await page.evaluate((origin) => {
		window.rpcTest.startClient(window.frames[0], origin);
		window.rpcTest.call('wait');
	}, childOrigin);
	await peer.waitForFunction(() => window.rpcTest.waiting);
	const id = await page.evaluate(() => window.rpcTest.requestId);
	await peer.goto(`${parentOrigin}/origins.html`);
	await peer.waitForFunction(() => Boolean(window.rpcTest));
	await peer.evaluate(async (requestId) => {
		parent.postMessage(
			{
				type: '@channel-rpc/RESPONSE',
				channelId: 'origins',
				payload: { jsonrpc: '2.0', id: requestId, result: 'forged' }
			},
			'*'
		);
		await window.rpcTest.flush(parent);
	}, id);
	expect(await page.evaluate(() => window.rpcTest.done)).toBe(false);
	expect(await page.evaluate(() => window.rpcTest.events.map((event) => event.event))).toEqual(['send_request']);
	await peer.goto(`${childOrigin}/origins.html`);
	await peer.waitForFunction(() => Boolean(window.rpcTest));
	await peer.evaluate((requestId) => {
		parent.postMessage(
			{
				type: '@channel-rpc/RESPONSE',
				channelId: 'origins',
				payload: { jsonrpc: '2.0', id: requestId, result: 'expected origin' }
			},
			'*'
		);
	}, id);
	await expect.poll(() => page.evaluate(() => window.rpcTest.result)).toBe('expected origin');
});

test('does not deliver a delayed response after the requester navigates to another origin', async ({ page }) => {
	const { peer, parentOrigin, childOrigin } = await openWindows(page);
	await page.evaluate((origin) => window.rpcTest.startServer([origin]), childOrigin);
	await peer.evaluate((origin) => {
		window.rpcTest.startClient(parent, origin);
		window.rpcTest.call('wait');
	}, parentOrigin);
	await page.waitForFunction(() => window.rpcTest.waiting);
	await peer.goto(`${parentOrigin}/origins.html`);
	await peer.waitForFunction(() => Boolean(window.rpcTest));
	await page.evaluate(async () => {
		window.rpcTest.release('private delayed result');
		await Promise.resolve();
		await window.rpcTest.flush(window.frames[0]);
	});
	expect(await page.evaluate(() => window.rpcTest.events.map((event) => event.event))).toEqual([
		'receive_request',
		'send_response'
	]);
	expect(await peer.evaluate(() => window.rpcTest.messages)).toEqual([]);
});

test('preserves legacy bidirectional calls with an opaque-origin sandboxed iframe', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const { peer, parentOrigin } = await openWindows(page, { sandbox: true });
	expect(await peer.evaluate(() => globalThis.origin)).toBe('null');
	await page.evaluate(() => window.rpcTest.startServer());
	await peer.evaluate((origin) => {
		window.rpcTest.startClient(parent, origin);
		window.rpcTest.call('echo', 'from sandbox');
	}, parentOrigin);
	await expect.poll(() => peer.evaluate(() => window.rpcTest.result)).toBe('from sandbox');
	expect(await page.evaluate(() => window.rpcTest.messages[0].origin)).toBe('null');
	await peer.evaluate((origin) => window.rpcTest.startServer([origin]), parentOrigin);
	await page.evaluate(() => {
		window.rpcTest.startClient(window.frames[0]);
		window.rpcTest.call('echo', 'to sandbox');
	});
	await expect.poll(() => page.evaluate(() => window.rpcTest.result)).toBe('to sandbox');
	expect(await page.evaluate(() => window.rpcTest.messages.at(-1)?.origin)).toBe('null');
	expect(errors).toEqual([]);
});
