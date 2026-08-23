<script lang="ts">
  import { findmy, type FindMyDevice } from '$stores/findmy.svelte';

  // ─── Exclusion : ancien iPad de Laurent (position inconnue, batterie morte).
  // Filtre sur le topicId UNIQUEMENT — les deux iPad partagent le même `name`,
  // un filtre par nom supprimerait aussi l'iPad en service (axlejkxg).
  const EXCLUDED_TOPICS = new Set(['ipad-de-laurent-avm1zspv']);

  // ─── Propriétaire : aucun champ owner dans le payload → inférence sur le nom.
  // On détecte LAURENT (tous ses appareils sont nommés « … Laurent » / « de
  // Laurent ») et on range TOUT le reste chez Isabelle : ses appareils ont des
  // noms hétérogènes (« iPhone Isa », « Apple Watch d'Isabelle », ou « AirPods
  // Pro » sans prénom) — chercher « isabelle » en raterait. (Robuste tant que la
  // convention « … Laurent » tient ; sinon, faire publier `owner` par le bridge.)
  function inferOwner(name: string): 'laurent' | 'isabelle' {
    return /laurent/i.test(name) ? 'laurent' : 'isabelle';
  }

  // ─── Nom raccourci : le propriétaire est porté par la figurine d'en-tête, on
  // retire son prénom EN FIN de libellé (ancre $ → jamais de coupe au milieu).
  // « iPhone Laurent »/« iPad de Laurent »→« iPhone »/« iPad » ; « iPhone Isa »→
  // « iPhone » ; « Apple Watch d'Isabelle »→« Apple Watch » ; « AirPods Pro »
  // (sans prénom) reste tel quel. Repli sur le type si le reste est vide.
  function shortName(d: FindMyDevice): string {
    const stripped = d.name
      .replace(/\s*(d['’]\s*isabelle|de\s+laurent|isabelle|laurent|isa)\s*$/i, '')
      .trim();
    return stripped || d.deviceClass || d.name;
  }

  // ─── Item de rendu : appareil live OU placeholder « en attente de partage ».
  type LiveItem = { placeholder: false; device: FindMyDevice };
  type Placeholder = { placeholder: true; name: string; deviceClass: string };
  type RowItem = LiveItem | Placeholder;

  // Appareils réels, ancien iPad exclu.
  const liveDevices = $derived(findmy.sorted.filter((d) => !EXCLUDED_TOPICS.has(d.topicId)));

  const laurentItems = $derived(
    liveDevices
      .filter((d) => inferOwner(d.name) === 'laurent')
      .map((d) => ({ placeholder: false as const, device: d }))
  );

  // Placeholders Isabelle (préremplissage) — remplacés par ses vrais appareils
  // dès qu'elle partagera (fusion par type d'appareil), sans nouvelle modif.
  const ISABELLE_PLACEHOLDERS: Placeholder[] = [
    { placeholder: true, name: 'iPhone', deviceClass: 'iPhone' },
    { placeholder: true, name: 'iPad', deviceClass: 'iPad' },
    { placeholder: true, name: 'Apple Watch', deviceClass: 'Watch' },
    { placeholder: true, name: 'AirPods Pro', deviceClass: 'Accessory' }
  ];

  // Rapproche un type d'appareil live d'un type de placeholder (insensible casse).
  function classMatches(deviceClass: string | null, target: string): boolean {
    const a = (deviceClass || '').toLowerCase();
    if (!a) return false;
    const b = target.toLowerCase();
    return a.includes(b) || b.includes(a);
  }

  const isabelleItems = $derived.by<RowItem[]>(() => {
    const live = liveDevices.filter((d) => inferOwner(d.name) === 'isabelle');
    const used = new Set<string>();
    const items: RowItem[] = ISABELLE_PLACEHOLDERS.map((p) => {
      const match = live.find(
        (d) => !used.has(d.topicId) && classMatches(d.deviceClass, p.deviceClass)
      );
      if (match) {
        used.add(match.topicId);
        return { placeholder: false, device: match };
      }
      return p;
    });
    // Appareils live d'Isabelle d'un type hors placeholders → ajoutés à la suite.
    for (const d of live) if (!used.has(d.topicId)) items.push({ placeholder: false, device: d });
    return items;
  });

  // Nombre d'appareils réels affichés (placeholders & ancien iPad exclus).
  const shownCount = $derived(liveDevices.length);

  // Carte masquée seulement si le service n'est pas câblé. Les placeholders
  // d'Isabelle font que la carte a toujours du contenu une fois configurée.
  const visible = $derived(findmy.connectionStatus !== 'unconfigured');

  // Fallback figurines : si l'image ne charge pas → cercle initiale au thème.
  let laurentImgError = $state(false);
  let isabelleImgError = $state(false);

  // Batterie fiable seulement si statut ≠ Unknown (AirPods / appareils hors ligne
  // remontent souvent « 0 % / Unknown » → on affiche « — » plutôt qu'un faux 0 %).
  function batteryPct(d: FindMyDevice): number | null {
    if (d.battery == null || d.batteryStatus === 'Unknown') return null;
    return Math.round(d.battery);
  }
  function batteryColor(d: FindMyDevice): string {
    const p = batteryPct(d);
    if (p == null) return 'var(--color-muted-fg)';
    if (d.charging) return 'var(--color-battery)';
    if (p > 50) return 'var(--color-battery)';
    if (p > 20) return 'var(--color-warning)';
    return 'var(--color-alert)';
  }

  // Les AirPods (Accessory) ne remontent JAMAIS leur batterie au cloud Find My
  // (seulement leur position) → on masque la ligne batterie pour eux (sinon un
  // « — » permanent et inutile). Cf. limite Apple confirmée 2026-06-20.
  function isAirpods(d: FindMyDevice): boolean {
    const s = (d.deviceClass || '').toLowerCase();
    return (
      s.includes('accessory') || s.includes('airpod') || d.name.toLowerCase().includes('airpod')
    );
  }

  function mapsUrl(d: FindMyDevice): string {
    return `https://maps.apple.com/?ll=${d.lat},${d.lon}&q=${encodeURIComponent(d.name)}`;
  }

  // ─── Visuel par type d'appareil : PNG « flat produit » (PommePlate, CC0,
  // static/devices/) + zone d'écran (%) où la couleur de batterie MONTE depuis
  // le bas — l'écran s'allume au niveau de la charge. AirPods : boîtier dessiné
  // en SVG inline (même style), sans jauge (Find My ne donne pas leur batterie).
  type Art = {
    src: string | null;
    /** largeur affichée (px) pour 46 px de haut */
    w: number;
    screen: { x: number; y: number; w: number; h: number; r: number } | null;
    label: string;
  };
  function artFor(cls: string | null): Art {
    const s = (cls || '').toLowerCase();
    if (s.includes('iphone'))
      return {
        src: '/devices/iphone.png',
        w: 23,
        screen: { x: 5, y: 2.5, w: 90, h: 95, r: 4 },
        label: 'iPhone'
      };
    if (s.includes('ipad'))
      return {
        src: '/devices/ipad.png',
        w: 33,
        screen: { x: 5, y: 4, w: 90, h: 92, r: 3 },
        label: 'iPad'
      };
    if (s.includes('watch'))
      return {
        src: '/devices/watch.png',
        w: 27,
        screen: { x: 9, y: 21.5, w: 82, h: 56.5, r: 7 },
        label: 'Watch'
      };
    if (s.includes('accessory') || s.includes('airpod'))
      return { src: null, w: 30, screen: null, label: 'AirPods' };
    return { src: null, w: 30, screen: null, label: cls || 'Appareil' };
  }
</script>

<!-- Visuel d'appareil : PNG produit, écran rempli par la batterie depuis le bas
     (couleur selon le niveau) ; boîtier AirPods en SVG assorti ; grisé en attente
     de partage. -->
{#snippet deviceArt(cls: string | null, pct: number | null, color: string, ph: boolean)}
  {@const art = artFor(cls)}
  <span class="fm-art" class:fm-art-ph={ph} style="width: {art.w}px;">
    {#if art.src}
      <img class="fm-art-img" src={art.src} alt="" draggable="false" />
      {#if art.screen && pct != null}
        <span
          class="fm-screen"
          style="left: {art.screen.x}%; top: {art.screen.y}%; width: {art.screen.w}%; height: {art
            .screen.h}%; border-radius: {art.screen.r}px;"
        >
          <span class="fm-fill" style="height: {pct}%; background: {color};"></span>
        </span>
      {/if}
    {:else}
      <!-- Boîtier AirPods, flat produit (dessin maison, cf. static/devices/LICENSE.md) -->
      <svg viewBox="0 0 40 46" aria-hidden="true" style="width: 100%; height: auto;">
        <rect x="3" y="9" width="34" height="30" rx="9" fill="#b9babd" />
        <rect
          x="3"
          y="9"
          width="34"
          height="30"
          rx="9"
          fill="none"
          stroke="#8e8f93"
          stroke-width="1"
        />
        <path d="M3.4 21.5h33.2" stroke="#96979b" stroke-width="1.2" />
        <rect x="14" y="19.9" width="12" height="3.2" rx="1.6" fill="#a2a3a7" />
        <circle cx="20" cy="30" r="1.3" fill="#7c7d81" />
      </svg>
    {/if}
  </span>
{/snippet}

<!-- Cellule appareil : visuel (lien Plans si position connue) + nom court. -->
{#snippet deviceCell(item: RowItem, uid: string)}
  {#if item.placeholder}
    <div class="fm-cell fm-cell-ph" title="{item.name} — partage en attente">
      {@render deviceArt(item.deviceClass, null, 'transparent', true)}
      <span class="fm-cell-name">{artFor(item.deviceClass).label}</span>
    </div>
  {:else}
    {@const d = item.device}
    {@const pct = isAirpods(d) ? null : batteryPct(d)}
    {@const color = batteryColor(d)}
    {@const tip = `${shortName(d)}${pct == null ? '' : ` — ${pct} %`}${d.charging ? ' (en charge)' : ''}`}
    {#if d.lat != null && d.lon != null}
      <a
        class="fm-cell fm-cell-link"
        href={mapsUrl(d)}
        target="_blank"
        rel="noopener noreferrer"
        title={tip}
        aria-label="Voir {d.name} sur le plan — {tip}"
      >
        {@render deviceArt(d.deviceClass, pct, color, false)}
        {#if d.charging}<span class="fm-bolt" aria-hidden="true">⚡︎</span>{/if}
        <span class="fm-cell-name">{artFor(d.deviceClass).label}</span>
      </a>
    {:else}
      <div class="fm-cell" title={tip} aria-label={tip}>
        {@render deviceArt(d.deviceClass, pct, color, false)}
        {#if d.charging}<span class="fm-bolt" aria-hidden="true">⚡︎</span>{/if}
        <span class="fm-cell-name">{artFor(d.deviceClass).label}</span>
      </div>
    {/if}
  {/if}
{/snippet}

{#if visible}
  <section
    class="fm-card rounded-[var(--radius-2xl)] border"
    style="background: var(--color-card); border-color: var(--color-border);"
    aria-label="Appareils Localiser"
  >
    <!-- Une rangée par personne : figurine + silhouettes remplies par la batterie. -->
    <div class="fm-person">
      {#if !laurentImgError}
        <img
          class="fm-avatar"
          src="/avatars/laurent.jpg"
          alt="Laurent"
          onerror={() => (laurentImgError = true)}
        />
      {:else}
        <span class="fm-avatar fm-avatar-fallback" role="img" aria-label="Laurent">L</span>
      {/if}
      <div class="fm-devices">
        {#each laurentItems as item (item.device.topicId)}
          {@render deviceCell(item, item.device.topicId)}
        {/each}
      </div>
    </div>
    <div class="fm-person">
      {#if !isabelleImgError}
        <img
          class="fm-avatar"
          src="/avatars/isabelle.jpg"
          alt="Isabelle"
          onerror={() => (isabelleImgError = true)}
        />
      {:else}
        <span class="fm-avatar fm-avatar-fallback" role="img" aria-label="Isabelle">I</span>
      {/if}
      <div class="fm-devices">
        {#each isabelleItems as item (item.placeholder ? `ph-${item.deviceClass}` : item.device.topicId)}
          {@render deviceCell(
            item,
            item.placeholder ? `ph-${item.deviceClass}` : item.device.topicId
          )}
        {/each}
      </div>
    </div>
  </section>
{/if}

<style>
  /* Carte condensée (23/08/2026) : plus de titre ni d'état « À jour » (il vit
     dans le menu), deux rangées figurine + silhouettes ; le niveau de batterie
     REMPLIT le dessin de l'appareil. */
  .fm-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
  }
  .fm-person {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .fm-person + .fm-person {
    padding-top: 6px;
    border-top: 1px solid color-mix(in oklch, var(--color-border) 55%, transparent);
  }
  .fm-avatar {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 9999px;
    object-fit: cover;
    background: var(--color-primary-muted);
    border: 2px solid var(--color-border);
    box-shadow: 0 0 0 1px var(--color-primary-muted);
  }
  .fm-avatar-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
    font-weight: 700;
    color: var(--color-primary);
  }
  .fm-devices {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    justify-content: space-around;
    align-items: flex-start;
    gap: 4px;
  }
  .fm-cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 44px;
    padding: 2px 0;
    color: var(--color-fg);
    text-decoration: none;
    -webkit-tap-highlight-color: transparent;
  }
  .fm-cell-link {
    cursor: pointer;
    transition: transform var(--duration-fast, 100ms);
  }
  .fm-cell-link:active {
    transform: scale(0.94);
  }
  .fm-cell-ph {
    opacity: 0.45;
  }
  .fm-art {
    position: relative;
    display: inline-flex;
    height: 46px;
    align-items: center;
    justify-content: center;
  }
  .fm-art-img {
    height: 100%;
    width: auto;
    display: block;
    -webkit-user-drag: none;
  }
  .fm-art-ph {
    filter: grayscale(1);
    opacity: 0.75;
  }
  /* Écran : la couleur de batterie monte depuis le bas (l'écran s'allume). */
  .fm-screen {
    position: absolute;
    overflow: hidden;
    display: flex;
    align-items: flex-end;
  }
  /* « Liquide » : légèrement translucide (l'écran affleure dessous), ligne de
     surface plus claire en haut du niveau. */
  .fm-fill {
    width: 100%;
    opacity: 0.82;
    box-shadow: inset 0 1.5px 0 oklch(1 0 0 / 0.4);
    transition: height var(--duration-slow, 300ms) var(--ease-default, ease);
  }
  .fm-cell-name {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--color-muted-fg);
    white-space: nowrap;
  }
  .fm-bolt {
    position: absolute;
    right: 2px;
    top: 18px;
    font-size: 11px;
    line-height: 1;
    color: var(--color-battery);
    text-shadow: 0 0 3px oklch(0.2 0.03 286 / 0.8);
  }
</style>
