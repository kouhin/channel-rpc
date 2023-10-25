# channel-rpc: JSON-RPC over `postMessage`

[![GitHub License](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://github.com/kouhin/channel-rpc/blob/main/LICENSE)

Channel-rpc is a TypeScript library that simplifies JSON-RPC communication between different windows or iframes using the `postMessage` API. This library is designed to make inter-window communication a breeze, ensuring that only windows with matching `channelId` can exchange data and optionally validating the source origin.

## Features

- **Simple and Lightweight**: A minimalistic library that abstracts away the complexities of `postMessage` and JSON-RPC.
- **Strongly Typed**: Leverages TypeScript to ensure type safety in your communications.
- **Secure**: Channels can only communicate with windows or iframes having the same `channelId`, and optionally validate the source origin.
- **Controlled Communication**: Utilize the `start()` and `stop()` methods to manage when the server accepts messages.

## Installation

To get started with `channel-rpc`, you can install it via npm:

```shell
npm install channel-rpc
```

## Usage

### In the Main Window (main.ts)

```typescript
import { ChannelServer } from "channel-rpc";

// Define your message handlers
const handler = {
  add: (a: number, b: number): number => a + b,
};

// Create a ChannelServer instance
const server = new ChannelServer({
  channelId: "channel-1", // Must match the channelId in the child window
  handler: handler, // Your message handler
  sourceOrigin: "https://yourwebsite.com", // Optional source origin validation
});

// Start accepting messages
server.start();

export type HandlerType = typeof handler;
```

### In the Child Window (iframe.ts)

```typescript
import { ChannelClient } from "channel-rpc";

import type { HandlerType } from "./main.ts";

// Create a ChannelClient instance
const client = new ChannelClient({
  target: window.top,
  channel: "channel-1", // Must match the channelId in the main window
});

// Use the stub to call methods on the main window
const result = await client.stub.add(2, 3); // result === 5
```

## API Reference

### `ChannelServer`

- `channelId` (string): A unique identifier for the channel.
- `handler` (object): The message handler object.
- `sourceOrigin` (string, optional): The source origin to validate against.
- `start()`: Starts accepting messages.
- `stop()`: Stops accepting messages.

### `ChannelClient`

- `target` (Window): The target window for communication.
- `channel` (string): The channel identifier to match with the main window.

## License

This project is licensed under the MIT License. See the [LICENSE](https://github.com/kouhin/channel-rpc/blob/main/LICENSE) file for details.

## Get Started

To get started with `channel-rpc`, follow the installation and usage instructions provided above. Explore the examples folder for more usage examples.

## Issues and Support

If you encounter any issues or have questions, please [open an issue](https://github.com/kouhin/channel-rpc/issues). We're here to help!

## Release Notes

Check out the [Release Notes](https://github.com/kouhin/channel-rpc/releases) for information on the latest updates and features.

## Author

- [kouhin](https://github.com/kouhin)

Give `channel-rpc` a try, and simplify your inter-window communication in web applications. We look forward to your feedback and contributions!
