import unittest
from copy import deepcopy

import srsim_hw_schema as srsim


SAMPLE_HARDWARE_SCHEMA = {
    "$schema": "https://srl-labs.local/srsim-supported-hardware.schema.v1.json",
    "generated_at": "2026-05-20T00:00:00+00:00",
    "source": "fixture",
    "models": {
        "7750 SR-7s": {
            "default_layout": [
                {
                    "card": "cpm2-s",
                    "chassis": "SR-7s",
                    "memory": "4 GB",
                    "sfm": "sfm2-s",
                    "slot": "A",
                },
                {
                    "card": "xcm2-7s",
                    "chassis": "SR-7s",
                    "mda": "x2-s36-800g-qsfpdd-18.0t",
                    "memory": "6 GB",
                    "sfm": "sfm2-s",
                    "slot": "1",
                },
            ],
            "supported_hardware": [
                {
                    "card": "xcm-7s",
                    "chassis": "SR-7s",
                    "mda": "ms2-400gb-qsfpdd+2-100gb-qsfp28",
                    "sfm": "sfm-s",
                    "xiom": "iom-s-1.5t\niom-s-3.0t",
                }
            ],
            "supported_values": {
                "card": ["cpm2-s", "xcm2-7s", "xcm-7s"],
                "chassis": ["SR-7s"],
                "mda": [
                    "x2-s36-800g-qsfpdd-18.0t",
                    "ms2-400gb-qsfpdd+2-100gb-qsfp28",
                ],
                "sfm": ["sfm2-s", "sfm-s"],
                "slot": ["A", "1"],
                "xiom": ["iom-s-1.5t", "iom-s-3.0t"],
            },
        },
        "7750 DMS-1-24D": {
            "default_layout": [
                {
                    "card": "cpm-1x/dms24-800g-qsfpdd-1",
                    "chassis": "DMS-1-24D",
                    "slot": "A",
                },
                {
                    "card": "cpm-1x/dms24-800g-qsfpdd-1",
                    "chassis": "DMS-1-24D",
                    "mda": "d24-800g-qsfpdd-1",
                    "slot": "1",
                },
            ],
            "supported_hardware": [],
            "supported_values": {
                "card": ["cpm-1x/dms24-800g-qsfpdd-1"],
                "chassis": ["DMS-1-24D"],
                "mda": ["d24-800g-qsfpdd-1"],
                "sfm": [],
                "slot": ["A", "1"],
                "xiom": [],
            },
        },
    },
}


MINIMAL_CLAB_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "definitions": {
        "env": {"type": "object"},
        "sros-card-types": {"type": "string", "enum": ["xcm-7s"]},
        "sros-cpm-types": {"type": "string", "enum": ["cpm2-s"]},
        "sros-sfm-types": {"type": "string", "enum": ["sfm-s"]},
        "sros-xiom-types": {"type": "string", "enum": ["iom-s-1.5t"]},
        "sros-mda-types": {
            "type": "string",
            "enum": ["ms2-400gb-qsfpdd+2-100gb-qsfp28"],
        },
        "sros-xiom-mda-types": {
            "type": "string",
            "enum": ["ms2-400gb-qsfpdd+2-100gb-qsfp28"],
        },
        "node-config": {
            "type": "object",
            "properties": {
                "kind": {"type": "string"},
                "type": {"type": "string"},
                "components": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "slot": {"type": "string"},
                            "type": {"description": "Set component type"},
                        },
                    },
                    "uniqueItems": True,
                    "description": "List of node components",
                    "markdownDescription": "Dependency list for Components",
                },
            },
            "allOf": [
                {
                    "if": {
                        "properties": {"kind": {"pattern": "(nokia_srsim)"}},
                        "required": ["kind"],
                    },
                    "then": {
                        "properties": {
                            "type": {"type": "string", "enum": ["sr-7s"]}
                        }
                    },
                }
            ],
        },
    },
}


class ClabFragmentTest(unittest.TestCase):
    def test_fragment_contains_srsim_definitions_and_matrix(self) -> None:
        sidecar = srsim.build_srsim_schema_module(SAMPLE_HARDWARE_SCHEMA)
        definitions = sidecar["definitions"]

        for definition in srsim.CLAB_COMPONENT_DEFINITIONS:
            self.assertIn(definition, definitions)
        self.assertIn("srsim-node", definitions)
        self.assertIn("srsim-component-sr-7s", definitions)
        self.assertEqual(sidecar["$id"], srsim.CLAB_SRSIM_SCHEMA)
        self.assertIn("sr-7s", definitions["srsim-chassis-types"]["enum"])
        self.assertIn("xcm-7s", definitions["srsim-card-types"]["enum"])
        self.assertIn("cpm2-s", definitions["srsim-cpm-types"]["enum"])
        self.assertIn(
            "cpm-1x/dms24-800g-qsfpdd-1",
            definitions["srsim-card-types"]["enum"],
        )
        self.assertIn(
            "cpm-1x/dms24-800g-qsfpdd-1",
            definitions["srsim-cpm-types"]["enum"],
        )
        self.assertIn("iom-s-1.5t", definitions["srsim-xiom-types"]["enum"])
        self.assertIn(
            "ms2-400gb-qsfpdd+2-100gb-qsfp28",
            definitions["srsim-mda-types"]["enum"],
        )

        sr7s_component = definitions["srsim-component-sr-7s"]
        encoded = srsim.dumps_json(sr7s_component)
        self.assertIn("iom-s-1.5t", encoded)
        self.assertIn("ms2-400gb-qsfpdd+2-100gb-qsfp28", encoded)

    def test_sidecar_groups_identical_chassis_component_definitions(self) -> None:
        schema = deepcopy(SAMPLE_HARDWARE_SCHEMA)
        duplicate = deepcopy(schema["models"]["7750 SR-7s"])
        duplicate["supported_values"]["chassis"] = ["SR-7e"]
        for table_name in ("default_layout", "supported_hardware"):
            for row in duplicate[table_name]:
                row["chassis"] = "SR-7e"
        schema["models"]["7750 SR-7e"] = duplicate

        sidecar = srsim.build_srsim_schema_module(schema)
        definitions = sidecar["definitions"]
        component_definitions = [
            name for name in definitions if name.startswith("srsim-component-")
        ]

        self.assertEqual(sidecar["x-srsim-metadata"]["chassis"], 3)
        self.assertEqual(sidecar["x-srsim-metadata"]["component_definitions"], 2)
        self.assertEqual(len(component_definitions), 2)
        shared_rules = [
            rule
            for rule in definitions["srsim-node"]["allOf"]
            if rule["if"]["properties"]["type"].get("enum") == ["sr-7e", "sr-7s"]
        ]
        self.assertEqual(len(shared_rules), 1)

    def test_apply_clab_fragment_is_idempotent(self) -> None:
        fragment = srsim.build_clab_fragment(SAMPLE_HARDWARE_SCHEMA)
        clab_schema = deepcopy(MINIMAL_CLAB_SCHEMA)
        clab_schema["definitions"]["srsim-component-old-inline"] = {"type": "object"}
        updated = srsim.apply_clab_fragment(clab_schema, fragment)
        updated_again = srsim.apply_clab_fragment(updated, fragment)
        srsim_ref = srsim.DEFAULT_SRSIM_SCHEMA_REF

        self.assertEqual(updated, updated_again)
        self.assertIn("sros-component", updated["definitions"])
        self.assertNotIn("srsim-component-old-inline", updated["definitions"])
        self.assertEqual(
            updated["definitions"]["node-config"]["properties"]["components"]["items"],
            {
                "anyOf": [
                    {"$ref": "#/definitions/sros-component"},
                    {"$ref": f"{srsim_ref}#/definitions/srsim-component"},
                ]
            },
        )

        srsim_branch = srsim.find_srsim_branch(updated)
        self.assertEqual(
            srsim_branch["then"],
            {
                "allOf": [
                    {"$ref": f"{srsim_ref}#/definitions/srsim-node"}
                ]
            },
        )
        self.assertEqual(
            updated["x-srsim-schema-ref"],
            srsim_ref,
        )
        self.assertNotIn("x-srsim-compatibility-matrix", updated)


if __name__ == "__main__":
    unittest.main()
