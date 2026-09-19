#!/usr/bin/env python3
"""airpods-ble — batterie des AirPods (écouteurs + boîtier) captée en Bluetooth LE → MQTT.

Le cloud Localiser ne donne AUCUNE batterie pour les AirPods : `batteryLevel 0.0`,
`batteryStatus "Unknown"`, et aucun champ boîtier (contenu brut iCloud relu le 19/09/2026
sur des Pro 2 et des Pro 3). Les AirPods, eux, diffusent leurs niveaux EN CLAIR dans leurs
annonces Apple « proximity pairing » (données fabricant 0x004C, type 0x07) : c'est ce que lit
l'iPhone pour son widget Batteries. Le RPi4 les écoute passivement.

Rapprochement avec Localiser : le modèle de la trame (octets 3-4, petit-boutiste) est le
`rawDeviceModel` d'iCloud — 0x2024 = AirPods_8228 (Pro 2), 0x2027 = AirPods_8231 (Pro 3).
On ne publie QUE les modèles présents dans Localiser (lus sur `findmy/+`, champ `model`) :
les AirPods des voisins ne créent pas de topics.

Publie `findmy/_airpods/<modèle>` (retained) :
  { model, left, right, case, left_charging, right_charging, case_charging,
    left_ts, right_ts, case_ts, rssi, ts }
Niveaux en %, par pas de 10 (résolution de la trame). Un niveau inconnu (0xF : boîtier loin
des écouteurs…) n'efface JAMAIS la dernière valeur connue : chaque élément garde sa propre
date de mesure, et `ts` date la dernière trame entendue.
"""
import asyncio
import json
import logging
import os
import threading
import time

import paho.mqtt.client as mqtt
from bleak import BleakScanner

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("airpods-ble")

MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USER = os.environ.get("MQTT_USER") or None
MQTT_PASS = os.environ.get("MQTT_PASS") or None
PREFIX = os.environ.get("TOPIC_PREFIX", "findmy")
# Republication sans changement (rafraîchit `ts` = « entendus il y a… »).
HEARTBEAT_S = int(os.environ.get("HEARTBEAT_S", "300"))
# Aucune annonce BLE (tous émetteurs confondus) pendant ce délai = scanner mort → on sort,
# Docker relance. Le RPi4 entend des centaines de trames Apple par minute.
SILENCE_S = int(os.environ.get("SILENCE_S", "300"))
# 1 = journalise les trames décodées sans rien publier (mise au point).
OBSERVE_ONLY = os.environ.get("OBSERVE_ONLY", "0") == "1"

APPLE = 0x004C
PROXIMITY_PAIRING = 0x07
PARTS = ("left", "right", "case")

lock = threading.Lock()
known_models: set[str] = set()  # modèles d'AirPods présents dans Localiser
state: dict[str, dict] = {}  # modèle → dernier état publié (repris des retained au démarrage)
last_pub: dict[str, float] = {}
last_adv = time.time()


def level(nibble: int) -> int | None:
    """Quartet 0-10 → %, par pas de 10 ; 11-15 = inconnu."""
    return nibble * 10 if nibble <= 10 else None


def decode(m: bytes) -> dict | None:
    """Trame « proximity pairing » (données fabricant Apple, sans l'identifiant 0x004C).

    0 type 0x07 · 1 longueur 0x19 · 2 préfixe · 3-4 modèle (petit-boutiste) · 5 état
    (bit 0x20 à 0 = quartets des écouteurs inversés) · 6 niveaux des deux écouteurs, un
    quartet chacun · 7 quartet haut = indicateurs de charge, quartet bas = boîtier.
    """
    if len(m) < 8 or m[0] != PROXIMITY_PAIRING or m[1] != 0x19:
        return None
    flip = (m[5] & 0x20) == 0
    hi, lo = m[6] >> 4, m[6] & 0x0F
    flags, case = m[7] >> 4, m[7] & 0x0F
    left, right = (hi, lo) if flip else (lo, hi)
    return {
        "model": f"AirPods_{m[3] | (m[4] << 8)}",
        "left": level(left),
        "right": level(right),
        "case": level(case),
        "left_charging": bool(flags & (0b10 if flip else 0b01)),
        "right_charging": bool(flags & (0b01 if flip else 0b10)),
        "case_charging": bool(flags & 0b100),
    }


def signature(s: dict) -> tuple:
    return tuple((s.get(p), s.get(f"{p}_charging")) for p in PARTS)


def connect_mqtt() -> mqtt.Client:
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if MQTT_USER:
        c.username_pw_set(MQTT_USER, MQTT_PASS)

    def on_connect(client, userdata, flags, reason_code, properties):
        client.subscribe(f"{PREFIX}/+")  # appareils Localiser → modèles connus
        client.subscribe(f"{PREFIX}/_airpods/+")  # nos retained → reprise après redémarrage

    def on_message(client, userdata, msg):
        if not msg.payload:
            return
        try:
            p = json.loads(msg.payload)
        except ValueError:
            return
        model = p.get("model")
        if not isinstance(model, str):
            return
        with lock:
            if msg.topic.startswith(f"{PREFIX}/_airpods/"):
                state.setdefault(model, p)
            elif model.startswith("AirPods") and model not in known_models:
                known_models.add(model)
                log.info("modèle suivi : %s (%s)", model, p.get("name"))

    c.on_connect = on_connect
    c.on_message = on_message
    c.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    c.loop_start()
    return c


def on_advertisement(mc: mqtt.Client, device, adv) -> None:
    global last_adv
    last_adv = time.time()
    m = adv.manufacturer_data.get(APPLE)
    if not m or m[0] != PROXIMITY_PAIRING:
        return
    frame = decode(m)
    if frame is None:
        return
    model = frame["model"]
    if OBSERVE_ONLY:
        log.info("trame %s rssi=%s %s", model, adv.rssi, frame)
        return
    now = int(time.time())
    with lock:
        if model not in known_models:
            return
        s = dict(state.get(model) or {"model": model})
        before = signature(s)
        for p in PARTS:
            if frame[p] is not None:
                s[p] = frame[p]
                s[f"{p}_charging"] = frame[f"{p}_charging"]
                s[f"{p}_ts"] = now
        s["rssi"] = adv.rssi
        s["ts"] = now
        state[model] = s
        changed = signature(s) != before
        due = now - last_pub.get(model, 0) >= HEARTBEAT_S
        if not (changed or due):
            return
        last_pub[model] = now
    mc.publish(f"{PREFIX}/_airpods/{model}", json.dumps(s), retain=True)
    if changed:
        log.info(
            "pub %s G=%s D=%s boîtier=%s charge=%s/%s/%s rssi=%s",
            model,
            s.get("left"),
            s.get("right"),
            s.get("case"),
            s.get("left_charging"),
            s.get("right_charging"),
            s.get("case_charging"),
            adv.rssi,
        )


async def main() -> None:
    mc = connect_mqtt()
    scanner = BleakScanner(lambda d, a: on_advertisement(mc, d, a))
    await scanner.start()
    log.info("scan BLE démarré%s", " (observation seule)" if OBSERVE_ONLY else "")
    try:
        while True:
            await asyncio.sleep(30)
            silent = time.time() - last_adv
            if silent > SILENCE_S:
                raise RuntimeError(f"aucune annonce BLE depuis {silent:.0f} s — scanner mort")
    finally:
        await scanner.stop()


if __name__ == "__main__":
    asyncio.run(main())
