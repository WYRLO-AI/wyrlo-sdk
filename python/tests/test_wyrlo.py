"""Tests du SDK Python, contre un faux serveur HTTP local (données fictives)."""

import json
import os
import sys
import threading
import time
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from wyrlo import DEFAULT_BASE_URL, Wyrlo, WyrloError  # noqa: E402

KEY = "wyr_test_" + "ab" * 24
OK = {
    "trace_id": "00000000-0000-4000-8000-000000000001",
    "decision": "answer",
    "confidence": "certain",
    "confidence_score": 1,
    "reason": "1 phrase(s) sur 1 appuyée(s) par les sources.",
    "passages": [{"id": "cgv-11", "kept": True, "rank": 1, "score": 0.9, "injection": False}],
    "unsupported_sentences": [],
    "injection_detected": False,
    "skipped_steps": [],
    "degraded": False,
    "settings_version": 2,
    "language": "fr",
    "rerank_method": "similarity",
    "verification_method": "signals",
    "latency_ms": 120,
    "quota_exceeded": False,
}


class FakeApi:
    def __init__(self):
        self.responses = []
        self.calls = []
        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length) if length else b""
                api.calls.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": dict(self.headers),
                        "body": json.loads(raw) if raw else None,
                    }
                )
                index = min(len(api.calls) - 1, len(api.responses) - 1)
                status, body, delay = api.responses[index]
                if delay:
                    time.sleep(delay)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                try:
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # le client a abandonné (test du délai dépassé)

            do_PUT = do_POST  # noqa: N815
            do_GET = do_POST  # noqa: N815
            do_DELETE = do_POST  # noqa: N815

            def log_message(self, *args):  # silence
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        os.environ.pop("WYRLO_API_KEY", None)
        self._region_env = os.environ.pop("WYRLO_REGION", None)

    def tearDown(self):
        self.api.close()
        os.environ.pop("WYRLO_REGION", None)
        if self._region_env is not None:
            os.environ["WYRLO_REGION"] = self._region_env

    def client(self, **kwargs):
        return Wyrlo(api_key=KEY, base_url=self.api.url + "/", **kwargs)

    def test_envoie_la_requete_et_renvoie_la_decision(self):
        self.api.responses = [(200, OK, 0)]
        res = self.client().guard(
            question="Délai de rétractation ?",
            passages=[{"id": "cgv-11", "text": "14 jours.", "source": "CGV.pdf"}, "Autre passage"],
            answer="14 jours.",
            language="fr",
        )
        self.assertTrue(res.should_answer)
        self.assertFalse(res.degraded)
        self.assertEqual(
            (res.language, res.rerank_method, res.verification_method),
            ("fr", "similarity", "signals"),
        )
        self.assertEqual(res.kept_passages[0].id, "cgv-11")
        call = self.api.calls[0]
        self.assertEqual(call["path"], "/v1/guard")
        self.assertEqual(call["headers"]["Authorization"], f"Bearer {KEY}")
        self.assertTrue(call["headers"]["X-Wyrlo-Sdk"].startswith("python/"))
        # Traitement imposé à Paris, région du projet (ADR 0003).
        self.assertEqual(call["headers"]["X-Region"], "eu-west-3")
        self.assertEqual(call["body"]["passages"][1], {"text": "Autre passage"})
        self.assertEqual(call["body"]["request_id"], res.request_id)
        self.assertEqual(call["body"]["language"], "fr")

    def test_plafond_atteint_reponse_transmise_et_marquee_degradee(self):
        over = dict(
            OK,
            trace_id=None,
            confidence="unverified",
            confidence_score=None,
            skipped_steps=["rerank", "injection_check", "consistency", "verification"],
            degraded=True,
            rerank_method="none",
            verification_method="none",
            quota_exceeded=True,
        )
        self.api.responses = [(200, over, 0)]
        res = self.client().guard(question="Q ?", passages=["14 jours."], answer="R.")
        self.assertTrue(res.should_answer)
        self.assertTrue(res.degraded)
        self.assertTrue(res.quota_exceeded)
        self.assertIsNone(res.trace_id)
        self.assertEqual(res.answer, "R.")
        self.assertEqual(len(self.api.calls), 1)

    def test_reponse_non_verifiee_jamais_probable(self):
        unverified = dict(
            OK,
            confidence="unverified",
            confidence_score=None,
            skipped_steps=["rerank", "verification"],
            degraded=True,
            verification_method="none",
        )
        self.api.responses = [(200, unverified, 0)]
        res = self.client().guard(question="Q ?", passages=["14 jours."], answer="R.")
        self.assertEqual((res.decision, res.confidence), ("answer", "unverified"))
        self.assertTrue(res.degraded)

    def test_serveur_sans_champ_degraded_deduit_des_etapes_sautees(self):
        old = {k: v for k, v in OK.items() if k != "degraded"}
        self.api.responses = [(200, dict(old, skipped_steps=["rerank"]), 0)]
        res = self.client().guard(question="Q ?", passages=["14 jours."], answer="R.")
        self.assertTrue(res.degraded)

    def test_refuse_hors_de_paris_421_resultat_degrade(self):
        refused = {"error": {"code": "wrong_region", "message": "Hors de Paris."}}
        self.api.responses = [(421, refused, 0), (421, refused, 0)]
        res = self.client().guard(question="Q ?", passages=["14 jours."], answer="R.")
        self.assertTrue(res.degraded)
        self.assertEqual((res.decision, res.confidence), ("answer", "unverified"))

    def test_generate_produit_la_reponse(self):
        self.api.responses = [(200, OK, 0)]
        res = self.client().guard(
            question="Délai ?",
            passages=["14 jours."],
            generate=lambda passages: f"Fondé sur {len(passages)} passage.",
        )
        self.assertEqual(res.answer, "Fondé sur 1 passage.")
        self.assertEqual(self.api.calls[0]["body"]["answer"], "Fondé sur 1 passage.")

    def test_reessaie_une_erreur_5xx_avec_le_meme_request_id(self):
        self.api.responses = [(502, {}, 0), (200, OK, 0)]
        res = self.client().guard(question="Q ?", passages=[], answer="R.")
        self.assertFalse(res.degraded)
        self.assertEqual(len(self.api.calls), 2)
        self.assertEqual(
            self.api.calls[0]["body"]["request_id"], self.api.calls[1]["body"]["request_id"]
        )

    def test_ne_bloque_jamais_sur_une_panne(self):
        self.api.responses = [(500, {}, 0)]
        res = self.client(max_retries=2).guard(
            question="Q ?", passages=[{"id": "a", "text": "t"}], answer="R.", request_id="req-1"
        )
        self.assertEqual(len(self.api.calls), 3)
        self.assertTrue(res.degraded)
        self.assertEqual((res.decision, res.confidence, res.trace_id), ("answer", "unverified", None))
        self.assertEqual(res.request_id, "req-1")
        self.assertTrue(res.passages[0].kept)
        self.assertEqual((res.rerank_method, res.verification_method), ("none", "none"))

    def test_service_surcharge_mode_degrade_sans_nouvel_essai(self):
        self.api.responses = [(503, {"error": {"code": "overloaded"}}, 0), (200, OK, 0)]
        res = self.client().guard(question="Q ?", passages=[], answer="R.")
        self.assertEqual(len(self.api.calls), 1)
        self.assertTrue(res.degraded)
        self.assertIn("overloaded", res.reason)

    def test_delai_total_par_defaut_de_3_s_nouvel_essai_compris(self):
        self.api.responses = [(200, OK, 4.0)]
        started = time.monotonic()
        res = self.client().guard(question="Q ?", passages=[], answer="R.")
        elapsed = time.monotonic() - started
        self.assertGreater(elapsed, 2.8)
        self.assertLess(elapsed, 3.4)
        self.assertTrue(res.degraded)

    def test_ne_bloque_jamais_sur_un_delai_depasse(self):
        self.api.responses = [(200, OK, 1.0)]
        started = time.monotonic()
        res = self.client(timeout=0.1, max_retries=0).guard(question="Q ?", passages=[], answer="R.")
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertTrue(res.degraded)

    def test_ne_bloque_jamais_si_le_serveur_est_injoignable(self):
        res = Wyrlo(api_key=KEY, base_url="http://127.0.0.1:9/v1", max_retries=0).guard(
            question="Q ?", passages=[], answer="R."
        )
        self.assertTrue(res.degraded)

    def test_leve_wyrlo_error_pour_une_requete_invalide(self):
        self.api.responses = [
            (
                422,
                {
                    "error": {
                        "code": "invalid_request",
                        "message": "Requête invalide.",
                        "details": [{"field": "question", "issue": "vide"}],
                    }
                },
                0,
            )
        ]
        with self.assertRaises(WyrloError) as ctx:
            self.client().guard(question="", passages=[], answer="R.")
        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.details, [{"field": "question", "issue": "vide"}])
        self.assertEqual(len(self.api.calls), 1)

    def test_exige_une_cle_et_une_reponse(self):
        with self.assertRaises(WyrloError):
            Wyrlo(api_key="")
        with self.assertRaises(ValueError):
            self.client().guard(question="Q ?", passages=[])

    def test_lit_la_cle_dans_l_environnement(self):
        os.environ["WYRLO_API_KEY"] = KEY
        self.api.responses = [(200, OK, 0)]
        Wyrlo(base_url=self.api.url).guard(question="Q ?", passages=[], answer="R.")
        self.assertEqual(self.api.calls[0]["headers"]["Authorization"], f"Bearer {KEY}")

    def test_region_de_l_option_puis_de_l_environnement_sinon_paris(self):
        self.api.responses = [(200, OK, 0)]

        def region_of(**kwargs):
            self.client(**kwargs).guard(question="Q ?", passages=[], answer="R.")
            return self.api.calls[-1]["headers"]["X-Region"]

        self.assertEqual(region_of(), "eu-west-3")
        self.assertEqual(region_of(region="eu-central-1"), "eu-central-1")
        # Une valeur vide ne doit pas laisser Supabase choisir la région.
        self.assertEqual(region_of(region=" "), "eu-west-3")
        os.environ["WYRLO_REGION"] = "eu-west-1"
        self.assertEqual(region_of(), "eu-west-1")
        self.assertEqual(region_of(region="eu-central-1"), "eu-central-1")
        os.environ["WYRLO_REGION"] = "  "
        self.assertEqual(region_of(), "eu-west-3")

    def test_option_locale_en_tete_accept_language_absent_par_defaut(self):
        self.api.responses = [(200, OK, 0)]

        def language_of(**kwargs):
            self.client(**kwargs).guard(question="Q ?", passages=[], answer="R.")
            return self.api.calls[-1]["headers"].get("Accept-Language")

        # Sans option, aucun en-tête : l'API répond en anglais.
        self.assertIsNone(language_of())
        self.assertEqual(language_of(locale="fr"), "fr")


class PrepareTests(unittest.TestCase):
    """Étape « préparer », avant la recherche du client (données fictives)."""

    def setUp(self):
        self.api = FakeApi()

    def tearDown(self):
        self.api.close()

    def client(self):
        return Wyrlo(api_key=KEY, base_url=self.api.url + "/", timeout=2.0)

    def test_renvoie_la_question_enrichie_et_la_variante(self):
        self.api.responses = [
            (
                200,
                {
                    "query": "Comment obtenir un remboursement ? (rétractation)",
                    "added_terms": ["rétractation"],
                    "request_id": "req-1",
                    "settings_version": 3,
                    "settings_variant": "candidate",
                },
                0,
            )
        ]
        res = self.client().prepare("Comment obtenir un remboursement ?", request_id="req-1")
        self.assertEqual(self.api.calls[0]["path"], "/v1/guard/prepare")
        self.assertEqual(self.api.calls[0]["body"]["request_id"], "req-1")
        self.assertEqual(res.query, "Comment obtenir un remboursement ? (rétractation)")
        self.assertEqual(res.settings_variant, "candidate")
        self.assertFalse(res.degraded)

    def test_panne_renvoie_la_question_d_origine(self):
        self.api.responses = [(503, {}, 0)]
        res = self.client().prepare("Question fictive ?")
        self.assertEqual(res.query, "Question fictive ?")
        self.assertTrue(res.degraded)
        self.assertTrue(res.request_id)


class FeedbackTests(unittest.TestCase):
    """Pouce de l'utilisateur final (données fictives)."""

    TRACE = "00000000-0000-4000-8000-000000000001"

    def setUp(self):
        self.api = FakeApi()

    def tearDown(self):
        self.api.close()

    def client(self):
        return Wyrlo(api_key=KEY, base_url=self.api.url + "/", timeout=2.0)

    def test_envoie_la_trace_et_le_pouce_sans_texte(self):
        self.api.responses = [(200, {"recorded": True, "trace_id": self.TRACE}, 0)]
        self.assertTrue(self.client().feedback(self.TRACE, False))
        self.assertEqual(self.api.calls[0]["path"], "/v1/guard/feedback")
        self.assertEqual(self.api.calls[0]["body"], {"trace_id": self.TRACE, "helpful": False})

    def test_trace_inconnue_ou_panne_renvoie_faux_sans_exception(self):
        self.api.responses = [(404, {"error": {"code": "not_found", "message": "?"}}, 0)]
        self.assertFalse(self.client().feedback(self.TRACE, True))
        self.api.responses = [(503, {}, 0)]
        self.assertFalse(self.client().feedback(self.TRACE, True))

    def test_cle_refusee_leve_wyrlo_error(self):
        self.api.responses = [(401, {"error": {"code": "unauthorized", "message": "Clé refusée."}}, 0)]
        with self.assertRaises(WyrloError):
            self.client().feedback(self.TRACE, True)


class BaseUrlTests(unittest.TestCase):
    """Adresse de l'API : option, puis WYRLO_BASE_URL, sinon DEFAULT_BASE_URL."""

    def setUp(self):
        self._env = os.environ.pop("WYRLO_BASE_URL", None)

    def tearDown(self):
        os.environ.pop("WYRLO_BASE_URL", None)
        if self._env is not None:
            os.environ["WYRLO_BASE_URL"] = self._env

    def url_of(self, **kwargs):
        """URL demandée par guard, sans toucher au réseau (_ouvrir remplacé)."""
        seen = []

        def fake_urlopen(request, timeout=None):
            seen.append(request.full_url)
            raise urllib.error.URLError("hors ligne (test)")

        with mock.patch("wyrlo._ouvrir", fake_urlopen):
            res = Wyrlo(api_key=KEY, max_retries=0, **kwargs).guard(
                question="Q ?", passages=[], answer="R."
            )
        self.assertTrue(res.degraded)
        return seen[0]

    def test_utilise_default_base_url_par_defaut(self):
        self.assertEqual(self.url_of(), DEFAULT_BASE_URL + "/guard")
        # Une valeur vide retombe sur l'adresse par défaut.
        self.assertEqual(self.url_of(base_url=" "), DEFAULT_BASE_URL + "/guard")
        os.environ["WYRLO_BASE_URL"] = ""
        self.assertEqual(self.url_of(), DEFAULT_BASE_URL + "/guard")

    def test_l_environnement_puis_l_option_remplacent_l_adresse(self):
        os.environ["WYRLO_BASE_URL"] = "https://env.example.test/functions/v1"
        self.assertEqual(self.url_of(), "https://env.example.test/functions/v1/guard")
        self.assertEqual(
            self.url_of(base_url="https://option.example.test/v1"),
            "https://option.example.test/v1/guard",
        )

    def test_retire_les_barres_obliques_finales(self):
        self.assertEqual(
            self.url_of(base_url="https://option.example.test/v1///"),
            "https://option.example.test/v1/guard",
        )
        os.environ["WYRLO_BASE_URL"] = "https://env.example.test/functions/v1/"
        self.assertEqual(self.url_of(), "https://env.example.test/functions/v1/guard")


if __name__ == "__main__":
    unittest.main()


class SecuriteTests(unittest.TestCase):
    """Audit de sécurité, SEC-33 : la clé ne part jamais en clair ni vers une autre adresse."""

    def setUp(self):
        self.recus = []
        recus = self.recus

        class Redirige(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                recus.append({"path": self.path, "auth": self.headers.get("Authorization")})
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/vole")
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_POST  # noqa: N815

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Redirige)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_une_redirection_n_est_pas_suivie(self):
        res = Wyrlo(api_key=KEY, base_url=self.url, max_retries=0).guard(
            question="Q ?", passages=[], answer="R."
        )
        self.assertTrue(res.degraded)
        # Un seul appel, celui de l'API : la clé n'est pas renvoyée à l'adresse « /vole ».
        self.assertEqual([r["path"] for r in self.recus], ["/v1/guard"])

    def test_adresse_sans_https_refusee_sauf_machine_locale(self):
        for adresse in ("http://api.example.test/v1", "ftp://api.example.test", "api.example.test"):
            with self.assertRaises(WyrloError) as erreur:
                Wyrlo(api_key=KEY, base_url=adresse)
            self.assertEqual(erreur.exception.code, "insecure_base_url")
        for adresse in ("https://api.example.test/v1", "http://localhost:8000", "http://[::1]:8000"):
            Wyrlo(api_key=KEY, base_url=adresse)


class MasquageTests(unittest.TestCase):
    """Option ``mask`` : masquage sur la machine du développeur avant l'envoi."""

    QUESTION = "Comment joindre le service client ?"
    ANSWER = "Écrivez à aide@boutique-exemple.fr ou appelez le 01 84 88 12 34."
    SOURCES = [
        {"id": "contact", "text": "Service client : aide@boutique-exemple.fr. Téléphone : 01 84 88 12 34."}
    ]

    def setUp(self):
        self.api = FakeApi()
        self._region_env = os.environ.pop("WYRLO_REGION", None)

    def tearDown(self):
        self.api.close()
        if self._region_env is not None:
            os.environ["WYRLO_REGION"] = self._region_env

    def client(self, **kwargs):
        return Wyrlo(api_key=KEY, base_url=self.api.url, **kwargs)

    def test_regles_integrees_seules_les_marques_partent(self):
        self.api.responses = [
            (
                200,
                dict(
                    OK,
                    reason="Phrase non appuyée : appelez le [TELEPHONE_1].",
                    unsupported_sentences=["Écrivez à [EMAIL_1] ou appelez le [TELEPHONE_1]."],
                ),
                0,
            )
        ]
        res = self.client(mask=True).guard(
            question=self.QUESTION, passages=self.SOURCES, answer=self.ANSWER
        )
        envoye = json.dumps(self.api.calls[0]["body"], ensure_ascii=False)
        self.assertNotIn("aide@boutique-exemple.fr", envoye)
        self.assertNotIn("01 84 88 12 34", envoye)
        self.assertEqual(
            self.api.calls[0]["body"]["passages"],
            [{"id": "contact", "text": "Service client : [EMAIL_1]. Téléphone : [TELEPHONE_1]."}],
        )
        self.assertEqual(res.answer, self.ANSWER)
        self.assertEqual(res.unsupported_sentences, [self.ANSWER])
        self.assertEqual(res.reason, "Phrase non appuyée : appelez le 01 84 88 12 34.")
        self.assertEqual(res.local_masking.method, "rules")
        self.assertEqual(res.local_masking.counts, {"EMAIL": 2, "TELEPHONE": 2})

    def test_sans_option_textes_tels_quels(self):
        self.api.responses = [(200, OK, 0)]
        res = self.client().guard(question=self.QUESTION, passages=self.SOURCES, answer=self.ANSWER)
        self.assertEqual(self.api.calls[0]["body"]["answer"], self.ANSWER)
        self.assertIsNone(res.local_masking)

    def test_fonction_fournie_appelee_une_fois(self):
        self.api.responses = [(200, OK, 0)]
        recus = []

        def masque(textes):
            recus.append(textes)
            return [t.replace("Jeanne Martin", "[PERSONNE_1]") for t in textes]

        res = self.client(mask=masque).guard(
            question="Qui suit le dossier ?",
            passages=["Le dossier est suivi par Jeanne Martin."],
            generate=lambda _p: "Jeanne Martin suit le dossier.",
        )
        self.assertEqual(
            recus,
            [["Qui suit le dossier ?", "Jeanne Martin suit le dossier.", "Le dossier est suivi par Jeanne Martin."]],
        )
        self.assertEqual(self.api.calls[0]["body"]["answer"], "[PERSONNE_1] suit le dossier.")
        self.assertEqual(res.answer, "Jeanne Martin suit le dossier.")
        self.assertEqual(res.local_masking.method, "custom")

    def test_masquage_en_echec_rien_n_est_envoye(self):
        def leve(_t):
            raise RuntimeError("modèle absent")

        for masque in (leve, lambda t: t[1:], lambda t: [1, 2, 3]):
            self.api.calls.clear()
            self.api.responses = [(200, OK, 0)]
            res = self.client(mask=masque).guard(
                question=self.QUESTION, passages=self.SOURCES, answer=self.ANSWER
            )
            self.assertEqual(self.api.calls, [])
            self.assertTrue(res.degraded)
            self.assertEqual((res.decision, res.confidence), ("answer", "unverified"))
            self.assertIn("anonymize", res.skipped_steps)
            self.assertEqual(res.answer, self.ANSWER)
            self.assertIn("Local masking failed", res.reason)

    def test_prepare_question_masquee_vraie_question_rendue(self):
        self.api.responses = [
            (
                200,
                {
                    "query": "Mon colis pour [ADRESSE_1] ? (livraison)",
                    "added_terms": ["livraison"],
                    "settings_version": 3,
                    "settings_variant": None,
                },
                0,
            )
        ]
        res = self.client(mask=True).prepare(question="Mon colis pour 12 rue des Lilas, 75011 Paris ?")
        self.assertEqual(self.api.calls[0]["body"]["question"], "Mon colis pour [ADRESSE_1] ?")
        self.assertEqual(res.query, "Mon colis pour 12 rue des Lilas, 75011 Paris ? (livraison)")
        self.assertEqual(res.added_terms, ["livraison"])
        self.assertFalse(res.degraded)

    def test_prepare_masquage_en_echec_rien_n_est_envoye(self):
        self.api.responses = [(200, OK, 0)]

        def leve(_t):
            raise RuntimeError("x")

        res = self.client(mask=leve).prepare(question="Q ?")
        self.assertEqual(self.api.calls, [])
        self.assertEqual((res.query, res.degraded), ("Q ?", True))

    def test_memes_regles_que_le_moteur_corpus_commun(self):
        from wyrlo import mask_texts, unmask_text

        # Dépôt principal (packages/sdk) ou dépôt des SDK publiés (typescript/).
        ici = os.path.dirname(__file__)
        chemin = next(
            c
            for c in (
                os.path.join(ici, "..", "..", dossier, "test", "masquage-corpus.json")
                for dossier in ("sdk", "typescript")
            )
            if os.path.exists(c)
        )
        with open(chemin, encoding="utf-8") as fichier:
            corpus = json.load(fichier)
        self.assertGreater(len(corpus), 20)
        for cas in corpus:
            masque = mask_texts(cas["textes"])
            self.assertEqual(masque.texts, cas["attendu"], cas["textes"])
            self.assertEqual(masque.counts, cas["decompte"])
            if len(cas["textes"]) == 1:
                self.assertEqual(unmask_text(masque.texts[0], masque.values), cas["textes"][0])


class IndexTests(unittest.TestCase):
    """Index sans copie (mode B) : données fictives uniquement."""

    FP = "a" * 64

    def setUp(self):
        self.api = FakeApi()
        self._region_env = os.environ.pop("WYRLO_REGION", None)

    def tearDown(self):
        self.api.close()
        if self._region_env is not None:
            os.environ["WYRLO_REGION"] = self._region_env

    def client(self, **kwargs):
        return Wyrlo(api_key=KEY, base_url=self.api.url, **kwargs)

    def test_index_put_sur_l_identifiant_encode(self):
        self.api.responses = [
            (200, {"document": "docs/cgv.md", "version": "v1", "status": "indexed", "passages": []}, 0)
        ]
        res = self.client().index("docs/cgv.md", "v1", text="Délai de 14 jours.", labels=["cgv"])
        self.assertEqual(res["status"], "indexed")
        call = self.api.calls[0]
        self.assertEqual(call["method"], "PUT")
        self.assertEqual(call["path"], "/v1/guard/index/documents/docs%2Fcgv.md")
        self.assertEqual(call["body"]["labels"], ["cgv"])
        self.assertTrue(call["body"]["request_id"])
        self.assertEqual(call["headers"]["X-Region"], "eu-west-3")

    def test_index_coupe_ou_en_panne_leve_wyrlo_error(self):
        self.api.responses = [(403, {"error": {"code": "index_disabled", "message": "x"}}, 0)]
        with self.assertRaises(WyrloError) as ctx:
            self.client().index("d", "v1", text="x")
        self.assertEqual(ctx.exception.code, "index_disabled")
        self.api.responses = [(503, {}, 0)]
        with self.assertRaises(WyrloError) as ctx:
            self.client().index("d", "v1", text="x")
        self.assertEqual(ctx.exception.code, "unavailable")

    def test_index_avec_mask_n_envoie_rien_sans_accord(self):
        self.api.responses = [(200, {"status": "indexed"}, 0)]
        with self.assertRaises(WyrloError) as ctx:
            self.client(mask=True).index("d", "v1", text="x")
        self.assertEqual(ctx.exception.code, "mask_unsupported")
        self.assertEqual(self.api.calls, [])
        self.client(mask=True).index("d", "v1", text="x", allow_unmasked=True)
        self.assertEqual(self.api.calls[0]["body"]["text"], "x")

    def test_remove_et_index_stats(self):
        self.api.responses = [
            (200, {"document": "d", "deleted": True}, 0),
            (200, {"enabled": True, "documents": 1, "passages": 2}, 0),
        ]
        wyrlo = self.client()
        self.assertTrue(wyrlo.remove("d")["deleted"])
        self.assertEqual(wyrlo.index_stats()["passages"], 2)
        self.assertEqual(self.api.calls[0]["method"], "DELETE")
        self.assertIsNone(self.api.calls[0]["body"])
        self.assertEqual(self.api.calls[1]["method"], "GET")
        self.assertEqual(self.api.calls[1]["path"], "/v1/guard/index/stats")

    def test_lot_post_index_documents(self):
        out = {"results": [{"document": "a", "status": "indexed"}], "indexed": 1,
               "unchanged": 0, "failed": 0}
        self.api.responses = [(200, out, 0)]
        wyrlo = self.client()
        res = wyrlo.index_many([{"id": "a", "version": "v1", "text": "x", "title": "A"}],
                               tenant="client-1")
        self.assertEqual(res["indexed"], 1)
        self.assertEqual(self.api.calls[0]["method"], "POST")
        self.assertEqual(self.api.calls[0]["path"], "/v1/guard/index/documents")
        self.assertEqual(self.api.calls[0]["body"]["tenant"], "client-1")
        self.assertEqual(self.api.calls[0]["body"]["documents"][0]["title"], "A")

    def test_mode_c_espace_dans_le_corps_ou_l_adresse(self):
        self.api.responses = [
            (200, {"status": "indexed"}, 0),
            (200, {"results": []}, 0),
            (200, {"document": "d", "deleted": True}, 0),
            (200, {"enabled": True, "documents": 1, "passages": 2, "tenant": "client-1"}, 0),
            (200, {"tenant": "client 1", "documents": 1, "passages": 2}, 0),
        ]
        wyrlo = self.client()
        wyrlo.index("d", "v1", text="x", tenant="client-1", title="CGV 2026")
        wyrlo.search("Q ?", tenant="client-1")
        wyrlo.remove("d", tenant="client-1")
        wyrlo.index_stats(tenant="client-1")
        self.assertEqual(wyrlo.remove_tenant("client 1")["documents"], 1)
        self.assertEqual(self.api.calls[0]["body"]["tenant"], "client-1")
        self.assertEqual(self.api.calls[0]["body"]["title"], "CGV 2026")
        self.assertEqual(self.api.calls[1]["body"]["tenant"], "client-1")
        self.assertEqual(self.api.calls[2]["path"], "/v1/guard/index/documents/d?tenant=client-1")
        self.assertEqual(self.api.calls[3]["path"], "/v1/guard/index/stats?tenant=client-1")
        self.assertEqual(self.api.calls[4]["path"], "/v1/guard/index?tenant=client%201")
        self.assertEqual(self.api.calls[4]["method"], "DELETE")
        with self.assertRaises(ValueError):
            wyrlo.remove_tenant("")
        self.assertEqual(len(self.api.calls), 5)

    def test_search_puis_adresse_transmise_a_guard_et_stale_rendu(self):
        address = {"document": "d", "version": "v1", "start": 0, "length": 18, "fingerprint": self.FP}
        result = dict(address, index=0, labels=[], score=0.8)
        guard_ok = dict(OK, passages=[dict(OK["passages"][0], stale=True)])
        self.api.responses = [(200, {"results": [result]}, 0), (200, guard_ok, 0)]
        wyrlo = self.client()
        res = wyrlo.search("Délai ?", k=3, labels_any=["cgv"], keyword_hits=["d"])
        self.assertFalse(res.degraded)
        self.assertEqual(res.results, [result])
        self.assertEqual(
            self.api.calls[0]["body"],
            {
                "question": "Délai ?",
                "request_id": res.request_id,
                "k": 3,
                "labels_any": ["cgv"],
                "keyword_hits": [{"document": "d"}],
            },
        )
        out = wyrlo.guard(
            question="Délai ?",
            answer="14 jours.",
            passages=[{"id": "cgv-11", "text": "Délai de 14 jours.", "address": address}],
        )
        self.assertEqual(self.api.calls[1]["body"]["passages"][0]["address"], address)
        self.assertTrue(out.passages[0].stale)

    def test_search_en_panne_liste_vide_degradee_et_403_leve(self):
        for status in (503, 500, 421):
            self.api.responses = [(status, {}, 0)]
            res = self.client().search("Q ?")
            self.assertTrue(res.degraded)
            self.assertEqual(res.results, [])
        self.api.responses = [(403, {"error": {"code": "index_disabled", "message": "x"}}, 0)]
        with self.assertRaises(WyrloError):
            self.client().search("Q ?")

    def test_search_question_masquee_avec_mask(self):
        self.api.responses = [(200, {"results": []}, 0)]
        self.client(mask=True).search("Commande de jean@exemple.fr ?")
        self.assertEqual(self.api.calls[0]["body"]["question"], "Commande de [EMAIL_1] ?")

    def test_passages_from_search_relit_chez_vous_et_garde_l_adresse(self):
        from wyrlo import passages_from_search

        doc = "Préambule. Le délai est de 14 jours."
        results = [
            {"document": "cgv", "version": "v1", "start": 11, "length": 25,
             "fingerprint": self.FP, "index": 1, "labels": [], "score": 0.8},
            {"document": "efface", "version": "v1", "start": 0, "length": 5,
             "fingerprint": self.FP, "index": 0, "labels": [], "score": 0.5},
        ]
        lus = []

        def read(document, version, start, length):
            lus.append((document, version, start, length))
            return doc[start : start + length] if document == "cgv" else None

        out = passages_from_search(results, read)
        self.assertEqual(
            out,
            [
                {
                    "id": "cgv#11",
                    "text": "Le délai est de 14 jours.",
                    "source": "cgv",
                    "score": 0.8,
                    "address": {"document": "cgv", "version": "v1", "start": 11,
                                "length": 25, "fingerprint": self.FP},
                }
            ],
        )
        self.assertEqual(lus, [("cgv", "v1", 11, 25), ("efface", "v1", 0, 5)])

    def test_guard_avec_mask_retire_l_adresse_d_un_texte_masque(self):
        self.api.responses = [(200, OK, 0)]
        address = {"document": "d", "version": "v1", "start": 0, "length": 10, "fingerprint": self.FP}
        self.client(mask=True).guard(
            question="Contact ?",
            answer="Écrire au support.",
            passages=[
                {"id": "a", "text": "Écrire à jean@exemple.fr.", "address": address},
                {"id": "b", "text": "Le délai est de 14 jours.", "address": address},
            ],
        )
        sent = self.api.calls[0]["body"]["passages"]
        self.assertNotIn("address", sent[0])
        self.assertEqual(sent[1]["address"], address)
