<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { T, useThrelte } from '@threlte/core';
  import { OrbitControls, HTML, interactivity, type IntersectionEvent } from '@threlte/extras';
  import { WALLS, ROOMS } from './maison-plan';
  import { zigbee } from '$stores/zigbee.svelte';
  import { acquire } from '$stores/refcount';

  // Raycasting Threlte : clic/tap sur les sols de pièce.
  interactivity();

  // ─── Flux temps réel des sondes Zigbee (SSE, refcount partagé avec les
  //     autres pages — ne coupe pas le flux au démontage si une autre page
  //     l'utilise). ──────────────────────────────────────────────────────────
  let releaseZigbee: (() => void) | null = null;
  onMount(() => {
    releaseZigbee = acquire(zigbee);
  });

  // ─── Libération EXPLICITE du contexte WebGL au démontage (RÈGLE Domo) ──────
  // renderer.dispose() libère le GPU mais PAS le contexte WebGL ; sans
  // forceContextLoss(), chaque visite de /maison fuit un contexte (~8 max iOS)
  // → au-delà Safari tue les anciens et la scène devient noire. Voir Phase 0.
  const { renderer } = useThrelte();
  onDestroy(() => {
    releaseZigbee?.();
    try {
      renderer?.dispose();
      renderer?.forceContextLoss();
    } catch {
      /* contexte déjà perdu — sans gravité */
    }
  });

  // ─── Mapping pièce → sonde de température (PROVISOIRE, à confirmer) ─────────
  // L'espace de vie ouvert (Salon/SàM/Cuisine) partage la sonde « Thermo Salon ».
  // Les pièces sans sonde n'affichent pas de température.
  const ROOM_SENSOR: Record<string, string> = {
    Salon: 'Thermo Salon',
    'Salle à Manger': 'Thermo Salon',
    Cuisine: 'Thermo Salon',
    Terrasse: 'Thermo_ext',
    Vélos: 'Thermo_velos'
  };
  const tempByRoom = $derived.by(() => {
    const m: Record<string, number | null> = {};
    for (const room of ROOMS) {
      const sensor = ROOM_SENSOR[room.name];
      const dev = sensor ? zigbee.devices.find((d) => d.friendlyName === sensor) : undefined;
      const t = dev?.state?.temperature;
      m[room.id] = typeof t === 'number' ? t : null;
    }
    return m;
  });
  const fmtTemp = (t: number) => `${t.toFixed(1).replace('.', ',')} °C`;

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

  <!-- Labels flottants : nom de pièce + température (sonde Zigbee) ; surface au tap. -->
  {#each ROOMS as room (room.id)}
    {@const selected = selectedId === room.id}
    {@const temp = tempByRoom[room.id]}
    <HTML position={[room.labelAt[0], 1.4, room.labelAt[1]]} center pointerEvents="none">
      <div class="room-label" class:is-selected={selected}>
        <span class="rl-name">{room.name}</span>
        {#if temp != null}
          <span class="rl-temp">{fmtTemp(temp)}</span>
        {/if}
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
  .rl-temp {
    font-weight: 700;
    color: var(--color-primary);
  }
  .rl-area {
    font-weight: 500;
    font-size: 10px;
    color: var(--color-muted-fg);
  }
</style>
