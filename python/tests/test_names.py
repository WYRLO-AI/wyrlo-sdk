"""Masquage des noms de personnes côté client (détecteur factice : aucun modèle requis)."""

import json
import unittest

from wyrlo import Wyrlo
from wyrlo.masking import unmask_text
from wyrlo.names import mask_texts_with_names

from test_wyrlo import KEY, OK, FakeApi


def finder_of(*noms):
    def trouver(texte):
        positions = []
        for nom in noms:
            i = texte.find(nom)
            if i >= 0:
                positions.append((i, i + len(nom)))
        return positions

    return trouver


class NamesTest(unittest.TestCase):
    def test_noms_apres_les_regles_meme_marque(self):
        masque = mask_texts_with_names(
            [
                "Camille Durand (camille.durand@example.com) a écrit à Jean-Pierre Lefèvre.",
                "Réponse pour camille durand, puis pour Jean-Pierre Lefèvre.",
            ],
            finder_of("Camille Durand", "Jean-Pierre Lefèvre"),
        )
        self.assertEqual(
            masque.texts,
            [
                "[PERSONNE_1] ([EMAIL_1]) a écrit à [PERSONNE_2].",
                "Réponse pour [PERSONNE_1], puis pour [PERSONNE_2].",
            ],
        )
        self.assertEqual(masque.counts, {"EMAIL": 1, "PERSONNE": 4})
        self.assertEqual(
            unmask_text(masque.texts[0], masque.values),
            "Camille Durand (camille.durand@example.com) a écrit à Jean-Pierre Lefèvre.",
        )

    def test_mot_entier_positions_invalides_et_marques(self):
        masque = mask_texts_with_names(
            ["Appeler Lefèvre au 06 12 34 56 78."],
            lambda _t: [(8, 11), (-1, 3), (5, 500), (19, 30), "x"],
        )
        self.assertEqual(masque.texts, ["Appeler [PERSONNE_1] au [TELEPHONE_1]."])

    def test_pas_dans_un_autre_mot(self):
        masque = mask_texts_with_names(
            ["Rose Martin aime les roses et la rosée."], finder_of("Rose Martin")
        )
        self.assertEqual(masque.texts, ["[PERSONNE_1] aime les roses et la rosée."])

    def test_client_noms_masques_a_l_envoi_remis_au_retour(self):
        api = FakeApi()
        self.addCleanup(api.close)
        api.responses = [(200, dict(OK, reason="[PERSONNE_1] figure dans le passage."), 0)]
        wyrlo = Wyrlo(
            api_key=KEY, base_url=api.url, mask={"names": finder_of("Camille Durand")}
        )
        resultat = wyrlo.guard(
            question="Le dossier de Camille Durand est-il complet ?",
            answer="Le dossier de Camille Durand est complet.",
            passages=[{"text": "Dossier de Camille Durand : complet."}],
        )
        envoye = json.dumps(api.calls[0]["body"], ensure_ascii=False)
        self.assertNotIn("Camille", envoye)
        self.assertIn("[PERSONNE_1]", envoye)
        self.assertEqual(resultat.reason, "Camille Durand figure dans le passage.")
        self.assertEqual(resultat.local_masking.method, "rules+names")
        self.assertEqual(resultat.local_masking.counts, {"PERSONNE": 3})

    def test_detecteur_en_panne_rien_n_est_envoye(self):
        api = FakeApi()
        self.addCleanup(api.close)

        def en_panne(_texte):
            raise RuntimeError("modèle absent")

        wyrlo = Wyrlo(api_key=KEY, base_url=api.url, mask={"names": en_panne})
        resultat = wyrlo.guard(question="q", answer="a", passages=[{"text": "p"}])
        self.assertEqual(api.calls, [])
        self.assertTrue(resultat.degraded)


if __name__ == "__main__":
    unittest.main()
