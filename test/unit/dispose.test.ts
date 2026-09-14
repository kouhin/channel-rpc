import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { ChannelClient, ChannelErrors, type ChannelTraceEvent } from '../../src';
import { channelId, messageHarness, responseType } from './messages';

let messages: ReturnType<typeof messageHarness>;
beforeEach(() => {
	messages = messageHarness();
});
afterEach(() => {
	mock.restore();
	messages.restore();
});

function response(id: string, result: unknown = 42) {
	return { type: responseType, channelId, payload: { jsonrpc: '2.0', id, result } };
}

test('disposes idempotently, rejects all pending calls, and clears their timers', async () => {
	const schedule = spyOn(globalThis, 'setTimeout');
	const clear = spyOn(globalThis, 'clearTimeout');
	const remove = spyOn(globalThis, 'removeEventListener');
	const client = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
	const value = client.stub.value;
	const pending = Promise.allSettled([value(), value()]);
	const timers = schedule.mock.results.map((result) => result.value);
	expect(timers).toHaveLength(2);
	expect(messages.listeners.size).toBe(1);

	client.dispose();
	client.dispose();
	expect(messages.listeners.size).toBe(0);
	expect(remove).toHaveBeenCalledTimes(1);
	expect(clear).toHaveBeenCalledTimes(2);
	for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer);
	await expect(pending).resolves.toEqual([
		{ status: 'rejected', reason: ChannelErrors.Disposed },
		{ status: 'rejected', reason: ChannelErrors.Disposed }
	]);

	await expect(value()).rejects.toEqual(ChannelErrors.Disposed);
	await expect(client.stub.value()).rejects.toEqual(ChannelErrors.Disposed);
	expect(schedule).toHaveBeenCalledTimes(2);
	expect(messages.postRequest).toHaveBeenCalledTimes(2);
});

test('can dispose before the first call without sending or tracing', async () => {
	const onTrace = mock((_event: ChannelTraceEvent) => {});
	const client = new ChannelClient<{ value(): number }>({ channelId, target: messages.target, onTrace });
	client.dispose();
	await expect(client.stub.value()).rejects.toEqual(ChannelErrors.Disposed);
	expect(messages.listeners.size).toBe(0);
	expect(messages.postRequest).not.toHaveBeenCalled();
	expect(onTrace).not.toHaveBeenCalled();
});

test('ignores late success, error, and malformed responses without tracing them', async () => {
	const events: ChannelTraceEvent[] = [];
	const client = new ChannelClient<{ value(): number }>({
		channelId,
		target: messages.target,
		onTrace: (event) => {
			events.push(event);
		}
	});
	const pending = client.stub.value();
	client.dispose();
	await expect(pending).rejects.toEqual(ChannelErrors.Disposed);
	for (const payload of [
		response(messages.requestId()).payload,
		{ jsonrpc: '2.0', id: messages.requestId(), error: ChannelErrors.InternalError },
		{ jsonrpc: '2.0', id: null, error: ChannelErrors.InternalError },
		null
	]) {
		expect(() => messages.emitResponse({ type: responseType, channelId, payload })).not.toThrow();
	}
	expect(events.map((event) => event.event)).toEqual(['send_request']);
});

test('leaves other clients listening and permits a replacement client on the same channel', async () => {
	const first = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
	const second = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
	const pending = first.stub.value();
	const surviving = second.stub.value();
	first.dispose();
	expect(messages.listeners.size).toBe(1);
	await expect(pending).rejects.toEqual(ChannelErrors.Disposed);
	messages.emitResponse(response(messages.requestId(1)));
	await expect(surviving).resolves.toBe(42);
	const replacement = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
	const next = replacement.stub.value();
	messages.emitResponse(response(messages.requestId(2), 43));
	await expect(next).resolves.toBe(43);
	second.dispose();
	replacement.dispose();
	expect(messages.listeners.size).toBe(0);
});

test.each(['success', 'error'])('preserves an already settled %s before promise callbacks run', async (outcome) => {
	const client = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
	const pending = client.stub.value();
	const id = messages.requestId();
	const payload =
		outcome === 'success'
			? { jsonrpc: '2.0', id, result: 42 }
			: { jsonrpc: '2.0', id, error: ChannelErrors.InternalError };
	messages.emitResponse({ type: responseType, channelId, payload });
	client.dispose();
	if (outcome === 'success') await expect(pending).resolves.toBe(42);
	else await expect(pending).rejects.toEqual(ChannelErrors.InternalError);
});

test.each([new DOMException('Cannot clone value', 'DataCloneError'), null])(
	'cleans up a synchronous send failure and preserves the original rejection: %s',
	async (error) => {
		const schedule = spyOn(globalThis, 'setTimeout');
		const clear = spyOn(globalThis, 'clearTimeout');
		const client = new ChannelClient<{ value(): number }>({ channelId, target: messages.target });
		messages.postRequest.mockImplementationOnce(() => {
			throw error;
		});
		await expect(client.stub.value()).rejects.toBe(error);
		expect(clear).toHaveBeenCalledWith(schedule.mock.results[0].value);
		const next = client.stub.value();
		messages.emitResponse(response(messages.requestId(1)));
		await expect(next).resolves.toBe(42);
		expect(clear).toHaveBeenCalledTimes(2);
		client.dispose();
		expect(clear).toHaveBeenCalledTimes(2);
	}
);

test('does not send if the send_request trace disposes the client', async () => {
	const client = new ChannelClient<{ value(): number }>({
		channelId,
		target: messages.target,
		onTrace: () => {
			client.dispose();
		}
	});
	await expect(client.stub.value()).rejects.toEqual(ChannelErrors.Disposed);
	expect(messages.postRequest).not.toHaveBeenCalled();
	expect(messages.listeners.size).toBe(0);
});

test.each(['success', 'invalid'])('stops handling a %s response if its trace disposes the client', async (outcome) => {
	const events: ChannelTraceEvent[] = [];
	const client = new ChannelClient<{ value(): number }>({
		channelId,
		target: messages.target,
		onTrace: (event) => {
			events.push(event);
			if (event.event === 'receive_response') client.dispose();
		}
	});
	const pending = client.stub.value();
	const payload = outcome === 'success' ? response(messages.requestId()).payload : null;
	expect(() => messages.emitResponse({ type: responseType, channelId, payload })).not.toThrow();
	await expect(pending).rejects.toEqual(ChannelErrors.Disposed);
	expect(events.map((event) => event.event)).toEqual(['send_request', 'receive_response']);
});
