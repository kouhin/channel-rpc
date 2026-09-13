import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ChannelClient, ChannelErrors, ChannelServer } from '../../src';
import { channelId, clientOrigin, messageHarness, requestType, responseType } from './messages';

let messages: ReturnType<typeof messageHarness>;
beforeEach(() => {
	messages = messageHarness();
});
afterEach(() => {
	messages.restore();
});

function connect<T extends object>(handler: T) {
	const server = new ChannelServer({ channelId, handler, allowOrigins: [clientOrigin] });
	server.start();
	messages.loopback();
	const client = new ChannelClient<T>({ channelId, target: messages.target, timeout: 500 });
	return { server, client };
}

function request(payload: unknown, channel = channelId) {
	return { type: requestType, channelId: channel, payload };
}

function response(id: string, result: unknown, channel = channelId) {
	return { type: responseType, channelId: channel, payload: { jsonrpc: '2.0', id, result } };
}

describe('ChannelServer', () => {
	test('requires a channel identifier', () => {
		expect(() => new ChannelServer({ channelId: '' })).toThrow('id is required');
	});

	test('starts and stops idempotently and can restart', () => {
		const server = new ChannelServer({ channelId });
		server.start();
		server.start();
		expect(messages.listeners.size).toBe(1);
		server.stop();
		server.stop();
		expect(messages.listeners.size).toBe(0);
		server.start();
		expect(messages.listeners.size).toBe(1);
	});

	test('ignores other channels, unrelated messages, and null sources', () => {
		const server = new ChannelServer({ channelId, handler: { add: (a: number, b: number) => a + b } });
		server.start();
		const payload = { jsonrpc: '2.0', id: 'ignored', method: 'add', params: [1, 2] };
		messages.emit(request(payload, 'another-channel'));
		messages.emit(null);
		messages.emit({ type: 'unrelated' });
		expect(() => messages.emit(request(payload), { source: null })).not.toThrow();
		expect(messages.postResponse).not.toHaveBeenCalled();
	});

	test('rejects origins outside the allowlist without replying', () => {
		new ChannelServer({ channelId, allowOrigins: [clientOrigin] }).start();
		expect(() =>
			messages.emit(request({ jsonrpc: '2.0', method: 'add', id: 'blocked' }), { origin: 'https://other.example' })
		).toThrow('Invalid origin');
		expect(messages.postResponse).not.toHaveBeenCalled();
	});

	test('returns InvalidRequest for an invalid JSON-RPC request object', () => {
		new ChannelServer({ channelId }).start();
		messages.emit(request({ jsonrpc: '1.0', method: 'add', id: 'invalid' }));
		expect(messages.postResponse).toHaveBeenCalledWith(
			{
				type: responseType,
				channelId,
				payload: { jsonrpc: '2.0', error: ChannelErrors.InvalidRequest, id: 'invalid' }
			},
			{ targetOrigin: clientOrigin }
		);
	});

	test('does not dispatch requests while stopped', () => {
		const server = new ChannelServer({ channelId });
		server.start();
		server.stop();
		messages.emit(request({ jsonrpc: '2.0', method: 'unknown', id: 'stopped' }));
		expect(messages.postResponse).not.toHaveBeenCalled();
	});
});

describe('RPC calls', () => {
	test('preserves arguments, return values, and the handler receiver', async () => {
		const { client } = connect({
			offset: 4,
			add(a: number, b: number) {
				return this.offset + a + b;
			},
			async greet(name: string) {
				return { greeting: `Hello ${name}` };
			}
		});
		await expect(client.stub.add(2, 3)).resolves.toBe(9);
		await expect(client.stub.greet('world')).resolves.toEqual({ greeting: 'Hello world' });
		expect(messages.postRequest.mock.calls[0][1]).toBe('*');
	});

	test('matches concurrent responses by request id even when they arrive out of order', async () => {
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		const { client } = connect({ value: (key: string) => (key === 'first' ? first.promise : second.promise) });
		const firstCall = client.stub.value('first');
		const secondCall = client.stub.value('second');
		expect(messages.requestId(0)).not.toBe(messages.requestId(1));
		second.resolve('second result');
		await expect(secondCall).resolves.toBe('second result');
		first.resolve('first result');
		await expect(firstCall).resolves.toBe('first result');
	});

	test('rejects missing methods with the public MethodNotFound error', async () => {
		new ChannelServer({ channelId }).start();
		messages.loopback();
		const client = new ChannelClient<{ missing(): void }>({ channelId, target: messages.target });
		await expect(client.stub.missing()).rejects.toEqual(ChannelErrors.MethodNotFound);
	});

	test('maps thrown and rejected handler failures to InternalError', async () => {
		const { client } = connect({
			fail() {
				throw new Error('private error');
			},
			async failAsync() {
				throw new Error('private async error');
			}
		});
		await expect(client.stub.fail()).rejects.toEqual(ChannelErrors.InternalError);
		await expect(client.stub.failAsync()).rejects.toEqual(ChannelErrors.InternalError);
	});

	test('supports wildcard origins', async () => {
		new ChannelServer({ channelId, handler: { value: () => 42 }, allowOrigins: ['*'] }).start();
		messages.loopback();
		const client = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
		await expect(client.stub.value()).resolves.toBe(42);
	});
});

describe('ChannelClient', () => {
	test('validates the target and channel identifier', () => {
		expect(() => new ChannelClient({ channelId, target: null as unknown as WindowProxy })).toThrow(
			'target is required'
		);
		expect(() => new ChannelClient({ channelId: '', target: messages.target })).toThrow('channelId is required');
	});

	test('ignores responses with an unrelated type, channel, or request id', async () => {
		const client = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
		const result = client.stub.value();
		const id = messages.requestId();
		messages.emitResponse({ ...response(id, -1), type: 'unrelated' });
		messages.emitResponse(response(id, -2, 'another-channel'));
		messages.emitResponse(response('another-request', -3));
		messages.emitResponse(response(id, 42));
		await expect(result).resolves.toBe(42);
	});

	test('times out, ignores a late response, and accepts a subsequent request', async () => {
		const client = new ChannelClient<{ value(): number }>({ channelId, target: messages.target, timeout: 20 });
		await expect(client.stub.value()).rejects.toEqual(ChannelErrors.Timeout);
		expect(() => messages.emitResponse(response(messages.requestId(), -1))).not.toThrow();
		const next = client.stub.value();
		messages.emitResponse(response(messages.requestId(1), 42));
		await expect(next).resolves.toBe(42);
	});
});
