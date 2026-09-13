#!/usr/bin/env python3
"""
CHIEN DE GARDE de la Solarbank Max AC — à déployer SUR LE RPi4.

POURQUOI, ET POURQUOI PAS SUR LE VPS.
En mode Modbus « contrôle par un tiers » (`operating_mode = 3`), la Max AC cesse
totalement de réguler. Mesuré le 13/09/2026 : de 670 W de charge à 0 W en trente
secondes, et 684 W partis au réseau en continu tant que personne ne commandait.
Domo devient donc indispensable en permanence — or il redémarre à chaque
déploiement, et le VPS peut tomber. Le garde-fou doit vivre AILLEURS que ce
qu'il surveille : sur le RPi4, qui est sur le même réseau que l'appareil et
n'a besoin de rien d'autre pour agir.

CE QU'IL FAIT, ET RIEN D'AUTRE.
Toutes les VERIFY_EVERY_S secondes : lire le mode. S'il vaut 3, demander à Domo
s'il tient encore la barre (`/api/maxac/heartbeat`, revendication qui EXPIRE
d'elle-même — un process mort ne peut pas mentir). Si la réponse manque ou dit
non FAILS_BEFORE_ACT fois de suite, réécrire le mode 0 et le vérifier.

Il ne pilote JAMAIS la puissance, ne touche à aucun autre registre, et son seul
geste est un retour à l'état sûr. Un doute (réseau coupé, JSON illisible, Domo
muet) est traité comme « rends la main » : c'est le sens conservateur.

Déploiement (RPi4) :
    sudo cp maxac-watchdog.py /usr/local/bin/
    sudo cp maxac-watchdog.service /etc/systemd/system/
    sudo systemctl enable --now maxac-watchdog
"""

from __future__ import annotations

import json
import logging
import os
import socket
import struct
import sys
import time
import urllib.error
import urllib.request

MAXAC_HOST = os.environ.get("MAXAC_HOST", "192.168.1.49")
MAXAC_PORT = int(os.environ.get("MAXAC_PORT", "502"))
MAXAC_UNIT = int(os.environ.get("MAXAC_UNIT", "1"))
HEARTBEAT_URL = os.environ.get("MAXAC_HEARTBEAT_URL", "https://domo.feroux.fr/api/maxac/heartbeat")
HEARTBEAT_TOKEN = os.environ.get("MAXAC_HEARTBEAT_TOKEN", "")

REG_OPERATING_MODE = 10064
MODE_SELF_CONSUMPTION = 0
MODE_THIRD_PARTY = 3

VERIFY_EVERY_S = float(os.environ.get("MAXAC_VERIFY_EVERY_S", "10"))
FAILS_BEFORE_ACT = int(os.environ.get("MAXAC_FAILS_BEFORE_ACT", "3"))
HTTP_TIMEOUT_S = 5
MODBUS_TIMEOUT_S = 3
# La bascule de mode n'est pas instantanée : la carte officielle Anker pose
# write_protection_duration = 15 s. Relire aussitôt ferait conclure à tort à un échec.
MODE_SETTLE_S = 8

log = logging.getLogger("maxac-watchdog")


def _modbus(fc: int, addr: int, arg: int) -> list[int] | None:
    """Une requête Modbus TCP, sans dépendance. None = échec (jamais d'exception)."""
    try:
        with socket.create_connection((MAXAC_HOST, MAXAC_PORT), timeout=MODBUS_TIMEOUT_S) as s:
            s.settimeout(MODBUS_TIMEOUT_S)
            s.sendall(struct.pack(">HHHBBHH", 1, 0, 6, MAXAC_UNIT, fc, addr, arg))
            head = s.recv(9)
            if len(head) < 9:
                return None
            if head[7] & 0x80:  # exception Modbus
                log.warning("Modbus exception %s (fc=%s addr=%s)", head[8], fc, addr)
                return None
            if fc == 6:  # écho de l'écriture
                rest = s.recv(2)
                return [struct.unpack(">H", rest)[0]] if len(rest) == 2 else [arg]
            n = head[8]
            body = b""
            while len(body) < n:
                chunk = s.recv(n - len(body))
                if not chunk:
                    return None
                body += chunk
            return list(struct.unpack(f">{n // 2}H", body))
    except OSError as e:
        log.warning("Modbus injoignable : %s", e)
        return None


def read_mode() -> int | None:
    r = _modbus(3, REG_OPERATING_MODE, 1)
    return r[0] if r else None


def write_mode(value: int) -> bool:
    return _modbus(6, REG_OPERATING_MODE, value) is not None


def domo_controls() -> bool | None:
    """True/False selon Domo, None si on n'a pas pu lui demander (traité comme False)."""
    req = urllib.request.Request(HEARTBEAT_URL)
    if HEARTBEAT_TOKEN:
        req.add_header("Authorization", f"Bearer {HEARTBEAT_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            if r.status != 200:
                log.warning("heartbeat HTTP %s", r.status)
                return None
            return bool(json.loads(r.read().decode("utf-8")).get("controlling"))
    except (urllib.error.URLError, ValueError, TimeoutError, OSError) as e:
        log.warning("heartbeat injoignable : %s", e)
        return None


def rendre_la_main(why: str) -> None:
    log.error("REPLI : %s → écriture du mode %s (autoconsommation)", why, MODE_SELF_CONSUMPTION)
    for essai in range(1, 4):
        if write_mode(MODE_SELF_CONSUMPTION):
            time.sleep(MODE_SETTLE_S)
            m = read_mode()
            if m == MODE_SELF_CONSUMPTION:
                log.error("REPLI RÉUSSI (essai %s) — la Max AC régule de nouveau seule", essai)
                return
            log.error("REPLI : mode relu = %s après écriture (essai %s)", m, essai)
        time.sleep(2)
    log.critical(
        "REPLI IMPOSSIBLE après 3 essais — la Max AC est peut-être restée inerte, "
        "intervention humaine requise (app Anker : repasser en autoconsommation)"
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout
    )
    log.info(
        "chien de garde Max AC — %s:%s, vérif toutes les %.0f s, repli après %s échecs (~%.0f s)",
        MAXAC_HOST,
        MAXAC_PORT,
        VERIFY_EVERY_S,
        FAILS_BEFORE_ACT,
        FAILS_BEFORE_ACT * VERIFY_EVERY_S,
    )
    echecs = 0
    dernier_mode: int | None = None
    while True:
        mode = read_mode()
        if mode != dernier_mode:
            log.info("mode = %s%s", mode, " (CONTRÔLE PAR UN TIERS)" if mode == MODE_THIRD_PARTY else "")
            dernier_mode = mode
        if mode == MODE_THIRD_PARTY:
            ok = domo_controls()
            if ok:
                echecs = 0
            else:
                echecs += 1
                log.warning(
                    "Domo ne revendique plus le contrôle (%s/%s)%s",
                    echecs,
                    FAILS_BEFORE_ACT,
                    " — injoignable" if ok is None else "",
                )
                if echecs >= FAILS_BEFORE_ACT:
                    rendre_la_main("Domo silencieux alors que l'appareil est en mode 3")
                    echecs = 0
        else:
            # Mode sûr (ou lecture impossible) : rien à faire. Une Max AC injoignable
            # n'est pas notre affaire — elle régule seule tant qu'on ne l'en empêche pas.
            echecs = 0
        time.sleep(VERIFY_EVERY_S)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log.info("arrêt demandé")
