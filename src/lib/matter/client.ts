/**
 * Matter WebSocket client for python-matter-server.
 * WSS via Caddy in prod, direct WS in dev.
 * Auto-reconnect with exponential backoff.
 */

type MessageHandler = (data: unknown) => void;

interface MatterMessage {
  message_id: string;
  command: string;
  args?: Record<string, unknown>;
}

export class MatterClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private handlers = new Map<string, (data: unknown) => void>();
  private onNodesUpdate: MessageHandler = () => {};
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private _status: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private onStatusChange: (status: string) => void = () => {};

  get status() {
    return this._status;
  }

  constructor(private getWsUrl: () => string) {}

  setOnNodesUpdate(handler: MessageHandler) {
    this.onNodesUpdate = handler;
  }

  setOnStatusChange(handler: (status: string) => void) {
    this.onStatusChange = handler;
  }

  connect() {
    if (this.ws) return;
    this.shouldReconnect = true;
    this._connect();
  }

  disconnect() {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
    this._setStatus('disconnected');
  }

  private _connect() {
    const url = this.getWsUrl();
    this._setStatus('connecting');

    try {
      this.ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._setStatus('connected');
      this.reconnectDelay = 1000;
      this.getNodes();
    };

    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);

        if (data.message_id && this.handlers.has(data.message_id)) {
          this.handlers.get(data.message_id)!(data);
          this.handlers.delete(data.message_id);
          return;
        }

        if (data.event === 'node_updated' || data.event === 'attribute_updated') {
          this.getNodes();
        }
      } catch {
        /* ignore parse errors */
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this._setStatus('disconnected');
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private _setStatus(s: 'connecting' | 'connected' | 'disconnected') {
    this._status = s;
    this.onStatusChange(s);
  }

  private _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    setTimeout(() => {
      if (this.shouldReconnect && !this.ws) this._connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
  }

  private _send(msg: MatterMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      this.handlers.set(msg.message_id, resolve);
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.handlers.has(msg.message_id)) {
          this.handlers.delete(msg.message_id);
          reject(new Error('Timeout'));
        }
      }, 10000);
    });
  }

  async getNodes() {
    try {
      const resp = (await this._send({
        message_id: String(++this.msgId),
        command: 'get_nodes'
      })) as { result?: unknown[] };
      if (resp?.result) {
        this.onNodesUpdate(resp.result);
      }
    } catch {
      /* reconnect will retry */
    }
  }

  async sendCommand(
    nodeId: number,
    commandName: string,
    payload?: Record<string, unknown>
  ) {
    const args: Record<string, unknown> = {
      endpoint_id: 1,
      node_id: nodeId,
      cluster_id: 258,
      command_name: commandName
    };
    args.payload = payload || {};

    await this._send({
      message_id: String(++this.msgId),
      command: 'device_command',
      args
    });

    setTimeout(() => this.getNodes(), 500);
    setTimeout(() => this.getNodes(), 2000);
  }

  async open(nodeId: number) {
    await this.sendCommand(nodeId, 'UpOrOpen');
  }

  async close(nodeId: number) {
    await this.sendCommand(nodeId, 'DownOrClose');
  }

  async stop(nodeId: number) {
    await this.sendCommand(nodeId, 'StopMotion');
  }

  async goToPosition(nodeId: number, percent: number) {
    const value = Math.round(Math.max(0, Math.min(100, percent)) * 100);
    await this.sendCommand(nodeId, 'GoToLiftPercentage', {
      liftPercent100thsValue: value
    });
  }
}

/** Build WS URL based on current page location */
export function getMatterWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const loc = window.location;
  if (loc.protocol === 'https:') {
    return `wss://${loc.host}/matter/ws`;
  }
  return 'ws://192.168.1.29:5580/ws';
}
