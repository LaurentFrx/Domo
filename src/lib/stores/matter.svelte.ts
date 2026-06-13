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
  /** Durée de course pleine AFFICHÉE (ms) — cale l'animation sur le temps réel
   *  pour les stores bridés. Absent = vitesse d'animation par défaut. */
  travelMs?: number;
  /** Libellés des extrêmes (store-banne) : 0 % et 100 %. Défaut Ouvert/Fermé. */
  labelMin?: string;
  labelMax?: string;
}

export interface Switch {
  nodeId: number;
  name: string;
  room: string;
  available: boolean;
  /** true = on, false = off */
  isOn: boolean;
  /** Puissance active mesurée (W) si la prise expose le cluster 144 ; sinon absent. */
  powerW?: number;
  /** Alimentation critique : suivie en conso mais JAMAIS commandable (exclue de la
   *  page Pièces et des actions groupées). Ex. prise du concentrateur Matter. */
  monitorOnly?: boolean;
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
  21: { name: 'Chambre amis', room: 'Étage' },
  // node 25 commissionné le 2026-06-04 (Sonoff « WiFi Smart Switch »,
  // device type 514 WindowCovering) — store roulant du séjour.
  25: { name: 'Store', room: 'Séjour' }
};

// Sonoff Matter Smart Switch — assignation par date de commissioning.
// node 1 commissionné le 2026-05-15, node 22 le 2026-05-24, node 24 le
// 2026-05-27, node 26 le 2026-06-13 (tous network_only mDNS via le matter-server).
// Le node 26 (Sonoff Smart Plug) mesure la conso du home cinéma (cluster 144).
const SWITCH_NAMES: Record<number, { name: string; room: string }> = {
  1: { name: 'Sèche-serviette', room: 'Salle de bain' },
  22: { name: 'Bureau multimédia', room: 'Bureau' },
  24: { name: 'Chargeur Lau', room: 'Séjour' },
  26: { name: 'Home cinéma', room: 'Séjour' }
};

// Prises à ALIMENTATION CRITIQUE : suivies en conso mais JAMAIS commandables
// (exclues de la page Pièces, des actions groupées, et coupure refusée côté store).
// node 26 (Home cinéma) alimente l'Apple TV qui sert de CONCENTRATEUR Matter —
// la couper tuerait tout le réseau Matter.
const MONITOR_ONLY = new Set<number>([26]);

// ─── Stores bridés (sécurité matérielle) ───────────────────────────────
// La position du module (rapportée ET commandée via GoToLiftPercentage) va de
// 0 (replié/enroulé, au repos) à 100 (course pleine). Certains stores ne
// peuvent pas faire toute leur course sans heurter un obstacle : on borne le
// déploiement à maxOpenPercent ET on étire la plage [0 … maxOpenPercent] sur
// 0–100 % à l'écran (l'utilisateur voit un store « normal », butée = 100 %).
//   maxOpenPercent : déploiement physique maxi autorisé (au-delà = obstacle) ;
//   travelMs       : durée réelle mesurée de la course bridée (0 → maxOpenPercent) ;
//   labelMin/Max   : libellés des extrêmes (store-banne).
// Sens VÉRIFIÉ le 2026-06-05 par test direct : GoToLiftPercentage(x) déploie le
// module à x % (0 = enroulé), honoré au centième, le moteur s'arrête seul.
const SHUTTER_LIMITS: Record<
  number,
  { maxOpenPercent: number; travelMs: number; labelMin: string; labelMax: string }
> = {
  // node 25 (Store, Séjour) : au-delà de 75 % de déploiement il heurte des
  // tuiles voisines. Course 0 → 75 % chronométrée à ~42 s.
  25: { maxOpenPercent: 75, travelMs: 42_000, labelMin: 'Rentré', labelMax: 'Déployé' }
};

const clampPct = (p: number) => Math.max(0, Math.min(100, p));

/** Déploiement PHYSIQUE (%) à commander au module depuis une consigne AFFICHÉE.
 *  Borné DUR à maxOpenPercent → jamais déployé au-delà de la butée, quelle que
 *  soit l'entrée (sécurité anti-obstacle). */
function realFromDisplay(nodeId: number, displayPct: number): number {
  const limit = SHUTTER_LIMITS[nodeId];
  if (!limit) return clampPct(displayPct);
  return (clampPct(displayPct) / 100) * limit.maxOpenPercent;
}

/** % AFFICHÉ (0–100) depuis le déploiement PHYSIQUE rapporté par le module. */
function displayFromReal(nodeId: number, realPct: number): number {
  const limit = SHUTTER_LIMITS[nodeId];
  if (!limit) return clampPct(realPct);
  return clampPct(Math.round((realPct / limit.maxOpenPercent) * 100));
}

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
    // Déploiement réel (% de course) → échelle AFFICHÉE pour les stores bridés.
    position: displayFromReal(nodeId, Math.round(pos100ths / 100)),
    targetPosition: displayFromReal(nodeId, Math.round(target100ths / 100)),
    moving: opStatus !== 0,
    travelMs: SHUTTER_LIMITS[nodeId]?.travelMs,
    labelMin: SHUTTER_LIMITS[nodeId]?.labelMin,
    labelMax: SHUTTER_LIMITS[nodeId]?.labelMax
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

  // Puissance active : cluster 144 (ElectricalPowerMeasurement) attr 8 = ActivePower
  // en milliwatts ; absent si la prise ne mesure pas.
  const rawP = attrs['1/144/8'];
  const powerW = typeof rawP === 'number' ? rawP / 1000 : undefined;

  return {
    nodeId,
    name: meta.name,
    room: meta.room,
    available,
    isOn,
    powerW,
    monitorOnly: MONITOR_ONLY.has(nodeId)
  };
}

class MatterState {
  shutters = $state<Shutter[]>([]);
  switches = $state<Switch[]>([]);
  connectionStatus = $state<'connected' | 'connecting' | 'disconnected'>('disconnected');
  /** Une connexion a-t-elle déjà abouti depuis le dernier connect() ? Sert à
   *  distinguer « pas encore connecté » (état initial, normal) d'une vraie
   *  « connexion perdue » (déconnexion APRÈS un succès) → évite le faux message
   *  d'erreur qui flashait au montage de la page. */
  everConnected = $state(false);
  private client: MatterClient | null = null;

  /** Switches commandables : exclut les monitorOnly (alimentation critique). À
   *  utiliser pour l'AFFICHAGE et la commande ; `switches` (tout) reste exposé
   *  pour le suivi conso (page Énergie). */
  commandableSwitches = $derived(this.switches.filter((s) => !s.monitorOnly));

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
    // monitorOnly exclus : aucune tuile commandable pour une alim critique.
    for (const sw of this.commandableSwitches) ensure(sw.room).switches.push(sw);

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
      if (status === 'connected') this.everConnected = true;
    });

    this.client.connect();
  }

  disconnect() {
    this.client?.disconnect();
    this.client = null;
    // Déconnexion volontaire (départ de la page) : on repart « neuf » au prochain
    // montage → pas de message « perdue » au retour sur la page.
    this.everConnected = false;
  }

  async open(nodeId: number) {
    // « Rentrer » : UpOrOpen ramène à la position 0 (enroulé) → sûr pour tous,
    // y compris les stores bridés (s'éloigne de l'obstacle).
    await this.client?.open(nodeId);
  }
  async close(nodeId: number) {
    const limit = SHUTTER_LIMITS[nodeId];
    if (limit) {
      // Store bridé : « déployer » = aller à la BUTÉE (maxOpenPercent) par
      // positionnement. JAMAIS DownOrClose (qui irait à 100 % → obstacle).
      await this.client?.goToPosition(nodeId, limit.maxOpenPercent);
    } else {
      await this.client?.close(nodeId);
    }
  }
  async stop(nodeId: number) {
    await this.client?.stop(nodeId);
  }
  async goToPosition(nodeId: number, percent: number) {
    // percent = consigne AFFICHÉE (0–100) → déploiement physique borné dur.
    await this.client?.goToPosition(nodeId, realFromDisplay(nodeId, percent));
  }

  async openAll() {
    for (const s of this.shutters.filter((s) => s.available)) {
      await this.open(s.nodeId); // « rentrer » tous (UpOrOpen → 0)
    }
  }

  async closeAll() {
    for (const s of this.shutters.filter((s) => s.available)) {
      await this.close(s.nodeId); // routé via close() → déploiement borné des stores bridés
    }
  }

  async turnOn(nodeId: number) {
    await this.client?.turnOn(nodeId);
  }

  async turnOff(nodeId: number) {
    // Sécurité : ne JAMAIS couper une prise à alimentation critique (concentrateur Matter).
    if (this.switches.find((s) => s.nodeId === nodeId)?.monitorOnly) return;
    await this.client?.turnOff(nodeId);
  }

  async toggleSwitch(nodeId: number) {
    const sw = this.switches.find((s) => s.nodeId === nodeId);
    if (!sw || sw.monitorOnly) return; // alim critique : non commandable
    if (sw.isOn) {
      await this.client?.turnOff(nodeId);
    } else {
      await this.client?.turnOn(nodeId);
    }
  }

  async openRoom(room: string) {
    for (const s of this.shutters.filter((s) => s.available && s.room === room)) {
      await this.open(s.nodeId); // « rentrer » la pièce (UpOrOpen → 0)
    }
  }

  async closeRoom(room: string) {
    for (const s of this.shutters.filter((s) => s.available && s.room === room)) {
      await this.close(s.nodeId); // routé via close() → déploiement borné des stores bridés
    }
  }

  async switchesOnInRoom(room: string) {
    for (const sw of this.switches.filter(
      (s) => s.available && s.room === room && !s.monitorOnly
    )) {
      await this.client?.turnOn(sw.nodeId);
    }
  }

  async switchesOffInRoom(room: string) {
    // !monitorOnly : un « tout éteindre » de pièce ne doit pas couper une alim critique.
    for (const sw of this.switches.filter(
      (s) => s.available && s.room === room && !s.monitorOnly
    )) {
      await this.client?.turnOff(sw.nodeId);
    }
  }
}

export const matter = new MatterState();
