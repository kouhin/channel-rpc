interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: unknown[];
  id: string;
}

interface JsonRpcSuccessResponse {
  jsonrpc: string;
  result: any;
  id: string;
}

interface JsonRpcErrorResponse {
  jsonrpc: string;
  error: {
    code: number;
    message: string;
    data?: any;
  };
  id: string;
}

const MessageTypes = {
  HandShakeRequest: "@channel-rpc/HANDSHAKE_REQUEST",
  HandShakeResponse: "@channel-rpc/HANDSHAKE_RESPONSE",
} as const;

function isJsonRpcRequest(data: any): data is JsonRpcRequest {
  return data && data.jsonrpc === "2.0" && typeof data.method === "string";
}

function isJsonRpcSuccessResponse(data: any): data is JsonRpcSuccessResponse {
  return data && data.jsonrpc === "2.0" && typeof data.result !== "undefined";
}

function isJsonRpcErrorResponse(data: any): data is JsonRpcErrorResponse {
  return data && data.jsonrpc === "2.0" && typeof data.error !== "undefined";
}

function generateUUID(): string {
  return new Array(4)
    .fill(0)
    .map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16))
    .join("-");
}

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  promise: Promise<T>;
}

function defer<T>(timeout: number): Deferred<T> {
  const deferred = {
    resolve: (_value: T) => {},
    reject: (_reason: any) => {},
    promise: undefined as any as Promise<T>,
  };
  deferred.promise = new Promise<T>((resolve, reject) => {
    const t = timeout
      ? setTimeout(() => {
          reject(new Error("timeout"));
        }, timeout)
      : undefined;

    deferred.resolve = (value: T) => {
      clearTimeout(t);
      return resolve(value);
    };
    deferred.reject = (reason: any) => {
      clearTimeout(t);
      return reject(reason);
    };
  });
  return deferred;
}

export class ChannelServer<T extends object> {
  readonly channelId: string;
  readonly source: WindowProxy;
  readonly channel: MessageChannel;

  private readonly _handlers: Record<string, (...args: unknown[]) => unknown>;

  constructor(options: {
    channelId: string;
    source: WindowProxy;
    handler?: T;
  }) {
    const { source, channelId, handler } = options;
    if (!channelId) throw new Error("id is required");

    this.channelId = channelId;
    this._handlers = {};

    const h = handler || {};
    Object.keys(h).forEach((method) => {
      const fn = (h as any)[method];
      if (typeof fn === "function") {
        this._handlers[method] = fn.bind(h);
      }
    });

    this.channel = new MessageChannel();
    this.source = source || window;
    this.source.addEventListener("message", (ev) => {
      // DEBUG
      if (ev.data.type === MessageTypes.HandShakeRequest) {
        console.log("[CHANNEL_RPC][SERVER]HandShakeRequest", ev.data);
      }

      // Send back the port to the source window
      if (
        ev.data &&
        ev.data.type === MessageTypes.HandShakeRequest &&
        ev.data.channelId === this.channelId
      ) {
        console.log(
          "[CHANNEL_RPC][SERVER]HandShakeRequest Sendback",
          this.channel.port2
        );
        (ev.source as WindowProxy).postMessage(
          {
            type: MessageTypes.HandShakeResponse,
            channelId: this.channelId,
          },
          "*",
          [this.channel.port2]
        );
      }
    });
    this.channel.port1.onmessage = this._handleMessage.bind(this);
  }

  private async _handleMessage(ev: MessageEvent): Promise<void> {
    console.log("[CHANNEL_RPC][SERVER]HandShakeRequest handleMessage", ev);
    const data = ev.data;
    if (!isJsonRpcRequest(data)) {
      const res: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "Invalid Request",
        },
        id: data.id || null,
      };
      console.log("[CHANNEL_RPC][SERVER]HandShakeRequest reply", res);
      this.channel.port1.postMessage(res);
      return;
    }

    console.log(
      "[CHANNEL_RPC][SERVER]HandShakeRequest handleMessage method",
      data.method,
      this._handlers
    );
    const handler = this._handlers[data.method];
    if (!handler) {
      const res: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: "Method not found",
        },
        id: data.id,
      };
      console.log("[CHANNEL_RPC][SERVER]HandShakeRequest reply", res);
      this.channel.port1.postMessage(res);
      return;
    }
    try {
      const result = await handler(...(data.params || []));
      const res: JsonRpcSuccessResponse = {
        jsonrpc: "2.0",
        result,
        id: data.id,
      };
      console.log("[CHANNEL_RPC][SERVER]HandShakeRequest reply", res);
      this.channel.port1.postMessage(res);
    } catch (err) {
      const res: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal error",
          data: err,
        },
        id: data.id,
      };
      console.log("[CHANNEL_RPC][SERVER]HandShakeRequest reply", res);
      this.channel.port1.postMessage(res);
    }
  }
}

type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;
type Remote<T> = T extends (...args: infer TArguments) => infer TReturn
  ? (...args: { [I in keyof TArguments]: TArguments[I] }) => Promisify<TReturn>
  : unknown;
export type RemoteObject<T> = { [P in keyof T]: Remote<T[P]> };

export class ChannelClient<T extends object> {
  readonly channelId: string;
  readonly stub: RemoteObject<T>;
  readonly target: WindowProxy;

  private readonly _deferreds: Record<string, Deferred<unknown> | undefined>;
  private readonly _deferredPort: Deferred<MessagePort>;
  private readonly _timeout: number;

  constructor(options: {
    target: WindowProxy;
    channelId: string;
    timeout?: number;
  }) {
    const { target, channelId, timeout } = options;
    if (!target) throw new Error("target is required");
    if (!channelId) throw new Error("channelId is required");

    this.target = target;
    this.channelId = channelId;
    this._deferredPort = defer(0);
    this._deferreds = {};
    this._timeout = timeout || 1000;

    this.stub = new Proxy({} as RemoteObject<T>, {
      get: (_target, prop) => {
        return (...args: unknown[]) => {
          console.log("[CHANNEL_RPC][CLIENT] invoke stub method", prop, args);
          return this._sendRequest(String(prop), args);
        };
      },
    });

    this._startHandshake();
  }

  private async _sendRequest(
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    console.log("[CHANNEL_RPC][CLIENT] invoke fetching port");
    const port = await this._deferredPort.promise;
    console.log("[CHANNEL_RPC][CLIENT] invoke fetch port", port);
    const id = generateUUID();
    const deferred = defer(this._timeout);
    deferred.promise
      .then((value) => {
        delete this._deferreds[id];
        return value;
      })
      .catch((err) => {
        delete this._deferreds[id];
        throw err;
      });
    this._deferreds[id] = deferred;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params: args,
      id,
    };
    console.log("[CHANNEL_RPC][CLIENT] Send invoke", req);
    port.postMessage(req);
    return deferred.promise;
  }

  private _portMessageHandler(ev: MessageEvent) {
    console.log("[CHANNEL_RPC][CLIENT] portMessageHandler", ev);
    const { data } = ev;
    if (isJsonRpcSuccessResponse(data)) {
      const { id, result } = data;
      this._deferreds[id]?.resolve(result);
    } else if (isJsonRpcErrorResponse(data)) {
      const { id, error } = data;
      this._deferreds[id]?.reject(error);
    } else {
      console.warn("Unknown message", data);
    }
  }

  private _startHandshake() {
    const self = typeof globalThis === "object" ? globalThis : window;

    let port: MessagePort;
    const handler = (ev: MessageEvent) => {
      if (
        ev.data &&
        ev.data.type === MessageTypes.HandShakeResponse &&
        ev.data.channelId === this.channelId &&
        ev.ports.length
      ) {
        console.log("[CHANNEL_RPC][CLIENT] receive port", ev);
        self.removeEventListener("message", handler);

        port = ev.ports[0];
        console.log("[CHANNEL_RPC][CLIENT] connected", port);
        this._deferredPort.resolve(port);
        port.onmessage = this._portMessageHandler.bind(this);
      }
    };
    self.addEventListener("message", handler);

    let interval = setInterval(() => {
      // DEBUG
      console.info("[CLIENT]HandShakeRequest", this.channelId, port);
      if (port) {
        clearInterval(interval);
        return;
      }

      this.target.postMessage(
        {
          type: MessageTypes.HandShakeRequest,
          channelId: this.channelId,
        },
        "*"
      );
    }, 100);
  }
}
