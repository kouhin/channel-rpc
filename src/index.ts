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
  ChannelRpcRequest: "@channel-rpc/REQUEST",
  ChannelRpcResponse: "@channel-rpc/RESPONSE",
} as const;

interface ChannelRpcRequest {
  type: typeof MessageTypes.ChannelRpcRequest;
  channelId: string;
  payload: unknown;
}

interface ChannelRpcResponse {
  type: typeof MessageTypes.ChannelRpcResponse;
  channelId: string;
  payload: unknown;
}

function isChannelRpcRequest(data: any): data is ChannelRpcRequest {
  return data && data.type === MessageTypes.ChannelRpcRequest;
}

function isChannelRpcResponse(data: any): data is ChannelRpcResponse {
  return data && data.type === MessageTypes.ChannelRpcResponse;
}

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

  private readonly _handlers: Record<string, (...args: unknown[]) => unknown>;

  constructor(options: {
    channelId: string;
    sourceOrigin?: string;
    handler?: T;
  }) {
    const { sourceOrigin, channelId, handler } = options;
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

    const self = typeof globalThis === "object" ? globalThis : window;
    self.addEventListener("message", (ev) => {
      if (!isChannelRpcRequest(ev.data) || ev.data.channelId !== channelId) {
        return;
      }
      if (sourceOrigin && sourceOrigin !== "*" && sourceOrigin !== ev.origin) {
        throw new Error(
          `[CHANNEL_RPC_SERVER][channel=${this.channelId}] Invalid origin: ${ev.origin}`
        );
      }
      if (!ev.source) {
        throw new Error(
          `[CHANNEL_RPC_SERVER][channel=${this.channelId}] event.source is null`
        );
      }

      // DEBUG
      console.log(
        `[CHANNEL_RPC_SERVER][channel=${this.channelId}] ChannelRpcRequest`,
        ev.data
      );
      this._handleRpcRequest(ev.source, ev.data.payload);
    });
  }

  private async _sendResponse(
    source: MessageEventSource,
    payload: JsonRpcSuccessResponse | JsonRpcErrorResponse
  ) {
    const res: ChannelRpcResponse = {
      type: MessageTypes.ChannelRpcResponse,
      channelId: this.channelId,
      payload,
    };
    source.postMessage(res, {
      targetOrigin: "*",
    });
  }

  private async _handleRpcRequest(
    source: MessageEventSource,
    payload: unknown
  ): Promise<void> {
    console.log(
      `[CHANNEL_RPC_SERVER][channel=${this.channelId}] handleMessage`,
      payload
    );
    if (!isJsonRpcRequest(payload)) {
      const res: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "Invalid Request",
        },
        id: (payload as any).id || null,
      };
      console.log(`[CHANNEL_RPC_SERVER][channel=${this.channelId}] reply`, res);
      this._sendResponse(source, res);
      return;
    }

    console.log(
      `[CHANNEL_RPC_SERVER][channel=${this.channelId}] handleMessage method[${payload.method}]`,
      this._handlers
    );
    const handler = this._handlers[payload.method];
    if (!handler) {
      const res: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: "Method not found",
        },
        id: payload.id,
      };
      console.log(`[CHANNEL_RPC_SERVER][channel=${this.channelId}] reply`, res);
      this._sendResponse(source, res);
      return;
    }
    try {
      const result = await handler(...(payload.params || []));
      const res: JsonRpcSuccessResponse = {
        jsonrpc: "2.0",
        result,
        id: payload.id,
      };
      console.log(`[CHANNEL_RPC_SERVER][channel=${this.channelId}] reply`, res);
      this._sendResponse(source, res);
    } catch (err) {
      const res: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal error",
          data: err,
        },
        id: payload.id,
      };
      console.log(`[CHANNEL_RPC_SERVER][channel=${this.channelId}] reply`, res);
      this._sendResponse(source, res);
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

    const self = typeof globalThis === "object" ? globalThis : window;
    self.addEventListener("message", (ev) => {
      if (!isChannelRpcResponse(ev.data) || ev.data.channelId !== channelId) {
        return;
      }
      // DEBUG
      console.log(
        `[CHANNEL_RPC_CLIENT][channel=${this.channelId}] ChannelRpcResponse`,
        ev.data
      );
      this._handleRpcResponse(ev.data.payload);
    });
  }

  private async _sendRequest(
    method: string,
    args: unknown[]
  ): Promise<unknown> {
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
    console.log("[CHANNEL_RPC_CLIENT] Send invoke", req);
    const channelReq: ChannelRpcRequest = {
      type: MessageTypes.ChannelRpcRequest,
      channelId: this.channelId,
      payload: req,
    };
    this.target.postMessage(channelReq, "*");
    return deferred.promise;
  }

  private _handleRpcResponse(payload: unknown) {
    console.log("[CHANNEL_RPC_CLIENT] handleRpcResponse", payload);
    if (isJsonRpcSuccessResponse(payload)) {
      const { id, result } = payload;
      this._deferreds[id]?.resolve(result);
    } else if (isJsonRpcErrorResponse(payload)) {
      const { id, error } = payload;
      this._deferreds[id]?.reject(error);
    } else {
      throw new Error(
        `[CHANNEL_RPC_CLIENT][channel=${
          this.channelId
        }] UNKNOWN_RESPONSE: ${JSON.stringify(payload)}`
      );
    }
  }
}
