<script lang="ts">
  /**
   * « Mon code » — définir son code de secours, et pour un administrateur celui
   * d'un autre membre. Atteignable par Menu ▸ Mon code.
   *
   * Vocabulaire : pas de « PIN », pas de « lien magique », pas de « session ».
   * La page a été réécrite le 17/08 parce que sa première version renvoyait à un
   * « lien magique » que son propre auteur n'a pas su retrouver.
   */
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let monPin = $state('');
  let monEtat = $state<{ type: 'ok' | 'ko'; message: string } | null>(null);
  let monBusy = $state(false);

  let membreId = $state('');
  let membrePin = $state('');
  let membreEtat = $state<{ type: 'ok' | 'ko'; message: string } | null>(null);
  let membreBusy = $state(false);

  const monPret = $derived(/^\d{4}$/.test(monPin));
  const membrePret = $derived(membreId !== '' && /^\d{4}$/.test(membrePin));

  async function poser(pin: string, userId?: string) {
    const r = await fetch('/api/account/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(userId ? { pin, userId } : { pin })
    });
    const d = (await r.json().catch(() => ({}))) as { message?: string };
    if (!r.ok) throw new Error(d.message ?? 'Enregistrement impossible.');
  }

  async function soumettreMien(e: SubmitEvent) {
    e.preventDefault();
    if (!monPret || monBusy) return;
    monBusy = true;
    monEtat = null;
    try {
      await poser(monPin);
      monEtat = { type: 'ok', message: 'Ton code est enregistré.' };
      monPin = '';
    } catch (err) {
      monEtat = { type: 'ko', message: (err as Error).message };
    } finally {
      monBusy = false;
    }
  }

  async function soumettreMembre(e: SubmitEvent) {
    e.preventDefault();
    if (!membrePret || membreBusy) return;
    membreBusy = true;
    membreEtat = null;
    const cible = data.membres.find((m) => m.id === membreId);
    try {
      await poser(membrePin, membreId);
      membreEtat = { type: 'ok', message: `Code enregistré pour ${cible?.email ?? 'ce membre'}.` };
      membrePin = '';
    } catch (err) {
      membreEtat = { type: 'ko', message: (err as Error).message };
    } finally {
      membreBusy = false;
    }
  }
</script>

<!-- Pas de <title> ici : le layout racine est la source UNIQUE du titre d'onglet
     (plusieurs pages sont montées à la fois sous le pager, deux titres se
     télescoperaient). « Mon code » vient du registre du menu, via pageTitleFor. -->

<div class="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-6">
  <h1 class="text-[22px] font-semibold tracking-tight" style="color: var(--color-fg);">Mon code</h1>

  {#if !data.identifie}
    <div class="card" style="background: var(--color-card);">
      <p class="text-[14px] font-semibold" style="color: var(--color-fg);">
        Domo ne sait pas encore qui tu es
      </p>
      <p class="mt-2 text-[13px]" style="color: var(--color-muted-fg);">
        Cet appareil entre avec l'ancien lien d'accès, celui qui était le même pour toute la maison.
        Un code à 4 chiffres appartient à une personne, il n'y a donc rien à quoi le rattacher.
      </p>
      <p class="mt-3 text-[13px]" style="color: var(--color-fg);">
        <strong>Ce qu'il faut faire :</strong> demander ton lien personnel
        {#if data.adminEmail}
          à <span class="whitespace-nowrap">{data.adminEmail}</span>
        {/if}
        — dans Domo, c'est <em>Menu ▸ Utilisateurs</em>, puis <em>Inviter</em> sur ta ligne. Ouvre le
        lien reçu une fois depuis cet appareil, puis reviens ici : le formulaire sera là.
      </p>
    </div>
  {:else}
    <form class="card" style="background: var(--color-card);" onsubmit={soumettreMien}>
      <h2 class="titre">Définir mon code</h2>
      <p class="sous">
        Quatre chiffres, pour entrer le jour où tu n'as plus ton lien d'accès sous la main.
        {#if data.email}<span class="whitespace-nowrap">Compte : {data.email}</span>{/if}
      </p>
      <input
        class="champ code"
        type="password"
        inputmode="numeric"
        maxlength="4"
        bind:value={monPin}
        placeholder="••••"
        autocomplete="new-password"
        disabled={monBusy}
        aria-label="Mon code à 4 chiffres"
      />
      {#if monEtat}
        <p class="msg" class:ko={monEtat.type === 'ko'} role="status">{monEtat.message}</p>
      {/if}
      <button type="submit" class="valider" disabled={!monPret || monBusy}>
        {monBusy ? 'Enregistrement…' : 'Enregistrer'}
      </button>
    </form>

    {#if data.role === 'admin' && data.membres.length > 0}
      <form class="card" style="background: var(--color-card);" onsubmit={soumettreMembre}>
        <h2 class="titre">Définir le code d'un membre</h2>
        <p class="sous">La personne pourra le changer elle-même depuis cette page.</p>
        <select class="champ" bind:value={membreId} disabled={membreBusy} aria-label="Membre">
          <option value="" disabled>Choisir…</option>
          {#each data.membres as m (m.id)}
            <option value={m.id}>{m.email}</option>
          {/each}
        </select>
        <input
          class="champ code mt-3"
          type="password"
          inputmode="numeric"
          maxlength="4"
          bind:value={membrePin}
          placeholder="••••"
          autocomplete="new-password"
          disabled={membreBusy}
          aria-label="Code à 4 chiffres du membre"
        />
        {#if membreEtat}
          <p class="msg" class:ko={membreEtat.type === 'ko'} role="status">{membreEtat.message}</p>
        {/if}
        <button type="submit" class="valider" disabled={!membrePret || membreBusy}>
          {membreBusy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </form>
    {/if}
  {/if}
</div>

<style>
  .card {
    border-radius: 18px;
    padding: 18px;
  }
  .titre {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .sous {
    margin: 4px 0 14px;
    font-size: 13px;
    color: var(--color-muted-fg);
  }
  .champ {
    width: 100%;
    padding: 11px 13px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 16px; /* 16px minimum : en dessous, iOS zoome à la mise au point */
    outline: none;
  }
  .champ:focus {
    border-color: var(--color-primary);
  }
  .champ:disabled {
    opacity: 0.6;
  }
  .code {
    letter-spacing: 0.4em;
  }
  .msg {
    margin-top: 10px;
    font-size: 13px;
    color: var(--color-success);
  }
  .msg.ko {
    color: var(--color-alert);
  }
  .valider {
    margin-top: 14px;
    width: 100%;
    padding: 12px;
    border-radius: 999px;
    background: var(--color-primary);
    color: white;
    font-size: 15px;
    font-weight: 600;
    transition: transform 0.12s ease;
  }
  .valider:active:not(:disabled) {
    transform: scale(0.97);
  }
  .valider:disabled {
    opacity: 0.45;
  }
</style>
