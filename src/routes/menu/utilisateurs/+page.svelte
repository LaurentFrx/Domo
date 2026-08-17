<script lang="ts">
  /**
   * Administration des accès, dans le langage des Réglages iOS (cf. le kit
   * ios-settings.css chargé par /menu/+layout).
   *
   * Parti pris de vocabulaire : aucun jargon. « Inviter » et non « émettre un
   * jeton », « Couper l'accès » et non « révoquer », « Peut tout régler » et non
   * « role=admin ». La page sert à gérer des personnes, pas des enregistrements.
   */
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let busy = $state<string | null>(null);
  let erreur = $state<string | null>(null);
  /** Lien fraîchement émis — affiché UNE fois, jamais relisible ensuite. */
  let lien = $state<{ email: string; url: string; jours: number } | null>(null);
  let copie = $state(false);

  let nouvelEmail = $state('');
  let nouveauRole = $state<'famille' | 'admin'>('famille');
  const emailValide = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nouvelEmail.trim()));

  async function appel(methode: string, corps: unknown, url = '/api/users') {
    const r = await fetch(url, {
      method: methode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corps)
    });
    const d = (await r.json().catch(() => ({}))) as { message?: string; [k: string]: unknown };
    if (!r.ok) throw new Error(d.message ?? 'Opération impossible.');
    return d;
  }

  async function agir(cle: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = cle;
    erreur = null;
    try {
      await fn();
      await invalidateAll();
    } catch (e) {
      erreur = (e as Error).message;
    } finally {
      busy = null;
    }
  }

  const inviter = (id: string, email: string) =>
    agir(`inv:${id}`, async () => {
      const d = (await appel('POST', { userId: id }, '/api/users/invite')) as {
        path: string;
        ttlDays: number;
      };
      lien = { email, url: `${location.origin}${d.path}`, jours: d.ttlDays };
      copie = false;
    });

  const couperLien = (id: string) =>
    agir(`del-inv:${id}`, () =>
      appel('DELETE', { userId: id }, '/api/users/invite').then(() => {})
    );

  const changerStatut = (id: string, status: 'active' | 'revoked') =>
    agir(`st:${id}`, () => appel('PATCH', { userId: id, status }).then(() => {}));

  const changerRole = (id: string, role: 'admin' | 'famille') =>
    agir(`rl:${id}`, () => appel('PATCH', { userId: id, role }).then(() => {}));

  const supprimer = (id: string, email: string) =>
    agir(`rm:${id}`, async () => {
      if (!confirm(`Supprimer définitivement l'accès de ${email} ?`)) return;
      await appel('DELETE', { userId: id });
    });

  const ajouter = () =>
    agir('add', async () => {
      await appel('POST', { email: nouvelEmail.trim(), role: nouveauRole });
      nouvelEmail = '';
      nouveauRole = 'famille';
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

  function etat(u: PageData['users'][number]): string {
    if (u.status === 'revoked') return 'Accès coupé';
    if (u.status === 'invited') return u.invitation ? 'Invitation envoyée' : 'Jamais venu';
    return u.lastLoginAt
      ? `Vu le ${new Date(u.lastLoginAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
      : 'Jamais venu';
  }
</script>

{#if erreur}
  <section class="ios-section">
    <div class="ios-group">
      <div class="ios-cell"><span class="ios-cell-label is-rouge">{erreur}</span></div>
    </div>
  </section>
{/if}

{#if lien}
  <section class="ios-section">
    <h2 class="ios-group-header">Lien pour {lien.email}</h2>
    <div class="ios-group">
      <div class="ios-cell bloc">
        <p class="aide">
          Envoie-le par SMS ou WhatsApp. Il ouvre l'app au nom de cette personne et vaut
          {lien.jours} jour{lien.jours > 1 ? 's' : ''}.
        </p>
        <code class="lien">{lien.url}</code>
        <div class="rangee">
          <button type="button" class="bouton" onclick={copier}>
            {copie ? 'Copié' : 'Copier le lien'}
          </button>
          <button type="button" class="bouton discret" onclick={() => (lien = null)}>Fermer</button>
        </div>
        <p class="aide attention">
          Note-le maintenant : il ne sera plus affiché. Tu pourras toujours en générer un autre —
          l'ancien cessera alors de fonctionner.
        </p>
      </div>
    </div>
  </section>
{/if}

<section class="ios-section">
  <h2 class="ios-group-header">Qui a accès</h2>
  <div class="ios-group">
    {#each data.users as u (u.id)}
      <div class="ios-cell bloc">
        <div class="entete">
          <span class="ios-cell-text">
            <span class="ios-cell-label">
              {u.email}{#if u.id === data.moiId}<span class="moi">toi</span>{/if}
            </span>
            <span class="ios-cell-sub">
              {etat(u)} · {u.role === 'admin' ? 'Peut tout régler' : 'Usage courant'}
              {#if u.aUnCode}· Code défini{/if}
              {#if u.invitation}
                · {u.invitation.perimee ? 'lien expiré' : 'lien actif'}
              {/if}
            </span>
          </span>
        </div>

        <div class="rangee">
          <button
            type="button"
            class="bouton"
            disabled={busy !== null || u.status === 'revoked'}
            onclick={() => inviter(u.id, u.email)}
          >
            {busy === `inv:${u.id}` ? '…' : u.invitation ? 'Nouveau lien' : 'Inviter'}
          </button>

          {#if u.invitation}
            <button
              type="button"
              class="bouton discret"
              disabled={busy !== null}
              onclick={() => couperLien(u.id)}>Annuler le lien</button
            >
          {/if}

          {#if u.id !== data.moiId}
            <button
              type="button"
              class="bouton discret"
              disabled={busy !== null}
              onclick={() => changerRole(u.id, u.role === 'admin' ? 'famille' : 'admin')}
            >
              {u.role === 'admin' ? 'Retirer les réglages' : 'Autoriser les réglages'}
            </button>

            {#if u.status === 'revoked'}
              <button
                type="button"
                class="bouton discret"
                disabled={busy !== null}
                onclick={() => changerStatut(u.id, 'active')}>Rétablir</button
              >
            {:else}
              <button
                type="button"
                class="bouton danger"
                disabled={busy !== null}
                onclick={() => changerStatut(u.id, 'revoked')}>Couper l'accès</button
              >
            {/if}

            <button
              type="button"
              class="bouton danger"
              disabled={busy !== null}
              onclick={() => supprimer(u.id, u.email)}>Supprimer</button
            >
          {/if}
        </div>
      </div>
    {/each}
  </div>
  <p class="ios-group-footer">
    « Couper l'accès » déconnecte immédiatement, même si la personne avait déjà l'app ouverte, et
    désactive son lien. « Supprimer » efface le compte et son code.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Ajouter quelqu'un</h2>
  <div class="ios-group">
    <div class="ios-cell bloc">
      <input
        class="champ"
        type="email"
        bind:value={nouvelEmail}
        placeholder="prenom@exemple.fr"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        disabled={busy !== null}
        aria-label="Adresse e-mail"
      />
      <select class="champ" bind:value={nouveauRole} disabled={busy !== null} aria-label="Droits">
        <option value="famille">Usage courant</option>
        <option value="admin">Peut tout régler</option>
      </select>
      <button
        type="button"
        class="bouton"
        disabled={!emailValide || busy !== null}
        onclick={ajouter}
      >
        {busy === 'add' ? 'Ajout…' : 'Ajouter'}
      </button>
    </div>
  </div>
  <p class="ios-group-footer">
    Le compte reste en attente jusqu'à ce que la personne ouvre son lien d'invitation.
  </p>
</section>

<style>
  .bloc {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .entete {
    display: flex;
    justify-content: space-between;
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
  .rangee {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .bouton {
    padding: 7px 13px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    background: var(--color-primary);
    color: white;
    transition: transform 0.12s ease;
  }
  .bouton:active:not(:disabled) {
    transform: scale(0.96);
  }
  .bouton:disabled {
    opacity: 0.4;
  }
  .bouton.discret {
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .bouton.danger {
    background: transparent;
    color: var(--color-alert);
    border: 1px solid var(--color-alert);
  }
  .champ {
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 16px; /* 16px minimum : en dessous, iOS zoome à la mise au point */
    outline: none;
  }
  .champ:focus {
    border-color: var(--color-primary);
  }
  .lien {
    display: block;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 12px;
    word-break: break-all;
  }
  .aide {
    font-size: 13px;
    color: var(--color-muted-fg);
  }
  .aide.attention {
    color: var(--color-alert);
  }
  .is-rouge {
    color: var(--color-alert);
  }
</style>
