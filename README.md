# channel-rpc

[![npm version](https://img.shields.io/npm/v/channel-rpc.svg)](https://www.npmjs.com/package/channel-rpc)
[![CI](https://github.com/kouhin/channel-rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/kouhin/channel-rpc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Typed remote function calls between browser windows and iframes, using JSON-RPC
request/response messages over `postMessage`.

- Infer remote method arguments and return types from a TypeScript handler.
- Call synchronous or asynchronous handlers through a Promise-based API.
- Separate conversations by channel, configure request timeouts, and filter
  incoming requests by origin.
- Use the library without runtime dependencies.

## Installation

```sh
npm install channel-rpc
```

The library requires a browser window with `postMessage`, `Proxy`, and `Promise`.
The repository builds ES2020 JavaScript in ESM and CommonJS formats, with separate
TypeScript declarations. Bun is only needed for development.

## Quick start

This example exposes a parent page's methods to an embedded iframe. Assume the
parent is hosted at `https://app.example` and the iframe at
`https://widget.example`. Replace these URLs with your own, and bundle each
TypeScript file into its corresponding page.

### 1. Expose methods in the parent page

`parent.ts`:

```ts
import { ChannelServer } from 'channel-rpc';

const handler = {
	add(a: number, b: number) {
		return a + b;
	},
	async greet(name: string) {
		return `Hello, ${name}!`;
	}
};

export type Handler = typeof handler;

const server = new ChannelServer({
	channelId: 'example',
	allowOrigins: ['https://widget.example'],
	handler
});

server.start();

// Mount the iframe after the server is listening. Run this after <body> exists.
const iframe = document.createElement('iframe');
iframe.title = 'RPC example';
iframe.src = 'https://widget.example';
document.body.append(iframe);
```

### 2. Call those methods from the iframe

`child.ts`:

```ts
import { ChannelClient } from 'channel-rpc';
import type { Handler } from './parent';

const client = new ChannelClient<Handler>({
	target: window.parent,
	targetOrigin: 'https://app.example',
	channelId: 'example',
	timeout: 5000
});

async function main() {
	const sum = await client.stub.add(2, 3); // 5
	const greeting = await client.stub.greet('Ada'); // 'Hello, Ada!'
	console.log({ sum, greeting });
}

void main().catch(console.error);
```

The channel IDs must match. `import type` shares the handler's contract without
running the parent module in the iframe. For separate projects, put that contract
in a shared type module instead.

Every remote call returns a promise, including calls to synchronous handlers.
Start the server before the client makes its first call: there is no readiness
handshake or automatic retry.

## API

### `new ChannelServer<T>(options)`

Registers an object's methods for callers on the selected channel.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `channelId` | `string` | Required | Non-empty channel identifier shared with the client. |
| `handler` | `T` | `{}` | Object whose own enumerable function properties are registered as handlers. |
| `allowOrigins` | `string[]` | `[]` | Exact origins allowed to send requests. An empty list or a list containing `'*'` permits any origin. |
| `onTrace` | `ChannelTraceHandler` | Unset | Optional observer of raw requests, responses, and handler failures. See [Debugging](#debugging). |

Handlers are registered at construction and bound to the supplied object, so
method calls retain their `this` value. Class prototype methods are not registered.

| Method | Behavior |
| --- | --- |
| `start(): void` | Attach the message listener. Repeated calls have no additional effect. |
| `stop(): void` | Detach the listener. The server can be started again later. |

Call `server.stop()` when the owning component is disposed. It stops accepting new
requests; handlers already running can still finish and send responses.

### `new ChannelClient<T>(options)`

Creates a client and starts listening for responses immediately.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `target` | `WindowProxy` | Required | The window hosting the server, such as `window.parent` or an iframe's `contentWindow`. |
| `targetOrigin` | `string` | `'*'` | Origin required for request delivery and incoming responses. An absolute URL is normalized to its origin; `'/'` selects the current window's origin at construction. `'*'` accepts any origin, but responses must still come from `target`. |
| `channelId` | `string` | Required | The server's channel identifier. |
| `timeout` | `number` | `1000` | Request timeout in milliseconds. Use a positive value; `0` falls back to the default. |
| `onTrace` | `ChannelTraceHandler` | Unset | Optional observer of raw requests and responses. See [Debugging](#debugging). |

Invalid URLs, empty strings, `'null'`, and URLs with opaque origins throw
`TypeError('Invalid targetOrigin')` at construction. Using `'/'` also throws if
the current window has an opaque origin. Invalid configuration never falls back
to `'*'`.

Call remote methods through `client.stub`. Its type is `RemoteObject<T>`, an
exported mapped type that preserves method arguments and wraps synchronous return
values in promises. Asynchronous methods retain their promise return types.

A timeout rejects the waiting call; it does not cancel the remote handler or
retry the request. Reuse client instances: the client API has no `stop()`
or `dispose()` method to remove its message listener.

### `ChannelErrors`

RPC failures reject with an object containing `code` and `message`, rather than an
`Error` instance. Compare codes using the exported constants:

| Constant | Code | Meaning |
| --- | --- | --- |
| `ChannelErrors.InvalidRequest` | `-32600` | The server received an invalid JSON-RPC request. |
| `ChannelErrors.MethodNotFound` | `-32601` | No handler was found for the requested method. |
| `ChannelErrors.InternalError` | `-32603` | A handler threw an exception or returned a rejected promise. |
| `ChannelErrors.Timeout` | `-32000` | No matching response arrived before the client timeout. |

For example, to handle timeouts in the iframe:

```ts
import { ChannelErrors } from 'channel-rpc';

async function addWithTimeoutHandling() {
	try {
		return await client.stub.add(2, 3);
	} catch (error) {
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === ChannelErrors.Timeout.code
		) {
			console.error('The remote call timed out.');
			return;
		}
		throw error;
	}
}
```

Handler exception details are replaced with `InternalError`; they are not sent to
the caller. Native messaging failures can also reject a call, so handle or
propagate errors that do not match the RPC constants.

## Data and trust boundaries

Arguments and results travel through the browser's
[structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).
Use cloneable values; functions and DOM nodes cannot be sent. TypeScript types do
not validate incoming data at runtime, so validate arguments inside your handlers.

Use this library between windows you trust. `channelId` identifies a conversation
and does not authenticate the other window.

- `allowOrigins` checks incoming **server requests**. Supply exact origins such as
  `https://widget.example` or `http://localhost:3000`, without paths.
- The client only accepts responses from its configured `target` window. With a
  specific `targetOrigin`, it also checks the response's origin before handling
  the body or invoking `onTrace`. Rejected sources are silently ignored; a call
  without a valid response eventually times out.
- Requests use the client's `targetOrigin`. Configure the server's exact origin
  when known, as in the quick start. The default is `'*'`, which permits delivery
  even after the target navigates to another origin.
- For requests with a non-opaque origin, the server sends each response to the
  request's window and origin, including when asynchronous handlers finish out
  of order. If that window has navigated to another origin, the browser discards
  the response.

Sandboxed windows without `allow-same-origin` and `data:` pages have opaque
origins, reported as `'null'`. The server replies with `'*'` to an opaque-origin
request that passes `allowOrigins`. A client targeting an opaque-origin server
must likewise use `'*'` (or omit `targetOrigin`). These paths cannot provide an
exact origin constraint. Allowing `'null'` in
`allowOrigins` permits opaque origins generally; it does not identify one window.

The server accepts multiple windows matching `allowOrigins`; it is not bound to
one client window. Origin checks do not distinguish documents after same-origin
navigation.

Account for these limits when embedding content or allowing windows to navigate.
See the browser's
[postMessage security guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#security_concerns)
when deciding whether this transport fits your application.

The public API provides individual calls with positional arguments. Batch calls,
notifications, cancellation, and transfer lists are not exposed.

## Debugging

Built-in debug logging is off by default. To enable it for a page's origin, run
this in its browser console and reload the page:

```js
localStorage.setItem('channel-rpc-debug', '1');
```

Remove the key and reload to disable it. The switch is read once when the module
loads; any non-empty value, including `'false'`, enables it. If storage is
unavailable, communication continues with built-in logging disabled. Parent and
iframe pages on different origins have separate storage settings.

Logs use `[CHANNEL_RPC]`, an event name, and selected metadata: `channelId`, string
`method` and `requestId`, response `outcome`, and a finite numeric `errorCode` when
available. They do not include parameters, results, error messages, or exception
objects. Identifiers and method names must not contain credentials; checking
their types does not redact their contents.

For full content inspection, both constructors accept an optional `onTrace`
callback. It works independently of the debug switch and is configured per
instance. For example, when debugging with artificial test data:

```ts
const client = new ChannelClient<Handler>({
	target: window.parent,
	channelId: 'example',
	onTrace(event) {
		console.log(event); // Includes raw content; use with test data.
	}
});
```

The exported `ChannelTraceHandler` receives a read-only `ChannelTraceEvent` with
`event`, `channelId`, optional `payload: unknown`, and optional `error: unknown`.
`payload` is the JSON-RPC body, rather than a browser event or window reference.

| Event | Contents and timing |
| --- | --- |
| `send_request` | Client request, immediately before attempting `postMessage`. |
| `receive_request` | Server request, after origin/source checks and before JSON-RPC validation. |
| `send_response` | Server response, immediately before attempting `postMessage`. |
| `receive_response` | Client response, after origin/source checks and before JSON-RPC validation and request matching. |
| `handler_error` | Server request and the handler's original thrown or rejected value in `error`. The caller receives `InternalError`. |
| `invalid_response` | Unrecognized response and the fixed `Error('UNKNOWN_RESPONSE')` thrown from the message listener. |

Sending events indicate an attempt, not confirmation that the other window
received the message. Remote error objects propagate unchanged. The
library-generated unknown-response error omits the original body.

Callbacks observe original references, not snapshots. Do not mutate them; copy
values yourself if you need historical snapshots. Callbacks run synchronously,
and returned promises are not awaited. Thrown exceptions and rejected promises
from the callback are ignored, as are failures of the built-in console output.
Keep callbacks lightweight because synchronous work still affects page timing.

Full traces are not automatically redacted. In production, explicitly select
fields your application allows recording instead of logging or uploading the
whole event. For metadata-only application logging, for example:

```ts
const onTrace: ChannelTraceHandler = ({ event, channelId }) => {
	console.info({ event, channelId });
};
```

Import `ChannelTraceHandler` with `import type` when using this example. For
temporary inspection without a callback, use breakpoints in the request/response
handlers; enable pausing on caught exceptions to inspect original handler errors.

## Development

Use the Bun and Node.js versions recorded in [`.bun-version`](./.bun-version) and
[`.node-version`](./.node-version). Setup instructions, individual check commands,
and dependency upgrade guidance are in [CONTRIBUTING.md](./CONTRIBUTING.md).

After setup, run the complete local verification suite with:

```sh
bun run verify
```

It checks formatting, lint rules, types, unit tests, real iframe communication in
Chromium, and the contents and compatibility of the npm tarball.

## Contributing and support

Bug reports and pull requests are welcome. Read the
[contribution guide](./CONTRIBUTING.md) before making changes. When
[reporting an issue](https://github.com/kouhin/channel-rpc/issues), include a small
reproduction, the library version, browser version, and the expected behavior.

See [GitHub Releases](https://github.com/kouhin/channel-rpc/releases) for release
notes. Maintainers can find versioning and publishing instructions in the
[release guide](./CONTRIBUTING.md#releasing).

Maintained by [kouhin](https://github.com/kouhin).

## License

[MIT](./LICENSE) © 2023 kouhin.
