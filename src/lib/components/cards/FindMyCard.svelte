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

  // ─── État de santé global (chip d'en-tête) ───
  type Health = { label: string; color: string };
  const health = $derived.by<Health>(() => {
    if (findmy.connectionStatus === 'connecting') return { label: 'Connexion…', color: 'muted-fg' };
    if (findmy.connectionStatus === 'disconnected')
      return { label: 'Hors ligne', color: 'warning' };
    switch (findmy.status) {
      case 'ok':
        return { label: 'À jour', color: 'battery' };
      case 'starting':
        return { label: 'Démarrage…', color: 'warning' };
      case 'reauth_required':
        return { label: 'Ré-auth iCloud requise', color: 'alert' };
      case 'offline':
        return { label: 'Bridge hors ligne', color: 'muted-fg' };
      default:
        return { label: '', color: 'muted-fg' };
    }
  });

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

  // Icône SVG par type d'appareil (trait = currentColor, hérite de la pastille).
  function iconSvg(cls: string | null): string {
    const s = (cls || '').toLowerCase();
    const open =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">';
    let inner: string;
    if (s.includes('iphone'))
      inner =
        '<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><line x1="10.5" y1="5" x2="13.5" y2="5"/>';
    else if (s.includes('ipad'))
      inner =
        '<rect x="4.5" y="3" width="15" height="18" rx="2.2"/><circle cx="12" cy="18" r="0.5"/>';
    else if (s.includes('watch'))
      inner =
        '<rect x="7" y="6.5" width="10" height="11" rx="3"/><path d="M9 6.5l.6-3.2h4.8l.6 3.2"/><path d="M9 17.5l.6 3.2h4.8l.6-3.2"/>';
    else if (s.includes('mac'))
      inner = '<rect x="3.5" y="5" width="17" height="11" rx="1.6"/><path d="M2 19.5h20"/>';
    else if (s.includes('accessory') || s.includes('airpod'))
      inner =
        '<path d="M5 13v-1.5a7 7 0 0 1 14 0V13"/><rect x="3.2" y="12.5" width="4" height="6.5" rx="1.6"/><rect x="16.8" y="12.5" width="4" height="6.5" rx="1.6"/>';
    else
      inner =
        '<path d="M12 21s-5.5-4.8-5.5-9.2A5.5 5.5 0 0 1 12 6.3a5.5 5.5 0 0 1 5.5 5.5C17.5 16.2 12 21 12 21z"/><circle cx="12" cy="11.6" r="1.9"/>';
    return open + inner + '</svg>';
  }
</script>

<!-- Rangée appareil (live) ou placeholder « en attente de partage ». -->
{#snippet deviceRow(item: RowItem)}
  {#if item.placeholder}
    <article class="fm-row fm-row-ph" aria-label="{item.name} — en attente de partage">
      <div class="fm-row-top">
        <span class="fm-chip" aria-hidden="true">{@html iconSvg(item.deviceClass)}</span>
        <span class="fm-name">{item.name}</span>
      </div>
      <span class="fm-ph-badge">Partage en attente</span>
    </article>
  {:else}
    {@const d = item.device}
    {@const pct = batteryPct(d)}
    {@const color = batteryColor(d)}
    <article class="fm-row">
      <div class="fm-row-top">
        {#if d.lat != null && d.lon != null}
          <a
            class="fm-chip fm-chip-link"
            href={mapsUrl(d)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Voir {d.name} sur le plan">{@html iconSvg(d.deviceClass)}</a
          >
        {:else}
          <span class="fm-chip" aria-hidden="true">{@html iconSvg(d.deviceClass)}</span>
        {/if}
        <span class="fm-name">{shortName(d)}</span>
      </div>

      {#if !isAirpods(d)}
        <div class="fm-batt-line">
          {#if d.charging}
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="var(--color-battery)"
              aria-hidden="true"
            >
              <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
            </svg>
          {/if}
          <span class="fm-batt-pct" style="color: {color};">
            {pct == null ? '—' : `${pct} %`}
          </span>
          <div class="fm-batt-track" aria-hidden="true">
            <div
              class="fm-batt-fill"
              style="width: {pct == null ? 0 : pct}%; background: {color};"
            ></div>
          </div>
        </div>
      {/if}
    </article>
  {/if}
{/snippet}

{#if visible}
  <section
    class="rounded-[var(--radius-2xl)] border p-4 sm:p-5"
    style="background: var(--color-card); border-color: var(--color-border);"
    aria-label="Appareils Localiser"
  >
    <!-- ─── En-tête global ─── -->
    <header class="mb-3 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="fm-title-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="16"
            height="16"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </span>
        <h2 class="text-base font-semibold tracking-tight" style="color: var(--color-fg);">
          Localiser
        </h2>
        {#if shownCount > 0}
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
            style="background: var(--color-primary-muted); color: var(--color-primary);"
          >
            {shownCount}
          </span>
        {/if}
      </div>

      {#if health.label}
        <span
          class="flex shrink-0 items-center gap-1.5 text-[11px] font-medium"
          style="color: var(--color-{health.color});"
        >
          <span class="h-1.5 w-1.5 rounded-full" style="background: var(--color-{health.color});"
          ></span>
          {health.label}
        </span>
      {/if}
    </header>

    <!-- ─── Deux colonnes : Laurent | Isabelle (côte à côte, mobile inclus) ─── -->
    <div class="fm-cols">
      <!-- Colonne Laurent -->
      <div class="fm-col">
        <div class="fm-col-head">
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
        </div>
        <div class="fm-col-list">
          {#each laurentItems as item (item.device.topicId)}
            {@render deviceRow(item)}
          {/each}
        </div>
      </div>

      <!-- Colonne Isabelle -->
      <div class="fm-col">
        <div class="fm-col-head">
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
        </div>
        <div class="fm-col-list">
          {#each isabelleItems as item (item.placeholder ? `ph-${item.deviceClass}` : item.device.topicId)}
            {@render deviceRow(item)}
          {/each}
        </div>
      </div>
    </div>
  </section>
{/if}

<style>
  .fm-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--color-primary);
  }

  /* Deux colonnes côte à côte, dès le mobile (demi-largeur chacune). */
  .fm-cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  @media (min-width: 640px) {
    .fm-cols {
      gap: 1rem;
    }
  }

  .fm-col {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* En-tête de colonne : figurine seule (le nom passe en aria-label). */
  .fm-col-head {
    display: flex;
    align-items: center;
    justify-content: center;
    padding-bottom: 0.125rem;
  }
  .fm-avatar {
    width: 44px;
    height: 44px;
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
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--color-primary);
  }

  .fm-col-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Rangée appareil : empilée (titre / état / batterie) pour tenir en demi-largeur.
     Pas de fond « verre » (évite le double backdrop-filter) — liseré + survol. */
  .fm-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.55rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: transparent;
    transition:
      border-color var(--duration-normal, 200ms),
      background var(--duration-normal, 200ms);
  }
  .fm-row:hover {
    border-color: var(--color-border-strong);
  }
  /* Placeholder « en attente de partage » : grisé, sobre. */
  .fm-row-ph {
    opacity: 0.5;
    border-style: dashed;
  }

  .fm-row-top {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
  }
  .fm-chip {
    display: inline-flex;
    width: 1.875rem;
    height: 1.875rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md, 0.5rem);
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }
  /* Logo cliquable → ouvre la position de l'appareil dans Plans. */
  .fm-chip-link {
    cursor: pointer;
    text-decoration: none;
    -webkit-tap-highlight-color: transparent;
    transition:
      background var(--duration-fast, 100ms),
      color var(--duration-fast, 100ms),
      transform var(--duration-fast, 100ms);
  }
  .fm-chip-link:hover {
    background: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .fm-chip-link:active {
    transform: scale(0.92);
  }
  /* Noms raccourcis : pas de troncature, on autorise le retour à la ligne. */
  .fm-name {
    min-width: 0;
    font-size: 12.5px;
    line-height: 1.15;
    font-weight: 600;
    color: var(--color-fg);
    overflow-wrap: anywhere;
  }

  .fm-ph-badge {
    align-self: flex-start;
    padding: 0.05rem 0.45rem;
    border: 1px dashed var(--color-border-strong, var(--color-border));
    border-radius: 9999px;
    font-size: 9.5px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }

  .fm-batt-line {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .fm-batt-pct {
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  /* Jauge batterie : piste arrondie + remplissage coloré (pas de box-shadow
     color-mix → conforme au piège Chrome documenté). */
  .fm-batt-track {
    width: 40px;
    height: 5px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--color-border);
    overflow: hidden;
  }
  .fm-batt-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width var(--duration-slow, 300ms) var(--ease-default, ease);
  }
</style>
