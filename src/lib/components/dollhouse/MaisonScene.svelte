<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { T, useThrelte } from '@threlte/core';
  import { OrbitControls, HTML, interactivity, type IntersectionEvent } from '@threlte/extras';
  import { WALLS, ROOMS, WALL_HEIGHT } from './maison-plan';

  // Raycasting Threlte : clic/tap sur les sols de pièce.
  interactivity();

  // ─── Libération EXPLICITE du contexte WebGL au démontage (RÈGLE Domo) ──────
  // renderer.dispose() libère le GPU mais PAS le contexte WebGL ; sans
  // forceContextLoss(), chaque visite de /maison fuit un contexte (~8 max iOS)
  // → au-delà Safari tue les anciens et la scène devient noire. Voir Phase 0.
  const { renderer } = useThrelte();
  onDestroy(() => {
    try {
      renderer?.dispose();
      renderer?.forceContextLoss();
    } catch {
      /* contexte déjà perdu — sans gravité */
    }
  });

  // ─── Recentrage du modèle (murs + pièces, terrasse/garage compris) ─────────
  const roomPoints = ROOMS.flatMap((r) => r.polygons.flat());
  const allX = [...WALLS.flatMap((w) => [w.x1, w.x2]), ...roomPoints.map((p) => p[0])];
  const allZ = [...WALLS.flatMap((w) => [w.z1, w.z2]), ...roomPoints.map((p) => p[1])];
  const cx = (Math.min(...allX) + Math.max(...allX)) / 2;
  const cz = (Math.min(...allZ) + Math.max(...allZ)) / 2;
  const extent = Math.max(
    Math.max(...allX) - Math.min(...allX),
    Math.max(...allZ) - Math.min(...allZ)
  );

  // ─── Pré-calcul des murs (boîtes extrudées orientées le long du segment) ───
  const wallMeshes = WALLS.map((w) => {
    const dx = w.x2 - w.x1;
    const dz = w.z2 - w.z1;
    const len = Math.hypot(dx, dz);
    return {
      pos: [(w.x1 + w.x2) / 2, w.h / 2, (w.z1 + w.z2) / 2] as [number, number, number],
      rotY: -Math.atan2(dz, dx),
      args: [len, w.h, Math.max(w.t, 0.05)] as [number, number, number]
    };
  });

  // ─── Sols : un THREE.Shape par polygone (une pièce peut en regrouper
  //     plusieurs, ex. terrasse). Points (x, −z) + rotation −90°/X → plan
  //     posé sur XZ, normale vers le haut, aligné sur les murs. ────────────────
  const floorShapes = ROOMS.map((r) =>
    r.polygons.map((poly) => {
      const shape = new THREE.Shape();
      poly.forEach(([x, z], i) => {
        if (i === 0) shape.moveTo(x, -z);
        else shape.lineTo(x, -z);
      });
      shape.closePath();
      return shape;
    })
  );

  // ─── Escalier DEMI-TOUR (U) dans la bande à l'ouest des WC ────────────────
  // 2 volées nord↔sud côte à côte + demi-palier au sud (le 180°), montant au
  // palier de l'étage (y = hauteur des murs). Le dessous au sud reste ouvert
  // → cumulus accessible. Marches = blocs (profil plein vu de dessus, dessous
  // ajouré).
  const stairSteps = (() => {
    const xWall = -2.008;
    const xToilet = -1.027;
    const N = 7; // contremarches par volée (14 au total → niveau étage)
    const fullW = xToilet - xWall; // largeur de la cage (~0.98 m)
    const flightW = 0.4; // volées étroites → vide central (cage) visible
    const xEast = xToilet - flightW / 2; // volée BASSE (côté WC)
    const xWest = xWall + flightW / 2; // volée HAUTE (côté Salon)
    const riser = WALL_HEIGHT / (2 * N);
    const half = N * riser; // hauteur du demi-palier (mi-étage)
    const top = 2 * N * riser; // = WALL_HEIGHT (niveau de l'étage)
    // emprise z : palier d'étage au NORD, demi-palier au SUD, volées entre
    const palStart = -0.7; // bord nord (mur) du palier d'étage
    const palEnd = -0.15; // bord sud du palier d'étage
    const demiStart = 1.5; // bord nord du demi-palier
    const demiEnd = 2.05; // bord sud (mur) du demi-palier
    const tread = (demiStart - palEnd) / N;
    type Step = { pos: [number, number, number]; size: [number, number, number] };
    const steps: Step[] = [];
    // VOLÉE BASSE (est) : entrée au nord (sol) → demi-palier (sud), monte
    for (let i = 0; i < N; i++) {
      steps.push({
        pos: [xEast, (i + 0.5) * riser, palEnd + (i + 0.5) * tread],
        size: [flightW, riser, tread * 1.02]
      });
    }
    // DEMI-PALIER (sud) : le demi-tour 180°, pleine largeur, à mi-hauteur
    steps.push({
      pos: [(xWall + xToilet) / 2, half - riser / 2, (demiStart + demiEnd) / 2],
      size: [fullW, riser, demiEnd - demiStart]
    });
    // VOLÉE HAUTE (ouest) : demi-palier (sud) → palier d'étage (nord), monte
    for (let i = 0; i < N; i++) {
      steps.push({
        pos: [xWest, half + (i + 0.5) * riser, demiStart - (i + 0.5) * tread],
        size: [flightW, riser, tread * 1.02]
      });
    }
    // PALIER DE L'ÉTAGE (nord) : plateau d'arrivée au niveau du 1er étage
    steps.push({
      pos: [(xWall + xToilet) / 2, top - riser / 2, (palStart + palEnd) / 2],
      size: [fullW, riser, palEnd - palStart]
    });
    return steps;
  })();

  let selectedId = $state<string | null>(null);
  function selectRoom(id: string) {
    selectedId = selectedId === id ? null : id;
  }
</script>

<!-- Caméra « maquette » : vue plongeante orbitable. Distance dérivée de
     l'emprise pour cadrer toute la maison quel que soit le plan. -->
<T.PerspectiveCamera makeDefault position={[extent * 0.42, extent * 0.72, extent * 0.88]} fov={47}>
  <OrbitControls
    enableDamping
    target={[0, -0.4, 0]}
    maxPolarAngle={Math.PI / 2.1}
    minDistance={extent * 0.3}
    maxDistance={extent * 2.4}
  />
</T.PerspectiveCamera>

<!-- Éclairage dirigé HAUT-GAUCHE (convention Yeldra) — pas d'ombres portées. -->
<T.AmbientLight intensity={0.78} />
<T.DirectionalLight position={[-extent * 0.6, extent, extent * 0.5]} intensity={1.25} />

<T.Group position={[-cx, 0, -cz]}>
  <!-- Sols cliquables, teintés par pièce (1 mesh par polygone) -->
  {#each ROOMS as room, i (room.id)}
    {@const selected = selectedId === room.id}
    {#each floorShapes[i] as shape, j (j)}
      <T.Mesh
        rotation.x={-Math.PI / 2}
        position.y={0.006 + room.lift}
        onclick={(event: IntersectionEvent<MouseEvent>) => {
          event.stopPropagation();
          selectRoom(room.id);
        }}
      >
        <T.ShapeGeometry args={[shape]} />
        <T.MeshStandardMaterial
          color={room.accent}
          transparent
          opacity={selected ? 0.5 : 0.26}
          emissive={room.accent}
          emissiveIntensity={selected ? 0.45 : 0.08}
          side={THREE.DoubleSide}
          roughness={0.7}
          metalness={0}
        />
      </T.Mesh>
    {/each}
  {/each}

  <!-- Murs : verre translucide bleuté (ne pas écrire la profondeur → on voit
       l'intérieur de la maquette sans tri d'opacité disgracieux). -->
  {#each wallMeshes as w, i (i)}
    <T.Mesh position={w.pos} rotation.y={w.rotY}>
      <T.BoxGeometry args={w.args} />
      <T.MeshStandardMaterial
        color="#aeb8ff"
        transparent
        opacity={0.16}
        depthWrite={false}
        roughness={0.4}
        metalness={0}
        side={THREE.DoubleSide}
      />
    </T.Mesh>
  {/each}

  <!-- Escalier demi-tour (bois clair, opaque) — repère vertical de la maquette. -->
  {#each stairSteps as s, i (i)}
    <T.Mesh position={s.pos}>
      <T.BoxGeometry args={s.size} />
      <T.MeshStandardMaterial color="#caa978" roughness={0.8} metalness={0} />
    </T.Mesh>
  {/each}

  <!-- Labels flottants : nom de pièce (+ température à brancher). -->
  {#each ROOMS as room (room.id)}
    {@const selected = selectedId === room.id}
    <HTML position={[room.labelAt[0], 1.4, room.labelAt[1]]} center pointerEvents="none">
      <div class="room-label" class:is-selected={selected}>
        <span class="rl-name">{room.name}</span>
        {#if selected}
          <span class="rl-area">{room.area} m²</span>
        {/if}
      </div>
    </HTML>
  {/each}
</T.Group>

<style>
  .room-label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-card);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--color-fg);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    transition:
      transform var(--duration-fast) var(--ease-default),
      border-color var(--duration-fast) var(--ease-default);
  }
  .room-label.is-selected {
    border-color: var(--color-primary);
    transform: scale(1.06);
  }
  .rl-area {
    font-weight: 500;
    font-size: 10px;
    color: var(--color-muted-fg);
  }
</style>
