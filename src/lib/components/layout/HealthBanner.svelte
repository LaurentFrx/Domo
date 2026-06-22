<script lang="ts">
  // Bandeau d'alerte global : s'affiche quand la liaison avec le système
  // domotique est interrompue depuis plus que le délai de grâce du store health
  // (auto-réparation infra échouée). Volontairement TRANCHANT (fond alerte plein)
  // pour attirer l'œil — contrairement aux cartes « verre » du reste de l'app.
  // Wording simple et rassurant (la clim/chauffage ne s'arrêtent pas) : public
  // familial non-technique.
  import { health } from '$stores/health.svelte';
</script>

{#if health.linkDown}
  <div class="health-banner" role="alert" aria-live="assertive">
    <svg class="hb-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.2 1.8 20.4a1 1 0 0 0 .87 1.5h18.66a1 1 0 0 0 .87-1.5L12 3.2Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
      <path
        d="M12 9.5v5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
      />
      <circle cx="12" cy="17.6" r="1.05" fill="currentColor" />
    </svg>
    <div class="hb-text">
      <strong>Liaison avec la maison interrompue</strong>
      <span>
        Depuis {health.downMinutes} min — le pilotage à distance est momentanément indisponible. La climatisation
        et le chauffage continuent sur leur dernière consigne.
      </span>
    </div>
  </div>
{/if}

<style>
  .health-banner {
    position: sticky;
    top: calc(env(safe-area-inset-top, 0px) + 0.5rem);
    z-index: 40;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin: 0.5rem 0 1rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-xl);
    background: var(--color-alert);
    color: var(--color-alert-fg);
    /* Ombre teintée en oklch DIRECT (pas de color-mix(var()) → safe Chrome). */
    box-shadow:
      0 8px 22px -10px oklch(0.55 0.24 27 / 0.55),
      0 2px 6px -3px oklch(0.55 0.24 27 / 0.4);
  }

  .hb-icon {
    flex: 0 0 auto;
    width: 1.4rem;
    height: 1.4rem;
    margin-top: 0.05rem;
  }

  .hb-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    line-height: 1.3;
  }
  .hb-text strong {
    font-weight: 600;
    font-size: 0.95rem;
  }
  .hb-text span {
    font-size: 0.8rem;
    opacity: 0.92;
  }

  @media (prefers-reduced-motion: no-preference) {
    .health-banner {
      animation: hb-in 0.28s ease-out both;
    }
    @keyframes hb-in {
      from {
        opacity: 0;
        transform: translateY(-0.4rem);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  }
</style>
