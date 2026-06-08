#!/usr/bin/env python3
"""
thermostat-bridge — daemon de régulation du sèche-serviette (salle de bain).

Régule un radiateur tout-ou-rien (switch Matter node 1, via python-matter-server)
en PWM lent « TPI » d'après la sonde Zigbee « Thermo SdB » (lue en MQTT), selon des
presets (hors-gel / éco / confort / boost) et un planning d'occupation.

Expose une petite API HTTP en loopback (:8101) consommée par le dashboard Domo
(routes /api/thermostat/*), qui pousse aussi la config et le planning.

⚠️ Déploiement : sur le RPi4 (près de matter-server + mosquitto). Voir README.md.
   Le thermostat physique de l'appareil doit être réglé AU MAXIMUM : le daemon
   régule par coupure d'alimentation ; un thermostat interne bas « combattrait »
   la consigne.

Phase 1 : régulation TPI + presets + manuel/auto + planning d'occupation + sécurités.
TODO Phase 4/5 : calendrier Google (scolaire / fériés / agenda) — cf. calendar_overrides().
"""

import asyncio
import contextlib
import json
import os
import time
import uuid
from datetime import datetime, date, timedelta
from pathlib import Path

import paho.mqtt.client as mqtt
import websockets
from aiohttp import web

# ─── Configuration (env, avec défauts RPi4) ──────────────────────────────
HTTP_HOST = os.environ.get("THERMOSTAT_HTTP_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("THERMOSTAT_HTTP_PORT", "8101"))

MATTER_WS_URL = os.environ.get("MATTER_WS_URL", "ws://192.168.1.29:5580/ws")
MATTER_NODE_ID = int(os.environ.get("MATTER_NODE_ID", "1"))

MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_TRANSPORT = os.environ.get("MQTT_TRANSPORT", "tcp")  # "tcp" | "websockets"
MQTT_USER = os.environ.get("MQTT_USER", "")
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD", "")
SENSOR_TOPIC = os.environ.get("THERMOSTAT_SENSOR_TOPIC", "zigbee2mqtt/Thermo SdB")
OUTDOOR_TOPIC = os.environ.get("THERMOSTAT_OUTDOOR_TOPIC", "zigbee2mqtt/Thermo_ext")

STATE_FILE = Path(os.environ.get("THERMOSTAT_STATE_FILE", "state.json"))
TICK_SEC = 10
SENSOR_TIMEOUT_SEC = int(os.environ.get("THERMOSTAT_SENSOR_TIMEOUT_SEC", "1800"))  # 30 min

DEFAULT_CONFIG = {
    "preset_temps": {"frost": 7.0, "eco": 16.0, "comfort": 22.0, "boost": 24.0},
    "coef_int": 0.6,
    "coef_ext": 0.01,
    "cycle_sec": 300,
    "boost_default_min": 30,
    "min_temp_c": 5.0,
    "max_temp_c": 27.0,
    "window_drop_c": 1.5,
    "window_drop_min": 5,
    "preheat_min": 30,
}
PRESET_SET = {"frost", "eco", "comfort", "boost", "off"}


# ─── Helpers : modèle de planning v2 « langage prof » ────────────────────
# Voir le miroir TypeScript dans src/lib/utils/planning-derive.ts. On ne stocke
# QUE l'heure du 1er cours par jour ; la chauffe est dérivée (réveil = 1er − 1h30).
def _uuid():
    return uuid.uuid4().hex


def _to_min(hhmm):
    try:
        h, m = str(hhmm).split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return 0


def _hhmm_ok(s):
    return isinstance(s, str) and len(s) == 5 and s[2] == ":" and s[:2].isdigit() and s[3:].isdigit()


def _iso_ok(s):
    return isinstance(s, str) and len(s) == 10 and s[4] == "-" and s[7] == "-"


def _parse_iso(s):
    try:
        y, m, d = str(s).split("-")
        return date(int(y), int(m), int(d))
    except Exception:
        return None


def _iso_monday(d):
    return d - timedelta(days=d.weekday())


_TYPES = {"cours", "reunion", "conseil", "aide", "autre"}


def _default_week():
    return [{"kind": "inherit"} for _ in range(5)] + [{"kind": "rest"}, {"kind": "rest"}]


def _default_planning():
    return {
        "version": 2,
        "defaultStart": "08:00",
        "abEnabled": False,
        "abAnchorMonday": _iso_monday(datetime.now().date()).isoformat(),
        "abAnchorIsA": True,
        "weekA": _default_week(),
        "weekB": _default_week(),
        "comfort": {"wakeBeforeFirstMin": 90, "departBeforeFirstMin": 15},
        "eveningShower": {"enabled": False, "targetReady": "19:30", "days": [0, 1, 2, 3, 4]},
        "exceptions": [],
        "assistantPeriods": [],
    }


def _norm_day_morning(v):
    if isinstance(v, dict):
        k = v.get("kind")
        if k == "start" and _hhmm_ok(v.get("start")):
            day = {"kind": "start", "start": v["start"]}
            if v.get("halfGroup") is True:
                day["halfGroup"] = True
            return day
        if k in ("afternoon", "rest", "inherit"):
            return {"kind": k}
    return {"kind": "inherit"}


def _norm_week(v):
    base = _default_week()
    if isinstance(v, list):
        for i in range(7):
            if i < len(v):
                base[i] = _norm_day_morning(v[i])
    return base


def _norm_exception(e):
    if not isinstance(e, dict) or not _iso_ok(e.get("date")):
        return None
    affects = e.get("affectsMorning") is True
    out = {
        "id": e["id"] if isinstance(e.get("id"), str) and e["id"] else _uuid(),
        "date": e["date"],
        "type": e["type"] if e.get("type") in _TYPES else "autre",
        "affectsMorning": affects,
    }
    if isinstance(e.get("label"), str) and e["label"]:
        out["label"] = e["label"]
    if affects:
        m = e.get("morning") or {}
        if m.get("kind") == "start" and _hhmm_ok(m.get("start")):
            out["morning"] = {"kind": "start", "start": m["start"]}
        else:
            out["morning"] = {"kind": "rest"}
    elif _hhmm_ok(e.get("time")):
        out["time"] = e["time"]
    return out


def _norm_assistant(a):
    if not isinstance(a, dict) or not _iso_ok(a.get("from")) or not _iso_ok(a.get("to")):
        return None
    out = {
        "id": a["id"] if isinstance(a.get("id"), str) and a["id"] else _uuid(),
        "from": a["from"],
        "to": a["to"],
    }
    if isinstance(a.get("label"), str) and a["label"]:
        out["label"] = a["label"]
    return out


def _migrate_v1(o):
    """Ancien format {week:[[{start,end}…]×7], exceptions:[{date,slots}]} → v2.
    Lossy assumé : un jour → heure de début la plus tôt ; jour vide → inherit."""
    base = _default_planning()
    week = o.get("week") if isinstance(o.get("week"), list) else []
    starts = []
    wk = _default_week()
    for i in range(7):
        slots = week[i] if i < len(week) and isinstance(week[i], list) else []
        valid = sorted(s["start"] for s in slots if isinstance(s, dict) and _hhmm_ok(s.get("start")))
        if valid:
            wk[i] = {"kind": "start", "start": valid[0]}
            starts.append(_to_min(valid[0]))
    base["weekA"] = wk
    if starts:
        mn = min(starts)
        base["defaultStart"] = f"{mn // 60:02d}:{mn % 60:02d}"
    out_ex = []
    for e in o.get("exceptions") if isinstance(o.get("exceptions"), list) else []:
        if not isinstance(e, dict) or not _iso_ok(e.get("date")):
            continue
        slots = e.get("slots") if isinstance(e.get("slots"), list) else []
        valid = sorted(s["start"] for s in slots if isinstance(s, dict) and _hhmm_ok(s.get("start")))
        out_ex.append(
            {
                "id": _uuid(),
                "date": e["date"],
                "type": "autre",
                "affectsMorning": True,
                "morning": {"kind": "start", "start": valid[0]} if valid else {"kind": "rest"},
            }
        )
    base["exceptions"] = out_ex
    return base


def _normalize_planning(p):
    """Normalise vers le modèle v2 (migre depuis v1 si besoin)."""
    if not isinstance(p, dict):
        return _default_planning()
    if p.get("version") != 2:
        if isinstance(p.get("week"), list) or isinstance(p.get("exceptions"), list):
            return _migrate_v1(p)
        return _default_planning()
    base = _default_planning()
    comfort = p.get("comfort") if isinstance(p.get("comfort"), dict) else {}
    es = p.get("eveningShower") if isinstance(p.get("eveningShower"), dict) else {}
    days = es.get("days") if isinstance(es.get("days"), list) else [0, 1, 2, 3, 4]
    return {
        "version": 2,
        "defaultStart": p["defaultStart"] if _hhmm_ok(p.get("defaultStart")) else "08:00",
        "abEnabled": p.get("abEnabled") is True,
        "abAnchorMonday": p["abAnchorMonday"] if _iso_ok(p.get("abAnchorMonday")) else base["abAnchorMonday"],
        "abAnchorIsA": p.get("abAnchorIsA") is not False,
        "weekA": _norm_week(p.get("weekA")),
        "weekB": _norm_week(p.get("weekB")),
        "comfort": {
            "wakeBeforeFirstMin": int(comfort["wakeBeforeFirstMin"])
            if isinstance(comfort.get("wakeBeforeFirstMin"), (int, float))
            else 90,
            "departBeforeFirstMin": int(comfort["departBeforeFirstMin"])
            if isinstance(comfort.get("departBeforeFirstMin"), (int, float))
            else 15,
        },
        "eveningShower": {
            "enabled": es.get("enabled") is True,
            "targetReady": es["targetReady"] if _hhmm_ok(es.get("targetReady")) else "19:30",
            "days": [d for d in days if isinstance(d, int) and 0 <= d <= 6],
        },
        "exceptions": sorted(
            [x for x in (_norm_exception(e) for e in (p.get("exceptions") or [])) if x],
            key=lambda e: e["date"],
        ),
        "assistantPeriods": [
            x for x in (_norm_assistant(a) for a in (p.get("assistantPeriods") or [])) if x
        ],
    }


def _ab_letter_for(date_obj, plan):
    """Lettre de semaine (A|B) pour une date, d'après l'ancre de parité éditable."""
    if not plan.get("abEnabled"):
        return "A"
    anchor = _parse_iso(plan.get("abAnchorMonday"))
    if anchor is None:
        return "A"
    weeks = round((_iso_monday(date_obj) - _iso_monday(anchor)).days / 7)
    same_par = (weeks % 2) == 0
    anchor_is_a = plan.get("abAnchorIsA", True)
    is_a = anchor_is_a if same_par else not anchor_is_a
    return "A" if is_a else "B"


def _morning_for(date_obj, plan):
    """Matin effectif d'une date : exception datée > semaine A|B > rythme habituel."""
    iso = date_obj.isoformat()
    for exc in plan.get("exceptions", []):
        if exc.get("date") == iso:
            if not exc.get("affectsMorning"):
                return {"kind": "rest"}
            m = exc.get("morning") or {}
            if m.get("kind") == "start" and _hhmm_ok(m.get("start")):
                return {"kind": "start", "start": m["start"]}
            return {"kind": "rest"}
    letter = _ab_letter_for(date_obj, plan)
    week = plan.get("weekA" if letter == "A" else "weekB", [])
    wd = date_obj.weekday()
    day = week[wd] if 0 <= wd < len(week) else {"kind": "inherit"}
    k = day.get("kind")
    if k == "rest":
        return {"kind": "rest"}
    if k == "afternoon":
        return {"kind": "afternoon"}
    if k == "start" and _hhmm_ok(day.get("start")):
        return {"kind": "start", "start": day["start"]}
    return {"kind": "start", "start": plan.get("defaultStart", "08:00")}


# ─── Sondes (MQTT) ───────────────────────────────────────────────────────
class Sensors:
    def __init__(self):
        self.room_temp = None
        self.room_temp_ts = 0.0
        self.humidity = None
        self.outdoor_temp = None
        self.outdoor_ts = 0.0
        self._history = []  # [(ts, temp)] récent, pour la détection fenêtre

    def update_room(self, payload):
        t = payload.get("temperature")
        if isinstance(t, (int, float)):
            self.room_temp = float(t)
            self.room_temp_ts = time.time()
            self._history.append((self.room_temp_ts, self.room_temp))
            cutoff = self.room_temp_ts - 3600
            self._history = [(ts, v) for ts, v in self._history if ts >= cutoff]
        h = payload.get("humidity")
        if isinstance(h, (int, float)):
            self.humidity = float(h)

    def update_outdoor(self, payload):
        t = payload.get("temperature")
        if isinstance(t, (int, float)):
            self.outdoor_temp = float(t)
            self.outdoor_ts = time.time()

    def window_open(self, drop_c, drop_min):
        """Chute >= drop_c sur les drop_min dernières minutes = fenêtre ouverte."""
        if self.room_temp is None:
            return False
        window = time.time() - drop_min * 60
        recent = [v for ts, v in self._history if ts >= window]
        if len(recent) < 2:
            return False
        return (max(recent) - self.room_temp) >= drop_c


def start_mqtt(sensors):
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        transport="websockets" if MQTT_TRANSPORT == "websockets" else "tcp",
    )
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)

    def on_connect(c, userdata, flags, reason_code, properties=None):
        c.subscribe(SENSOR_TOPIC)
        c.subscribe(OUTDOOR_TOPIC)

    def on_message(c, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
        except Exception:
            return
        if msg.topic == SENSOR_TOPIC:
            sensors.update_room(payload)
        elif msg.topic == OUTDOOR_TOPIC:
            sensors.update_outdoor(payload)

    client.on_connect = on_connect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
    return client


# ─── Lien Matter (WebSocket python-matter-server) ────────────────────────
class MatterLink:
    """Client minimal : start_listening, parse node OnOff, device_command On/Off."""

    def __init__(self, url, node_id):
        self.url = url
        self.node_id = node_id
        self.connected = False
        self.switch_on = None
        self.available = False
        self._ws = None
        self._msg_id = 0
        self._cmd_of = {}

    async def run(self):
        while True:
            try:
                async with websockets.connect(self.url, max_size=None, open_timeout=10) as ws:
                    self._ws = ws
                    self.connected = True
                    await self._send("start_listening")
                    async for raw in ws:
                        await self._handle(raw)
            except Exception:
                pass
            self.connected = False
            self.available = False
            self._ws = None
            await asyncio.sleep(3)

    async def _send(self, command, args=None):
        if self._ws is None:
            return
        self._msg_id += 1
        mid = str(self._msg_id)
        self._cmd_of[mid] = command
        msg = {"message_id": mid, "command": command}
        if args:
            msg["args"] = args
        await self._ws.send(json.dumps(msg))

    async def _handle(self, raw):
        try:
            data = json.loads(raw)
        except Exception:
            return
        mid = data.get("message_id")
        if mid is not None:
            cmd = self._cmd_of.pop(mid, None)
            if cmd in ("start_listening", "get_nodes") and isinstance(data.get("result"), list):
                self._parse_nodes(data["result"])
            return
        if data.get("event") in ("attribute_updated", "node_updated", "node_added", "node_removed"):
            with contextlib.suppress(Exception):
                await self._send("get_nodes")

    def _parse_nodes(self, nodes):
        for node in nodes:
            if node.get("node_id") == self.node_id:
                self.available = bool(node.get("available"))
                attrs = node.get("attributes") or {}
                val = attrs.get("1/6/0")
                if isinstance(val, bool):
                    self.switch_on = val
                return

    async def set_switch(self, on):
        if self._ws is None:
            return
        with contextlib.suppress(Exception):
            await self._send(
                "device_command",
                {
                    "endpoint_id": 1,
                    "node_id": self.node_id,
                    "cluster_id": 6,
                    "command_name": "On" if on else "Off",
                    "payload": {},
                },
            )
            self.switch_on = on


# ─── Contrôleur (régulation TPI + planning + sécurités) ──────────────────
class Controller:
    def __init__(self, sensors, matter):
        self.sensors = sensors
        self.matter = matter
        self.config = json.loads(json.dumps(DEFAULT_CONFIG))
        self.planning = _default_planning()
        self.mode = "auto"  # auto | manual
        self.manual_preset = "comfort"
        self.override = None  # {"preset": str, "until": ts|None}
        # runtime
        self.active_preset = "eco"
        self.target_temp = None
        self.duty = 0.0
        self.reason = None
        self.next_transition = None
        self.window_open = False
        self.safety = "ok"
        self._desired = False
        self._cycle_start = time.time()
        self._wake = asyncio.Event()
        self.load_state()

    # ── Persistance ──
    def load_state(self):
        try:
            data = json.loads(STATE_FILE.read_text())
        except Exception:
            return
        self.mode = data.get("mode", self.mode)
        self.manual_preset = data.get("manual_preset", self.manual_preset)
        self.override = data.get("override", None)
        if isinstance(data.get("config"), dict):
            self._merge_config(data["config"])
        if isinstance(data.get("planning"), dict):
            self.planning = _normalize_planning(data["planning"])

    def save_state(self):
        payload = {
            "mode": self.mode,
            "manual_preset": self.manual_preset,
            "override": self.override,
            "config": self.config,
            "planning": self.planning,
        }
        try:
            tmp = STATE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2))
            tmp.replace(STATE_FILE)
        except Exception:
            pass

    def _merge_config(self, c):
        pt = c.get("preset_temps")
        if isinstance(pt, dict):
            for k in ("frost", "eco", "comfort", "boost"):
                if isinstance(pt.get(k), (int, float)):
                    self.config["preset_temps"][k] = float(pt[k])
        for k in ("coef_int", "coef_ext", "min_temp_c", "max_temp_c", "window_drop_c"):
            if isinstance(c.get(k), (int, float)):
                self.config[k] = float(c[k])
        for k in ("cycle_sec", "boost_default_min", "window_drop_min", "preheat_min"):
            if isinstance(c.get(k), (int, float)):
                self.config[k] = int(c[k])

    # ── Planning (dérivation v2 : chauffe AVANT le 1er cours, pas pendant) ──
    def _morning_window(self, now_dt):
        """Fenêtre de confort matinale = [réveil, départ] ; réveil = 1er cours − 1h30."""
        plan = self.planning
        m = _morning_for(now_dt.date(), plan)
        if m.get("kind") != "start":
            return None
        comfort = plan.get("comfort", {})
        wake_before = int(comfort.get("wakeBeforeFirstMin", 90))
        depart_before = int(comfort.get("departBeforeFirstMin", 15))
        first = _to_min(m["start"])
        wake = first - wake_before
        # Garde-fou : si le réveil tombe l'après-midi, ce n'est pas un besoin
        # matinal (1re activité = rendez-vous du soir mal classé) → pas de chauffe.
        if wake >= _to_min("12:00"):
            return None
        depart = first - depart_before
        end = depart if depart > wake else wake + 30
        return (wake, end)

    def _evening_window(self, now_dt):
        """Fenêtre douche du soir = [heure cible, +30 min] (préchauffe ajoutée après)."""
        es = self.planning.get("eveningShower", {})
        if not es.get("enabled"):
            return None
        if now_dt.weekday() not in (es.get("days") or []):
            return None
        ready = _to_min(es.get("targetReady", "19:30"))
        return (ready, ready + 30)

    def calendar_overrides(self, now_dt):
        """TODO Phase 4/5 : déduire du calendrier Google (scolaire/fériés/agenda)
        un ajustement (jour d'école, vacances, événement tôt…). Pour l'instant : rien."""
        return None

    def _planning_decision(self, now_dt):
        minutes = now_dt.hour * 60 + now_dt.minute
        preheat = int(self.config.get("preheat_min", 30))
        windows = []
        wm = self._morning_window(now_dt)
        if wm:
            windows.append(("morning", wm))
        we = self._evening_window(now_dt)
        if we:
            windows.append(("evening", we))
        # Confort effectif = [start − préchauffe, end] (le daemon démarre en avance).
        intervals = [(max(0, a - preheat), b, tag) for tag, (a, b) in windows]
        active = next((tag for (a, b, tag) in intervals if a <= minutes < b), None)
        preset = "comfort" if active else "eco"
        if active == "morning":
            reason = "Confort — préparation du matin"
        elif active == "evening":
            reason = "Confort — douche du soir"
        else:
            reason = "Éco — hors fenêtre de confort"
        bounds = []
        for a, b, _tag in intervals:
            bounds.append((a, "comfort"))
            bounds.append((b, "eco"))
        nxt = None
        for mn, p in sorted(bounds):
            if mn > minutes:
                nxt = (mn, p)
                break
        return preset, reason, nxt

    # ── Boucle de régulation ──
    async def run(self):
        while True:
            self._tick()
            await self._apply_switch()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=TICK_SEC)
            self._wake.clear()

    def _tick(self):
        now = time.time()
        now_dt = datetime.now()
        cfg = self.config

        # Expiration de l'override temporaire.
        if self.override and self.override.get("until") and now >= self.override["until"]:
            self.override = None
            self.save_state()

        # Détermination du preset visé.
        self.next_transition = None
        if self.override:
            preset, self.reason = self.override["preset"], "Forçage manuel"
        elif self.mode == "manual":
            preset, self.reason = self.manual_preset, "Mode manuel"
        else:
            preset, self.reason, nxt = self._planning_decision(now_dt)
            if nxt:
                base = now_dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
                self.next_transition = {"at": base + nxt[0] * 60, "preset": nxt[1]}
        self.active_preset = preset

        # Sécurités (priorité absolue).
        room = self.sensors.room_temp
        sensor_age = now - self.sensors.room_temp_ts if self.sensors.room_temp_ts else 1e9
        if room is None or sensor_age > SENSOR_TIMEOUT_SEC:
            self.safety, self.target_temp, self.duty, self._desired = "sensor_lost", None, 0.0, False
            return
        if room >= cfg["max_temp_c"]:
            self.safety = "over_max"
            self.target_temp = cfg["preset_temps"].get(preset)
            self.duty, self._desired = 0.0, False
            return
        if self.sensors.window_open(cfg["window_drop_c"], cfg["window_drop_min"]):
            self.window_open = True
            self.safety = "window_open"
            self.target_temp = cfg["preset_temps"].get(preset)
            self.duty, self._desired = 0.0, False
            return
        self.window_open = False
        self.safety = "ok"

        if preset == "off":
            self.target_temp, self.duty, self._desired = None, 0.0, False
            return

        target = cfg["preset_temps"].get(preset)
        self.target_temp = target
        if target is None:
            self.duty, self._desired = 0.0, False
            return

        # TPI : duty = coef_int·(cible−pièce) + coef_ext·(cible−extérieur), borné [0,1].
        outdoor = self.sensors.outdoor_temp
        ext_term = cfg["coef_ext"] * (target - outdoor) if outdoor is not None else 0.0
        duty = cfg["coef_int"] * (target - room) + ext_term
        duty = max(0.0, min(1.0, duty))
        if room < cfg["min_temp_c"]:  # sécurité basse → chauffe pleine
            duty = 1.0
        self.duty = duty

        # PWM lent : ON sur la fraction `duty` du cycle courant.
        cycle = max(30, int(cfg["cycle_sec"]))
        pos = (now - self._cycle_start) % cycle
        self._desired = pos < duty * cycle

    async def _apply_switch(self):
        if self.matter.switch_on != self._desired:
            await self.matter.set_switch(self._desired)

    # ── Commandes (depuis l'API HTTP) ──
    def apply_command(self, body):
        if not isinstance(body, dict):
            return
        if isinstance(body.get("config"), dict):
            self._merge_config(body["config"])
        if isinstance(body.get("planning"), dict):
            self.planning = _normalize_planning(body["planning"])
        if body.get("clear_override"):
            self.override = None
            self.mode = "auto"
        if body.get("mode") in ("auto", "manual"):
            self.mode = body["mode"]
            if self.mode == "manual" and "preset" not in body:
                self.manual_preset = self.active_preset if self.active_preset in PRESET_SET else "comfort"
        if "boost_minutes" in body:
            mins = body["boost_minutes"] or self.config.get("boost_default_min", 30)
            self.override = {"preset": "boost", "until": time.time() + mins * 60}
        elif body.get("preset") in PRESET_SET:
            p = body["preset"]
            if self.mode == "manual":
                self.manual_preset = p
            else:
                # Override en auto : tient jusqu'à la prochaine transition planifiée.
                _, _, nxt = self._planning_decision(datetime.now())
                until = None
                if nxt:
                    base = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
                    until = base + nxt[0] * 60
                self.override = {"preset": p, "until": until}
        self.save_state()
        self._wake.set()

    def status(self):
        ov = self.override
        return {
            "connected": self.matter.connected,
            "last_update": int(time.time()),
            "room_temp_c": self.sensors.room_temp,
            "humidity": self.sensors.humidity,
            "outdoor_temp_c": self.sensors.outdoor_temp,
            "switch_on": self.matter.switch_on,
            "switch_available": self.matter.available,
            "duty_cycle": round(self.duty, 3),
            "active_preset": self.active_preset,
            "target_temp_c": self.target_temp,
            "mode": self.mode,
            "override": (
                {"preset": ov["preset"], "until": int(ov["until"]) if ov.get("until") else None}
                if ov
                else None
            ),
            "reason": self.reason,
            "next_transition": (
                {"at": int(self.next_transition["at"]), "preset": self.next_transition["preset"]}
                if self.next_transition
                else None
            ),
            "window_open": self.window_open,
            "safety": self.safety,
            "config": self.config,
        }


# ─── Serveur HTTP (loopback) ─────────────────────────────────────────────
def make_app(ctrl):
    app = web.Application()

    async def status(_req):
        return web.json_response(ctrl.status())

    async def command(req):
        try:
            body = await req.json()
        except Exception:
            return web.json_response({"detail": "JSON invalide"}, status=400)
        ctrl.apply_command(body)
        return web.json_response(ctrl.status())

    app.router.add_get("/status", status)
    app.router.add_post("/command", command)
    return app


async def main():
    sensors = Sensors()
    matter = MatterLink(MATTER_WS_URL, MATTER_NODE_ID)
    ctrl = Controller(sensors, matter)

    mqtt_client = start_mqtt(sensors)
    mqtt_client.loop_start()

    runner = web.AppRunner(make_app(ctrl))
    await runner.setup()
    await web.TCPSite(runner, HTTP_HOST, HTTP_PORT).start()
    print(f"thermostat-bridge: HTTP http://{HTTP_HOST}:{HTTP_PORT} · matter {MATTER_WS_URL} · node {MATTER_NODE_ID}")

    await asyncio.gather(matter.run(), ctrl.run())


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
