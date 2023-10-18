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
    promise: new Promise<T>((resolve, reject) => {
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
    }),
  };
  return deferred;
}

export class ChannelServer<T extends object> {
  #source: WindowProxy;
  #channelId: string;
  #channel: MessageChannel;
  #handlers = new Map<string, (...args: unknown[]) => unknown>();

  constructor(options: {
    channelId: string;
    source: WindowProxy;
    handler?: T;
  }) {
    const { source, channelId, handler } = options;
    if (!channelId) throw new Error("id is required");

    this.#channelId = channelId;

    const h = handler || {};
    Object.keys(h).forEach((method) => {
      const fn = (h as any)[method];
      if (typeof fn === "function") {
        this.#handlers.set(method, fn.bind(h));
      }
    });

    this.#channel = new MessageChannel();
    this.#source = source || window;
    this.#source.addEventListener("message", (ev) => {
      // Send back the port to the source window
      if (
        ev.data &&
        ev.data.type === MessageTypes.HandShakeRequest &&
        ev.data.channelId === this.#channelId
      ) {
        (ev.source as WindowProxy).postMessage(
          {
            type: MessageTypes.HandShakeResponse,
            channelId: this.#channelId,
          },
          "*",
          [this.#channel.port2]
        );
      }
    });
    this.#channel.port1.onmessage = this.#handleMessage;
  }

  async #handleMessage(ev: MessageEvent): Promise<void> {
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
      this.#channel.port1.postMessage(res);
      return;
    }

    const handler = this.#handlers.get(data.method);
    if (!handler) {
      const res: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: "Method not found",
        },
        id: data.id,
      };
      this.#channel.port1.postMessage(res);
      return;
    }
    try {
      const result = await handler(...(data.params || []));
      const res: JsonRpcSuccessResponse = {
        jsonrpc: "2.0",
        result,
        id: data.id,
      };
      this.#channel.port1.postMessage(res);
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
      this.#channel.port1.postMessage(res);
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
  readonly #deferredPort: Deferred<MessagePort>;
  readonly #deferreds = new Map<string, Deferred<unknown>>();
  readonly #timeout: number;

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
    this.#deferredPort = defer(0);
    this.#timeout = timeout || 1000;

    this.stub = new Proxy({} as RemoteObject<T>, {
      get: (_target, prop) => {
        return async (...args: unknown[]) => {
          return this.#sendRequest(String(prop), args);
        };
      },
    });

    this.#startHandshake();
  }

  async #sendRequest(method: string, args: unknown[]): Promise<unknown> {
    const port = await this.#deferredPort.promise;
    const id = generateUUID();
    const deferred = defer(this.#timeout);
    deferred.promise
      .then((value) => {
        this.#deferreds.delete(id);
        return value;
      })
      .catch((err) => {
        this.#deferreds.delete(id);
        throw err;
      });
    this.#deferreds.set(id, deferred);
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params: args,
      id,
    };
    port.postMessage(req);
    return deferred.promise;
  }

  #portMessageHandler(ev: MessageEvent) {
    const { data } = ev;
    if (isJsonRpcSuccessResponse(data)) {
      const { id, result } = data;
      if (this.#deferreds.has(id)) {
        this.#deferreds.get(id)!.resolve(result);
      }
    } else if (isJsonRpcErrorResponse(data)) {
      const { id, error } = data;
      if (this.#deferreds.has(id)) {
        this.#deferreds.get(id)!.reject(error);
      }
    } else {
      console.warn("Unknown message", data);
    }
  }

  #startHandshake() {
    const self = typeof globalThis === "object" ? globalThis : window;

    let interval: number | undefined = undefined;
    const handler = (ev: MessageEvent) => {
      if (
        ev.data &&
        ev.data.type === MessageTypes.HandShakeResponse &&
        ev.data.channelId === this.channelId &&
        ev.ports.length
      ) {
        clearInterval(interval);
        this.target.removeEventListener("message", handler);

        const [port] = ev.ports;
        console.log("connected", port);
        this.#deferredPort.resolve(port);
        port.onmessage = this.#portMessageHandler;
      }
    };
    self.addEventListener("message", handler);

    interval = setInterval(() => {
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
