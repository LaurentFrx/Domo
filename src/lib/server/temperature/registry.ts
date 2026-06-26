/**
 * Registre des capteurs de température historisés.
 *
 * Source de vérité partagée par le collecteur (quoi échantillonner) ET la route
 * de lecture (valider `?sensor=` — jamais de chaîne arbitraire injectée en SQL).
 *
 * Clés stables (= ce que le client passe à `openTempHistory`) :
 *   - Zigbee : le friendly_name tel quel (ex. « Thermo Salon »).
 *   - Airzone : `airzone:<id de zone>` (zones lues dynamiquement du bridge).
 *   - Daikin extérieur : `daikin:outdoor`.
 *   - Météo : `meteo:sanguinet`.
 */

export interface ZigbeeSensor {
  /** Clé stable = friendly_name (paramètre `?sensor=`). */
  key: string;
  /** Topic MQTT souscrit pour lire la dernière valeur (retained). */
  topic: string;
  /** Libellé d'affichage par défaut (le client peut passer un libellé live). */
  label: string;
  room: string;
}

/** Sondes Zigbee SNZB-02 historisées (cache MQTT chaud côté serveur). */
export const ZIGBEE_SENSORS: ZigbeeSensor[] = [
  { key: 'Thermo Salon', topic: 'zigbee2mqtt/Thermo Salon', label: 'Séjour', room: 'Séjour' },
  {
    key: 'Thermo SdB',
    topic: 'zigbee2mqtt/Thermo SdB',
    label: 'Salle de bain',
    room: 'Salle de bain'
  },
  { key: 'Thermo Garage', topic: 'zigbee2mqtt/Thermo Garage', label: 'Atelier', room: 'Atelier' },
  {
    key: 'thermo_cumulus',
    topic: 'zigbee2mqtt/thermo_cumulus',
    label: 'Eau chaude (ballon)',
    room: 'Garage'
  },
  {
    key: 'Thermo_ext',
    topic: 'zigbee2mqtt/Thermo_ext',
    label: 'Terrasse Ouest',
    room: 'Extérieur'
  },
  {
    key: 'Thermo_velos',
    topic: 'zigbee2mqtt/Thermo_velos',
    label: 'Local Vélos',
    room: 'Extérieur'
  }
];

const STATIC_KEYS = new Set<string>([
  ...ZIGBEE_SENSORS.map((s) => s.key),
  'daikin:outdoor',
  'meteo:sanguinet'
]);

/** Clé acceptée par la route de lecture ? (anti-injection : registre fermé.) */
export function isValidSensorKey(key: string): boolean {
  if (STATIC_KEYS.has(key)) return true;
  // Zones Airzone : nombre de zones dynamique selon l'installation.
  return /^airzone:\d+$/.test(key);
}

/**
 * Zone de confort [min, max] °C par capteur — sert à COLORER la courbe selon
 * l'état (trop froid / confortable / trop chaud) et non la seule température
 * absolue. Valeurs indicatives, faciles à ajuster.
 */
export function comfortBand(key: string): [number, number] {
  if (key === 'thermo_cumulus') return [50, 62]; // eau chaude sanitaire souhaitée
  if (key === 'Thermo SdB') return [21, 25]; // salle de bain (un peu plus chaud)
  if (key === 'Thermo Garage') return [15, 23]; // atelier / garage (tolérant)
  if (
    key === 'Thermo_ext' ||
    key === 'Thermo_velos' ||
    key === 'meteo:sanguinet' ||
    key === 'daikin:outdoor'
  ) {
    return [16, 26]; // extérieur : plage de ressenti agréable
  }
  return [19, 24]; // pièces de vie (Thermo Salon, zones Airzone…)
}
