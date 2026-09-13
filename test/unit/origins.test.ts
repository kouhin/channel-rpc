import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ChannelClient, ChannelErrors, ChannelServer, type ChannelTraceEvent } from '../../src';
import { channelId, clientOrigin, messageHarness, requestType, responseType, serverOrigin } from './messages';

let messages: ReturnType<typeof messageHarness>;
beforeEach(() => {
	messages = messageHarness();
});
afterEach(() => {
	messages.restore();
});

function response(id: string, result: unknown = 42) {
	return { type: responseType, channelId, payload: { jsonrpc: '2.0', id, result } };
}

describe('client targetOrigin', () => {
	test.each([
		[undefined, '*', serverOrigin],
		['*', '*', 'null'],
		[serverOrigin, serverOrigin, serverOrigin],
		['https://SERVER.example:443/path?query=1#fragment', serverOrigin, serverOrigin],
		['http://localhost:8080/', 'http://localhost:8080', 'http://localhost:8080'],
		['/', clientOrigin, clientOrigin]
	])('sends and accepts replies using %s', async (targetOrigin, expectedOrigin, replyOrigin) => {
		const client = new ChannelClient<{ value(): number }>({
			channelId,
			target: messages.target,
			...(targetOrigin === undefined ? {} : { targetOrigin })
		});
		// The '/' origin is captured at construction, not read again for each call.
		Object.defineProperty(globalThis, 'origin', { value: 'https://changed.example' });
		const pending = client.stub.value();
		expect(messages.postRequest.mock.calls[0][1]).toBe(expectedOrigin);
		messages.emitResponse(response(messages.requestId()), { origin: replyOrigin });
		await expect(pending).resolves.toBe(42);
	});

	test.each([
		'',
		' ',
		'null',
		'not a URL',
		'/relative',
		'data:text/html,hello',
		'about:blank',
		'file:///tmp/page.html'
	])('rejects invalid or opaque targetOrigin %s before registering a listener', (targetOrigin) => {
		expect(() => new ChannelClient({ channelId, target: messages.target, targetOrigin })).toThrow(
			new TypeError('Invalid targetOrigin')
		);
		expect(messages.listeners.size).toBe(0);
		expect(messages.postRequest).not.toHaveBeenCalled();
	});

	test.each(['null', undefined])('rejects / when the current window origin is %s', (origin) => {
		Object.defineProperty(globalThis, 'origin', { value: origin });
		expect(() => new ChannelClient({ channelId, target: messages.target, targetOrigin: '/' })).toThrow(
			new TypeError('Invalid targetOrigin')
		);
		expect(messages.listeners.size).toBe(0);
	});

	test.each([undefined, '*', serverOrigin])(
		'filters other windows before tracing with targetOrigin %s',
		async (targetOrigin) => {
			const events: ChannelTraceEvent[] = [];
			const client = new ChannelClient<{ value(): number }>({
				channelId,
				target: messages.target,
				targetOrigin,
				onTrace: (event) => {
					events.push(event);
				}
			});
			const pending = client.stub.value();
			const id = messages.requestId();
			for (const source of [messages.source, null]) {
				messages.emitResponse(response(id, 'forged'), { source });
				expect(() => messages.emitResponse({ type: responseType, channelId, payload: null }, { source })).not.toThrow();
			}
			expect(events.map((event) => event.event)).toEqual(['send_request']);
			messages.emitResponse(response(id));
			await expect(pending).resolves.toBe(42);
			expect(events.map((event) => event.event)).toEqual(['send_request', 'receive_response']);
		}
	);

	test('filters wrong origins from the target without consuming the pending request or tracing the body', async () => {
		const onTrace = mock((_event: ChannelTraceEvent) => {});
		const client = new ChannelClient<{ value(): number }>({
			channelId,
			target: messages.target,
			targetOrigin: serverOrigin,
			onTrace
		});
		const pending = client.stub.value();
		for (const origin of [
			'http://server.example',
			'https://server.example:8443',
			'https://other.example',
			'null',
			''
		]) {
			messages.emitResponse(response(messages.requestId(), 'forged'), { origin });
			expect(() => messages.emitResponse({ type: responseType, channelId, payload: null }, { origin })).not.toThrow();
		}
		expect(onTrace).toHaveBeenCalledTimes(1);
		messages.emitResponse(response(messages.requestId()));
		await expect(pending).resolves.toBe(42);
		expect(onTrace).toHaveBeenCalledTimes(2);
	});

	test('times out when only an untrusted response arrives', async () => {
		const client = new ChannelClient<{ value(): number }>({
			channelId,
			target: messages.target,
			targetOrigin: serverOrigin,
			timeout: 20
		});
		const pending = client.stub.value();
		messages.emitResponse(response(messages.requestId()), { origin: clientOrigin });
		await expect(pending).rejects.toEqual(ChannelErrors.Timeout);
	});

	test('keeps the normalized origin independent between clients sharing a target', async () => {
		const clients = [serverOrigin, clientOrigin].map(
			(targetOrigin) => new ChannelClient<{ value(): number }>({ channelId, target: messages.target, targetOrigin })
		);
		const pending = clients.map((client) => client.stub.value());
		messages.emitResponse(response(messages.requestId(0), -1), { origin: clientOrigin });
		messages.emitResponse(response(messages.requestId(1), 2), { origin: clientOrigin });
		messages.emitResponse(response(messages.requestId(0), 1));
		await expect(Promise.all(pending)).resolves.toEqual([1, 2]);
	});
});

describe('server reply origins', () => {
	test.each([
		['value', '2.0', undefined],
		['valueAsync', '2.0', undefined],
		['value', '1.0', ChannelErrors.InvalidRequest],
		['missing', '2.0', ChannelErrors.MethodNotFound],
		['fail', '2.0', ChannelErrors.InternalError],
		['failAsync', '2.0', ChannelErrors.InternalError]
	] as const)('replies to the original origin for %s (%s)', async (method, jsonrpc, error) => {
		new ChannelServer({
			channelId,
			allowOrigins: [clientOrigin],
			handler: {
				value: () => 42,
				valueAsync: async () => 42,
				fail: () => {
					throw new Error('private');
				},
				failAsync: async () => {
					throw new Error('private');
				}
			}
		}).start();
		messages.emit({ type: requestType, channelId, payload: { jsonrpc, method, id: 'reply' } });
		await Promise.resolve();
		expect(messages.postResponse).toHaveBeenCalledWith(
			{
				type: responseType,
				channelId,
				payload: { jsonrpc: '2.0', id: 'reply', ...(error ? { error } : { result: 42 }) }
			},
			{ targetOrigin: clientOrigin }
		);
	});

	test.each(['omitted', 'empty', 'wildcard', 'opaque'])(
		'preserves opaque-origin replies with an %s allowlist',
		async (mode) => {
			const allowOrigins =
				mode === 'omitted' ? undefined : mode === 'empty' ? [] : [mode === 'wildcard' ? '*' : 'null'];
			new ChannelServer({ channelId, allowOrigins, handler: { value: () => 42 } }).start();
			messages.emit(
				{ type: requestType, channelId, payload: { jsonrpc: '2.0', method: 'value', id: 'opaque' } },
				{ origin: 'null' }
			);
			await Promise.resolve();
			expect(messages.postResponse.mock.calls[0][1]).toEqual({ targetOrigin: '*' });
		}
	);

	test('applies the allowlist before allowing an opaque-origin request', () => {
		const handler = { value: mock(() => 42) };
		const onTrace = mock((_event: ChannelTraceEvent) => {});
		new ChannelServer({ channelId, allowOrigins: [clientOrigin], handler, onTrace }).start();
		expect(() =>
			messages.emit(
				{ type: requestType, channelId, payload: { jsonrpc: '2.0', method: 'value', id: 'opaque' } },
				{ origin: 'null' }
			)
		).toThrow('Invalid origin');
		expect(handler.value).not.toHaveBeenCalled();
		expect(onTrace).not.toHaveBeenCalled();
		expect(messages.postResponse).not.toHaveBeenCalled();
	});

	test('retains each source and origin across out-of-order asynchronous handlers', async () => {
		const gates = [Promise.withResolvers<number>(), Promise.withResolvers<number>(), Promise.withResolvers<number>()];
		const senders = [mock((_data: unknown, _options: unknown) => {}), mock((_data: unknown, _options: unknown) => {})];
		const sources = senders.map((postMessage) => ({ postMessage }) as unknown as WindowProxy);
		const origins = [clientOrigin, 'https://second.example', 'https://navigated.example'];
		new ChannelServer({ channelId, handler: { value: (index: number) => gates[index].promise } }).start();
		for (const index of [0, 1, 2]) {
			messages.emit(
				{
					type: requestType,
					channelId,
					payload: { jsonrpc: '2.0', method: 'value', params: [index], id: 'shared-id' }
				},
				{ source: sources[index % 2], origin: origins[index] }
			);
		}
		for (const index of [2, 1, 0]) {
			gates[index].resolve(index);
			await Promise.resolve();
			expect(senders[index % 2]).toHaveBeenLastCalledWith(response('shared-id', index), {
				targetOrigin: origins[index]
			});
		}
		expect(senders[0]).toHaveBeenCalledTimes(2);
		expect(senders[1]).toHaveBeenCalledTimes(1);
	});
});
