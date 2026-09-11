import rpc = require('channel-rpc');

interface Handler {
	add(a: number, b: number): number;
	greet(name: string): Promise<string>;
}

export function useChannel(target: WindowProxy) {
	const handler: Handler = { add: (a, b) => a + b, greet: async (name) => `Hello ${name}` };
	const server = new rpc.ChannelServer({ channelId: 'consumer', handler });
	const client = new rpc.ChannelClient<Handler>({ channelId: server.channelId, target });
	const remote: rpc.RemoteObject<Handler> = client.stub;
	const sum: Promise<number> = remote.add(2, 3);
	const greeting: Promise<string> = remote.greet('world');
	const timeout: -32000 = rpc.ChannelErrors.Timeout.code;
	// @ts-expect-error CommonJS consumers retain argument checking.
	remote.add('2', 3);
	// @ts-expect-error Only declared methods are available.
	remote.missing();
	// @ts-expect-error Remote calls always return a promise.
	const synchronous: number = remote.add(2, 3);
	return { sum, greeting, timeout, synchronous };
}
