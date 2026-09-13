import { resolve } from 'node:path';
import { root } from '../../scripts/utils';

const port = Number(process.env.RPC_TEST_PORT ?? 4173);
const parentOrigin = `http://127.0.0.1:${port}`;
const childOrigin = `http://127.0.0.1:${port + 1}`;

function parentPage(mode: string) {
	return `<!doctype html><html lang="en"><head><title>Channel RPC parent</title></head><body>
		<iframe title="RPC client"></iframe>
		<script type="module">
			import { ChannelServer } from '/dist/index.js';
			const mode = ${JSON.stringify(mode)};
			window.traceEvents = [];
			const server = new ChannelServer({
				channelId: 'browser-test',
				onTrace: mode === 'trace' ? (event) => { window.traceEvents.push(event); } : undefined,
				allowOrigins: [mode === 'deny' ? ${JSON.stringify(parentOrigin)} : ${JSON.stringify(childOrigin)}],
				handler: {
					add: (a, b) => a + b,
					double: async (value) => value * 2,
					echo: (value) => value,
					fail: () => { throw new Error(mode === 'trace' ? 'redacted-session-secret' : 'private failure'); }
				}
			});
			server.start();
			document.querySelector('iframe').src = ${JSON.stringify(childOrigin)} + '/child.html?mode=' + mode;
		</script>
	</body></html>`;
}

const childPage = `<!doctype html><html lang="en"><head><title>Channel RPC child</title></head><body>
	<output id="result">pending</output>
	<script type="module">
		import { ChannelClient } from '/dist/index.js';
		const mode = new URL(location.href).searchParams.get('mode');
		window.traceEvents = [];
		const client = new ChannelClient({
			target: window.parent,
			channelId: 'browser-test',
			timeout: mode === 'deny' ? 500 : 2000,
			onTrace: mode === 'trace' ? (event) => { window.traceEvents.push(event); } : undefined
		});
		const errorCode = async (call) => { try { await call; return null; } catch (error) { return error.code; } };
		try {
			const result = mode === 'deny'
				? [await errorCode(client.stub.add(2, 3))]
				: mode === 'errors'
					? await Promise.all([errorCode(client.stub.missing()), errorCode(client.stub.fail())])
					: mode === 'trace'
						? [await client.stub.echo({ nested: [{ value: 'redacted-wallet-token' }] }), await errorCode(client.stub.fail())]
						: await Promise.all([client.stub.add(2, 3), client.stub.double(7)]);
			document.querySelector('#result').textContent = JSON.stringify(result);
		} catch (error) {
			document.querySelector('#result').textContent = 'Unexpected error: ' + JSON.stringify(error);
		}
	</script>
</body></html>`;

function fetch(request: Request) {
	const url = new URL(request.url);
	if (url.pathname === '/health') return new Response('ok');
	if (url.pathname === '/dist/index.js') return new Response(Bun.file(resolve(root, 'dist/index.js')));
	if (url.pathname === '/parent.html') {
		const mode = url.searchParams.get('mode') ?? 'success';
		if (!['success', 'errors', 'deny', 'trace'].includes(mode)) return new Response('Unknown mode', { status: 400 });
		return new Response(parentPage(mode), { headers: { 'content-type': 'text/html' } });
	}
	if (url.pathname === '/child.html') return new Response(childPage, { headers: { 'content-type': 'text/html' } });
	return new Response('Not found', { status: 404 });
}

const servers = [port, port + 1].map((serverPort) => Bun.serve({ hostname: '127.0.0.1', port: serverPort, fetch }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		for (const server of servers) server.stop(true);
		process.exit(0);
	});
}
console.log(`Browser fixtures: ${parentOrigin} and ${childOrigin}`);
