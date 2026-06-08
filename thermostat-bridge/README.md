# thermostat-bridge — daemon de régulation du sèche-serviette (SdB)

Daemon 24/7 qui régule le sèche-serviette de la salle de bain (switch **Matter
node 1**) en PWM lent (**TPI**) selon la sonde Zigbee **« Thermo SdB »**, des
**presets** (hors-gel / éco / confort / boost) et un **planning d'occupation**.
Expose une API HTTP loopback consommée par Domo (`/api/thermostat/*`).

> **À déployer sur le RPi4** (près de matter-server + mosquitto), comme les
> bridges forecast/apsystems. Le code vit ici dans le repo pour être versionné ;
> il **ne tourne pas** sur le VPS. Voir aussi `../docs/chauffage-sdb.md`.

## ⚠️ Prérequis physique

Régler le **thermostat de l'appareil au MAXIMUM**. Le daemon régule par coupure
d'alimentation (le Sonoff node 1) ; si le thermostat interne coupe avant la
consigne, il « combat » la régulation.

## Installation (RPi4)

```bash
cd ~/thermostat-bridge          # copier ce dossier sur le RPi4
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env            # puis éditer (cf. tableau ci-dessous)
.venv/bin/python thermostat_bridge.py   # test au premier plan
```

## Configuration (.env)

| Variable | Défaut | Rôle |
|---|---|---|
| `THERMOSTAT_HTTP_PORT` | `8101` | Port loopback HTTP (status/command) |
| `MATTER_WS_URL` | `ws://192.168.1.29:5580/ws` | WebSocket python-matter-server |
| `MATTER_NODE_ID` | `1` | Node du sèche-serviette |
| `MQTT_HOST` / `MQTT_PORT` | `127.0.0.1` / `1883` | Broker mosquitto (local RPi4) |
| `MQTT_TRANSPORT` | `tcp` | `tcp`, ou `websockets` (port 9001) |
| `MQTT_USER` / `MQTT_PASSWORD` | — | Identifiants mosquitto (`ha_user`) |
| `THERMOSTAT_SENSOR_TOPIC` | `zigbee2mqtt/Thermo SdB` | Sonde SdB (temp + humidité) |
| `THERMOSTAT_OUTDOOR_TOPIC` | `zigbee2mqtt/Thermo_ext` | Sonde extérieure (terme coef_ext) |

## Service systemd

Adapter user/chemins dans `thermostat-bridge.service` puis :

```bash
sudo cp thermostat-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thermostat-bridge
```

## Tunnel vers le VPS

Le daemon écoute en loopback sur le RPi4. Pour que Domo (VPS) le lise, exposer le
port via un tunnel SSH inverse (même modèle que `tunnel-8100.sh` d'apsystems) :

```bash
chmod +x tunnel-8101.sh
# crontab -e :
# @reboot /home/pi/thermostat-bridge/tunnel-8101.sh >> /tmp/tunnel-8101.log 2>&1
```

## Côté Domo (VPS)

Ajouter au `.env` de Domo puis rebuild + restart (`sudo systemctl restart domo`) :

```
THERMOSTAT_BRIDGE_URL=http://127.0.0.1:8101
```

La carte (`/climat`) et la section Réglages s'animeront. Sans cette ligne, le
thermostat reste affiché « hors ligne » (dégradé propre, aucune erreur).

## API

- `GET /status` → état complet : `room_temp_c`, `active_preset`, `target_temp_c`,
  `duty_cycle`, `switch_on`, `mode`, `override`, `reason`, `next_transition`,
  `window_open`, `safety`, `config`…
- `POST /command` `{mode?, preset?, boost_minutes?, clear_override?, config?, planning?}`
  → applique puis renvoie le `status`.

Domo pousse `config` (presets/coefs, depuis Réglages) et `planning` (page Planning
d'Isabelle) via `/command` ; le daemon les persiste dans `state.json`.

## Régulation (TPI)

À chaque cycle (`cycle_sec`, défaut 300 s), puissance appelée :

```
duty = clamp01( coef_int·(cible − T_pièce) + coef_ext·(cible − T_ext) )
```

Le switch est ON sur la fraction `duty` du cycle. Sécurités prioritaires : sonde
muette (`sensor_lost` → coupe), `T_pièce ≥ max` (`over_max`), chute rapide
(`window_open`), plancher `min_temp_c` (chauffe pleine).

## Roadmap (cf. `../docs/chauffage-sdb.md`)

- ✅ **Phase 1** : TPI + presets + manuel/auto + planning d'occupation + sécurités.
- ⏳ **Phase 4/5** : calendrier Google (scolaire zone A / fériés / agenda) — point
  d'entrée `calendar_overrides()` dans `thermostat_bridge.py`.
