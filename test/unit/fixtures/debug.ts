import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import type { ChannelTraceEvent } from '../../../src';
import { channelId, messageHarness, responseType } from '../messages';

const mode = process.argv[2];
const enabled = ['on', 'false-string', 'console-throws', 'late-disable'].includes(mode);
let storageValue: string | null = enabled ? (mode === 'false-string' ? 'false' : '1') : mode === 'empty' ? '' : null;
Reflect.deleteProperty(globalThis, 'localStorage');
if (mode !== 'storage-missing') {
	Object.defineProperty(globalThis, 'localStorage', {
		get() {
			if (mode === 'storage-denied') throw new Error('Storage unavailable');
			return {
				getItem() {
					if (mode === 'get-item-denied') throw new Error('Storage unavailable');
					return storageValue;
				}
			};
		}
	});
}
const { ChannelClient, ChannelErrors, ChannelServer } = await import('../../../src');
if (mode === 'late-enable') storageValue = '1';
if (mode === 'late-disable') storageValue = null;

const messages = messageHarness();
const logs: unknown[][] = [];
console.log = (...args) => {
	logs.push(args);
	if (mode === 'console-throws') throw new Error('Console unavailable');
};
const secrets = ['redacted-session-secret', 'redacted-wallet-token'];
const value = { nested: [{ value: secrets }], count: 42n, self: undefined as unknown };
value.self = value;
const events: ChannelTraceEvent[] = [];
const onTrace = (event: ChannelTraceEvent) => {
	events.push(event);
};
const handlerError = new Error(secrets[0]);
new ChannelServer({
	channelId,
	onTrace,
	handler: {
		echo: (input: unknown) => input,
		fail() {
			throw handlerError;
		}
	}
}).start();
messages.loopback();
const client = new ChannelClient<{ echo(input: unknown): unknown; fail(): never; missing(): never }>({
	channelId,
	onTrace,
	target: messages.target
});
assert.deepEqual(await client.stub.echo(value), value);
await assert.rejects(client.stub.fail(), ChannelErrors.InternalError);
await assert.rejects(client.stub.missing(), ChannelErrors.MethodNotFound);
assert.equal(events.find((event) => event.event === 'handler_error')?.error, handlerError);
assert.deepEqual((events[3].payload as { result: unknown }).result, value);

function emit(payload: unknown) {
	messages.emitResponse({ type: responseType, channelId, payload });
}
for (const payload of [undefined, null, secrets[0], 42n, { jsonrpc: '1.0', value }, { jsonrpc: '2.0', value }]) {
	let thrown: unknown;
	try {
		emit(payload);
	} catch (error) {
		thrown = error;
	}
	assert(thrown instanceof Error);
	assert.equal(thrown.message, 'UNKNOWN_RESPONSE');
	assert(!('cause' in thrown));
	assert(!('payload' in thrown));
	const details = inspect(Object.getOwnPropertyDescriptors(thrown), { depth: null });
	for (const secret of secrets) assert(!details.includes(secret));
	const last = events.at(-1);
	assert(last);
	assert.equal(last.event, 'invalid_response');
	assert.equal(last.payload, payload);
	assert.equal(last.error, thrown);
}
// Metadata is selected by type; neither malformed fields nor extra properties are logged.
for (const code of [undefined, null, secrets[0], { value }, NaN, Infinity, -Infinity, -32001]) {
	emit({ jsonrpc: '2.0', id: 'unmatched', error: { code, message: secrets[0], data: value } });
	if (enabled) {
		const metadata = logs.at(-1)?.[2] as { errorCode: unknown; outcome: string };
		assert.equal(metadata.errorCode, typeof code === 'number' && Number.isFinite(code) ? code : undefined);
		assert.equal(metadata.outcome, 'error');
	}
}
emit({ jsonrpc: '2.0', id: { value }, method: { value }, result: value, extra: value });
if (enabled) {
	const metadata = logs.at(-1)?.[2] as Record<string, unknown>;
	assert.equal(metadata.requestId, undefined);
	assert.equal(metadata.method, undefined);
	assert.equal(metadata.outcome, 'success');
}
assert.equal(logs.length > 0, enabled);
for (const [prefix, event, metadata] of logs) {
	assert.equal(prefix, '[CHANNEL_RPC]');
	assert.equal(typeof event, 'string');
	assert.deepEqual(Object.keys(metadata as object).sort(), [
		'channelId',
		'errorCode',
		'method',
		'outcome',
		'requestId'
	]);
}
for (const secret of secrets) assert(!inspect(logs, { depth: null }).includes(secret));

// Debug works without a callback as well; a callback is never required for communication.
new ChannelServer({ channelId: 'no-hook', handler: { echo: (input: unknown) => input } }).start();
const noHook = new ChannelClient<{ echo(input: unknown): unknown }>({ channelId: 'no-hook', target: messages.target });
assert.deepEqual(await noHook.stub.echo(value), value);
for (const secret of secrets) assert(!inspect(logs, { depth: null }).includes(secret));
if (!enabled) assert.equal(logs.length, 0);
messages.restore();
