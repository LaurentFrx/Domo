/**
 * Store Matter — client WebSocket vers python-matter-server (Svelte 5 Runes).
 *
 * Protocole : envoie `{message_id, command, args}` et reçoit des frames qui
 * contiennent soit `result` (réponse à une commande), soit `event` (push).
 * Pour les volets roulants, on s'appuie sur le cluster WindowCovering (258).
 */

type WebSocketCtor = new (url: string) => WebSocket;

export type AttributeMap = Record<string, unknown>;

export interface MatterNode {
  node_id: number;
  available: boolean;
  attributes: AttributeMap;
}

interface ServerMessage {
  message_id?: string;
  result?: unknown;
  event?: string;
  error_code?: string | number;
  details?: unknown;
  [key: string]: unknown;
}

interface NodeUpdateEvent {
  node_id: number;
  available?: boolean;
  attributes?: AttributeMap;
}

interface AttributeUpdatedEvent {
  node_id: number;
  endpoint: number;
  cluster_id: number;
  attribute_id: number;
  value: unknown;
}

const WINDOW_COVERING_CLUSTER = 258;
const CURRENT_LIFT_ATTR = 14;
const TARGET_LIFT_ATTR = 11;
const OPERATIONAL_STATUS_ATTR = 10;

/** Construit la clé d'attribut Matter au format `endpoint/cluster/attribute`. */
export function attrKey(endpoint: number, cluster: number, attribute: number): string {
  return `${endpoint}/${cluster}/${attribute}`;
}

/** Lit `CurrentPositionLiftPercent100ths` (0–10000) sur l'endpoint 1. */
export function readLiftPercent100ths(node: MatterNode): number | null {
  const raw = node.attributes[attrKey(1, WINDOW_COVERING_CLUSTER, CURRENT_LIFT_ATTR)];
  return typeof raw === 'number' ? raw : null;
}

class MatterStore {
  // ─── Config ───
  wsUrl = $state('ws://192.168.1.29:5580/ws');

  // ─── State ───
  connected = $state(false);
  reconnecting = $state(false);
  nodes = $state<MatterNode[]>([]);

  // ─── Internals ───
  #ws: WebSocket | null = null;
  #messageId = 0;
  #retries = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #manuallyClosed = false;
  readonly #maxRetries = 10;
  readonly #reconnectDelayMs = 5_000;

  /** Ouvre la connexion (idempotent). */
  connect(): void {
    if (typeof window === 'undefined') return; // SSR-safe
    if (
      this.#ws &&
      (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.#manuallyClosed = false;
    this.#open();
  }

  /** Coupe la connexion et désactive l'auto-reconnect. */
  disconnect(): void {
    this.#manuallyClosed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        /* noop */
      }
      this.#ws = null;
    }
    this.connected = false;
    this.reconnecting = false;
  }

  /** Envoie une commande générique sur un endpoint/cluster donné. */
  sendCommand(
    nodeId: number,
    endpointId: number,
    clusterId: number,
    commandName: string,
    args?: Record<string, unknown>
  ): void {
    this.#send({
      command: 'device_command',
      args: {
        node_id: nodeId,
        endpoint_id: endpointId,
        cluster_id: clusterId,
        command_name: commandName,
        ...(args ? { payload: args } : {})
      }
    });
  }

  // ─── Helpers volets (cluster WindowCovering 258, endpoint 1) ───

  openShutter(nodeId: number): void {
    this.sendCommand(nodeId, 1, WINDOW_COVERING_CLUSTER, 'UpOrOpen');
  }

  closeShutter(nodeId: number): void {
    this.sendCommand(nodeId, 1, WINDOW_COVERING_CLUSTER, 'DownOrClose');
  }

  stopShutter(nodeId: number): void {
    this.sendCommand(nodeId, 1, WINDOW_COVERING_CLUSTER, 'StopMotion');
  }

  /**
   * Position cible en pourcent d'ouverture (0 = fermé, 100 = ouvert).
   * Matter exprime `lift_percent_100ths` côté FERMETURE : 0 = ouvert, 10000 = fermé.
   * On inverse ici pour exposer une sémantique « 100 % = ouvert » côté UI.
   */
  setPosition(nodeId: number, percentOpen: number): void {
    const clamped = Math.max(0, Math.min(100, percentOpen));
    const liftPercent100ths = Math.round((100 - clamped) * 100);
    this.sendCommand(nodeId, 1, WINDOW_COVERING_CLUSTER, 'GoToLiftPercentage', {
      lift_percent_100ths_value: liftPercent100ths
    });
  }

  // ─── Sélecteurs dérivés ───

  /** Pourcentage d'ouverture (0–100) ou `null` si inconnu. */
  positionFor(nodeId: number): number | null {
    const node = this.nodes.find((n) => n.node_id === nodeId);
    if (!node) return null;
    const liftClosed = readLiftPercent100ths(node);
    if (liftClosed === null) return null;
    return Math.round(100 - liftClosed / 100);
  }

  /** `true` si le nœud répond. */
  isAvailable(nodeId: number): boolean {
    const node = this.nodes.find((n) => n.node_id === nodeId);
    return node?.available ?? false;
  }

  // ─── Internes ───

  #open(): void {
    const Ctor = (globalThis.WebSocket ?? undefined) as WebSocketCtor | undefined;
    if (!Ctor) return;

    let ws: WebSocket;
    try {
      ws = new Ctor(this.wsUrl);
    } catch (err) {
      console.error('[matter] WebSocket construction failed', err);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.reconnecting = false;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.#retries = 0;
      this.#send({ command: 'get_nodes' });
    });

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
      this.#handleRaw(ev.data);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this.#ws = null;
      if (!this.#manuallyClosed) this.#scheduleReconnect();
    });

    ws.addEventListener('error', (err) => {
      console.warn('[matter] WebSocket error', err);
      // close suivra
    });
  }

  #scheduleReconnect(): void {
    if (this.#manuallyClosed) return;
    if (this.#retries >= this.#maxRetries) {
      console.warn('[matter] max retries reached, giving up');
      return;
    }
    this.#retries += 1;
    this.reconnecting = true;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, this.#reconnectDelayMs);
  }

  #send(payload: { command: string; args?: Record<string, unknown> }): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#messageId += 1;
    const frame = {
      message_id: String(this.#messageId),
      command: payload.command,
      ...(payload.args ? { args: payload.args } : {})
    };
    try {
      this.#ws.send(JSON.stringify(frame));
    } catch (err) {
      console.error('[matter] send failed', err);
    }
  }

  #handleRaw(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    // Réponse à get_nodes : un tableau de nœuds.
    if (Array.isArray(msg.result)) {
      this.#ingestNodes(msg.result);
      return;
    }

    // Événements push.
    if (typeof msg.event === 'string') {
      this.#handleEvent(msg.event, msg);
    }
  }

  #handleEvent(event: string, msg: ServerMessage): void {
    if (event === 'node_added' || event === 'node_updated') {
      const data = (msg.data ?? msg.result) as NodeUpdateEvent | undefined;
      if (!data) return;
      this.#upsertNode({
        node_id: data.node_id,
        available: data.available ?? true,
        attributes: data.attributes ?? {}
      });
      return;
    }

    if (event === 'attribute_updated') {
      const data = (msg.data ?? msg.result) as AttributeUpdatedEvent | undefined;
      if (!data) return;
      this.#updateAttribute(data);
      return;
    }
  }

  #ingestNodes(rawNodes: unknown[]): void {
    const next: MatterNode[] = [];
    for (const raw of rawNodes) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;
      const nodeId = obj.node_id;
      if (typeof nodeId !== 'number') continue;
      next.push({
        node_id: nodeId,
        available: typeof obj.available === 'boolean' ? obj.available : true,
        attributes: (obj.attributes as AttributeMap | undefined) ?? {}
      });
    }
    this.nodes = next;
  }

  #upsertNode(node: MatterNode): void {
    const idx = this.nodes.findIndex((n) => n.node_id === node.node_id);
    if (idx === -1) {
      this.nodes = [...this.nodes, node];
    } else {
      const merged: MatterNode = {
        node_id: node.node_id,
        available: node.available,
        attributes: { ...this.nodes[idx].attributes, ...node.attributes }
      };
      const copy = this.nodes.slice();
      copy[idx] = merged;
      this.nodes = copy;
    }
  }

  #updateAttribute(ev: AttributeUpdatedEvent): void {
    const key = attrKey(ev.endpoint, ev.cluster_id, ev.attribute_id);
    const idx = this.nodes.findIndex((n) => n.node_id === ev.node_id);
    if (idx === -1) {
      this.nodes = [
        ...this.nodes,
        { node_id: ev.node_id, available: true, attributes: { [key]: ev.value } }
      ];
      return;
    }
    const copy = this.nodes.slice();
    copy[idx] = {
      ...copy[idx],
      attributes: { ...copy[idx].attributes, [key]: ev.value }
    };
    this.nodes = copy;
  }
}

export const matter = new MatterStore();

// Constantes exportées pour les consommateurs avancés.
export const MATTER_CLUSTERS = {
  WINDOW_COVERING: WINDOW_COVERING_CLUSTER
} as const;

export const MATTER_ATTRS = {
  CURRENT_LIFT_PERCENT_100THS: CURRENT_LIFT_ATTR,
  TARGET_LIFT_PERCENT_100THS: TARGET_LIFT_ATTR,
  OPERATIONAL_STATUS: OPERATIONAL_STATUS_ATTR
} as const;
