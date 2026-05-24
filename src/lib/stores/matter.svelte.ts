/**
 * Matter store — état des volets roulants (Svelte 5 Runes).
 */

import { MatterClient, getMatterWsUrl } from '$lib/matter/client';

export interface Shutter {
  nodeId: number;
  name: string;
  room: string;
  available: boolean;
  /** 0 = fully open, 100 = fully closed */
  position: number;
  /** 0 = fully open, 100 = fully closed */
  targetPosition: number;
  /** true if motor is moving */
  moving: boolean;
}

// Re-commissioning du 24/05/2026 — nouveau mapping des node_ids
// (cf. matter-server fabric 1, après cleanup des zombies 2-7).
const NODE_NAMES: Record<number, { name: string; room: string }> = {
  12: { name: 'Balcon', room: 'Étage' },
  13: { name: 'Salle à manger', room: 'Séjour' },
  18: { name: 'Salon', room: 'Séjour' },
  19: { name: 'Bureau', room: 'Étage' },
  20: { name: 'Chambre parents', room: 'Étage' },
  21: { name: 'Chambre amis', room: 'Étage' }
};

function parseShutter(node: Record<string, unknown>): Shutter | null {
  const nodeId = node.node_id as number;
  const available = node.available as boolean;
  const attrs = (node.attributes || {}) as Record<string, unknown>;

  const hasWC = Object.keys(attrs).some((k) => k.includes('/258/'));
  if (!hasWC) return null;

  let label = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (k.includes('/40/5') && v) label = String(v);
  }

  const meta = NODE_NAMES[nodeId] || {
    name: label || `Volet ${nodeId}`,
    room: 'Autre'
  };

  // Matter: 0 = open, 10000 = closed (hundredths of %)
  const pos100ths = (attrs['1/258/14'] ?? attrs['1/258/8'] ?? 0) as number;
  const target100ths = (attrs['1/258/11'] ?? 0) as number;
  const opStatus = (attrs['1/258/10'] ?? 0) as number;

  return {
    nodeId,
    name: meta.name,
    room: meta.room,
    available,
    position: Math.round(pos100ths / 100),
    targetPosition: Math.round(target100ths / 100),
    moving: opStatus !== 0
  };
}

class MatterState {
  shutters = $state<Shutter[]>([]);
  connectionStatus = $state<'connected' | 'connecting' | 'disconnected'>('disconnected');
  private client: MatterClient | null = null;

  get rooms(): string[] {
    const rooms = new Set(this.shutters.map((s) => s.room));
    return [...rooms].sort();
  }

  get onlineCount(): number {
    return this.shutters.filter((s) => s.available).length;
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.client) return;

    this.client = new MatterClient(getMatterWsUrl);

    this.client.setOnNodesUpdate((nodes) => {
      const raw = nodes as Record<string, unknown>[];
      const parsed = raw.map(parseShutter).filter((s): s is Shutter => s !== null);
      parsed.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return a.nodeId - b.nodeId;
      });
      this.shutters = parsed;
    });

    this.client.setOnStatusChange((status) => {
      this.connectionStatus = status as typeof this.connectionStatus;
    });

    this.client.connect();
  }

  disconnect() {
    this.client?.disconnect();
    this.client = null;
  }

  async open(nodeId: number) {
    await this.client?.open(nodeId);
  }
  async close(nodeId: number) {
    await this.client?.close(nodeId);
  }
  async stop(nodeId: number) {
    await this.client?.stop(nodeId);
  }
  async goToPosition(nodeId: number, percent: number) {
    await this.client?.goToPosition(nodeId, percent);
  }

  async openAll() {
    for (const s of this.shutters.filter((s) => s.available)) {
      await this.client?.open(s.nodeId);
    }
  }

  async closeAll() {
    for (const s of this.shutters.filter((s) => s.available)) {
      await this.client?.close(s.nodeId);
    }
  }
}

export const matter = new MatterState();
