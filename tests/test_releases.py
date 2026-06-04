import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace

import srsim_hw_schema as srsim


class ReleaseCatalogTests(unittest.TestCase):
    def test_load_releases_catalog_reads_repo_manifest(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        self.assertGreaterEqual(len(catalog), 1)
        self.assertEqual(str(catalog[0]["id"]).strip(), "26.3")

    def test_duplicate_release_id_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            catalog_path = Path(tmp) / "releases.yaml"
            catalog_path.write_text(
                "releases:\n"
                "  - id: one\n    label: One\n    appendix_source: https://example.com/one\n"
                "  - id: one\n    label: One again\n    appendix_source: https://example.com/two\n",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                srsim.load_releases_catalog(catalog_path)

    def test_resolve_release_prefers_explicit_source(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        resolved = srsim.resolve_release(
            catalog,
            release_id="26.3",
            explicit_source="https://example.com/custom.html",
        )
        self.assertEqual(resolved.appendix_source, "https://example.com/custom.html")
        self.assertEqual(resolved.id, "26.3")

    def test_resolve_release_uses_catalog_default(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        resolved = srsim.resolve_release(catalog)
        self.assertEqual(resolved.id, "26.3")
        self.assertIn("documentation.nokia.com", resolved.appendix_source)

    def test_build_schema_includes_release_metadata(self) -> None:
        schema = srsim.build_schema("<html></html>", "fixture", release="26.3", release_label="SR OS 26.3")
        self.assertEqual(schema["release"], "26.3")
        self.assertEqual(schema["release_label"], "SR OS 26.3")

    def test_list_releases_json_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            catalog_path = Path(tmp) / "releases.yaml"
            catalog_path.write_text(
                "releases:\n"
                "  - id: 26.3\n    label: SR OS 26.3\n    default: true\n"
                "    appendix_source: https://example.com/a\n"
                "    schema_output: out/26.3.json\n",
                encoding="utf-8",
            )
            args = SimpleNamespace(catalog=str(catalog_path), format="json")
            buffer = StringIO()
            with redirect_stdout(buffer):
                self.assertEqual(srsim.cmd_list_releases(args), 0)
            payload = json.loads(buffer.getvalue())
            self.assertEqual(payload["default_release"], "26.3")
            self.assertEqual(payload["releases"][0]["id"], "26.3")


if __name__ == "__main__":
    unittest.main()
