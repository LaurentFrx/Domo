/**
 * CALIBRATION DE LA VOIE RÉSEAU DE L'EM-50 — le compteur qui gouverne tout.
 *
 * ⛔ Découvert le 01/09/2026, en confrontant Domo au compteur ENEDIS.
 *
 * La voie 0 du Shelly Pro EM-50 SOUS-LIT d'environ 35 W. Domo affichait donc une
 * « injection permanente » de 25 à 40 W, jour et nuit, depuis la mise en service
 * du compteur (13/06) — alors que la maison SOUTIRAIT quelques watts.
 *
 * Preuve, sur 3 421 demi-heures appariées (13/06 → 30/08) : là où Enedis mesure
 * un soutirage de 0 à 8 W, l'EM-50 affiche −27 à −36 W. L'écart est un OFFSET,
 * pas une erreur d'échelle — il vaut +31 à +43 W sur toute la plage exploitable
 * (EM-50 de −100 à +500 W), sans dépendance à la puissance :
 *
 * Étalonné sur l'ÉNERGIE SOUTIRÉE du jour (la seule grandeur que les deux
 * compteurs mesurent pareil), 89 jours appariés :
 *
 *     offset 20 W → biais −107 Wh/j      offset 28 W → biais  −51 Wh/j
 *     offset 25 W → biais  −76 Wh/j      offset 30 W → biais  −31 Wh/j
 *     offset 26 W → MINIMUM d'erreur     offset 35 W → biais  +28 Wh/j
 *
 * Stable dans le temps : 29 W en juillet, 28 W en août.
 *
 * Pourquoi c'est grave : cette voie pilote la boucle SB3 ET le veto d'achat du
 * cumulus. Croyant injecter, la boucle baisse la consigne des Solarbank — et
 * fabrique un achat EDF réel pour corriger une injection imaginaire. Dans la nuit
 * du 01/09, elle est descendue de 178 W à 36 W et visait 0 W.
 *
 * ⚠️ La cause PHYSIQUE reste à établir (offset du CT à très faible courant, ou
 * charge d'environ 35 W raccordée entre le Linky et la pince). Tant qu'elle n'est
 * pas trouvée, cette correction est un étalonnage, pas une explication.
 *
 * Vérification : après correction, l'EM-50 doit afficher un LÉGER SOUTIRAGE
 * (~+5 W) au repos, jamais une injection. Se recale contre `enedis_curve`.
 */
import { env } from '$env/dynamic/private';

/** −1 si la convention de la pince devait s'inverser. */
export const gridSign = (): 1 | -1 => (Number(env.EM50_GRID_SIGN ?? 1) < 0 ? -1 : 1);

/**
 * Correction d'étalonnage (W) ajoutée à la voie réseau, APRÈS le signe.
 * Mesurée contre Enedis sur cette installation ; surchargeable par
 * `EM50_GRID_OFFSET_W` sans toucher au code.
 *
 * ⚠ MÉTHODE — la première calibration (35 W, 01/09) était FAUSSE, et sa faute
 * est instructive. Elle comparait la MOYENNE des demi-heures Enedis à celle de
 * l'EM-50. Or Enedis ne mesure QUE le soutirage : sur une demi-heure où la
 * maison alterne, il compte les seuls instants positifs, pas le net. L'écart
 * apparent contenait donc l'injection, et l'offset s'en trouvait gonflé.
 *
 * La bonne mesure compare la même grandeur des deux côtés : l'ÉNERGIE SOUTIRÉE
 * du jour, intégrée depuis `pv_samples` d'un côté, `enedis_daily.soutirage_kwh`
 * de l'autre. Sur 89 jours, l'offset qui annule le biais vaut 28-30 W et le
 * minimum d'erreur tombe à 26 W. Et il est STABLE : 29 W en juillet, 28 W en
 * août — pas de dérive. D'où 28 W.
 */
export const gridOffsetW = (): number => {
  const v = Number(env.EM50_GRID_OFFSET_W ?? 28);
  return Number.isFinite(v) ? v : 0;
};

/**
 * Puissance réseau étalonnée, en W : **+ soutirage EDF / − injection**.
 * `null` si la mesure est absente ou non finie — jamais 0, qui ferait croire à
 * un compteur sain (une entrée manquante ne doit pas éteindre une protection).
 */
export function calibratedGridW(actPower: unknown): number | null {
  if (typeof actPower !== 'number' || !Number.isFinite(actPower)) return null;
  return Math.round(gridSign() * actPower + gridOffsetW());
}
