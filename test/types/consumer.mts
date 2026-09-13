import {
	ChannelClient,
	ChannelErrors,
	ChannelServer,
	type ChannelTraceEvent,
	type ChannelTraceHandler,
	type RemoteObject
} from 'channel-rpc';

interface Handler {
	add(a: number, b: number): number;
	greet(name: string): Promise<string>;
}

export function useChannel(target: WindowProxy) {
	const handler: Handler = { add: (a, b) => a + b, greet: async (name) => `Hello ${name}` };
	const traces: ChannelTraceEvent[] = [];
	const onTrace: ChannelTraceHandler = (event) => {
		traces.push(event);
		// @ts-expect-error Trace payloads require narrowing before access.
		event.payload.params;
		// @ts-expect-error Trace metadata is read-only.
		event.channelId = 'changed';
	};
	const server = new ChannelServer({ channelId: 'consumer', handler, onTrace });
	new ChannelClient<Handler>({ channelId: server.channelId, target });
	// @ts-expect-error targetOrigin must be a string.
	new ChannelClient<Handler>({ channelId: server.channelId, target, targetOrigin: 42 });
	const client = new ChannelClient<Handler>({
		channelId: server.channelId,
		target,
		targetOrigin: 'https://server.example',
		onTrace: async (event) => {
			await onTrace(event);
		}
	});
	const remote: RemoteObject<Handler> = client.stub;
	const sum: Promise<number> = remote.add(2, 3);
	const greeting: Promise<string> = remote.greet('world');
	const timeout: -32000 = ChannelErrors.Timeout.code;
	// @ts-expect-error Arguments remain typed across the package boundary.
	remote.add('2', 3);
	// @ts-expect-error Only declared methods are available.
	remote.missing();
	// @ts-expect-error Remote calls always return a promise.
	const synchronous: number = remote.add(2, 3);
	return { sum, greeting, timeout, synchronous };
}
