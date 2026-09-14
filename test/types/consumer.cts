import rpc = require('channel-rpc');

interface Handler {
	add(a: number, b: number): number;
	greet(name: string): Promise<string>;
}

export function useChannel(target: WindowProxy) {
	const handler: Handler = { add: (a, b) => a + b, greet: async (name) => `Hello ${name}` };
	const traces: rpc.ChannelTraceEvent[] = [];
	const onTrace: rpc.ChannelTraceHandler = (event) => {
		traces.push(event);
		// @ts-expect-error CommonJS trace payloads also require narrowing.
		event.payload.params;
	};
	const server = new rpc.ChannelServer({ channelId: 'consumer', source: target, handler, onTrace });
	new rpc.ChannelServer({ channelId: 'unbound', handler });
	// @ts-expect-error source must be a window reference.
	new rpc.ChannelServer({ channelId: 'invalid', source: 42 });
	new rpc.ChannelClient<Handler>({ channelId: server.channelId, target });
	// @ts-expect-error targetOrigin must be a string.
	new rpc.ChannelClient<Handler>({ channelId: server.channelId, target, targetOrigin: 42 });
	const client = new rpc.ChannelClient<Handler>({
		channelId: server.channelId,
		target,
		targetOrigin: 'https://server.example',
		onTrace: async (event) => {
			await onTrace(event);
		}
	});
	const remote: rpc.RemoteObject<Handler> = client.stub;
	const sum: Promise<number> = remote.add(2, 3);
	const greeting: Promise<string> = remote.greet('world');
	const timeout: -32000 = rpc.ChannelErrors.Timeout.code;
	const disposed: -32097 = rpc.ChannelErrors.Disposed.code;
	// @ts-expect-error CommonJS consumers retain argument checking.
	remote.add('2', 3);
	// @ts-expect-error Only declared methods are available.
	remote.missing();
	// @ts-expect-error Remote calls always return a promise.
	const synchronous: number = remote.add(2, 3);
	client.dispose();
	return { sum, greeting, timeout, disposed, synchronous };
}
