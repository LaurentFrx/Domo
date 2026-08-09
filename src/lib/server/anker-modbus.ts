/**
 * Client Modbus TCP minimal — LECTURE SEULE — pour les devices Anker Solix
 * locaux, via la loopback du VPS (sorties du tunnel SSH inverse
 * tunnel-1502-anker-modbus.sh + crontab @reboot sur le RPi4, modèle
 * tunnel-8102-em50.sh) :
 *   127.0.0.1:1502 → Anker Smart Meter Gen 2  192.168.1.48:502
 *
 * Le tunnel 1503 desservait la Solarbank Max AC, retirée de l'installation le
 * 09/08/2026 — plus rien ne la lit. ⚠️ Elle répondait ENCORE en Modbus après son
 * débranchement (batterie interne + Wi-Fi actif) : continuer à la lire aurait
 * versé 7,1 kWh de batterie INERTE dans le SoC du parc sans qu'aucun fail-safe
 * ne s'en aperçoive — c'est pourquoi le lecteur a été supprimé, pas désactivé.
 * Modbus TCP = TCP brut : le -R ssh le transporte tel quel, comme le RPC HTTP
 * du EM-50. Deux -R dans un seul process ssh (ExitOnForwardFailure=yes).
 *
 * Registres SOURCÉS depuis l'intégration HA OFFICIELLE Anker
 * (github.com/anker-charging/ha-anker-solix-official, config/*.yaml par
 * produit) — AUCUN registre deviné. Conventions relevées dans son code :
 *   - unit ID 1 (défaut pymodbus, aucun slave explicite dans modbus_client.py) ;
 *   - INT32 big-endian, mot HAUT d'abord (registers[0] = 16 bits hauts) ;
 *   - YAML « legacy » (liste plate, cas du meter) = input registers (FC 04) ;
 *   - Solarbank : operating_mode 10064 est en plage HOLDING (FC 03).
 *
 * SÉCURITÉ : seuls les function codes de LECTURE 03/04 existent dans ce module.
 * Aucune écriture Modbus n'est possible depuis Domo, par construction.
 *
 * Concurrence : un poll partage sa promesse (deux requêtes simultanées ne
 * double-connectent pas le device) + micro-cache pour absorber deux clients
 * (iPhone + iPad) sans rafale de sockets sur des firmwares mono-connexion.
 */
import { connect } from 'node:net';
import { env } from '$env/dynamic/private';

// ─── Cibles (IP/ports/unit IDs surchargables par env, défauts = tunnels) ──
interface ModbusTarget {
  host: string;
  port: number;
  unitId: number;
}

const meterTarget = (): ModbusTarget => ({
  host: env.ANKER_MODBUS_METER_HOST ?? '127.0.0.1',
  port: Number(env.ANKER_MODBUS_METER_PORT ?? 1502),
  unitId: Number(env.ANKER_MODBUS_METER_UNIT ?? 1)
});
/** −1 si la convention du CT réseau devait s'inverser (cf. EM50_GRID_SIGN). */
const meterSign = (): 1 | -1 => (Number(env.ANKER_MODBUS_METER_SIGN ?? 1) < 0 ? -1 : 1);

// Budget par device et par poll (connexion + toutes les transactions). Le
// device est en LAN via tunnel (~10-30 ms/transaction) : 5 s = déjà une panne.
const DEVICE_TIMEOUT_MS = 5_000;

// ─── Transport : une socket par poll, transactions séquentielles ──────────
type ReadFc = 3 | 4;
interface ReadSpec {
  fc: ReadFc;
  address: number;
  count: number;
}

/**
 * Ouvre UNE connexion TCP vers `target`, exécute les lectures en séquence
 * (une requête Modbus en vol à la fois), ferme, et rend les registres 16 bits
 * de chaque lecture. Toute anomalie (timeout global, exception Modbus, trame
 * incohérente) rejette — l'appelant traduit en `available:false`.
 */
function readMany(target: ModbusTarget, reads: ReadSpec[]): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const results: number[][] = [];
    let current = 0;
    let txId = Math.floor(Math.random() * 0xf000);
    let buf = Buffer.alloc(0);
    let settled = false;

    const sock = connect({ host: target.host, port: target.port });
    sock.setNoDelay(true);

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('timeout'), DEVICE_TIMEOUT_MS);

    const sendCurrent = () => {
      const { fc, address, count } = reads[current];
      txId = (txId + 1) & 0xffff;
      const req = Buffer.alloc(12);
      req.writeUInt16BE(txId, 0); // transaction id
      req.writeUInt16BE(0, 2); // protocol id (Modbus = 0)
      req.writeUInt16BE(6, 4); // longueur unit+PDU
      req.writeUInt8(target.unitId, 6);
      req.writeUInt8(fc, 7);
      req.writeUInt16BE(address, 8);
      req.writeUInt16BE(count, 10);
      buf = Buffer.alloc(0);
      sock.write(req);
    };

    sock.on('connect', sendCurrent);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return; // MBAP (7) + fc + byteCount/exception
      if (buf.readUInt16BE(0) !== txId) return fail('transaction id inattendu');
      const fc = reads[current].fc;
      const rfc = buf.readUInt8(7);
      if (rfc === fc + 0x80) return fail(`exception Modbus 0x${buf.readUInt8(8).toString(16)}`);
      if (rfc !== fc) return fail(`function code inattendu (${rfc})`);
      const byteCount = buf.readUInt8(8);
      if (byteCount !== reads[current].count * 2) return fail('longueur de réponse inattendue');
      if (buf.length < 9 + byteCount) return; // trame incomplète, attendre la suite
      const regs: number[] = [];
      for (let i = 0; i < byteCount / 2; i++) regs.push(buf.readUInt16BE(9 + i * 2));
      results.push(regs);
      current += 1;
      if (current >= reads.length) {
        settled = true;
        clearTimeout(timer);
        sock.end();
        sock.destroy();
        resolve(results);
        return;
      }
      sendCurrent();
    });
    sock.on('error', (e) => fail(e.message));
    sock.on('close', () => fail('connexion fermée'));
  });
}

// ─── Décodage (conventions de l'intégration officielle) ───────────────────
/** INT32 big-endian, mot haut d'abord. Les bitwise JS rendent l'int32 signé. */
const i32 = (hi: number, lo: number): number => ((hi & 0xffff) << 16) | (lo & 0xffff) | 0;

// ─── Smart Meter Gen 2 (192.168.1.48) ─────────────────────────────────────
export interface AnkerMeterStatus {
  available: boolean;
  /** Réseau signé (W), MÊME convention que grid_power_w du EM-50 :
   *  + soutirage EDF / − injection PV (vérifié en réel contre le EM-50). */
  grid_power_w: number;
  /** Tension phase 1 (V). */
  voltage_v: number;
}

const METER_OFFLINE: AnkerMeterStatus = { available: false, grid_power_w: 0, voltage_v: 0 };

/**
 * Une transaction FC 04 @10632 ×14 couvre :
 *   10632 primary_phase_1_voltage (UINT16, /10) → offset 0
 *   10644 primary_total_active_power (INT32)    → offsets 12-13
 */
async function fetchMeter(): Promise<AnkerMeterStatus> {
  const [r] = await readMany(meterTarget(), [{ fc: 4, address: 10632, count: 14 }]);
  return {
    available: true,
    grid_power_w: meterSign() * i32(r[12], r[13]),
    voltage_v: r[0] / 10
  };
}

// ─── Partage de vol + micro-cache (absorbe iPhone + iPad simultanés) ──────
const CACHE_MS = 1_500;

function shared<T>(fetcher: () => Promise<T>, offline: T): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  let last: { at: number; value: T } | null = null;
  return () => {
    if (last && Date.now() - last.at < CACHE_MS) return Promise.resolve(last.value);
    inflight ??= fetcher()
      .catch(() => offline)
      .then((value) => {
        last = { at: Date.now(), value };
        inflight = null;
        return value;
      });
    return inflight;
  };
}

/** Lecture Smart Meter Gen 2 — ne rejette jamais (offline ⇒ available:false). */
export const readAnkerMeter = shared(fetchMeter, METER_OFFLINE);
