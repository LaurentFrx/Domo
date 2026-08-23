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

  // ─── Silhouette par type d'appareil : corps (rect arrondi, rempli par la
  // batterie depuis le bas) + détails (trait). Repère 24×24.
  type Body = { x: number; y: number; w: number; h: number; rx: number };
  type Shape = { body: Body | null; extra: string; label: string };
  function shapeFor(cls: string | null): Shape {
    const s = (cls || '').toLowerCase();
    if (s.includes('iphone'))
      return {
        body: { x: 6.5, y: 2, w: 11, h: 20, rx: 2.8 },
        extra: '<line x1="10.3" y1="4.6" x2="13.7" y2="4.6"/>',
        label: 'iPhone'
      };
    if (s.includes('ipad'))
      return {
        body: { x: 3.5, y: 2.5, w: 17, h: 19, rx: 2.4 },
        extra: '<circle cx="12" cy="19" r="0.6"/>',
        label: 'iPad'
      };
    if (s.includes('watch'))
      return {
        body: { x: 6.5, y: 6.5, w: 11, h: 11, rx: 3 },
        extra: '<path d="M8.6 6.5l.6-3.5h5.6l.6 3.5"/><path d="M8.6 17.5l.6 3.5h5.6l.6-3.5"/>',
        label: 'Watch'
      };
    if (s.includes('mac'))
      return {
        body: { x: 3, y: 4.5, w: 18, h: 12, rx: 1.8 },
        extra: '<path d="M1.5 19.5h21"/>',
        label: 'Mac'
      };
    if (s.includes('accessory') || s.includes('airpod'))
      return {
        body: null,
        extra:
          '<path d="M5 13v-1.5a7 7 0 0 1 14 0V13"/><rect x="3.2" y="12.5" width="4" height="6.5" rx="1.6"/><rect x="16.8" y="12.5" width="4" height="6.5" rx="1.6"/>',
        label: 'AirPods'
      };
    return {
      body: null,
      extra:
        '<path d="M12 21s-5.5-4.8-5.5-9.2A5.5 5.5 0 0 1 12 6.3a5.5 5.5 0 0 1 5.5 5.5C17.5 16.2 12 21 12 21z"/><circle cx="12" cy="11.6" r="1.9"/>',
      label: cls || 'Appareil'
    };
  }
</script>

<!-- Silhouette d'appareil remplie par la batterie (depuis le bas), couleur selon le
     niveau ; éclair si en charge ; pointillés pour un appareil en attente de partage. -->
{#snippet glyph(
  cls: string | null,
  pct: number | null,
  color: string,
  uid: string,
  dashed: boolean
)}
  {@const sh = shapeFor(cls)}
  <svg class="fm-glyph" viewBox="0 0 24 24" aria-hidden="true">
    {#if sh.body && pct != null}
      <defs>
        <clipPath id="fm-clip-{uid}">
          <rect x={sh.body.x} y={sh.body.y} width={sh.body.w} height={sh.body.h} rx={sh.body.rx} />
        </clipPath>
      </defs>
      <rect
        x={sh.body.x}
        y={sh.body.y + (sh.body.h * (100 - pct)) / 100}
        width={sh.body.w}
        height={(sh.body.h * pct) / 100}
        fill={color}
        opacity="0.9"
        clip-path="url(#fm-clip-{uid})"
      />
    {/if}
    <g
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-dasharray={dashed ? '2 1.6' : undefined}
    >
      {#if sh.body}
        <rect x={sh.body.x} y={sh.body.y} width={sh.body.w} height={sh.body.h} rx={sh.body.rx} />
      {/if}
      {@html sh.extra}
    </g>
  </svg>
{/snippet}

<!-- Cellule appareil : silhouette (lien Plans si position connue) + nom court. -->
{#snippet deviceCell(item: RowItem, uid: string)}
  {#if item.placeholder}
    <div class="fm-cell fm-cell-ph" title="{item.name} — partage en attente">
      {@render glyph(item.deviceClass, null, 'transparent', uid, true)}
      <span class="fm-cell-name">{shapeFor(item.deviceClass).label}</span>
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
        {@render glyph(d.deviceClass, pct, color, uid, false)}
        {#if d.charging}<span class="fm-bolt" aria-hidden="true">⚡︎</span>{/if}
        <span class="fm-cell-name">{shapeFor(d.deviceClass).label}</span>
      </a>
    {:else}
      <div class="fm-cell" title={tip} aria-label={tip}>
        {@render glyph(d.deviceClass, pct, color, uid, false)}
        {#if d.charging}<span class="fm-bolt" aria-hidden="true">⚡︎</span>{/if}
        <span class="fm-cell-name">{shapeFor(d.deviceClass).label}</span>
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
  .fm-glyph {
    width: 34px;
    height: 34px;
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
