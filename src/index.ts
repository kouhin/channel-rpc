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
	id: string | null;
}

const MessageTypes = {
	ChannelRpcRequest: '@channel-rpc/REQUEST',
	ChannelRpcResponse: '@channel-rpc/RESPONSE'
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
	return data && data.jsonrpc === '2.0' && typeof data.method === 'string';
}

function isJsonRpcSuccessResponse(data: any): data is JsonRpcSuccessResponse {
	return data && data.jsonrpc === '2.0' && 'result' in data;
}

function isJsonRpcErrorResponse(data: any): data is JsonRpcErrorResponse {
	return data && data.jsonrpc === '2.0' && 'error' in data;
}

function generateUUID(): string {
	if (typeof crypto !== 'undefined' && typeof crypto?.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return new Array(4)
		.fill(0)
		.map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16))
		.join('-');
}

interface Deferred<T> {
	resolve: (value: T) => void;
	reject: (reason: any) => void;
	promise: Promise<T>;
}
// get debugEnabled from localStorage
let debugEnabled = false;
try {
	debugEnabled = !!localStorage.getItem('channel-rpc-debug');
} catch {
	// Storage may be unavailable in restricted browser contexts or outside a browser.
}

export type ChannelTraceEvent = Readonly<{
	event:
		| 'send_request'
		| 'receive_request'
		| 'send_response'
		| 'receive_response'
		| 'handler_error'
		| 'invalid_response';
	channelId: string;
	payload?: unknown;
	error?: unknown;
}>;

export type ChannelTraceHandler = (event: ChannelTraceEvent) => void | Promise<void>;

function trace(
	event: ChannelTraceEvent['event'],
	channelId: string,
	payload: unknown,
	onTrace?: ChannelTraceHandler,
	error?: unknown
) {
	if (!debugEnabled && !onTrace) return;
	if (debugEnabled) {
		try {
			const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
			const rpcError = data.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>) : {};
			console.log('[CHANNEL_RPC]', event, {
				channelId,
				method: typeof data.method === 'string' ? data.method : undefined,
				requestId: typeof data.id === 'string' ? data.id : undefined,
				outcome: isJsonRpcSuccessResponse(data) ? 'success' : isJsonRpcErrorResponse(data) ? 'error' : undefined,
				errorCode: typeof rpcError.code === 'number' && Number.isFinite(rpcError.code) ? rpcError.code : undefined
			});
		} catch {
			// Diagnostics must not interrupt communication.
		}
	}
	if (onTrace) {
		try {
			const pending = onTrace({ event, channelId, payload, error });
			if (pending) void Promise.resolve(pending).catch(() => {});
		} catch {
			// A consumer's diagnostic callback must not replace the RPC result.
		}
	}
}

const TIMEOUT_ERROR_MSG = 'timeout' as const;

export const ChannelErrors = {
	InvalidRequest: {
		code: -32600,
		message: 'Invalid Request'
	},
	MethodNotFound: {
		code: -32601,
		message: 'Method not found'
	},
	InternalError: {
		code: -32603,
		message: 'Internal error'
	},
	Timeout: {
		code: -32000,
		message: 'Timeout'
	}
} as const;

function createErrorResponse(
	err: (typeof ChannelErrors)[keyof typeof ChannelErrors],
	id: string | null
): JsonRpcErrorResponse {
	return {
		jsonrpc: '2.0',
		error: {
			code: err.code,
			message: err.message
		},
		id
	};
}

function defer<T>(timeout: number): Deferred<T> {
	const deferred = {
		resolve: (_value: T) => {},
		reject: (_reason: any) => {},
		promise: undefined as any as Promise<T>
	};
	deferred.promise = new Promise<T>((resolve, reject) => {
		const t = timeout
			? setTimeout(() => {
					reject(new Error(TIMEOUT_ERROR_MSG));
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
	readonly allowOrigins: string[];

	private _unlisten: (() => void) | undefined = undefined;

	private readonly _handlers: Record<string, (...args: unknown[]) => unknown>;
	private readonly _onTrace?: ChannelTraceHandler;

	constructor(options: {
		channelId: string;
		allowOrigins?: string[];
		handler?: T;
		onTrace?: ChannelTraceHandler;
	}) {
		const { allowOrigins, channelId, handler } = options;
		if (!channelId) throw new Error('id is required');

		this.channelId = channelId;
		this.allowOrigins = allowOrigins && allowOrigins.indexOf('*') === -1 ? allowOrigins : [];
		this._handlers = {};
		this._onTrace = options.onTrace;

		const h = handler || {};
		Object.keys(h).forEach((method) => {
			const fn = (h as any)[method];
			if (typeof fn === 'function') {
				this._handlers[method] = fn.bind(h);
			}
		});
	}

	public start(): void {
		if (this._unlisten) return;
		const self = typeof globalThis === 'object' ? globalThis : window;
		self.addEventListener('message', this._handleMessage);
		this._unlisten = (): void => {
			self.removeEventListener('message', this._handleMessage);
		};
	}

	public stop(): void {
		if (this._unlisten) {
			this._unlisten();
			this._unlisten = undefined;
		}
	}

	private _handleMessage: (ev: MessageEvent) => void = (ev) => {
		if (!isChannelRpcRequest(ev.data) || ev.data.channelId !== this.channelId) {
			return;
		}
		if (this.allowOrigins.length > 0 && this.allowOrigins.indexOf(ev.origin) === -1) {
			throw new Error(`[CHANNEL_RPC_SERVER][channel=${this.channelId}] Invalid origin: ${ev.origin}`);
		}
		if (!ev.source) {
			return;
		}

		trace('receive_request', this.channelId, ev.data.payload, this._onTrace);
		this._handleRpcRequest(ev.source, ev.data.payload);
	};

	private async _sendResponse(source: MessageEventSource, payload: JsonRpcSuccessResponse | JsonRpcErrorResponse) {
		const res: ChannelRpcResponse = {
			type: MessageTypes.ChannelRpcResponse,
			channelId: this.channelId,
			payload
		};
		trace('send_response', this.channelId, payload, this._onTrace);
		source.postMessage(res, {
			targetOrigin: '*'
		});
	}

	private async _handleRpcRequest(source: MessageEventSource, payload: unknown): Promise<void> {
		if (!isJsonRpcRequest(payload)) {
			const res: JsonRpcErrorResponse = createErrorResponse(ChannelErrors.InvalidRequest, (payload as any).id || null);
			this._sendResponse(source, res);
			return;
		}

		const handler = this._handlers[payload.method];
		if (!handler) {
			const res: JsonRpcErrorResponse = createErrorResponse(ChannelErrors.MethodNotFound, payload.id || null);
			this._sendResponse(source, res);
			return;
		}
		try {
			const result = await handler(...(payload.params || []));
			const res: JsonRpcSuccessResponse = {
				jsonrpc: '2.0',
				result,
				id: payload.id
			};
			this._sendResponse(source, res);
		} catch (error) {
			trace('handler_error', this.channelId, payload, this._onTrace, error);
			const res: JsonRpcErrorResponse = createErrorResponse(ChannelErrors.InternalError, payload.id || null);
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
	private readonly _onTrace?: ChannelTraceHandler;

	constructor(options: {
		target: WindowProxy;
		channelId: string;
		timeout?: number;
		onTrace?: ChannelTraceHandler;
	}) {
		const { target, channelId, timeout } = options;
		if (!target) throw new Error('target is required');
		if (!channelId) throw new Error('channelId is required');

		this.target = target;
		this.channelId = channelId;
		this._deferreds = {};
		this._timeout = timeout || 1000;
		this._onTrace = options.onTrace;

		this.stub = new Proxy({} as RemoteObject<T>, {
			get: (_target, prop) => {
				return (...args: unknown[]) => {
					return this._sendRequest(String(prop), args);
				};
			}
		});

		const self = typeof globalThis === 'object' ? globalThis : window;
		self.addEventListener('message', (ev) => {
			if (!isChannelRpcResponse(ev.data) || ev.data.channelId !== channelId) {
				return;
			}
			this._handleRpcResponse(ev.data.payload);
		});
	}

	private async _sendRequest(method: string, args: unknown[]): Promise<unknown> {
		const id = generateUUID();
		const deferred = defer(this._timeout);
		const promise = deferred.promise
			.then((value) => {
				delete this._deferreds[id];
				return value;
			})
			.catch((err) => {
				delete this._deferreds[id];
				if (err.message === TIMEOUT_ERROR_MSG) {
					throw createErrorResponse(ChannelErrors.Timeout, id).error;
				}
				throw err;
			});
		this._deferreds[id] = deferred;
		const req: JsonRpcRequest = {
			jsonrpc: '2.0',
			method,
			params: args,
			id
		};
		const channelReq: ChannelRpcRequest = {
			type: MessageTypes.ChannelRpcRequest,
			channelId: this.channelId,
			payload: req
		};
		trace('send_request', this.channelId, req, this._onTrace);
		this.target.postMessage(channelReq, '*');
		return promise;
	}

	private _handleRpcResponse(payload: unknown) {
		trace('receive_response', this.channelId, payload, this._onTrace);
		if (isJsonRpcSuccessResponse(payload)) {
			const { id, result } = payload;
			this._deferreds[id]?.resolve(result);
		} else if (isJsonRpcErrorResponse(payload)) {
			const { id, error } = payload;
			if (!id) throw error;
			this._deferreds[id]?.reject(error);
		} else {
			const err = new Error('UNKNOWN_RESPONSE');
			trace('invalid_response', this.channelId, payload, this._onTrace, err);
			throw err;
		}
	}
}
