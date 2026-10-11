/**
 * Minimal WebSocket double for Node tests. Emits `gateway.ready` on open and
 * lets a test script the server side, including the server-to-client
 * requests of Hermes v0.21.6 (tui_gateway/server_requests.py).
 */

type Listener = (event: unknown) => void

export interface FakeSocketScript {
  /** Called for each request frame; return a result or throw a JSON-RPC style error. */
  onRequest?: (method: string, params: Record<string, unknown>) => unknown
  readyPayload?: Record<string, unknown>
  /** Close immediately with this code instead of opening. */
  closeOnOpen?: { code: number; reason?: string }
}

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []
  static script: FakeSocketScript = {}

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
    setTimeout(() => this.openNow(), 0)
  }

  private openNow(): void {
    const script = FakeWebSocket.script
    if (script.closeOnOpen) {
      this.readyState = FakeWebSocket.CLOSED
      this.emit('close', { code: script.closeOnOpen.code, reason: script.closeOnOpen.reason ?? '' })
      return
    }
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
    this.serverEvent({ type: 'gateway.ready', payload: { heartbeat: true, replay_epoch: 'epoch-fake', ...(script.readyPayload ?? {}) } })
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>
    this.sent.push(frame)
    // A frame without `method` is the client's answer to a server request;
    // Hermes answers nothing back (server_requests.py:253-293).
    if (frame.method === undefined) {
      return
    }
    const method = String(frame.method)
    if (method === 'gateway.ping') {
      this.serverReply(frame.id, { ok: true })
      return
    }
    const handler = FakeWebSocket.script.onRequest
    if (!handler) {
      this.serverReply(frame.id, {})
      return
    }
    try {
      const result = handler(method, (frame.params as Record<string, unknown>) ?? {})
      this.serverReply(frame.id, result ?? {})
    } catch (err) {
      const e = err as { code?: number; message?: string }
      this.serverMessage({ jsonrpc: '2.0', id: frame.id, error: { code: e.code ?? -32603, message: e.message ?? 'error' } })
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return
    }
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code, reason })
  }

  /** Server side: drop the connection. */
  serverClose(code: number, reason = ''): void {
    this.close(code, reason)
  }

  serverEvent(params: Record<string, unknown>): void {
    this.serverMessage({ jsonrpc: '2.0', method: 'event', params })
  }

  /** Server side: a server-to-client request, as `ServerRequest.frame()` writes it (server_requests.py:70-72). */
  serverRequest(id: string, method: string, params: Record<string, unknown>): void {
    this.serverMessage({ jsonrpc: '2.0', id, method, params })
  }

  serverReply(id: unknown, result: unknown): void {
    this.serverMessage({ jsonrpc: '2.0', id, result })
  }

  private serverMessage(obj: unknown): void {
    setTimeout(() => this.emit('message', { data: JSON.stringify(obj) }), 0)
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

export function installFakeWebSocket(script: FakeSocketScript = {}): void {
  FakeWebSocket.instances = []
  FakeWebSocket.script = script
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
}

export const fakeSocketFactory = (url: string) => new FakeWebSocket(url) as unknown as WebSocket

export const flush = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
