/**
 * Matter store — état des volets roulants et interrupteurs (Svelte 5 Runes).
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

export interface Switch {
  nodeId: number;
  name: string;
  room: string;
  available: boolean;
  /** true = on, false = off */
  isOn: boolean;
}

export interface DeviceGroup {
  room: string;
  shutters: Shutter[];
  switches: Switch[];
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

// Sonoff Matter Smart Switch — assignation par date de commissioning.
// node 1 commissionné le 2026-05-15, node 22 le 2026-05-24, node 24 le
// 2026-05-27 (commissioning via VPS, network_only mDNS).
const SWITCH_NAMES: Record<number, { name: string; room: string }> = {
  1: { name: 'Bureau multimédia', room: 'Bureau' },
  22: { name: 'Sèche-serviette', room: 'Salle de bain' },
  24: { name: 'Chargeur Lau', room: 'Séjour' }
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

function parseSwitch(node: Record<string, unknown>): Switch | null {
  const nodeId = node.node_id as number;
  const available = node.available as boolean;
  const attrs = (node.attributes || {}) as Record<string, unknown>;

  // Doit avoir OnOff (6) mais PAS WindowCovering (258).
  const hasOnOff = Object.keys(attrs).some((k) => k.includes('/6/'));
  const hasWC = Object.keys(attrs).some((k) => k.includes('/258/'));
  if (!hasOnOff || hasWC) return null;

  // Attribut OnOff : endpoint 1, cluster 6, attribute 0 = OnOff state (bool).
  const isOn = Boolean(attrs['1/6/0'] ?? false);

  const meta = SWITCH_NAMES[nodeId] || {
    name: `Interrupteur ${nodeId}`,
    room: 'Autre'
  };

  return { nodeId, name: meta.name, room: meta.room, available, isOn };
}

class MatterState {
  shutters = $state<Shutter[]>([]);
  switches = $state<Switch[]>([]);
  connectionStatus = $state<'connected' | 'connecting' | 'disconnected'>('disconnected');
  private client: MatterClient | null = null;

  rooms = $derived.by<DeviceGroup[]>(() => {
    const grouped = new Map<string, DeviceGroup>();
    const ensure = (room: string): DeviceGroup => {
      let g = grouped.get(room);
      if (!g) {
        g = { room, shutters: [], switches: [] };
        grouped.set(room, g);
      }
      return g;
    };

    for (const s of this.shutters) ensure(s.room).shutters.push(s);
    for (const sw of this.switches) ensure(sw.room).switches.push(sw);

    return [...grouped.values()].sort((a, b) => {
      const ca = a.shutters.length + a.switches.length;
      const cb = b.shutters.length + b.switches.length;
      if (ca !== cb) return cb - ca;
      return a.room.localeCompare(b.room, 'fr');
    });
  });

  get onlineCount(): number {
    return this.shutters.filter((s) => s.available).length;
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.client) return;

    this.client = new MatterClient(getMatterWsUrl);

    this.client.setOnNodesUpdate((nodes) => {
      const raw = nodes as Record<string, unknown>[];

      const parsedShutters = raw.map(parseShutter).filter((s): s is Shutter => s !== null);
      parsedShutters.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return a.nodeId - b.nodeId;
      });
      this.shutters = parsedShutters;

      const parsedSwitches = raw.map(parseSwitch).filter((s): s is Switch => s !== null);
      parsedSwitches.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return a.nodeId - b.nodeId;
      });
      this.switches = parsedSwitches;
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

  async turnOn(nodeId: number) {
    await this.client?.turnOn(nodeId);
  }

  async turnOff(nodeId: number) {
    await this.client?.turnOff(nodeId);
  }

  async toggleSwitch(nodeId: number) {
    const sw = this.switches.find((s) => s.nodeId === nodeId);
    if (!sw) return;
    if (sw.isOn) {
      await this.client?.turnOff(nodeId);
    } else {
      await this.client?.turnOn(nodeId);
    }
  }

  async openRoom(room: string) {
    for (const s of this.shutters.filter((s) => s.available && s.room === room)) {
      await this.client?.open(s.nodeId);
    }
  }

  async closeRoom(room: string) {
    for (const s of this.shutters.filter((s) => s.available && s.room === room)) {
      await this.client?.close(s.nodeId);
    }
  }

  async switchesOnInRoom(room: string) {
    for (const sw of this.switches.filter((s) => s.available && s.room === room)) {
      await this.client?.turnOn(sw.nodeId);
    }
  }

  async switchesOffInRoom(room: string) {
    for (const sw of this.switches.filter((s) => s.available && s.room === room)) {
      await this.client?.turnOff(sw.nodeId);
    }
  }
}

export const matter = new MatterState();
