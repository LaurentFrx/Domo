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
from datetime import datetime
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


# ─── Helpers ─────────────────────────────────────────────────────────────
def _to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _valid_slot(s):
    return (
        isinstance(s, dict)
        and isinstance(s.get("start"), str)
        and isinstance(s.get("end"), str)
    )


def _normalize_planning(p):
    """Garantit la forme {week: 7×[slots], exceptions: [...]} avec créneaux valides."""
    week_raw = p.get("week") if isinstance(p, dict) else None
    week = []
    for i in range(7):
        day = week_raw[i] if isinstance(week_raw, list) and i < len(week_raw) else []
        week.append([s for s in day if _valid_slot(s)] if isinstance(day, list) else [])
    ex_raw = p.get("exceptions") if isinstance(p, dict) else None
    exceptions = []
    if isinstance(ex_raw, list):
        for e in ex_raw:
            if isinstance(e, dict) and isinstance(e.get("date"), str):
                slots = e.get("slots") or []
                exceptions.append(
                    {"date": e["date"], "slots": [s for s in slots if _valid_slot(s)]}
                )
    return {"week": week, "exceptions": exceptions}


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
        self.planning = {"week": [[] for _ in range(7)], "exceptions": []}
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

    # ── Planning ──
    def _slots_for(self, now_dt):
        iso = now_dt.strftime("%Y-%m-%d")
        for exc in self.planning.get("exceptions", []):
            if exc.get("date") == iso:
                return exc.get("slots", [])
        week = self.planning.get("week", [])
        wd = now_dt.weekday()  # 0 = lundi
        return week[wd] if 0 <= wd < len(week) else []

    def _comfort_intervals(self, now_dt):
        preheat = int(self.config.get("preheat_min", 30))
        intervals = []
        for s in self._slots_for(now_dt):
            try:
                a = max(0, _to_min(s["start"]) - preheat)
                b = _to_min(s["end"])
            except Exception:
                continue
            if b > a:
                intervals.append((a, b))
        return sorted(intervals)

    def calendar_overrides(self, now_dt):
        """TODO Phase 4/5 : déduire du calendrier Google (scolaire/fériés/agenda)
        un ajustement des créneaux (jour d'école, vacances, événement tôt…).
        Pour l'instant : aucun ajustement."""
        return None

    def _planning_decision(self, now_dt):
        minutes = now_dt.hour * 60 + now_dt.minute
        intervals = self._comfort_intervals(now_dt)
        in_comfort = any(a <= minutes < b for a, b in intervals)
        preset = "comfort" if in_comfort else "eco"
        bounds = []
        for a, b in intervals:
            bounds.append((a, "comfort"))
            bounds.append((b, "eco"))
        nxt = None
        for m, p in sorted(bounds):
            if m > minutes:
                nxt = (m, p)
                break
        reason = "Confort — occupation prévue" if in_comfort else "Éco — pas d'occupation prévue"
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
