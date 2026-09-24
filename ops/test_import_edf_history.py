"""
Tests de ops/import-edf-history.py — fixtures SYNTHÉTIQUES uniquement : le dépôt
est public, les vrais exports EDF n'y entrent jamais.

    python3 -m unittest ops/test_import_edf_history.py

Ce qu'ils protègent : un export décodé de travers, un sous-total compté comme un
mois, un doublon qui se contredit, ou une ligne déjà en base réécrite en silence
fausseraient pour toujours l'historique affiché sur la page Énergie.
"""

import importlib.util
import pathlib
import sqlite3
import tempfile
import unittest

ICI = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("import_edf_history", ICI / "import-edf-history.py")
edf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(edf)

INDEX = """
Récapitulatif de mes index

Date de relevé de l'index;Type d'index;Index Heures pleines (kWh);Index Heures creuses (kWh)
03/01/2001;Index transmis par le distributeur;1010;520
02/01/2001;Index transmis par le distributeur;1004;517
02/01/2001;Index transmis par le distributeur;1004;517
01/01/2001;Index transmis par le distributeur;1000;515
01/11/2000;Index transmis par le distributeur;900;460

"""

QUOTIDIEN = """
Récapitulatif de ma consommation

Date de consommation;Consommation (kWh);Nature de la donnée
02/01/2001;9;Réelle
01/01/2001;7;Réelle

"""

MENSUEL = """
Récapitulatif de ma consommation

Période de consommation;Consommation (kWh);Nature de la donnée

Année 2001;1 016;
01/2001;1016;Réelle
Année 2000;2\u00a0345;
12/2000;1300;Estimée
11/2000;1045;Estimée

"""


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._tmp.name)
        self.dossier = self.tmp / "exports"
        self.dossier.mkdir()
        self.db = self.tmp / "history.db"
        con = sqlite3.connect(self.db)
        # Une table étrangère à l'import : elle doit sortir intacte.
        con.execute("CREATE TABLE enedis_daily (date TEXT PRIMARY KEY, soutirage_kwh REAL)")
        con.execute("INSERT INTO enedis_daily VALUES ('2001-01-01', 7.2)")
        con.commit()
        con.close()

    def tearDown(self):
        self._tmp.cleanup()

    def ecrire(self, index=INDEX, quotidien=QUOTIDIEN, mensuel=MENSUEL, encodage="cp1252"):
        # Noms quelconques : chaque export est reconnu à son en-tête.
        (self.dossier / "a.csv").write_bytes(index.encode(encodage))
        (self.dossier / "b.csv").write_bytes(quotidien.encode(encodage))
        (self.dossier / "c.csv").write_bytes(mensuel.encode(encodage))

    def dump(self):
        con = sqlite3.connect(self.db)
        try:
            return list(con.iterdump())
        finally:
            con.close()

    def tables(self):
        con = sqlite3.connect(self.db)
        try:
            return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            con.close()


class Lecture(Base):
    def test_cp1252_sous_totaux_et_doublon_identique(self):
        self.ecrire()
        lu = edf.lire_dossier(self.dossier)
        self.assertEqual(
            lu["index"],
            {
                "2000-11-01": (900, 460),
                "2001-01-01": (1000, 515),
                "2001-01-02": (1004, 517),
                "2001-01-03": (1010, 520),
            },
        )
        self.assertEqual(lu["doublons"]["index"], 1)
        # Les lignes « Année » (séparateur de milliers espace ou insécable) sont
        # des sous-totaux : jamais un mois.
        self.assertEqual(lu["sous_totaux"], 2)
        self.assertEqual(
            lu["monthly"],
            {
                "2000-11": (1045.0, "estimee"),
                "2000-12": (1300.0, "estimee"),
                "2001-01": (1016.0, "reelle"),
            },
        )
        self.assertEqual(lu["daily"], {"2001-01-01": (7, "reelle"), "2001-01-02": (9, "reelle")})

    def test_export_reencode_en_utf8_refuse(self):
        self.ecrire(encodage="utf-8")
        with self.assertRaisesRegex(edf.ImportErreur, "UTF-8"):
            edf.lire_dossier(self.dossier)

    def test_doublon_divergent_refuse_avant_toute_ecriture(self):
        # Le 02/01 apparaît deux fois : la seconde occurrence se contredit.
        ligne = "02/01/2001;Index transmis par le distributeur;1004;517\n01"
        self.ecrire(index=INDEX.replace(ligne, ligne.replace("1004", "1005")))
        with self.assertRaisesRegex(edf.ImportErreur, "DIVERGENT"):
            edf.lire_dossier(self.dossier)
        avant = self.dump()
        self.assertEqual(edf.main([str(self.dossier), "--db", str(self.db)]), 1)
        self.assertEqual(self.dump(), avant)

    def test_index_non_mesure_refuse(self):
        estime = INDEX.replace("2000;Index transmis par le distributeur", "2000;Index estimé")
        self.ecrire(index=estime)
        with self.assertRaisesRegex(edf.ImportErreur, "transmis par le distributeur"):
            edf.lire_dossier(self.dossier)

    def test_index_non_monotone_refuse(self):
        self.ecrire(index=INDEX.replace("distributeur;900;", "distributeur;1200;"))
        with self.assertRaisesRegex(edf.ImportErreur, "monotone"):
            edf.lire_dossier(self.dossier)

    def test_nature_inconnue_refusee(self):
        self.ecrire(quotidien=QUOTIDIEN.replace("01/01/2001;7;Réelle", "01/01/2001;7;Calculée"))
        with self.assertRaisesRegex(edf.ImportErreur, "nature inconnue"):
            edf.lire_dossier(self.dossier)

    def test_export_manquant_refuse(self):
        self.ecrire()
        (self.dossier / "b.csv").unlink()
        with self.assertRaisesRegex(edf.ImportErreur, "manquant"):
            edf.lire_dossier(self.dossier)


class Ecriture(Base):
    def test_import_puis_relance_idempotente(self):
        self.ecrire()
        self.assertEqual(edf.main([str(self.dossier), "--db", str(self.db)]), 0)
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM edf_index").fetchone()[0], 4)
        self.assertEqual(
            con.execute("SELECT nature, COUNT(*) FROM edf_monthly GROUP BY nature").fetchall(),
            [("estimee", 2), ("reelle", 1)],
        )
        self.assertEqual(con.execute("SELECT SUM(kwh) FROM edf_daily").fetchone()[0], 16)
        self.assertEqual(
            {r[0] for r in con.execute("SELECT DISTINCT source FROM edf_index")}, {"edf-trv-export"}
        )
        self.assertEqual(
            con.execute("SELECT * FROM enedis_daily").fetchall(), [("2001-01-01", 7.2)]
        )
        con.close()
        apres = self.dump()
        bilan = edf.importer(edf.lire_dossier(self.dossier), self.db)
        self.assertEqual({t: b["inserees"] for t, b in bilan.items()}, dict.fromkeys(bilan, 0))
        self.assertEqual(self.dump(), apres)

    def test_ligne_deja_en_base_divergente_rien_n_est_ecrit(self):
        # Seule edf_monthly préexiste, avec une valeur qui contredit le fichier :
        # l'échec doit aussi annuler la création des deux autres tables.
        con = sqlite3.connect(self.db)
        con.execute(edf.DDL["edf_monthly"])
        con.execute(
            "INSERT INTO edf_monthly VALUES ('2000-12', 1299.0, 'estimee', 'edf-trv-export')"
        )
        con.commit()
        con.close()
        self.ecrire()
        avant = self.dump()
        with self.assertRaisesRegex(edf.ImportErreur, "déjà en base"):
            edf.importer(edf.lire_dossier(self.dossier), self.db)
        self.assertEqual(self.dump(), avant)
        self.assertNotIn("edf_index", self.tables())

    def test_dry_run_n_ecrit_rien(self):
        self.ecrire()
        avant = self.dump()
        self.assertEqual(edf.main([str(self.dossier), "--db", str(self.db), "--dry-run"]), 0)
        self.assertEqual(self.dump(), avant)

    def test_base_absente_jamais_creee(self):
        self.ecrire()
        absente = self.tmp / "absente.db"
        self.assertEqual(edf.main([str(self.dossier), "--db", str(absente)]), 1)
        self.assertFalse(absente.exists())


if __name__ == "__main__":
    unittest.main()
