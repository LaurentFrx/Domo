#!/usr/bin/env python3
"""
IMPORT DE L'HISTORIQUE EDF (ancien contrat Tarif Bleu HP/HC) dans history.db.

POURQUOI.
Enedis ne sert que 36 mois de consommation journalière et 24 mois de courbe de
charge : tout ce qui précède septembre 2023 est hors d'atteinte par l'API. Les
exports CSV de l'espace client EDF (index, consommation quotidienne,
consommation mensuelle) comblent ce passé. Ils sont rangés TELS QUELS dans trois
tables brutes ; tout ce qui en découle (volume d'un mois, ventilation Creuses /
Pleines) se calcule à la lecture, côté Domo (src/lib/server/edf-history.ts).

CE QUE LE SCRIPT GARANTIT.
  · Décodage Windows-1252 — l'export n'est PAS en UTF-8 : un fichier ré-encodé
    échoue au lieu d'importer du texte corrompu. Séparateur « ; », dates
    JJ/MM/AAAA, préambule sauté, sous-totaux « Année AAAA » ignorés. Chaque
    fichier est reconnu à son en-tête, pas à son nom.
  · Nature conservée ('reelle' / 'estimee') : une estimation ne sera jamais
    présentée comme une mesure. Seuls les index « transmis par le
    distributeur » (des mesures) sont acceptés.
  · Un doublon identique est dédupliqué ; un doublon DIVERGENT fait échouer
    l'import avant toute écriture.
  · Une seule transaction (BEGIN IMMEDIATE, busy_timeout 30 s : le recorder
    écrit toutes les 30 s). Idempotent : relancer ne change rien, et une ligne
    déjà en base qui diffère du fichier fait tout échouer, sans rien écrire.
  · N'écrit QUE dans edf_index, edf_monthly et edf_daily. Retour arrière :
    DROP TABLE de ces trois tables.

Usage :
    ops/import-edf-history.py <dossier des CSV> [--db history.db] [--dry-run]
La base vient de --db, sinon de la variable RECORDER_DB_PATH. Aucun chemin en
dur : les exports contiennent des données personnelles et restent hors dépôt.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sqlite3
import sys
from datetime import date

SOURCE = "edf-trv-export"

# Première colonne de l'en-tête → type de fichier (comparaison en minuscules).
EN_TETES = {
    "date de relevé de l'index": "index",
    "date de consommation": "daily",
    "période de consommation": "monthly",
}

NATURES = {"réelle": "reelle", "estimée": "estimee"}

TYPE_INDEX_MESURE = "index transmis par le distributeur"

DDL = {
    "edf_index": """
CREATE TABLE IF NOT EXISTS edf_index (
  date TEXT PRIMARY KEY,                 -- 'YYYY-MM-DD' : index lu en DÉBUT de ce jour
  hp_kwh INTEGER NOT NULL,               -- registre cumulé Heures Pleines
  hc_kwh INTEGER NOT NULL,               -- registre cumulé Heures Creuses
  source TEXT NOT NULL
)""",
    "edf_monthly": """
CREATE TABLE IF NOT EXISTS edf_monthly (
  month TEXT PRIMARY KEY,                -- 'YYYY-MM'
  kwh REAL NOT NULL,
  nature TEXT NOT NULL CHECK (nature IN ('reelle', 'estimee')),
  source TEXT NOT NULL
)""",
    "edf_daily": """
CREATE TABLE IF NOT EXISTS edf_daily (
  date TEXT PRIMARY KEY,                 -- 'YYYY-MM-DD'
  kwh INTEGER NOT NULL,
  nature TEXT NOT NULL,
  source TEXT NOT NULL
)""",
}

COLONNES = {
    "edf_index": ["date", "hp_kwh", "hc_kwh", "source"],
    "edf_monthly": ["month", "kwh", "nature", "source"],
    "edf_daily": ["date", "kwh", "nature", "source"],
}

TABLE_DU_TYPE = {"index": "edf_index", "monthly": "edf_monthly", "daily": "edf_daily"}


class ImportErreur(Exception):
    """Refus d'importer : le message dit quoi et où. Rien n'a été écrit."""


def _sans_espaces(s: str) -> str:
    # Séparateur de milliers : espace, insécable ou fine insécable (« 4 660 »).
    return s.replace("\u00a0", "").replace("\u202f", "").replace(" ", "")


def _entier(s: str, ctx: str) -> int:
    t = _sans_espaces(s)
    if not re.fullmatch(r"\d+", t):
        raise ImportErreur(f"{ctx} : entier attendu, lu {s!r}")
    return int(t)


def _reel(s: str, ctx: str) -> float:
    t = _sans_espaces(s).replace(",", ".")
    if not re.fullmatch(r"\d+(\.\d+)?", t):
        raise ImportErreur(f"{ctx} : nombre attendu, lu {s!r}")
    return float(t)


def _jour(s: str, ctx: str) -> str:
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", s.strip())
    if not m:
        raise ImportErreur(f"{ctx} : date JJ/MM/AAAA attendue, lu {s!r}")
    try:
        return date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    except ValueError:
        raise ImportErreur(f"{ctx} : date impossible {s!r}") from None


def _mois(s: str, ctx: str) -> str:
    m = re.fullmatch(r"(\d{2})/(\d{4})", s.strip())
    if not m or not 1 <= int(m[1]) <= 12:
        raise ImportErreur(f"{ctx} : mois MM/AAAA attendu, lu {s!r}")
    return f"{m[2]}-{m[1]}"


def _nature(s: str, ctx: str) -> str:
    n = NATURES.get(s.strip().lower())
    if n is None:
        raise ImportErreur(f"{ctx} : nature inconnue {s!r} (attendu : Réelle ou Estimée)")
    return n


def lire_csv(chemin: pathlib.Path) -> tuple[str, list[list[str]]]:
    """(type, lignes de données découpées) — préambule et lignes vides ôtés."""
    try:
        texte = chemin.read_bytes().decode("cp1252")
    except UnicodeDecodeError as e:
        raise ImportErreur(f"{chemin.name} : octets hors Windows-1252 ({e})") from None
    lignes = [l.rstrip("\r") for l in texte.split("\n")]
    # L'en-tête est la première ligne à « ; » ; le préambule (titre) n'en a aucun.
    i = next((k for k, l in enumerate(lignes) if ";" in l), None)
    if i is None:
        raise ImportErreur(f"{chemin.name} : aucune ligne à « ; » — pas un export EDF")
    premiere = lignes[i].split(";")[0].strip().lower()
    genre = EN_TETES.get(premiere)
    if genre is None:
        indice = " (UTF-8 lu comme Windows-1252 ? l'export d'origine est en Windows-1252)"
        raise ImportErreur(
            f"{chemin.name} : en-tête inconnu {lignes[i]!r}" + (indice if "Ã" in texte else "")
        )
    donnees = [[c.strip() for c in l.split(";")] for l in lignes[i + 1 :] if l.strip()]
    return genre, donnees


def _ranger(dico: dict, cle: str, valeur: tuple, ctx: str) -> int:
    """Ajoute cle → valeur ; 1 si c'était un doublon identique, 0 sinon."""
    if cle in dico:
        if dico[cle] != valeur:
            raise ImportErreur(f"{ctx} : doublon DIVERGENT pour {cle} : {dico[cle]} ≠ {valeur}")
        return 1
    dico[cle] = valeur
    return 0


def lire_dossier(dossier: pathlib.Path) -> dict:
    """Lit et valide les trois exports ; lève ImportErreur au moindre doute."""
    fichiers = sorted(p for p in dossier.iterdir() if p.is_file() and p.suffix.lower() == ".csv")
    trouves: dict[str, pathlib.Path] = {}
    for p in fichiers:
        genre, _ = lire_csv(p)
        if genre in trouves:
            raise ImportErreur(
                f"deux exports du même type ({genre}) : {trouves[genre].name}, {p.name}"
            )
        trouves[genre] = p
    manquants = sorted(set(TABLE_DU_TYPE) - set(trouves))
    if manquants:
        raise ImportErreur(f"export(s) manquant(s) dans {dossier} : {', '.join(manquants)}")

    out: dict = {"doublons": {}, "sous_totaux": 0}

    # ── Index cumulés HP / HC ──
    _, lignes = lire_csv(trouves["index"])
    index: dict[str, tuple] = {}
    doublons = 0
    for n, c in enumerate(lignes, 1):
        ctx = f"{trouves['index'].name}, ligne de données {n}"
        if len(c) < 4:
            raise ImportErreur(f"{ctx} : 4 colonnes attendues, lu {c}")
        if c[1].strip().lower() != TYPE_INDEX_MESURE:
            raise ImportErreur(
                f"{ctx} : type d'index {c[1]!r} — seuls les index transmis par le distributeur"
                " (des mesures) sont importés"
            )
        valeur = (_entier(c[2], ctx), _entier(c[3], ctx))
        doublons += _ranger(index, _jour(c[0], ctx), valeur, ctx)
    jours = sorted(index)
    for a, b in zip(jours, jours[1:]):
        if index[b][0] < index[a][0] or index[b][1] < index[a][1]:
            raise ImportErreur(f"index non monotone entre {a} {index[a]} et {b} {index[b]}")
    out["index"] = index
    out["doublons"]["index"] = doublons

    # ── Consommation quotidienne ──
    _, lignes = lire_csv(trouves["daily"])
    quot: dict[str, tuple] = {}
    doublons = 0
    for n, c in enumerate(lignes, 1):
        ctx = f"{trouves['daily'].name}, ligne de données {n}"
        if len(c) < 3:
            raise ImportErreur(f"{ctx} : 3 colonnes attendues, lu {c}")
        valeur = (_entier(c[1], ctx), _nature(c[2], ctx))
        doublons += _ranger(quot, _jour(c[0], ctx), valeur, ctx)
    out["daily"] = quot
    out["doublons"]["daily"] = doublons

    # ── Consommation mensuelle (les lignes « Année AAAA » sont des sous-totaux) ──
    _, lignes = lire_csv(trouves["monthly"])
    mens: dict[str, tuple] = {}
    doublons = 0
    for n, c in enumerate(lignes, 1):
        ctx = f"{trouves['monthly'].name}, ligne de données {n}"
        if c[0].lower().startswith("année"):
            out["sous_totaux"] += 1
            continue
        if len(c) < 3:
            raise ImportErreur(f"{ctx} : 3 colonnes attendues, lu {c}")
        valeur = (_reel(c[1], ctx), _nature(c[2], ctx))
        doublons += _ranger(mens, _mois(c[0], ctx), valeur, ctx)
    out["monthly"] = mens
    out["doublons"]["monthly"] = doublons
    return out


def _lignes_table(lu: dict) -> dict[str, dict[str, tuple]]:
    """Clé primaire → ligne complète, telle qu'elle doit exister en base."""
    return {
        "edf_index": {d: (d, hp, hc, SOURCE) for d, (hp, hc) in lu["index"].items()},
        "edf_monthly": {m: (m, kwh, nat, SOURCE) for m, (kwh, nat) in lu["monthly"].items()},
        "edf_daily": {d: (d, kwh, nat, SOURCE) for d, (kwh, nat) in lu["daily"].items()},
    }


def importer(lu: dict, db: pathlib.Path) -> dict[str, dict[str, int]]:
    """Écrit les trois tables en UNE transaction ; retourne les compteurs par table."""
    if not db.is_file():
        raise ImportErreur(f"base introuvable : {db}")
    # mode=rw : ne JAMAIS créer une base vide si le chemin est faux.
    uri = f"{db.resolve().as_uri()}?mode=rw"
    con = sqlite3.connect(uri, uri=True, timeout=30, isolation_level=None)
    try:
        con.execute("PRAGMA busy_timeout = 30000")
        con.execute("BEGIN IMMEDIATE")
        try:
            bilan = {}
            for table, lignes in _lignes_table(lu).items():
                con.execute(DDL[table])
                cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})")]
                if cols != COLONNES[table]:
                    raise ImportErreur(f"{table} existe déjà avec d'autres colonnes : {cols}")
                existant = {r[0]: tuple(r) for r in con.execute(f"SELECT * FROM {table}")}
                inserees = identiques = 0
                for cle, ligne in sorted(lignes.items()):
                    if cle in existant:
                        if existant[cle] != ligne:
                            raise ImportErreur(
                                f"{table} : {cle} déjà en base avec {existant[cle]},"
                                f" le fichier dit {ligne}"
                            )
                        identiques += 1
                        continue
                    trous = ", ".join("?" * len(ligne))
                    con.execute(f"INSERT INTO {table} VALUES ({trous})", ligne)
                    inserees += 1
                bilan[table] = {
                    "inserees": inserees,
                    "identiques": identiques,
                    "hors_fichier": len(set(existant) - set(lignes)),
                }
            con.execute("COMMIT")
            return bilan
        except BaseException:
            # Un COMMIT raté a déjà tout annulé : pas de second ROLLBACK qui
            # masquerait l'erreur d'origine.
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
    finally:
        con.close()


def _compte(d: dict[str, int]) -> str:
    return ", ".join(f"{v} {k}" for k, v in sorted(d.items()))


def resume(lu: dict) -> str:
    idx, mens, quot = lu["index"], lu["monthly"], lu["daily"]
    jours = sorted(idx)
    natm: dict[str, int] = {}
    for _, nat in mens.values():
        natm[nat] = natm.get(nat, 0) + 1
    natq: dict[str, int] = {}
    for _, nat in quot.values():
        natq[nat] = natq.get(nat, 0) + 1
    dernier = idx[jours[-1]]
    somme_m = sum(k for k, _ in mens.values())
    somme_q = sum(k for k, _ in quot.values())
    return "\n".join(
        [
            f"edf_index   : {len(idx)} dates ({lu['doublons']['index']} doublon(s) identique(s)"
            f" écarté(s)) du {jours[0]} au {jours[-1]} — dernier HP {dernier[0]} / HC {dernier[1]}",
            f"edf_monthly : {len(mens)} mois ({_compte(natm)} ; {lu['sous_totaux']} sous-totaux"
            f" ignorés) de {min(mens)} à {max(mens)} — somme {somme_m:g} kWh",
            f"edf_daily   : {len(quot)} jours ({_compte(natq)}) du {min(quot)} au {max(quot)}"
            f" — somme {somme_q} kWh",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Importe les exports CSV EDF (Tarif Bleu) dans history.db."
    )
    ap.add_argument("dossier", type=pathlib.Path, help="dossier contenant les 3 exports CSV")
    ap.add_argument(
        "--db", type=pathlib.Path, default=None, help="history.db (défaut : $RECORDER_DB_PATH)"
    )
    ap.add_argument("--dry-run", action="store_true", help="lire et contrôler sans rien écrire")
    args = ap.parse_args(argv)
    try:
        lu = lire_dossier(args.dossier)
        print(resume(lu))
        if args.dry_run:
            print("--dry-run : rien n'a été écrit.")
            return 0
        env = os.environ.get("RECORDER_DB_PATH")
        db = args.db or (pathlib.Path(env) if env else None)
        if db is None:
            raise ImportErreur("base non précisée : --db ou RECORDER_DB_PATH")
        for table, b in importer(lu, db).items():
            print(
                f"{table:11} : {b['inserees']} insérée(s), {b['identiques']} déjà identique(s)"
                f", {b['hors_fichier']} en base hors de ces fichiers"
            )
        return 0
    except ImportErreur as e:
        print(f"ÉCHEC — rien n'a été écrit : {e}", file=sys.stderr)
        return 1
    except sqlite3.Error as e:
        print(f"ÉCHEC SQLite — transaction annulée, rien n'a été écrit : {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
