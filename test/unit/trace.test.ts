import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import {
	ChannelClient,
	ChannelErrors,
	ChannelServer,
	type ChannelTraceEvent,
	type ChannelTraceHandler
} from '../../src';
import { channelId, clientOrigin, messageHarness, requestType, responseType } from './messages';

let messages: ReturnType<typeof messageHarness>;
beforeEach(() => {
	messages = messageHarness();
});
afterEach(() => {
	messages.restore();
});

function connect<T extends object>(handler: T, onTrace: ChannelTraceHandler, channel = channelId) {
	new ChannelServer({ channelId: channel, handler, onTrace }).start();
	messages.loopback();
	return new ChannelClient<T>({ channelId: channel, target: messages.target, timeout: 100, onTrace });
}

test('traces each communication boundary once and exposes the original local values', async () => {
	const events: ChannelTraceEvent[] = [];
	const sendCounts: number[] = [];
	const value = { nested: [{ value: 'redacted-session-secret' }] };
	let received: unknown;
	const client = connect(
		{
			echo(input: unknown) {
				received = input;
				return input;
			}
		},
		(event) => {
			events.push(event);
			if (event.event === 'send_request') sendCounts.push(messages.postRequest.mock.calls.length);
			if (event.event === 'send_response') sendCounts.push(messages.postResponse.mock.calls.length);
		}
	);
	const result = await client.stub.echo(value);
	expect(result).toEqual(value);
	expect(sendCounts).toEqual([0, 0]);
	expect(events.map((event) => event.event)).toEqual([
		'send_request',
		'receive_request',
		'send_response',
		'receive_response'
	]);
	expect(events.every((event) => event.channelId === channelId)).toBe(true);
	expect((events[0].payload as { params: unknown[] }).params[0]).toBe(value);
	expect((events[1].payload as { params: unknown[] }).params[0]).toBe(received);
	expect((events[2].payload as { result: unknown }).result).toBe(received);
	expect((events[3].payload as { result: unknown }).result).toBe(result);
	expect(Object.isFrozen(value)).toBe(false);
});

test('exposes synchronous and asynchronous handler failures while preserving InternalError', async () => {
	const events: ChannelTraceEvent[] = [];
	const syncError = new Error('redacted-session-secret');
	const asyncError = { nested: ['redacted-wallet-token'] };
	const client = connect(
		{
			fail() {
				throw syncError;
			},
			async failAsync() {
				throw asyncError;
			}
		},
		(event) => {
			events.push(event);
		}
	);
	await expect(client.stub.fail()).rejects.toEqual(ChannelErrors.InternalError);
	await expect(client.stub.failAsync()).rejects.toEqual(ChannelErrors.InternalError);
	const failures = events.filter((event) => event.event === 'handler_error');
	expect(failures).toHaveLength(2);
	expect(failures[0].error).toBe(syncError);
	expect(failures[1].error).toBe(asyncError);
	expect(failures[0].payload).toBe(events[1].payload);
	expect(events.slice(0, 5).map((event) => event.event)).toEqual([
		'send_request',
		'receive_request',
		'handler_error',
		'send_response',
		'receive_response'
	]);
});

test.each(['throw', 'reject', 'pending'])('isolates a callback that returns %s on either side', async (mode) => {
	let calls = 0;
	const client = connect(
		{
			value: () => 42,
			fail: () => {
				throw new Error('handler failure');
			}
		},
		() => {
			calls++;
			if (mode === 'throw') throw new Error('diagnostic failure');
			if (mode === 'reject') return Promise.reject(new Error('diagnostic failure'));
			return new Promise<void>(() => {});
		}
	);
	await expect(client.stub.value()).resolves.toBe(42);
	await expect(client.stub.fail()).rejects.toEqual(ChannelErrors.InternalError);
	expect(calls).toBe(9);
});

test('keeps callbacks isolated between client and server instances during concurrent calls', async () => {
	const clientEvents: ChannelTraceEvent[][] = [[], []];
	const serverEvents: ChannelTraceEvent[][] = [[], []];
	const gates = [Promise.withResolvers<number>(), Promise.withResolvers<number>()];
	const clients = gates.map((gate, index) => {
		const channel = `trace-${index}`;
		new ChannelServer({
			channelId: channel,
			handler: { value: () => gate.promise },
			onTrace: (event) => {
				serverEvents[index].push(event);
			}
		}).start();
		return new ChannelClient<{ value(): Promise<number> }>({
			channelId: channel,
			target: messages.target,
			onTrace: (event) => {
				clientEvents[index].push(event);
			}
		});
	});
	messages.loopback();
	const results = clients.map((client) => client.stub.value());
	gates[1].resolve(2);
	await expect(results[1]).resolves.toBe(2);
	gates[0].resolve(1);
	await expect(results[0]).resolves.toBe(1);
	for (const index of [0, 1]) {
		expect(clientEvents[index].map((event) => event.event)).toEqual(['send_request', 'receive_response']);
		expect(serverEvents[index].map((event) => event.event)).toEqual(['receive_request', 'send_response']);
		for (const event of [...clientEvents[index], ...serverEvents[index]]) {
			expect(event.channelId).toBe(`trace-${index}`);
			expect((event.payload as { id: string }).id).toBe(messages.requestId(index));
		}
	}
});

test('traces requests after source checks and before JSON-RPC validation', () => {
	const onTrace = mock((_event: ChannelTraceEvent) => {});
	new ChannelServer({ channelId, onTrace, allowOrigins: [clientOrigin] }).start();
	const request = { type: requestType, channelId, payload: { jsonrpc: '1.0', id: 'invalid' } };
	messages.emit({ ...request, channelId: 'other' });
	messages.emit(request, { source: null });
	expect(() => messages.emit(request, { origin: 'https://other.example' })).toThrow('Invalid origin');
	expect(onTrace).not.toHaveBeenCalled();
	messages.emit(request);
	expect(onTrace.mock.calls.map(([event]) => event.event)).toEqual(['receive_request', 'send_response']);
	expect(onTrace.mock.calls[0][0].payload).toBe(request.payload);
	expect(onTrace.mock.calls[1][0].payload).toEqual({
		jsonrpc: '2.0',
		id: 'invalid',
		error: ChannelErrors.InvalidRequest
	});
});

test('preserves remote error identity and gives the trace callback the same response', async () => {
	const events: ChannelTraceEvent[] = [];
	const client = new ChannelClient<{ value(): number }>({
		channelId,
		target: messages.target,
		onTrace: (event) => {
			events.push(event);
		}
	});
	const error = { code: -32001, message: 'redacted-session-secret', data: ['redacted-wallet-token'] };
	const pending = client.stub.value();
	const payload = { jsonrpc: '2.0', id: messages.requestId(), error };
	messages.emitResponse({ type: responseType, channelId, payload });
	await expect(pending).rejects.toBe(error);
	expect(events[1].payload).toBe(payload);
	let thrown: unknown;
	try {
		messages.emitResponse({ type: responseType, channelId, payload: { ...payload, id: null } });
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown).toBe(error);
});
