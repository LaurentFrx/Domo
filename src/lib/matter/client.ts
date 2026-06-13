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
    // Un reconnect différé peut être en attente : on repart proprement.
    this._clearReconnectTimer();
    this._connect();
  }

  disconnect() {
    this.shouldReconnect = false;
    // Nettoie les timers en vol (refresh debounce + reconnexion différée) :
    // sans ça, un getNodes/_connect orphelin peut repartir après destruction.
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this._clearReconnectTimer();
    this.reconnectDelay = 1000;
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
      // `start_listening` retourne le dump initial dans `result` ET active le
      // push des événements `attribute_updated` / `node_updated`. Sans ça, le
      // serveur reste muet → l'UI ne se met à jour qu'après chaque commande
      // locale (via les polls de `sendCommand`), pas en temps réel.
      this.startListening();
    };

    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);

        if (data.message_id && this.handlers.has(data.message_id)) {
          this.handlers.get(data.message_id)!(data);
          this.handlers.delete(data.message_id);
          return;
        }

        if (
          data.event === 'attribute_updated' ||
          data.event === 'node_updated' ||
          data.event === 'node_added' ||
          data.event === 'node_removed'
        ) {
          // Debounce : pendant un mouvement le serveur push plusieurs events
          // par seconde (CurrentPosition, TargetPosition, OperationalStatus).
          // On groupe les refresh par tranches de 200 ms pour ne pas marteler
          // le serveur avec des `get_nodes`.
          this._scheduleRefresh();
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

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this._clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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

  /**
   * Active le push d'événements `attribute_updated` / `node_updated` côté
   * serveur. La réponse contient le dump initial des nœuds (équivalent à
   * `get_nodes`), qu'on propage directement au store.
   */
  async startListening() {
    try {
      const resp = (await this._send({
        message_id: String(++this.msgId),
        command: 'start_listening'
      })) as { result?: unknown[] };
      if (resp?.result) {
        this.onNodesUpdate(resp.result);
      }
    } catch {
      /* reconnect will retry */
    }
  }

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.getNodes();
    }, 200);
  }

  async sendCommand(
    nodeId: number,
    endpointId: number,
    clusterId: number,
    commandName: string,
    payload?: Record<string, unknown>
  ) {
    const args: Record<string, unknown> = {
      endpoint_id: endpointId,
      node_id: nodeId,
      cluster_id: clusterId,
      command_name: commandName,
      payload: payload || {}
    };

    await this._send({
      message_id: String(++this.msgId),
      command: 'device_command',
      args
    });

    // Filet de sécurité : si pour une raison X le serveur ne pousse pas
    // l'event de mouvement (race, paquet perdu), on garantit un refresh
    // visuel dans la seconde. Les events `attribute_updated` arrivent
    // normalement avant, et le _scheduleRefresh debounce déduplique.
    setTimeout(() => this._scheduleRefresh(), 800);
  }

  async open(nodeId: number) {
    await this.sendCommand(nodeId, 1, 258, 'UpOrOpen');
  }

  async close(nodeId: number) {
    await this.sendCommand(nodeId, 1, 258, 'DownOrClose');
  }

  async stop(nodeId: number) {
    await this.sendCommand(nodeId, 1, 258, 'StopMotion');
  }

  async goToPosition(nodeId: number, percent: number) {
    const value = Math.round(Math.max(0, Math.min(100, percent)) * 100);
    await this.sendCommand(nodeId, 1, 258, 'GoToLiftPercentage', {
      liftPercent100thsValue: value
    });
  }

  async turnOn(nodeId: number) {
    await this.sendCommand(nodeId, 1, 6, 'On');
  }

  async turnOff(nodeId: number) {
    await this.sendCommand(nodeId, 1, 6, 'Off');
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
