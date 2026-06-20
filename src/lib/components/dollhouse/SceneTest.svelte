<script lang="ts">
  import { onDestroy } from 'svelte';
  import { T, useThrelte } from '@threlte/core';
  import { OrbitControls, HTML, interactivity, type IntersectionEvent } from '@threlte/extras';

  // Raycasting Threlte : active les événements pointeur (onclick…) sur les meshes.
  interactivity();

  // ─── Libération EXPLICITE du contexte WebGL au démontage ───────────────────
  // Sans ça, chaque visite de /maison crée un nouveau contexte WebGL que ni
  // Threlte ni three ne rendent au navigateur (renderer.dispose() libère les
  // ressources GPU mais PAS le contexte lui-même). Ils s'accumulent : ~16 max
  // sur desktop, ~8 sur iOS → au-delà, Safari tue les plus anciens et la scène
  // « bloque » / devient noire (bug constaté en naviguant via le footer).
  // forceContextLoss() (WEBGL_lose_context) rend le contexte immédiatement.
  const { renderer } = useThrelte();
  onDestroy(() => {
    try {
      renderer?.dispose();
      renderer?.forceContextLoss();
    } catch {
      /* contexte déjà perdu / renderer déjà libéré — sans gravité */
    }
  });

  // ─── Pièces factices (validation technique, pas la vraie maison) ────────
  // Couleurs de marque en hex : les matériaux three ne lisent pas les
  // variables CSS (violet charte #6E45FF, menthe #3DFD98, gris neutre).
  type Room = {
    id: string;
    label: string;
    color: string;
    position: [number, number, number];
  };

  const rooms: Room[] = [
    { id: 'salon', label: 'Salon', color: '#6E45FF', position: [-1.9, 0.5, 0.4] },
    { id: 'cuisine', label: 'Cuisine', color: '#3DFD98', position: [0, 0.5, -1.3] },
    { id: 'chambre', label: 'Chambre', color: '#8b8fa3', position: [1.9, 0.5, 0.7] }
  ];

  // Sélection de pièce simulée : la boîte cliquée s'allume (emissive).
  let selectedId = $state<string | null>(null);

  function toggleRoom(id: string) {
    selectedId = selectedId === id ? null : id;
  }
</script>

<T.PerspectiveCamera makeDefault position={[5.5, 4.5, 6.5]} fov={42}>
  <!-- enableDamping : inertie douce au doigt (iOS). Cible (0,0,0) par défaut. -->
  <OrbitControls enableDamping maxPolarAngle={Math.PI / 2.05} minDistance={3} maxDistance={16} />
</T.PerspectiveCamera>

<!-- Éclairage simple — pas de post-processing, pas d'ombres portées (coût GPU). -->
<T.AmbientLight intensity={0.7} />
<T.DirectionalLight position={[5, 8, 4]} intensity={1.4} />

<!-- Sol -->
<T.Mesh rotation.x={-Math.PI / 2}>
  <T.PlaneGeometry args={[14, 14]} />
  <T.MeshStandardMaterial color="#3a3a4c" roughness={0.95} />
</T.Mesh>

<!-- « Pièces » : clic = toggle sélection (emissive), futur clic-pièce dollhouse -->
{#each rooms as room (room.id)}
  {@const selected = selectedId === room.id}
  <T.Mesh
    position={room.position}
    onclick={(event: IntersectionEvent<MouseEvent>) => {
      event.stopPropagation();
      toggleRoom(room.id);
    }}
  >
    <T.BoxGeometry args={[1.5, 1, 1.5]} />
    <T.MeshStandardMaterial
      color={room.color}
      emissive={selected ? room.color : '#000000'}
      emissiveIntensity={selected ? 0.5 : 0}
      roughness={0.55}
    />
  </T.Mesh>
{/each}

<!-- Label billboard (overlay écran, face caméra) au-dessus de la Cuisine :
     simule le futur label température par pièce. -->
<HTML position={[0, 1.55, -1.3]} center pointerEvents="none">
  <div class="room-label">Cuisine · 21,5 °C</div>
</HTML>

<style>
  .room-label {
    padding: 4px 10px;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-card);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--color-fg);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
</style>
