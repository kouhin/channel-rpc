import { mock } from 'bun:test';

export const requestType = '@channel-rpc/REQUEST';
export const responseType = '@channel-rpc/RESPONSE';
export const channelId = 'test-channel';
export const clientOrigin = 'https://client.example';
export const serverOrigin = 'https://server.example';

export function messageHarness() {
	const listeners = new Set<EventListenerOrEventListenerObject>();
	const properties = ['addEventListener', 'removeEventListener', 'origin'] as const;
	const original = properties.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperties(globalThis, {
		origin: { configurable: true, value: clientOrigin },
		addEventListener: {
			configurable: true,
			value: (type: string, listener: EventListenerOrEventListenerObject) => {
				if (type === 'message') listeners.add(listener);
			}
		},
		removeEventListener: {
			configurable: true,
			value: (type: string, listener: EventListenerOrEventListenerObject) => {
				if (type === 'message') listeners.delete(listener);
			}
		}
	});

	const postRequest = mock((_data: unknown, _origin: string) => {});
	const target = { postMessage: postRequest } as unknown as WindowProxy;
	const postResponse = mock((data: unknown, _options: unknown) => {
		queueMicrotask(() => emitResponse(structuredClone(data)));
	});
	const source = { postMessage: postResponse } as unknown as WindowProxy;

	function emit(data: unknown, options: { origin?: string; source?: MessageEventSource | null } = {}) {
		const event = {
			type: 'message',
			data,
			origin: options.origin ?? clientOrigin,
			source: options.source === undefined ? source : options.source
		} as MessageEvent;
		for (const listener of listeners) {
			if (typeof listener === 'function') listener(event);
			else listener.handleEvent(event);
		}
	}

	function emitResponse(data: unknown, options: { origin?: string; source?: MessageEventSource | null } = {}) {
		emit(data, { source: target, origin: serverOrigin, ...options });
	}

	return {
		target,
		source,
		postRequest,
		postResponse,
		listeners,
		emit,
		emitResponse,
		loopback() {
			postRequest.mockImplementation((data) => queueMicrotask(() => emit(structuredClone(data))));
		},
		requestId(index = 0): string {
			return (postRequest.mock.calls[index][0] as { payload: { id: string } }).payload.id;
		},
		restore() {
			listeners.clear();
			properties.forEach((name, index) => {
				const descriptor = original[index];
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			});
		}
	};
}
