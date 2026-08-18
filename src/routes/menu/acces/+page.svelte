<script lang="ts">
  /**
   * Une fiche par personne, repliée. On en ouvre une, tout ce qui la concerne
   * est là : son code, son lien, ses droits, son retrait. Rien ailleurs.
   *
   * La liste précédente portait jusqu'à cinq boutons par ligne, dont deux
   * changeaient de libellé selon l'état — un tableau de bord, pas une liste.
   *
   * Vocabulaire : un seul mot par idée. « Peut tout régler » partout, jamais
   * « admin », jamais « rôle », jamais « révoquer ».
   */
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Gens = PageData['gens'][number];

  let ouvert = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let erreur = $state<string | null>(null);
  let lien = $state<{ email: string; url: string } | null>(null);
  let copie = $state(false);
  let codes = $state<Record<string, string>>({});
  let succes = $state<string | null>(null);

  let nouvelEmail = $state('');
  const emailValide = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nouvelEmail.trim()));

  async function appel(methode: string, corps: unknown, url: string) {
    const r = await fetch(url, {
      method: methode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corps)
    });
    const d = (await r.json().catch(() => ({}))) as { message?: string; [k: string]: unknown };
    if (!r.ok) throw new Error(d.message ?? 'Impossible pour le moment.');
    return d;
  }

  async function agir(cle: string, fn: () => Promise<string | void>) {
    if (busy) return;
    busy = cle;
    erreur = null;
    succes = null;
    try {
      const m = await fn();
      if (m) succes = m;
      await invalidateAll();
    } catch (e) {
      erreur = (e as Error).message;
    } finally {
      busy = null;
    }
  }

  const poserCode = (g: Gens) =>
    agir(`code:${g.id}`, async () => {
      const pin = codes[g.id] ?? '';
      await appel(
        'POST',
        g.id === data.moiId ? { pin } : { pin, userId: g.id },
        '/api/account/pin'
      );
      codes = { ...codes, [g.id]: '' };
      return g.id === data.moiId ? 'Ton code est enregistré.' : `Code enregistré pour ${g.email}.`;
    });

  const inviter = (g: Gens) =>
    agir(`lien:${g.id}`, async () => {
      const d = (await appel('POST', { userId: g.id }, '/api/users/invite')) as { path: string };
      lien = { email: g.email, url: `${location.origin}${d.path}` };
      copie = false;
    });

  const annulerLien = (g: Gens) =>
    agir(`nolien:${g.id}`, async () => {
      await appel('DELETE', { userId: g.id }, '/api/users/invite');
      return 'Lien annulé.';
    });

  const basculerDroits = (g: Gens) =>
    agir(`droits:${g.id}`, async () => {
      await appel(
        'PATCH',
        { userId: g.id, role: g.peutToutRegler ? 'famille' : 'admin' },
        '/api/users'
      );
    });

  const basculerAcces = (g: Gens) =>
    agir(`acces:${g.id}`, async () => {
      await appel(
        'PATCH',
        { userId: g.id, status: g.accesRetire ? 'active' : 'revoked' },
        '/api/users'
      );
    });

  const supprimer = (g: Gens) =>
    agir(`rm:${g.id}`, async () => {
      if (!confirm(`Supprimer définitivement le compte de ${g.email} ?`)) return;
      await appel('DELETE', { userId: g.id }, '/api/users');
      ouvert = null;
    });

  const ajouter = () =>
    agir('add', async () => {
      await appel('POST', { email: nouvelEmail.trim(), role: 'famille' }, '/api/users');
      nouvelEmail = '';
      return 'Compte créé. Envoie-lui son lien pour qu’il devienne actif.';
    });

  async function copier() {
    if (!lien) return;
    try {
      await navigator.clipboard.writeText(lien.url);
      copie = true;
    } catch {
      copie = false;
    }
  }

  const jour = (iso: string) =>
    new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

  /** Une seule phrase d'état par personne — pas une accumulation de pastilles. */
  function etat(g: Gens): string {
    if (g.accesRetire) return 'Accès retiré';
    if (!g.derniereVenue)
      return g.lien && !g.lien.perime ? 'Lien envoyé, pas encore venu' : 'Jamais venu';
    return `Vu le ${jour(g.derniereVenue)}`;
  }
</script>

{#if !data.identifie}
  <section class="ios-section">
    <div class="ios-group">
      <div class="ios-cell bloc">
        <span class="ios-cell-label">Domo ne sait pas encore qui tu es</span>
        <p class="aide">
          Cet appareil entre avec l'ancien lien commun à toute la maison. Demande ton lien personnel
          à la personne qui gère les accès, ouvre-le une fois depuis cet appareil, et reviens ici.
        </p>
      </div>
    </div>
  </section>
{:else}
  {#if erreur}
    <section class="ios-section">
      <div class="ios-group">
        <div class="ios-cell"><span class="ios-cell-label is-rouge">{erreur}</span></div>
      </div>
    </section>
  {/if}

  {#if succes}
    <section class="ios-section">
      <div class="ios-group">
        <div class="ios-cell"><span class="ios-cell-label is-vert">{succes}</span></div>
      </div>
    </section>
  {/if}

  {#if lien}
    <section class="ios-section">
      <h2 class="ios-group-header">Lien pour {lien.email}</h2>
      <div class="ios-group">
        <div class="ios-cell bloc">
          <p class="aide">Envoie-le par SMS. Il vaut 7 jours et ouvre l'app à son nom.</p>
          <code class="url">{lien.url}</code>
          <div class="rangee">
            <button type="button" class="b" onclick={copier}>{copie ? 'Copié' : 'Copier'}</button>
            <button type="button" class="b gris" onclick={() => (lien = null)}>Fermer</button>
          </div>
          <p class="aide rouge">Il ne sera plus réaffiché. Tu pourras en générer un autre.</p>
        </div>
      </div>
    </section>
  {/if}

  <section class="ios-section">
    <h2 class="ios-group-header">{data.estAdmin ? 'Le foyer' : 'Mon accès'}</h2>
    <div class="ios-group">
      {#each data.gens as g (g.id)}
        <div class="ios-cell bloc">
          <button
            type="button"
            class="ligne"
            onclick={() => (ouvert = ouvert === g.id ? null : g.id)}
            aria-expanded={ouvert === g.id}
          >
            <span class="ios-cell-text">
              <span class="ios-cell-label">
                {g.email}{#if g.id === data.moiId}<span class="moi">toi</span>{/if}
              </span>
              <span class="ios-cell-sub">{etat(g)}</span>
            </span>
            <span class="chevron" class:ouvert={ouvert === g.id}>›</span>
          </button>

          {#if ouvert === g.id}
            <div class="detail">
              <div class="champ-groupe">
                <span class="titre">Code à 4 chiffres</span>
                <p class="aide">
                  {g.aUnCode ? 'Un code est déjà défini.' : 'Aucun code pour l’instant.'} Il sert à entrer
                  sans le lien.
                </p>
                <div class="rangee">
                  <input
                    class="saisie code"
                    type="password"
                    inputmode="numeric"
                    maxlength="4"
                    placeholder="••••"
                    autocomplete="new-password"
                    value={codes[g.id] ?? ''}
                    oninput={(e) =>
                      (codes = { ...codes, [g.id]: (e.currentTarget as HTMLInputElement).value })}
                    disabled={busy !== null}
                    aria-label="Code à 4 chiffres"
                  />
                  <button
                    type="button"
                    class="b"
                    disabled={busy !== null || !/^\d{4}$/.test(codes[g.id] ?? '')}
                    onclick={() => poserCode(g)}>Enregistrer</button
                  >
                </div>
              </div>

              {#if data.estAdmin}
                <div class="champ-groupe">
                  <span class="titre">Lien d'accès</span>
                  <p class="aide">
                    {#if g.lien && !g.lien.perime}
                      Un lien est actif{#if g.lien.expireLe}, jusqu'au {jour(
                          new Date(g.lien.expireLe).toISOString()
                        )}{/if}.
                    {:else if g.lien}
                      Le dernier lien a expiré.
                    {:else}
                      Aucun lien en cours.
                    {/if}
                  </p>
                  <div class="rangee">
                    <button
                      type="button"
                      class="b"
                      disabled={busy !== null || g.accesRetire}
                      onclick={() => inviter(g)}
                      >{g.lien ? 'Nouveau lien' : 'Envoyer un lien'}</button
                    >
                    {#if g.lien}
                      <button
                        type="button"
                        class="b gris"
                        disabled={busy !== null}
                        onclick={() => annulerLien(g)}>Annuler</button
                      >
                    {/if}
                  </div>
                </div>

                {#if g.id !== data.moiId}
                  <div class="champ-groupe">
                    <label class="bascule">
                      <span class="ios-cell-text">
                        <span class="titre">Peut tout régler</span>
                        <span class="aide">
                          Configuration du cumulus, boucle SB3, bridage de l'onduleur, suppression
                          d'un morceau, et gestion des accès.
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={g.peutToutRegler}
                        disabled={busy !== null}
                        onchange={() => basculerDroits(g)}
                      />
                    </label>
                  </div>

                  <div class="rangee fin">
                    <button
                      type="button"
                      class="b {g.accesRetire ? 'gris' : 'rouge'}"
                      disabled={busy !== null}
                      onclick={() => basculerAcces(g)}
                    >
                      {g.accesRetire ? 'Rétablir l’accès' : 'Retirer l’accès'}
                    </button>
                    <button
                      type="button"
                      class="b rouge"
                      disabled={busy !== null}
                      onclick={() => supprimer(g)}>Supprimer le compte</button
                    >
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {#if data.estAdmin}
      <p class="ios-group-footer">
        Retirer l'accès déconnecte immédiatement, même app déjà ouverte, et désactive le lien. C'est
        réversible ; supprimer ne l'est pas.
      </p>
    {/if}
  </section>

  {#if data.estAdmin}
    <section class="ios-section">
      <h2 class="ios-group-header">Ajouter quelqu'un</h2>
      <div class="ios-group">
        <div class="ios-cell bloc">
          <div class="rangee">
            <input
              class="saisie"
              type="email"
              bind:value={nouvelEmail}
              placeholder="prenom@exemple.fr"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              disabled={busy !== null}
              aria-label="Adresse e-mail"
            />
            <button
              type="button"
              class="b"
              disabled={!emailValide || busy !== null}
              onclick={ajouter}
            >
              Ajouter
            </button>
          </div>
        </div>
      </div>
      <p class="ios-group-footer">
        La personne arrive sans droits particuliers. Ouvre ensuite sa fiche pour lui envoyer son
        lien.
      </p>
    </section>
  {/if}
{/if}

<style>
  .bloc {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }
  .ligne {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 12px;
    text-align: left;
    padding: 2px 0;
  }
  .chevron {
    color: var(--color-muted-fg);
    font-size: 20px;
    transition: transform 0.18s ease;
  }
  .chevron.ouvert {
    transform: rotate(90deg);
  }
  .moi {
    margin-left: 8px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 16px 0 4px;
  }
  .champ-groupe {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .titre {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .aide {
    font-size: 13px;
    color: var(--color-muted-fg);
  }
  .aide.rouge {
    color: var(--color-alert);
  }
  .rangee {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .rangee.fin {
    padding-top: 4px;
  }
  .bascule {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }
  .saisie {
    flex: 1 1 160px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 16px; /* 16px minimum : en dessous, iOS zoome à la mise au point */
    outline: none;
  }
  .saisie:focus {
    border-color: var(--color-primary);
  }
  .code {
    flex: 0 0 108px;
    letter-spacing: 0.35em;
  }
  .b {
    padding: 8px 14px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    background: var(--color-primary);
    color: white;
    transition: transform 0.12s ease;
  }
  .b:active:not(:disabled) {
    transform: scale(0.96);
  }
  .b:disabled {
    opacity: 0.4;
  }
  .b.gris {
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .b.rouge {
    background: transparent;
    color: var(--color-alert);
    border: 1px solid var(--color-alert);
  }
  .url {
    display: block;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 12px;
    word-break: break-all;
  }
  .is-rouge {
    color: var(--color-alert);
  }
  .is-vert {
    color: var(--color-success);
  }
</style>
