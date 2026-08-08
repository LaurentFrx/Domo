<script lang="ts">
  import ConcentricRings from '$components/effects/ConcentricRings.svelte';

  let email = $state('');
  let pin = $state('');
  let busy = $state(false);
  let erreur = $state<string | null>(null);

  const pret = $derived(email.trim().length > 0 && /^\d{4}$/.test(pin));

  async function connecter(e: SubmitEvent) {
    e.preventDefault();
    if (!pret || busy) return;
    busy = true;
    erreur = null;
    try {
      const r = await fetch('/api/auth/pin-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), pin })
      });
      const d = (await r.json().catch(() => ({}))) as { redirect?: string; message?: string };
      if (r.ok && d.redirect) {
        // Rechargement franc plutôt que goto() : le cookie vient d'être posé, on
        // veut que TOUT reparte du serveur avec la nouvelle session.
        window.location.href = d.redirect;
        return;
      }
      erreur = d.message ?? 'Connexion impossible.';
      pin = '';
    } catch {
      erreur = 'Pas de réseau — réessaie dans un instant.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Accès restreint — Domo</title>
</svelte:head>

<div
  class="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-4"
  style="background: var(--color-bg);"
>
  <!-- Anneaux orbitaux (vert OVNI) centrés derrière la carte d'accès -->
  <div class="pointer-events-none absolute inset-0" aria-hidden="true">
    <ConcentricRings />
  </div>

  <div class="relative z-[1] flex max-w-sm flex-col items-center gap-6 text-center">
    <div
      class="flex h-16 w-16 items-center justify-center rounded-2xl"
      style="background: var(--color-primary-muted); color: var(--color-primary);"
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>

    <div class="flex flex-col gap-2">
      <h1 class="text-[20px] font-semibold tracking-tight" style="color: var(--color-fg);">
        Accès restreint
      </h1>
      <p class="text-[14px]" style="color: var(--color-muted-fg);">
        Cette application est réservée à la famille. Demande le lien d'accès à Laurent.
      </p>
      <a
        href="mailto:laurent@feroux.fr?subject=Demande%20d%27acc%C3%A8s%20Domo&body=Bonjour%20Laurent%2C%20peux-tu%20m%27envoyer%20le%20lien%20d%27acc%C3%A8s%20%C3%A0%20Domo%20%3F"
        class="inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-semibold transition-transform active:scale-95"
        style="background: var(--color-primary); color: white;"
      >
        Demander l'accès
      </a>
    </div>

    <!-- Voie de secours : email + code à 4 chiffres, pour qui n'a plus son lien
         magique sous la main. Le lien mailto ci-dessus reste la porte d'entrée
         de quelqu'un qui n'a pas encore de compte. -->
    <form
      class="pin-card w-full rounded-2xl p-5 text-left"
      style="background: var(--color-card);"
      onsubmit={connecter}
    >
      <h2 class="mb-1 text-[15px] font-semibold" style="color: var(--color-fg);">
        J'ai déjà un code
      </h2>
      <p class="mb-4 text-[13px]" style="color: var(--color-muted-fg);">
        Ton adresse e-mail et ton code à 4 chiffres.
      </p>

      <label class="pin-label" for="pin-email">E-mail</label>
      <input
        id="pin-email"
        class="pin-input"
        type="email"
        bind:value={email}
        autocomplete="username"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="prenom@exemple.fr"
        disabled={busy}
      />

      <label class="pin-label mt-3" for="pin-code">Code</label>
      <input
        id="pin-code"
        class="pin-input pin-code"
        type="password"
        inputmode="numeric"
        maxlength="4"
        bind:value={pin}
        autocomplete="current-password"
        placeholder="••••"
        disabled={busy}
      />

      {#if erreur}
        <p class="mt-3 text-[13px]" style="color: var(--color-alert);" role="alert">
          {erreur}
        </p>
      {/if}

      <button type="submit" class="pin-submit mt-4" disabled={!pret || busy}>
        {busy ? 'Vérification…' : 'Entrer'}
      </button>
    </form>
  </div>
</div>

<style>
  .pin-label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }
  .pin-input {
    width: 100%;
    padding: 11px 13px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 16px; /* 16px minimum : en dessous, iOS zoome à la mise au point */
    outline: none;
  }
  .pin-input:focus {
    border-color: var(--color-primary);
  }
  .pin-input:disabled {
    opacity: 0.6;
  }
  .pin-code {
    letter-spacing: 0.4em;
  }
  .pin-submit {
    width: 100%;
    padding: 12px;
    border-radius: 999px;
    background: var(--color-primary);
    color: white;
    font-size: 15px;
    font-weight: 600;
    transition: transform 0.12s ease;
  }
  .pin-submit:active:not(:disabled) {
    transform: scale(0.97);
  }
  .pin-submit:disabled {
    opacity: 0.45;
  }
</style>
