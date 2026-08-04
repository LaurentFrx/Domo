<script lang="ts">
  /**
   * Rubrique « Bilan & installation » — les chiffres qu'on consulte une fois par
   * mois, pas une fois par heure : cumul depuis l'installation (retiré de
   * l'accueil), barème EDF en vigueur, et le matériel avec ses coûts et ses dates.
   *
   * Le barème HP/HC écrit dans data/tariffs.json via /api/tariffs/regime — c'est
   * la source que lisent réellement le pilote cumulus, les économies et la
   * ventilation HP/HC. (Les anciens champs de /reglages écrivaient dans
   * settings.json, que personne ne relisait : réglage mort.)
   */
  import { onMount, onDestroy } from 'svelte';
  import { productionLifetime } from '$stores/productionLifetime.svelte';
  import { savings } from '$stores/savings.svelte';
  import { settings } from '$stores/settings.svelte';
  import { tariff } from '$stores/tariff.svelte';
  import { formatCurrency } from '$utils/format';
  import { haptic } from '$utils/haptic';

  // ─── Cumul depuis l'installation ───────────────────────────────────────
  // Source FIABLE : /api/production/lifetime = MAX des compteurs MATÉRIELS
  // historisés par le recorder. Robuste au bug cloud « daily-as-lifetime » du
  // SolarBank depuis la reconfiguration des systèmes Anker (22/07) : le max
  // recorder ne redescend jamais.
  const hasLifetime = $derived(productionLifetime.available && productionLifetime.totalKwh > 0);
  // Équivalent VE : énergie produite convertie en km d'une voiture électrique
  // (conso ~16,7 kWh/100 km → 6 km/kWh).
  const EV_KM_PER_KWH = 6;
  const evKm = $derived(productionLifetime.totalKwh * EV_KM_PER_KWH);

  // ─── Détail des économies du jour ──────────────────────────────────────
  // Retiré de la carte « Économies solaires » de l'accueil (03/08/2026) : là-bas
  // on veut le chiffre, ici sa décomposition. Le store savings est app-wide
  // (connecté par +layout.svelte) → rien à acquérir, on lit.
  const savingsToday = $derived(savings.today);
  const savingsRate = $derived(savingsToday.rate_eur_h);
  const showRate = $derived(savings.connected && savingsRate > 0.0005);
  const eur = (v: number) => formatCurrency(v);

  function fmtNumber(n: number, decimals = 0): string {
    return n.toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  // ─── Tarif en cours (store tariff, connecté app-wide par le layout) ────
  const tariffReady = $derived(tariff.status === 'live'); // évite le flash 0,00
  const currentTariff = $derived(tariff.period);
  const currentPrice = $derived(tariff.priceEurKwh);
  const nextTariff = $derived(tariff.next.period);
  const nextSwitchAt = $derived(tariff.next.at); // 'HH:MM' local Paris
  const hoursUntilSwitch = $derived(tariff.nextInHours);

  // ─── Barème HP/HC éditable ─────────────────────────────────────────────
  let regimeHp = $state<number | null>(null);
  let regimeHc = $state<number | null>(null);
  let regimeFrom = $state<string>(''); // date d'effet du barème affiché
  let regimeMsg = $state<string | null>(null);
  let regimeSaving = $state(false);

  async function loadRegime() {
    try {
      const res = await fetch('/api/tariffs/regime');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as {
        current: { from: string; hp_eur_kwh: number; hc_eur_kwh: number };
      };
      regimeHp = d.current.hp_eur_kwh;
      regimeHc = d.current.hc_eur_kwh;
      regimeFrom = d.current.from;
    } catch {
      regimeMsg = 'Barème illisible pour le moment.';
    }
  }

  async function saveRegime() {
    // Champ vidé → on ne poste rien : le serveur refuserait, et surtout un
    // `null` ne doit jamais devenir un prix.
    if (regimeHp === null || regimeHc === null) return;
    regimeSaving = true;
    regimeMsg = null;
    try {
      const res = await fetch('/api/tariffs/regime', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hp_eur_kwh: regimeHp, hc_eur_kwh: regimeHc })
      });
      const d = (await res.json().catch(() => ({}))) as {
        applied?: { from: string };
        message?: string;
      };
      if (!res.ok) throw new Error(d.message || `HTTP ${res.status}`);
      haptic('success');
      regimeFrom = d.applied?.from ?? regimeFrom;
      regimeMsg = `Barème appliqué à partir du ${regimeFrom}.`;
      void tariff.poll(); // la valeur « tarif en cours » reflète le nouveau prix
    } catch (e) {
      // Un échec d'enregistrement de PRIX ne doit jamais être silencieux : sans
      // ça, l'écran garde la valeur saisie et laisse croire qu'elle s'applique.
      regimeMsg = `Non enregistré : ${(e as Error).message}`;
    } finally {
      regimeSaving = false;
    }
  }

  onMount(() => {
    settings.hydrate();
    void loadRegime();
    productionLifetime.connect();
  });
  onDestroy(() => {
    productionLifetime.disconnect();
  });
</script>

<section class="ios-section">
  <h2 class="ios-group-header">Économies du jour</h2>
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-label">Total</span>
      <span class="ios-cell-value">{savings.connected ? eur(savingsToday.eur) : '—'}</span>
    </div>
    <div class="ios-cell">
      <span class="ios-cell-label">Heures pleines évitées</span>
      <span class="ios-cell-value">{savings.connected ? eur(savingsToday.eur_hp) : '—'}</span>
    </div>
    <div class="ios-cell">
      <span class="ios-cell-label">Heures creuses évitées</span>
      <span class="ios-cell-value">{savings.connected ? eur(savingsToday.eur_hc) : '—'}</span>
    </div>
    {#if showRate}
      <div class="ios-cell">
        <span class="ios-cell-label">En ce moment</span>
        <span class="ios-cell-value is-green">+{eur(savingsRate)}/h</span>
      </div>
    {/if}
  </div>
  <p class="ios-group-footer">
    Auto-consommation valorisée : l'électricité produite et consommée sur place, comptée au prix
    qu'elle aurait coûté chez EDF à cette heure-là. Ce n'est pas de l'argent reçu, c'est de l'argent
    non dépensé.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Depuis l'installation</h2>
  <div class="ios-group">
    {#if hasLifetime}
      <div class="ios-cell">
        <span class="ios-cell-label">Production totale</span>
        <span class="ios-cell-value">{fmtNumber(productionLifetime.totalKwh, 0)} kWh</span>
      </div>
      <div class="ios-cell">
        <span class="ios-cell-label">Équivalent voiture électrique</span>
        <span class="ios-cell-value">{fmtNumber(evKm, 0)} km</span>
      </div>
    {:else}
      <div class="ios-cell">
        <span class="ios-cell-label">Compteurs en cours de relevé</span>
      </div>
    {/if}
  </div>
  <p class="ios-group-footer">
    Relevé sur les compteurs du matériel (onduleur APsystems + SolarBank), pas sur le cloud : un
    cumul qui ne redescend jamais.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Tarifs EDF</h2>
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-label">Tarif en cours</span>
      <span class="ios-cell-value">
        {#if tariffReady}{currentTariff} · {(currentPrice * 100).toFixed(2)} cts/kWh{:else}—{/if}
      </span>
    </div>
    <div class="ios-cell">
      <span class="ios-cell-label">Prochaine bascule</span>
      <span class="ios-cell-value">
        {#if tariffReady && nextSwitchAt}
          {nextTariff} à {nextSwitchAt} · dans {hoursUntilSwitch} h
        {:else}—{/if}
      </span>
    </div>
    <label class="ios-cell">
      <span class="ios-cell-label">Heures creuses</span>
      <input
        type="number"
        class="ios-input"
        step="0.0001"
        min="0.01"
        max="2"
        bind:value={regimeHc}
        onchange={saveRegime}
      />
      <span class="ios-cell-value">€/kWh</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Heures pleines</span>
      <input
        type="number"
        class="ios-input"
        step="0.0001"
        min="0.01"
        max="2"
        bind:value={regimeHp}
        onchange={saveRegime}
      />
      <span class="ios-cell-value">€/kWh</span>
    </label>
  </div>
  <p class="ios-group-footer">
    {#if regimeMsg}
      {regimeMsg}
    {:else if regimeFrom}
      Ces prix pilotent le chauffe-eau et le calcul des économies. Barème en vigueur depuis le {regimeFrom}
      ; une modification s'applique à partir d'aujourd'hui et ne change pas les économies déjà calculées.
      Les horaires des heures creuses se règlent sur le serveur.
    {/if}
    {#if regimeSaving}
      · enregistrement…
    {/if}
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Matériel</h2>
  {#each settings.installationPhases as phase, i (phase.id)}
    <div class="mb-phase" class:is-first={i === 0}>
      <div class="ios-group">
        <label class="ios-cell">
          <span class="ios-cell-label">Nom</span>
          <input
            type="text"
            class="ios-input is-wide"
            bind:value={phase.label}
            placeholder="SB3 Pro + panneaux"
            onchange={() => {
              haptic('success');
              settings.save();
            }}
          />
        </label>
        <label class="ios-cell">
          <span class="ios-cell-label">Mise en service</span>
          <input
            type="date"
            class="ios-input"
            bind:value={phase.dateISO}
            onchange={() => {
              haptic('success');
              settings.save();
            }}
          />
        </label>
        <label class="ios-cell">
          <span class="ios-cell-label">Coût</span>
          <input
            type="number"
            class="ios-input"
            step="10"
            bind:value={phase.costEur}
            onchange={() => {
              haptic('success');
              settings.save();
            }}
          />
          <span class="ios-cell-value">€</span>
        </label>
        <button
          type="button"
          class="ios-cell is-destructive"
          disabled={settings.installationPhases.length <= 1}
          onclick={() => {
            haptic('success');
            settings.removePhase(phase.id);
          }}
        >
          Supprimer cette tranche
        </button>
      </div>
    </div>
  {/each}

  <div class="mb-phase">
    <div class="ios-group">
      <button
        type="button"
        class="ios-cell is-action"
        onclick={() => {
          haptic('success');
          settings.addPhase();
        }}
      >
        Ajouter une tranche
      </button>
      <div class="ios-cell">
        <span class="ios-cell-label">Total investi</span>
        <span class="ios-cell-value">{Math.round(settings.installationTotalEur)} €</span>
      </div>
    </div>
  </div>
  <p class="ios-group-footer">
    Dates et coûts servent au calcul du retour sur investissement affiché avec les économies.
  </p>
</section>

<style>
  /* Une tranche = un bloc iOS distinct (comme les cartes bancaires des Réglages),
     séparé du suivant par une respiration — plus lisible qu'un long bloc unique
     où les champs de deux matériels se toucheraient. */
  .mb-phase + .mb-phase {
    margin-top: 18px;
  }
</style>
