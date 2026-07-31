#!/usr/bin/env python3
"""
atelier-bridge — l'aspirateur de l'atelier suit l'outil.

L'outil est branché sur la prise Matter **node 28**, l'aspirateur sur le
**node 29**. Le daemon écoute la puissance mesurée par la prise de l'outil
(cluster 144 « ElectricalPowerMeasurement », attribut 8 = ActivePower en mW) :
outil qui démarre → aspirateur allumé ; outil arrêté → aspirateur coupé après
un délai de traînage.

> **À déployer sur le RPi4**, à côté du matter-server (comme les autres
> bridges). Le code vit ici pour être versionné ; il ne tourne PAS sur le VPS.
> Passer par le VPS ajouterait le tunnel SSH comme point de panne sur un
> asservissement qui doit réagir en 2 secondes.

## Le principe qui gouverne tout : on n'éteint QUE ce qu'on a allumé

Décision de Laurent (2026-07-31). Si l'aspirateur est allumé à la MAIN (pour
balayer, aspirer par terre), le daemon n'y touche pas : il ne coupe jamais un
appareil qu'un humain a mis en marche. D'où le drapeau `owned`, qui n'est vrai
que si c'est bien nous qui avons envoyé le « On ».

Corollaire, moins évident : si l'utilisateur éteint l'aspirateur à la main
PENDANT que l'outil tourne, on lâche la propriété et on ne le rallume pas. Se
battre avec la personne qui appuie sur le bouton est toujours le mauvais camp ;
l'asservissement reprendra au cycle d'outil suivant.

## Latences (mesurées le 2026-07-31, pas estimées)

La souscription du matter-server rapporte un changement de puissance en
**1 à 2 s** quand il est franc (démarrage / arrêt d'outil = 0 W ↔ plusieurs
centaines de watts), et se contente d'un rafraîchissement toutes les 15 s quand
la valeur est stable. Le budget d'un cycle est donc :
  démarrage : ~1-2 s (détection) + le temps de commande → aspirateur en marche
  arrêt     : ~1-2 s (détection) + OFF_DELAY_S → aspirateur coupé

⚠️ On lit la valeur DIRECTEMENT dans l'événement `attribute_updated`, sans
repasser par un `get_nodes` (ce que fait thermostat_bridge.py). Un aller-retour
supplémentaire par événement coûterait ici la moitié du budget de réaction.
"""

import asyncio
import contextlib
import json
import os
import time
from pathlib import Path

import websockets

# ─── Configuration ────────────────────────────────────────────────────────
MATTER_WS_URL = os.environ.get("MATTER_WS_URL", "ws://127.0.0.1:5580/ws")
TOOL_NODE_ID = int(os.environ.get("TOOL_NODE_ID", "28"))  # prise « Outils atelier »
VACUUM_NODE_ID = int(os.environ.get("VACUUM_NODE_ID", "29"))  # prise « Aspirateur »

# Hystérésis. DEUX seuils et pas un seul : avec un seuil unique, un outil dont
# la consommation oscille autour de la valeur pivot ferait claquer le relais de
# l'aspirateur en boucle (usure mécanique, et bruit insupportable à l'atelier).
# On démarre au-dessus de ON_W, on ne considère l'outil arrêté qu'en dessous de
# OFF_W, et l'écart entre les deux est la zone morte.
ON_W = float(os.environ.get("ON_W", "20"))
OFF_W = float(os.environ.get("OFF_W", "10"))

# Traînage : le temps que l'aspirateur finit d'avaler ce qui est encore dans le
# tuyau après l'arrêt de l'outil. 5 s demandés par Laurent.
OFF_DELAY_S = float(os.environ.get("OFF_DELAY_S", "5"))

# Mode observation : le daemon journalise ce qu'il FERAIT sans rien commander.
# Sert à valider les seuils sur un vrai outil avant de laisser la machine
# manœuvrer le relais.
OBSERVE_ONLY = os.environ.get("OBSERVE_ONLY", "0") not in ("0", "", "false", "False")

# La propriété survit au redémarrage du daemon. Sans ça, un simple redéploiement
# pendant que l'outil tourne laisserait l'aspirateur allumé POUR TOUJOURS : au
# redémarrage on aurait `owned=False`, donc l'ordre d'extinction ne partirait
# jamais.
STATE_PATH = Path(os.environ.get("STATE_PATH", "/data/atelier_state.json"))

PWR_ATTR = "1/144/8"  # ActivePower (mW)
ONOFF_ATTR = "1/6/0"  # OnOff (bool)

# Fenêtre pendant laquelle un changement d'état de l'aspirateur est mis sur le
# compte de NOTRE commande et non d'une main humaine. Au-delà, c'est quelqu'un.
ECHO_WINDOW_S = 8.0


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} atelier-bridge: {msg}", flush=True)


class AtelierBridge:
    def __init__(self) -> None:
        self._ws = None
        self._msg_id = 0
        self._cmd_of: dict[str, str] = {}

        self.tool_w: float | None = None
        self.tool_running = False
        self.vac_on: bool | None = None

        # Vrai UNIQUEMENT si c'est nous qui avons allumé l'aspirateur.
        self.owned = self._load_owned()

        # (valeur attendue, horodatage) de notre dernière commande vers
        # l'aspirateur — pour ne pas prendre l'écho de notre propre ordre pour
        # une intervention humaine.
        self._expect: tuple[bool, float] | None = None

        self._off_task: asyncio.Task | None = None

    # ─── Persistance de la propriété ──────────────────────────────────────
    def _load_owned(self) -> bool:
        try:
            return bool(json.loads(STATE_PATH.read_text()).get("owned", False))
        except Exception:
            return False

    def _save_owned(self) -> None:
        with contextlib.suppress(Exception):
            STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            STATE_PATH.write_text(json.dumps({"owned": self.owned}))

    def _set_owned(self, value: bool) -> None:
        if self.owned != value:
            self.owned = value
            self._save_owned()

    # ─── Lien WebSocket ───────────────────────────────────────────────────
    async def run(self) -> None:
        log(
            f"démarrage · outil=node {TOOL_NODE_ID} · aspirateur=node {VACUUM_NODE_ID} · "
            f"seuils {ON_W:.0f}/{OFF_W:.0f} W · traînage {OFF_DELAY_S:.0f} s"
            + (" · MODE OBSERVATION (aucune commande)" if OBSERVE_ONLY else "")
        )
        while True:
            try:
                async with websockets.connect(
                    MATTER_WS_URL, max_size=None, open_timeout=10
                ) as ws:
                    self._ws = ws
                    log("liaison Matter établie")
                    await self._send("start_listening")
                    async for raw in ws:
                        await self._handle(raw)
            except Exception as err:  # noqa: BLE001 — on retente toujours
                log(f"liaison Matter perdue ({type(err).__name__}) — nouvelle tentative dans 3 s")
            self._ws = None
            # On NE touche pas à `owned` ici : la liaison peut revenir et
            # l'aspirateur est peut-être toujours à nous. Le rattrapage se fait
            # au retour, dans _bootstrap().
            await asyncio.sleep(3)

    async def _send(self, command: str, args: dict | None = None) -> None:
        if self._ws is None:
            return
        self._msg_id += 1
        mid = str(self._msg_id)
        self._cmd_of[mid] = command
        msg: dict = {"message_id": mid, "command": command}
        if args:
            msg["args"] = args
        await self._ws.send(json.dumps(msg))

    async def _handle(self, raw: str) -> None:
        try:
            data = json.loads(raw)
        except Exception:
            return

        mid = data.get("message_id")
        if mid is not None:
            cmd = self._cmd_of.pop(mid, None)
            if cmd in ("start_listening", "get_nodes") and isinstance(data.get("result"), list):
                await self._bootstrap(data["result"])
            return

        if data.get("event") != "attribute_updated":
            return
        payload = data.get("data")
        if not isinstance(payload, list) or len(payload) != 3:
            return
        node_id, path, value = payload

        if node_id == TOOL_NODE_ID and path == PWR_ATTR:
            await self._on_tool_power(value / 1000.0)
        elif node_id == VACUUM_NODE_ID and path == ONOFF_ATTR:
            self._on_vacuum_state(bool(value))

    async def _bootstrap(self, nodes: list) -> None:
        """État initial (et après chaque reconnexion) depuis le dump complet."""
        for node in nodes:
            attrs = node.get("attributes") or {}
            if node.get("node_id") == TOOL_NODE_ID:
                raw = attrs.get(PWR_ATTR)
                if isinstance(raw, (int, float)):
                    self.tool_w = raw / 1000.0
                    self.tool_running = self.tool_w >= ON_W
            elif node.get("node_id") == VACUUM_NODE_ID:
                val = attrs.get(ONOFF_ATTR)
                if isinstance(val, bool):
                    self.vac_on = val

        log(
            f"état initial · outil {self.tool_w if self.tool_w is not None else '?'} W "
            f"({'en marche' if self.tool_running else 'arrêté'}) · "
            f"aspirateur {'allumé' if self.vac_on else 'éteint'} · "
            f"propriété={'oui' if self.owned else 'non'}"
        )

        # Rattrapage. Deux situations amènent ici avec un aspirateur allumé qui
        # nous appartient et un outil à l'arrêt :
        #   — le daemon a été redémarré pendant un cycle (redéploiement, reboot) ;
        #   — la liaison Matter est tombée juste avant l'ordre d'extinction.
        # Dans les deux cas l'aspirateur tournerait indéfiniment. On le coupe.
        if self.owned and self.vac_on and not self.tool_running:
            log("rattrapage : outil à l'arrêt et aspirateur encore à nous → extinction")
            self._schedule_off()
        elif self.owned and not self.vac_on:
            # Il a été éteint pendant qu'on ne regardait pas : la propriété n'a
            # plus d'objet.
            self._set_owned(False)

    # ─── Logique d'asservissement ─────────────────────────────────────────
    async def _on_tool_power(self, watts: float) -> None:
        self.tool_w = watts

        if not self.tool_running and watts >= ON_W:
            self.tool_running = True
            log(f"outil démarré ({watts:.0f} W)")
            self._cancel_off()
            await self._start_vacuum()
        elif self.tool_running and watts <= OFF_W:
            self.tool_running = False
            log(f"outil arrêté ({watts:.0f} W) — extinction dans {OFF_DELAY_S:.0f} s")
            self._schedule_off()

    async def _start_vacuum(self) -> None:
        if self.vac_on:
            # Déjà en marche, et pas par nous : on ne s'en attribue pas la
            # propriété, donc on ne l'éteindra pas non plus à la fin du cycle.
            log("aspirateur déjà en marche (allumé à la main) — laissé à l'utilisateur")
            return
        log("→ allumage de l'aspirateur")
        if await self._command_vacuum(True):
            self._set_owned(True)

    def _schedule_off(self) -> None:
        self._cancel_off()
        self._off_task = asyncio.create_task(self._off_after_delay())

    def _cancel_off(self) -> None:
        if self._off_task and not self._off_task.done():
            self._off_task.cancel()
        self._off_task = None

    async def _off_after_delay(self) -> None:
        try:
            await asyncio.sleep(OFF_DELAY_S)
        except asyncio.CancelledError:
            return

        # L'outil a pu repartir pendant le traînage (un coup de scie, une pause,
        # un autre coup) : dans ce cas _cancel_off() nous a déjà tués, mais on
        # revérifie — une annulation qui arrive pile pendant le réveil n'est pas
        # une course qu'on veut perdre en coupant l'aspiration au mauvais moment.
        if self.tool_running:
            return

        if not self.owned:
            log("outil arrêté — aspirateur laissé tel quel (il n'est pas à nous)")
            return
        if not self.vac_on:
            self._set_owned(False)
            return

        log("→ extinction de l'aspirateur")
        if await self._command_vacuum(False):
            self._set_owned(False)

    async def _command_vacuum(self, on: bool) -> bool:
        if OBSERVE_ONLY:
            log(f"   [observation] commande {'On' if on else 'Off'} NON envoyée")
            return False
        if self._ws is None:
            log("   commande impossible : liaison Matter coupée")
            return False
        try:
            await self._send(
                "device_command",
                {
                    "endpoint_id": 1,
                    "node_id": VACUUM_NODE_ID,
                    "cluster_id": 6,
                    "command_name": "On" if on else "Off",
                    "payload": {},
                },
            )
        except Exception as err:  # noqa: BLE001
            log(f"   échec de la commande ({type(err).__name__})")
            return False
        # On note ce qu'on attend pour ne pas confondre l'écho de notre propre
        # ordre avec une intervention humaine sur le bouton.
        self._expect = (on, time.monotonic())
        self.vac_on = on
        return True

    def _on_vacuum_state(self, value: bool) -> None:
        """L'aspirateur a changé d'état — de notre fait, ou d'une main humaine."""
        was = self.vac_on
        self.vac_on = value

        expected = (
            self._expect is not None
            and self._expect[0] == value
            and (time.monotonic() - self._expect[1]) < ECHO_WINDOW_S
        )
        if expected:
            self._expect = None
            return
        if was == value:
            return

        if value:
            log("aspirateur allumé à la main")
            # Pas à nous : on n'y touchera pas.
        else:
            log("aspirateur éteint à la main")
            if self.owned:
                # L'utilisateur a repris la main en plein cycle. On lâche, et on
                # ne rallume pas : l'asservissement repartira au prochain
                # démarrage d'outil.
                self._set_owned(False)
                self._cancel_off()


async def main() -> None:
    await AtelierBridge().run()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
