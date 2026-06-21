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

    def test_duplicate_release_id_fails_within_same_platform(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            catalog_path = Path(tmp) / "releases.yaml"
            catalog_path.write_text(
                "releases:\n"
                "  - id: one\n    platform: srsim\n    label: One\n    appendix_source: https://example.com/one\n"
                "  - id: one\n    platform: srsim\n    label: One again\n    appendix_source: https://example.com/two\n",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                srsim.load_releases_catalog(catalog_path)

    def test_duplicate_release_id_across_platforms_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            catalog_path = Path(tmp) / "releases.yaml"
            catalog_path.write_text(
                "releases:\n"
                "  - id: one\n    platform: srsim\n    label: One\n    appendix_source: https://example.com/one\n"
                "  - id: one\n    platform: sros\n    label: One vSIM\n    appendix_source: https://example.com/two\n",
                encoding="utf-8",
            )
            catalog = srsim.load_releases_catalog(catalog_path)
            self.assertEqual(len(catalog), 2)

    def test_resolve_release_prefers_explicit_source(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        resolved = srsim.resolve_release(
            catalog,
            release_id="srsim:26.3",
            explicit_source="https://example.com/custom.html",
        )
        self.assertEqual(resolved.appendix_source, "https://example.com/custom.html")
        self.assertEqual(resolved.id, "26.3")
        self.assertEqual(resolved.platform, "srsim")

    def test_resolve_release_uses_catalog_default(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        resolved = srsim.resolve_release(catalog)
        self.assertEqual(resolved.id, "26.3")
        self.assertEqual(resolved.platform, "srsim")
        self.assertEqual(resolved.containerlab_kind, "nokia_srsim")
        self.assertIn("documentation.nokia.com", resolved.appendix_source)

    def test_build_schema_includes_release_metadata(self) -> None:
        schema = srsim.build_schema(
            "<html></html>",
            "fixture",
            platform="sros",
            platform_label="SR OS vSIM",
            containerlab_kind="nokia_sros",
            release="25.10",
            release_label="SR OS 25.10",
        )
        self.assertEqual(schema["platform"], "sros")
        self.assertEqual(schema["platform_label"], "SR OS vSIM")
        self.assertEqual(schema["containerlab_kind"], "nokia_sros")
        self.assertEqual(schema["release"], "25.10")
        self.assertEqual(schema["release_label"], "SR OS 25.10")

    def test_resolve_release_accepts_platform_filter_for_sros(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        resolved = srsim.resolve_release(catalog, release_id="25.10", platform="sros")
        self.assertEqual(resolved.id, "25.10")
        self.assertEqual(resolved.platform, "sros")
        self.assertEqual(resolved.platform_label, "SR OS vSIM")
        self.assertEqual(resolved.containerlab_kind, "nokia_sros")
        self.assertEqual(resolved.schema_output, "releases/sros/25.10/sros-supported-hardware.json")

    def test_resolve_release_accepts_release_key(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        resolved = srsim.resolve_release(catalog, release_id="sros:26.3")
        self.assertEqual(resolved.platform, "sros")
        self.assertEqual(resolved.id, "26.3")

    def test_resolve_release_rejects_ambiguous_duplicate_ids(self) -> None:
        catalog = srsim.load_releases_catalog(Path(__file__).resolve().parents[1] / "releases.yaml")
        with self.assertRaises(SystemExit) as context:
            srsim.resolve_release(catalog, release_id="25.10")
        self.assertIn("ambiguous", str(context.exception))
        self.assertIn("srsim:25.10", str(context.exception))
        self.assertIn("sros:25.10", str(context.exception))

    def test_list_releases_json_output_includes_platform_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            catalog_path = Path(tmp) / "releases.yaml"
            catalog_path.write_text(
                "releases:\n"
                "  - id: 25.10\n    label: SR OS 25.10\n    platform: sros\n"
                "    platform_label: SR OS vSIM\n    containerlab_kind: nokia_sros\n"
                "    appendix_source: https://example.com/a\n"
                "    schema_output: out/25.10.json\n",
                encoding="utf-8",
            )
            args = SimpleNamespace(catalog=str(catalog_path), format="json")
            buffer = StringIO()
            with redirect_stdout(buffer):
                self.assertEqual(srsim.cmd_list_releases(args), 0)
            payload = json.loads(buffer.getvalue())
            self.assertEqual(payload["releases"][0]["platform"], "sros")
            self.assertEqual(payload["releases"][0]["platform_label"], "SR OS vSIM")
            self.assertEqual(payload["releases"][0]["containerlab_kind"], "nokia_sros")

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
            self.assertEqual(payload["default_release"], "srsim:26.3")
            self.assertEqual(payload["releases"][0]["id"], "26.3")
            self.assertEqual(payload["releases"][0]["key"], "srsim:26.3")

    def test_validate_topology_sros_checks_type_only(self) -> None:
        schema = {
            "platform": "sros",
            "platform_label": "SR OS vSIM",
            "containerlab_kind": "nokia_sros",
            "release": "26.3",
            "release_label": "SR OS 26.3 vSIM",
            "models": {
                "7750 SR-7s": {
                    "default_layout": [],
                    "supported_hardware": [],
                    "supported_values": {"chassis": ["SR-7s"]},
                }
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            schema_path = Path(tmp) / "sros.json"
            topo_ok = Path(tmp) / "ok.clab.yml"
            topo_bad = Path(tmp) / "bad.clab.yml"
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            topo_ok.write_text(
                "name: sros-lab\n"
                "topology:\n"
                "  nodes:\n"
                "    sros1:\n"
                "      kind: nokia_sros\n"
                "      image: vrnetlab/nokia_sros:26.3\n"
                "      type: sr-7s\n"
                "      license: license.txt\n",
                encoding="utf-8",
            )
            topo_bad.write_text(
                "name: sros-lab\n"
                "topology:\n"
                "  nodes:\n"
                "    sros1:\n"
                "      kind: nokia_sros\n"
                "      image: vrnetlab/nokia_sros:26.3\n"
                "      type: not-real\n"
                "      license: license.txt\n",
                encoding="utf-8",
            )
            self.assertEqual(
                srsim.cmd_validate_topology(
                    SimpleNamespace(schema=str(schema_path), topology=str(topo_ok), no_strict=False)
                ),
                0,
            )
            self.assertEqual(
                srsim.cmd_validate_topology(
                    SimpleNamespace(schema=str(schema_path), topology=str(topo_bad), no_strict=False)
                ),
                1,
            )


if __name__ == "__main__":
    unittest.main()
