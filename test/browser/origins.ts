import type { ChannelTraceEvent } from '../../src';

declare global {
	interface Window {
		rpcTest: {
			messages: { data: { type: string; payload: unknown }; origin: string }[];
			events: ChannelTraceEvent[];
			requestId: string;
			waiting: boolean;
			done: boolean;
			result: unknown;
			startServer(allowOrigins?: string[], source?: WindowProxy): void;
			startClient(target: WindowProxy, targetOrigin?: string, timeout?: number): void;
			disposeClient(): void;
			call(method: 'echo' | 'wait', value?: unknown): void;
			release(value: unknown): void;
			flush(target: WindowProxy): Promise<void>;
		};
	}
}

// Test-only controls keep navigation and delayed responses deterministic.
export const originPage = `<!doctype html><html lang="en"><head><title>Origin test</title></head><body>
	<script type="module">
		import { ChannelClient, ChannelServer } from '/dist/index.js';
		let client;
		let barrierId = 0;
		const onTrace = (event) => {
			state.events.push(event);
			if (event.event === 'send_request') state.requestId = event.payload.id;
		};
		const state = window.rpcTest = {
			messages: [], events: [], requestId: '', waiting: false, done: false, result: undefined,
			release: () => {},
			startServer(allowOrigins, source) {
				new ChannelServer({ channelId: 'origins', allowOrigins, source, onTrace, handler: {
					echo: (value) => value,
					wait: () => new Promise((resolve) => { state.release = resolve; state.waiting = true; })
				} }).start();
			},
			startClient(target, targetOrigin, timeout = 2000) {
				client = new ChannelClient({ channelId: 'origins', target, timeout, onTrace,
					...(targetOrigin === undefined ? {} : { targetOrigin }) });
			},
			disposeClient() { client.dispose(); },
			call(method, value) {
				state.done = false;
				client.stub[method](value).then(
					(result) => { state.result = result; state.done = true; },
					(error) => { state.result = error; state.done = true; }
				);
			},
			flush(target) {
				const id = ++barrierId;
				return new Promise((resolve) => {
					const listener = (event) => {
						if (event.source === target && event.data?.kind === 'ack' && event.data.id === id) {
							removeEventListener('message', listener);
							resolve();
						}
					};
					addEventListener('message', listener);
					target.postMessage({ kind: 'barrier', id }, '*');
				});
			}
		};
		addEventListener('message', (event) => {
			if (event.data?.kind === 'barrier') event.source.postMessage({ kind: 'ack', id: event.data.id }, { targetOrigin: '*' });
			if (event.data?.type?.startsWith('@channel-rpc/')) state.messages.push({ data: event.data, origin: event.origin });
		});
	</script>
</body></html>`;
