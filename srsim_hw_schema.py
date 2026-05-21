#!/usr/bin/env python3
"""Generate and query an SR-SIM hardware support schema from Nokia appendices.

The Nokia appendix is HTML generated from DITA.  The useful data lives in
regular tables, but many of those tables use rowspans.  This script expands
those tables into rectangular rows, classifies "default system layout" and
"supported hardware" tables, and emits a compact JSON schema that can be
queried later.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import datetime as dt
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from typing import Any
from urllib.request import Request, urlopen

import yaml


DEFAULT_APPENDIX_URL = (
    "https://documentation.nokia.com/sr/26-3/7x50-shared/"
    "srsim-installation-setup/appendices.html"
)

CLAB_FRAGMENT_SCHEMA = "https://srl-labs.local/srsim-clab-fragment.schema.v1.json"
CLAB_SRSIM_SCHEMA = "https://raw.githubusercontent.com/srl-labs/containerlab/main/schemas/srsim-hw.schema.json"
DEFAULT_SRSIM_SCHEMA_REF = CLAB_SRSIM_SCHEMA
DEFAULT_SRSIM_SCHEMA_FILE = "srsim-hw.schema.json"
CLAB_MATRIX_VERSION = 1
CLAB_COMPONENT_DEFINITIONS = (
    "srsim-chassis-types",
    "srsim-card-types",
    "srsim-cpm-types",
    "srsim-sfm-types",
    "srsim-xiom-types",
    "srsim-mda-types",
    "srsim-mda",
    "srsim-xiom",
    "srsim-component",
)
CLAB_SRSIM_DEFINITION_NAMES = set(CLAB_COMPONENT_DEFINITIONS) | {"srsim-node"}
MATRIX_SUPPORTED_VALUE_FIELDS = ("card", "sfm", "xiom", "mda")
INTEGRATED_CHASSIS = {"sr-1", "sr-1s", "ixr-r6", "ixr-ec", "ixr-e2", "ixr-e2c"}
REDUNDANT_INTEGRATED_CHASSIS = {"ixr-r6"}
MDA_SLOT_RESTRICTIONS: dict[tuple[str, str], list[int]] = {
    ("ixr-r4", "m20-1g-csfp"): [1, 2, 3],
    ("ixr-r4", "m10-1g-sfp+2-10g-sfp+"): [5],
    ("ixr-r6", "a32-chds1v2"): [5, 6],
    ("ixr-r6", "m20-1g-csfp"): [3, 4],
}


def clean_text(value: str) -> str:
    value = value.replace("\xa0", " ")
    lines = []
    for line in value.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def normalized_key(value: str) -> str:
    value = clean_text(value).lower()
    value = re.sub(r"[^a-z0-9]+", " ", value).strip()
    if value == "recommended memory per container":
        return "memory"
    if value in {"mda", "mda type"}:
        return "mda"
    if value in {"xiom", "xiom type"}:
        return "xiom"
    if value in {"card", "card type"}:
        return "card"
    if value in {"sfm", "sfm type"}:
        return "sfm"
    if value in {"chassis", "model", "chassis type"}:
        return "chassis"
    if value == "slot":
        return "slot"
    return value.replace(" ", "_")


def is_empty_value(value: str) -> bool:
    return clean_text(value) in {"", "-", "--", "—", "N/A", "n/a"}


def normalize_field_value(field: str, value: str) -> str:
    value = clean_text(value)
    if not value:
        return ""

    normalized_lines: list[str] = []
    for line in value.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        # Some cells include explanatory labels or notes in the value text,
        # while the actual SR-SIM environment value is the leading token.
        line = re.sub(r"^(?:ION|MDA)\s*:\s*", "", line, flags=re.I)
        line = re.sub(r"\s*\((?:fixed|pluggable)\s+in\s+MDA/[^)]*\)\s*$", "", line, flags=re.I)
        normalized_lines.append(line)

    return clean_text("\n".join(normalized_lines))


def split_values(value: str) -> list[str]:
    value = clean_text(value)
    if is_empty_value(value):
        return []

    parts: list[str] = []
    for line in value.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line or is_empty_value(line):
            continue
        for part in re.split(r"\s+\bor\b\s+", line, flags=re.I):
            part = normalize_field_value("", part)
            if part and not is_empty_value(part) and part.lower() != "or":
                parts.append(part)
    return parts or [value]


def canonical_token(value: str) -> str:
    return clean_text(value).lower()


class NokiaAppendixTableParser(HTMLParser):
    """Extract captions and table cells from Nokia appendix HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[dict[str, Any]] = []
        self._table: dict[str, Any] | None = None
        self._row: list[dict[str, Any]] | None = None
        self._cell: dict[str, Any] | None = None
        self._caption_parts: list[str] | None = None
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {k.lower(): v for k, v in attrs}
        tag = tag.lower()

        if tag in {"script", "style", "nav", "sup"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return

        if tag == "table":
            self._table = {"caption": "", "rows": []}
            return
        if self._table is None:
            return

        if tag == "caption":
            self._caption_parts = []
            return
        if tag == "tr":
            self._row = []
            return
        if tag in {"td", "th"} and self._row is not None:
            self._cell = {
                "text_parts": [],
                "header": tag == "th",
                "rowspan": int(attrs_dict.get("rowspan") or 1),
                "colspan": int(attrs_dict.get("colspan") or 1),
            }
            return
        if tag in {"br", "p", "li"} and self._cell is not None:
            self._cell["text_parts"].append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "nav", "sup"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return

        if tag == "caption" and self._table is not None and self._caption_parts is not None:
            self._table["caption"] = clean_text("".join(self._caption_parts))
            self._caption_parts = None
            return
        if tag in {"td", "th"} and self._cell is not None and self._row is not None:
            cell = {
                "text": clean_text("".join(self._cell["text_parts"])),
                "header": self._cell["header"],
                "rowspan": self._cell["rowspan"],
                "colspan": self._cell["colspan"],
            }
            self._row.append(cell)
            self._cell = None
            return
        if tag == "tr" and self._row is not None and self._table is not None:
            if self._row:
                self._table["rows"].append(self._row)
            self._row = None
            return
        if tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._cell is not None:
            self._cell["text_parts"].append(data)
        elif self._caption_parts is not None:
            self._caption_parts.append(data)


def load_source(source: str) -> str:
    if re.match(r"^https?://", source):
        request = Request(source, headers={"User-Agent": "srsim-hw-schema/1.0"})
        with urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8", errors="replace")
    return Path(source).read_text(encoding="utf-8", errors="replace")


def expand_table(rows: list[list[dict[str, Any]]]) -> list[list[dict[str, Any]]]:
    expanded: list[list[dict[str, Any]]] = []
    rowspans: dict[int, dict[str, Any]] = {}

    for row in rows:
        out: list[dict[str, Any]] = []
        col = 0

        def flush_rowspan_cells() -> None:
            nonlocal col
            while col in rowspans:
                pending = rowspans[col]
                out.append(pending["cell"])
                pending["remaining"] -= 1
                if pending["remaining"] <= 0:
                    del rowspans[col]
                col += 1

        flush_rowspan_cells()
        for cell in row:
            flush_rowspan_cells()
            colspan = max(1, int(cell.get("colspan", 1)))
            rowspan = max(1, int(cell.get("rowspan", 1)))
            flat_cell = {"text": cell["text"], "header": cell["header"]}
            for _ in range(colspan):
                out.append(flat_cell)
                if rowspan > 1:
                    rowspans[col] = {"remaining": rowspan - 1, "cell": flat_cell}
                col += 1
        flush_rowspan_cells()
        expanded.append(out)

    return expanded


def infer_missing_header_keys(keys: list[str]) -> list[str]:
    keys = keys[:]
    known_without_chassis = {"slot", "memory", "card", "mda", "xiom", "sfm"}
    if keys and not keys[0] and "chassis" not in keys:
        hits = known_without_chassis.intersection(keys)
        if "card" in hits and ("mda" in hits or "slot" in hits or "sfm" in hits):
            keys[0] = "chassis"
    return keys


def find_header_row(rows: list[list[dict[str, Any]]]) -> tuple[int, list[str]] | None:
    known = {"chassis", "slot", "memory", "card", "mda", "xiom", "sfm"}
    for idx, row in enumerate(rows):
        keys = infer_missing_header_keys([normalized_key(cell["text"]) for cell in row])
        hits = known.intersection(keys)
        if "chassis" in hits and ("card" in hits or "slot" in hits):
            return idx, keys
    return None


def table_type(caption: str) -> str | None:
    caption_norm = re.sub(r"\s+", " ", clean_text(caption).lower())
    if "default system layout" in caption_norm:
        return "default_layout"
    if "supported hardware" in caption_norm:
        return "supported_hardware"
    return None


def row_to_record(headers: list[str], row: list[dict[str, Any]]) -> dict[str, str]:
    record: dict[str, str] = {}
    for idx, key in enumerate(headers):
        if not key or key.startswith("table"):
            continue
        if idx >= len(row):
            continue
        value = normalize_field_value(key, row[idx]["text"])
        if is_empty_value(value):
            continue
        if key == "card":
            match = re.match(r"^(?P<card>\S+)\s+mda/(?P<slot>\d+)=(?P<mda>\S+)$", value, flags=re.I)
            if match:
                record[key] = match.group("card")
                record[f"mda_{match.group('slot')}"] = match.group("mda")
                record["mda"] = match.group("mda")
                continue
        record[key] = value
    return record


def model_name_from_caption(caption: str) -> str:
    caption = re.sub(r"\s+", " ", clean_text(caption))
    caption = re.sub(r"^Table\s+\d+\.\s*", "", caption)
    caption = re.sub(r"\s+(default system layout|supported hardware)$", "", caption, flags=re.I)
    parts = caption.split()
    deduped: list[str] = []
    for part in parts:
        if deduped and canonical_token(deduped[-1]) == canonical_token(part):
            continue
        deduped.append(part)
    caption = " ".join(deduped)
    return clean_text(caption)


def merge_unique(target: list[str], values: list[str]) -> None:
    seen = {canonical_token(v) for v in target}
    for value in values:
        key = canonical_token(value)
        if key and key not in seen:
            target.append(value)
            seen.add(key)


def build_schema(html: str, source: str) -> dict[str, Any]:
    parser = NokiaAppendixTableParser()
    parser.feed(html)

    schema: dict[str, Any] = {
        "$schema": "https://srl-labs.local/srsim-supported-hardware.schema.v1.json",
        "generated_at": dt.datetime.now(dt.UTC).isoformat(),
        "source": source,
        "models": {},
    }

    for table in parser.tables:
        kind = table_type(table["caption"])
        if kind is None:
            continue
        rows = expand_table(table["rows"])
        header = find_header_row(rows)
        if header is None:
            continue
        header_idx, headers = header

        model = model_name_from_caption(table["caption"])
        model_entry = schema["models"].setdefault(
            model,
            {
                "default_layout": [],
                "supported_hardware": [],
                "supported_values": {
                    "chassis": [],
                    "slot": [],
                    "sfm": [],
                    "card": [],
                    "xiom": [],
                    "mda": [],
                },
            },
        )

        for row in rows[header_idx + 1 :]:
            record = row_to_record(headers, row)
            if not record or "chassis" not in record:
                continue
            model_entry[kind].append(record)
            for field in record:
                if field.startswith("mda_"):
                    merge_unique(model_entry["supported_values"]["mda"], split_values(record[field]))
            for field in model_entry["supported_values"]:
                if field in record:
                    merge_unique(model_entry["supported_values"][field], split_values(record[field]))

    return schema


def find_model(schema: dict[str, Any], model: str) -> tuple[str, dict[str, Any]]:
    wanted = canonical_token(model)
    for name, entry in schema.get("models", {}).items():
        if canonical_token(name) == wanted:
            return name, entry
        chassis_values = entry.get("supported_values", {}).get("chassis", [])
        if wanted in {canonical_token(v) for v in chassis_values}:
            return name, entry
    raise SystemExit(f"model/chassis not found: {model}")


def record_matches(record: dict[str, str], criteria: dict[str, str]) -> bool:
    for field, expected in criteria.items():
        if not expected:
            continue
        values = {canonical_token(v) for v in split_values(record.get(field, ""))}
        if canonical_token(expected) not in values:
            return False
    return True


def record_matches_topology(record: dict[str, str], criteria: dict[str, str]) -> bool:
    """Match topology criteria against a schema row.

    Supported-hardware tables often do not include a slot column.  For topology
    validation, a missing schema field means "not constrained by this table";
    a present schema field must still match.
    """
    for field, expected in criteria.items():
        if not expected or field not in record:
            if field != "mda":
                continue
        if field == "mda":
            raw_values: list[str] = []
            for key, value in record.items():
                if key == "mda" or key.startswith("mda_"):
                    raw_values.extend(split_values(value))
        elif field == "card":
            raw_values = []
            for value in split_values(record.get(field, "")):
                raw_values.append(value)
                parts = split_card_parts(clab_hardware_token(value))
                if parts:
                    raw_values.extend(parts)
        elif field == "chassis":
            raw_values = [clab_chassis_token(v) for v in split_values(record.get(field, ""))]
        else:
            raw_values = split_values(record.get(field, ""))
        values = {canonical_token(v) for v in raw_values}
        if canonical_token(expected) not in values:
            return False
    return True


def matching_rows(rows: list[dict[str, str]], criteria: dict[str, str]) -> list[dict[str, str]]:
    return [row for row in rows if record_matches_topology(row, criteria)]


def missing_required_fields(matches: list[dict[str, str]], criteria: dict[str, str]) -> set[str]:
    topology_fields = {"card", "sfm", "xiom", "mda"}
    missing: set[str] = set()
    for row in matches:
        for field, value in row.items():
            target_field = "mda" if field.startswith("mda_") else field
            if target_field not in topology_fields or target_field in criteria or is_empty_value(value):
                continue
            missing.add(target_field)
    return missing


def check_schema(schema: dict[str, Any], args: argparse.Namespace) -> int:
    model_name, model = find_chassis_entry(schema, args.model)
    criteria = {
        "chassis": args.chassis or args.model,
        "slot": args.slot,
        "sfm": args.sfm,
        "card": args.card,
        "xiom": args.xiom,
        "mda": args.mda,
    }
    criteria = {k: v for k, v in criteria.items() if v}

    supported_matches = [row for row in model.get("supported_hardware", []) if record_matches(row, criteria)]
    default_matches = [row for row in model.get("default_layout", []) if record_matches(row, criteria)]
    matches = supported_matches + default_matches

    print(f"model: {model_name}")
    print(f"criteria: {json.dumps(criteria, sort_keys=True)}")
    if matches:
        print("supported: yes")
        print(json.dumps(matches, indent=2, sort_keys=True))
        if args.strict and supported_matches and not default_matches:
            missing = missing_required_fields(supported_matches, criteria)
            if missing:
                print(f"strict: missing required field(s): {', '.join(sorted(missing))}")
                return 2
        return 0

    print("supported: no")
    print("known supported values:")
    print(json.dumps(model.get("supported_values", {}), indent=2, sort_keys=True))
    return 1


def clab_chassis_token(value: str) -> str:
    value = clean_text(value)
    value = re.sub(r"\s*\([^)]*\)\s*$", "", value)
    value = re.sub(r"^(?:7250|7450|7705|7750|7950)\s+", "", value, flags=re.I)
    value = re.sub(r"\s+", "-", value.strip())
    return value.lower()


def clab_hardware_token(value: str) -> str:
    return clean_text(value).lower()


def sort_key(value: str) -> tuple[int, str]:
    if value.isdigit():
        return 0, value.zfill(8)
    return 1, value.lower()


def unique_sorted(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        value = clean_text(str(value))
        if not value:
            continue
        key = canonical_token(value)
        if key in seen:
            continue
        seen.add(key)
        result.append(value)
    return sorted(result, key=sort_key)


def normalized_record_values(field: str, value: str) -> list[str]:
    values = split_values(value)
    if field == "chassis":
        return unique_sorted([clab_chassis_token(v) for v in values])
    if field in MATRIX_SUPPORTED_VALUE_FIELDS or field.startswith("mda_"):
        return unique_sorted([clab_hardware_token(v) for v in values])
    return unique_sorted([clean_text(v) for v in values])


def model_chassis_aliases(model: str, entry: dict[str, Any]) -> list[str]:
    aliases: list[str] = []
    for chassis in entry.get("supported_values", {}).get("chassis", []):
        aliases.extend(normalized_record_values("chassis", chassis))

    if aliases:
        return unique_sorted(aliases)

    for table_name in ("default_layout", "supported_hardware"):
        for record in entry.get(table_name, []):
            if "chassis" in record:
                aliases.extend(normalized_record_values("chassis", record["chassis"]))

    if aliases:
        return unique_sorted(aliases)

    return unique_sorted([clab_chassis_token(model)])


def row_matches_chassis_alias(record: dict[str, str], alias: str) -> bool:
    if "chassis" not in record:
        return False
    return alias in normalized_record_values("chassis", record["chassis"])


def find_chassis_entry(schema: dict[str, Any], chassis: str) -> tuple[str, dict[str, Any]]:
    wanted = clab_chassis_token(chassis)
    models: list[str] = []
    default_layout: list[dict[str, str]] = []
    supported_hardware: list[dict[str, str]] = []

    for model, entry in schema.get("models", {}).items():
        aliases = model_chassis_aliases(model, entry)
        if wanted not in aliases and canonical_token(model) != canonical_token(chassis):
            continue
        models.append(model)
        for table_name, target in (
            ("default_layout", default_layout),
            ("supported_hardware", supported_hardware),
        ):
            for record in entry.get(table_name, []):
                if "chassis" not in record or row_matches_chassis_alias(record, wanted):
                    target.append(record)

    if not models:
        raise SystemExit(f"model/chassis not found: {chassis}")

    supported_values = {
        "chassis": [wanted],
        "slot": [],
        "sfm": [],
        "card": [],
        "xiom": [],
        "mda": [],
    }
    for record in default_layout + supported_hardware:
        for field, value in record.items():
            target_field = "mda" if field.startswith("mda_") else field
            if target_field not in supported_values:
                continue
            merge_values(supported_values[target_field], normalized_record_values(field, value))

    return ", ".join(unique_sorted(models)), {
        "default_layout": default_layout,
        "supported_hardware": supported_hardware,
        "supported_values": supported_values,
    }


def chassis_aliases_from_entry(chassis: str, chassis_entry: dict[str, Any]) -> list[str]:
    aliases = [chassis]
    for row in chassis_entry.get("default_layout", []) + chassis_entry.get("supported_hardware", []):
        aliases.extend(row.get("chassis", []))
    return unique_sorted([clab_chassis_token(alias) for alias in aliases])


def default_component_slots(chassis_entry: dict[str, Any]) -> list[str]:
    return unique_sorted(
        [
            str(slot)
            for row in chassis_entry.get("default_layout", [])
            for slot in row.get("slot", [])
        ]
    )


def deployment_mode(chassis: str, chassis_entry: dict[str, Any]) -> str:
    aliases = set(chassis_aliases_from_entry(chassis, chassis_entry))
    if aliases & REDUNDANT_INTEGRATED_CHASSIS:
        return "integrated_redundant"
    slots = default_component_slots(chassis_entry)
    has_alpha_slot = any(re.fullmatch(r"[A-Za-z]", slot) for slot in slots)
    has_numeric_slot = any(slot.isdigit() for slot in slots)
    if aliases & INTEGRATED_CHASSIS or (has_alpha_slot and not has_numeric_slot):
        return "standalone"
    return "distributed"


def split_card_parts(card: str) -> tuple[str, str] | None:
    if "/" not in card:
        return None
    cpm, line_card = card.split("/", 1)
    if not card_is_cpm(cpm) or not line_card:
        return None
    return cpm, line_card


def combined_card_preserved(chassis_entry: dict[str, Any], card: str) -> bool:
    alpha = False
    numeric = False
    for row in chassis_entry.get("default_layout", []):
        if card not in row.get("card", []):
            continue
        slots = row.get("slot", [])
        alpha = alpha or any(re.fullmatch(r"[A-Za-z]", slot) for slot in slots)
        numeric = numeric or any(slot.isdigit() for slot in slots)
    return alpha and numeric


def role_card_values(card: str, chassis_entry: dict[str, Any], role: str) -> list[str]:
    parts = split_card_parts(card)
    if parts and not combined_card_preserved(chassis_entry, card):
        return [parts[0] if role == "cpm" else parts[1]]
    return [card]


def direct_mda_values(row: dict[str, list[str]]) -> list[str]:
    values: list[str] = []
    for field, field_values in row.items():
        if field == "mda" or field.startswith("mda_"):
            merge_values(values, field_values)
    return values


def matrix_row(record: dict[str, str]) -> dict[str, list[str]]:
    row: dict[str, list[str]] = {}
    for field in sorted(record):
        values = normalized_record_values(field, record[field])
        if values:
            row[field] = values
    return row


def row_chassis_aliases(record: dict[str, str], fallback: list[str]) -> list[str]:
    if "chassis" not in record:
        return fallback
    aliases = normalized_record_values("chassis", record["chassis"])
    return aliases or fallback


def card_is_cpm(card: str) -> bool:
    card = canonical_token(card)
    return card.startswith(("cpm", "cpiom"))


def classify_card_values(
    row: dict[str, list[str]],
    chassis_entry: dict[str, Any] | None = None,
) -> tuple[list[str], list[str]]:
    cards = row.get("card", [])
    if not cards:
        return [], []

    chassis_entry = chassis_entry or {"default_layout": [], "supported_hardware": []}
    mode = deployment_mode("", chassis_entry) if chassis_entry.get("default_layout") else "distributed"
    slots = row.get("slot", [])
    has_alpha_slot = any(re.fullmatch(r"[A-Za-z]", slot) for slot in slots)
    has_numeric_slot = any(slot.isdigit() for slot in slots)
    has_payload = bool(direct_mda_values(row) or row.get("xiom"))

    cpms: list[str] = []
    line_cards: list[str] = []

    for card in cards:
        if mode in {"standalone", "integrated_redundant"}:
            merge_values(cpms, role_card_values(card, chassis_entry, "cpm"))
            continue

        split_parts = split_card_parts(card)
        split_for_roles = split_parts is not None and not combined_card_preserved(chassis_entry, card)

        if has_alpha_slot or split_for_roles or (card_is_cpm(card) and not has_payload):
            merge_values(cpms, role_card_values(card, chassis_entry, "cpm"))

        if has_numeric_slot or has_payload or not card_is_cpm(card):
            merge_values(line_cards, role_card_values(card, chassis_entry, "line"))

    return unique_sorted(cpms), unique_sorted(line_cards)


def empty_supported_values() -> dict[str, list[str]]:
    return {field: [] for field in MATRIX_SUPPORTED_VALUE_FIELDS}


def merge_values(target: list[str], values: list[str]) -> None:
    merged = unique_sorted(target + values)
    target[:] = merged


def append_unique_row(target: list[dict[str, list[str]]], row: dict[str, list[str]]) -> None:
    encoded = json.dumps(row, sort_keys=True)
    if encoded not in {json.dumps(existing, sort_keys=True) for existing in target}:
        target.append(row)


def build_clab_matrix(schema: dict[str, Any]) -> dict[str, Any]:
    matrix: dict[str, Any] = {
        "version": CLAB_MATRIX_VERSION,
        "source": schema.get("source", ""),
        "generated_at": schema.get("generated_at", ""),
        "chassis": {},
    }

    for model, entry in sorted(schema.get("models", {}).items()):
        aliases = model_chassis_aliases(model, entry)
        for alias in aliases:
            matrix["chassis"].setdefault(
                alias,
                {
                    "aliases": [alias],
                    "models": [],
                    "supported_values": empty_supported_values(),
                    "default_layout": [],
                    "supported_hardware": [],
                },
            )
            merge_values(matrix["chassis"][alias]["models"], [model])

        for table_name in ("default_layout", "supported_hardware"):
            for record in entry.get(table_name, []):
                row = matrix_row(record)
                for alias in row_chassis_aliases(record, aliases):
                    chassis_entry = matrix["chassis"].setdefault(
                        alias,
                        {
                            "aliases": [alias],
                            "models": [],
                            "supported_values": empty_supported_values(),
                            "default_layout": [],
                            "supported_hardware": [],
                        },
                    )
                    merge_values(chassis_entry["models"], [model])
                    append_unique_row(chassis_entry[table_name], row)
                    for field, values in row.items():
                        if field in MATRIX_SUPPORTED_VALUE_FIELDS:
                            merge_values(chassis_entry["supported_values"][field], values)
                        elif field.startswith("mda_"):
                            merge_values(chassis_entry["supported_values"]["mda"], values)

    for chassis_entry in matrix["chassis"].values():
        for table_name in ("default_layout", "supported_hardware"):
            chassis_entry[table_name] = sorted(
                chassis_entry[table_name],
                key=lambda row: json.dumps(row, sort_keys=True),
            )

    return matrix


def collect_clab_values(schema: dict[str, Any], matrix: dict[str, Any]) -> dict[str, list[str]]:
    values = {
        "chassis": list(matrix.get("chassis", {}).keys()),
        "card": [],
        "cpm": [],
        "sfm": [],
        "xiom": [],
        "mda": [],
    }

    for entry in schema.get("models", {}).values():
        for value in entry.get("supported_values", {}).get("sfm", []):
            merge_values(values["sfm"], normalized_record_values("sfm", value))
        for value in entry.get("supported_values", {}).get("xiom", []):
            merge_values(values["xiom"], normalized_record_values("xiom", value))
        for value in entry.get("supported_values", {}).get("mda", []):
            merge_values(values["mda"], normalized_record_values("mda", value))

    for chassis_entry in matrix.get("chassis", {}).values():
        for table_name in ("default_layout", "supported_hardware"):
            for row in chassis_entry.get(table_name, []):
                cpms, line_cards = classify_card_values(row, chassis_entry)
                merge_values(values["cpm"], cpms)
                merge_values(values["card"], line_cards)

    for key in values:
        values[key] = unique_sorted(values[key])

    return values


def enum_schema(description: str, values: list[str], allow_unknown: bool = False) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "string",
        "description": description,
    }
    if allow_unknown:
        schema["anyOf"] = [{"enum": values}, {"type": "string"}]
        schema["x-known-values"] = values
    else:
        schema["enum"] = values
    return schema


def build_clab_definitions(values: dict[str, list[str]], allow_unknown: bool = False) -> dict[str, Any]:
    return {
        "srsim-chassis-types": enum_schema(
            "SR-SIM chassis types generated from Nokia supported hardware tables.",
            values["chassis"],
            allow_unknown,
        ),
        "srsim-card-types": enum_schema(
            "SR-SIM line card types generated from Nokia supported hardware tables.",
            values["card"],
            allow_unknown,
        ),
        "srsim-cpm-types": enum_schema(
            "SR-SIM CPM types generated from Nokia supported hardware tables.",
            values["cpm"],
            allow_unknown,
        ),
        "srsim-sfm-types": enum_schema(
            "SR-SIM SFM types generated from Nokia supported hardware tables.",
            values["sfm"],
            allow_unknown,
        ),
        "srsim-xiom-types": enum_schema(
            "SR-SIM XIOM types generated from Nokia supported hardware tables.",
            values["xiom"],
            allow_unknown,
        ),
        "srsim-mda-types": enum_schema(
            "SR-SIM MDA types generated from Nokia supported hardware tables.",
            values["mda"],
            allow_unknown,
        ),
        "srsim-mda": {
            "type": "object",
            "properties": {
                "slot": {"type": "integer", "minimum": 1},
                "type": {"$ref": "#/definitions/srsim-mda-types"},
            },
            "required": ["slot", "type"],
            "additionalProperties": False,
        },
        "srsim-xiom": {
            "type": "object",
            "properties": {
                "slot": {"type": "integer", "minimum": 1},
                "type": {"$ref": "#/definitions/srsim-xiom-types"},
                "mda": {
                    "type": "array",
                    "items": {"$ref": "#/definitions/srsim-mda"},
                    "uniqueItems": True,
                },
            },
            "required": ["slot", "type"],
            "additionalProperties": False,
        },
        "srsim-component": {
            "type": "object",
            "properties": {
                "slot": {
                    "description": "Set component physical position on a distributed chassis",
                    "anyOf": [
                        {"type": "string", "pattern": "^[ABab]$"},
                        {"type": "integer", "minimum": 1},
                    ],
                },
                "type": {"description": "Set SR-SIM component type"},
                "sfm": {"$ref": "#/definitions/srsim-sfm-types"},
                "xiom": {
                    "type": "array",
                    "items": {"$ref": "#/definitions/srsim-xiom"},
                    "uniqueItems": True,
                },
                "mda": {
                    "type": "array",
                    "items": {"$ref": "#/definitions/srsim-mda"},
                    "uniqueItems": True,
                },
                "env": {"type": "object", "$ref": "#/definitions/env"},
            },
            "additionalProperties": False,
            "allOf": [
                {
                    "if": {
                        "properties": {"slot": {"type": "string"}},
                        "required": ["slot"],
                    },
                    "then": {
                        "properties": {
                            "type": {"$ref": "#/definitions/srsim-cpm-types"}
                        }
                    },
                    "else": {
                        "properties": {
                            "type": {"$ref": "#/definitions/srsim-card-types"}
                        }
                    },
                }
            ],
        },
    }


def definition_suffix(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def disallow_property(name: str) -> dict[str, Any]:
    return {"not": {"required": [name]}}


def mda_slot_restriction(chassis: str, mda_type: str) -> list[int]:
    aliases = {clab_chassis_token(chassis)}
    return next(
        (
            slots
            for (restricted_chassis, restricted_mda), slots in MDA_SLOT_RESTRICTIONS.items()
            if restricted_chassis in aliases and canonical_token(restricted_mda) == canonical_token(mda_type)
        ),
        [],
    )


def array_item_type_schema(values: list[str], *, chassis: str = "", restrict_mda_slots: bool = False) -> dict[str, Any]:
    item: dict[str, Any] = {"properties": {"type": {"enum": values}}}
    if restrict_mda_slots:
        rules: list[dict[str, Any]] = []
        for value in values:
            slots = mda_slot_restriction(chassis, value)
            if slots:
                rules.append(
                    {
                        "if": {
                            "properties": {"type": {"const": value}},
                            "required": ["type"],
                        },
                        "then": {"properties": {"slot": {"enum": slots}}},
                    }
                )
        if rules:
            item["allOf"] = rules
    return {"items": item}


def chassis_card_classes(chassis_entry: dict[str, Any]) -> tuple[list[str], list[str]]:
    cpms: list[str] = []
    cards: list[str] = []
    for table_name in ("default_layout", "supported_hardware"):
        for row in chassis_entry.get(table_name, []):
            row_cpms, row_cards = classify_card_values(row, chassis_entry)
            merge_values(cpms, row_cpms)
            merge_values(cards, row_cards)
    return cpms, cards


def card_compatibility(chassis_entry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    compatibility: dict[str, dict[str, Any]] = {}
    for table_name in ("default_layout", "supported_hardware"):
        for row in chassis_entry.get(table_name, []):
            cpms, line_cards = classify_card_values(row, chassis_entry)
            row_mdas = direct_mda_values(row)

            for card in cpms:
                entry = compatibility.setdefault(
                    card,
                    {
                        "sfm": [],
                        "direct_mda": [],
                        "xiom": [],
                        "xiom_mda": {},
                    },
                )
                if "sfm" in row:
                    merge_values(entry["sfm"], row["sfm"])

                mode = deployment_mode("", chassis_entry)
                if mode in {"standalone", "integrated_redundant"} and row_mdas and "xiom" not in row:
                    merge_values(entry["direct_mda"], row_mdas)

            for card in line_cards:
                entry = compatibility.setdefault(
                    card,
                    {
                        "sfm": [],
                        "direct_mda": [],
                        "xiom": [],
                        "xiom_mda": {},
                    },
                )
                if "sfm" in row:
                    merge_values(entry["sfm"], row["sfm"])
                if row_mdas and "xiom" not in row:
                    merge_values(entry["direct_mda"], row_mdas)
                if "xiom" in row:
                    merge_values(entry["xiom"], row["xiom"])
                    for xiom in row["xiom"]:
                        merge_values(entry["xiom_mda"].setdefault(xiom, []), row_mdas)
    return compatibility


def xiom_schema_for_card(entry: dict[str, Any], chassis: str) -> dict[str, Any]:
    xioms = entry["xiom"]
    schema: dict[str, Any] = {"properties": {"type": {"enum": xioms}}}
    rules: list[dict[str, Any]] = []
    for xiom, mdas in sorted(entry["xiom_mda"].items()):
        then: dict[str, Any]
        if mdas:
            then = {
                "properties": {
                    "mda": array_item_type_schema(
                        mdas,
                        chassis=chassis,
                        restrict_mda_slots=True,
                    )
                }
            }
        else:
            then = disallow_property("mda")
        rules.append(
            {
                "if": {
                    "properties": {"type": {"const": xiom}},
                    "required": ["type"],
                },
                "then": then,
            }
        )
    if rules:
        schema["allOf"] = rules
    return schema


def component_rule_for_card(card: str, entry: dict[str, Any], chassis: str) -> dict[str, Any]:
    then: dict[str, Any] = {"properties": {}}
    all_of: list[dict[str, Any]] = []

    if entry["sfm"]:
        then["properties"]["sfm"] = {"enum": entry["sfm"]}
    else:
        all_of.append(disallow_property("sfm"))

    if entry["direct_mda"]:
        then["properties"]["mda"] = array_item_type_schema(
            entry["direct_mda"],
            chassis=chassis,
            restrict_mda_slots=True,
        )
    else:
        all_of.append(disallow_property("mda"))

    if entry["xiom"]:
        then["properties"]["xiom"] = {"items": xiom_schema_for_card(entry, chassis)}
    else:
        all_of.append(disallow_property("xiom"))

    if all_of:
        then["allOf"] = all_of
    if not then["properties"]:
        del then["properties"]

    return {
        "if": {
            "properties": {"type": {"const": card}},
            "required": ["type"],
        },
        "then": then,
    }


def build_chassis_component_definition(chassis: str, chassis_entry: dict[str, Any]) -> dict[str, Any]:
    cpms, cards = chassis_card_classes(chassis_entry)
    mode = deployment_mode(chassis, chassis_entry)
    rules: list[dict[str, Any]] = []

    if mode in {"standalone", "integrated_redundant"}:
        allowed_slots = ["A", "a"] if mode == "standalone" else ["A", "B", "a", "b"]
        rules.append(
            {
                "if": {"required": ["slot"]},
                "then": {"properties": {"slot": {"enum": allowed_slots}}},
            }
        )
        rules.append(
            {
                "not": {
                    "properties": {"slot": {"type": "integer"}},
                    "required": ["slot"],
                }
            }
        )
        if cpms:
            rules.append({"properties": {"type": {"enum": cpms}}})

        standalone_mdas: list[str] = []
        for entry in card_compatibility(chassis_entry).values():
            merge_values(standalone_mdas, entry["direct_mda"])
        if standalone_mdas:
            rules.append(
                {
                    "properties": {
                        "mda": array_item_type_schema(
                            standalone_mdas,
                            chassis=chassis,
                            restrict_mda_slots=True,
                        )
                    }
                }
            )
        rules.extend([disallow_property("sfm"), disallow_property("xiom")])
    elif cpms:
        rules.append(
            {
                "if": {
                    "properties": {"slot": {"type": "string"}},
                    "required": ["slot"],
                },
                "then": {"properties": {"type": {"enum": cpms}}},
            }
        )
    if cards:
        rules.append(
            {
                "if": {
                    "properties": {"slot": {"type": "integer"}},
                    "required": ["slot"],
                },
                "then": {"properties": {"type": {"enum": cards}}},
            }
        )

    for card, entry in sorted(card_compatibility(chassis_entry).items()):
        rules.append(component_rule_for_card(card, entry, chassis))

    definition: dict[str, Any] = {
        "allOf": [
            {"$ref": "#/definitions/srsim-component"},
            *rules,
        ]
    }
    if mode == "distributed":
        definition["required"] = ["slot"]
    return definition


def schema_key(schema: dict[str, Any]) -> str:
    return json.dumps(schema, sort_keys=True, separators=(",", ":"))


def node_components_schema(definition_name: str, mode: str) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "array",
        "items": {"$ref": f"#/definitions/{definition_name}"},
        "uniqueItems": True,
    }
    if mode == "standalone":
        schema["maxItems"] = 1
    elif mode == "integrated_redundant":
        schema["maxItems"] = 2
    else:
        schema["minItems"] = 2
        schema["allOf"] = [
            {
                "contains": {
                    "properties": {"slot": {"type": "string"}},
                    "required": ["slot"],
                }
            },
            {
                "contains": {
                    "properties": {"slot": {"type": "integer"}},
                    "required": ["slot"],
                }
            },
        ]
    return schema


def build_srsim_schema_module(schema: dict[str, Any], allow_unknown: bool = False) -> dict[str, Any]:
    matrix = build_clab_matrix(schema)
    values = collect_clab_values(schema, matrix)
    definitions = build_clab_definitions(values, allow_unknown)

    chassis_component_groups: dict[str, dict[str, Any]] = {}
    for chassis, chassis_entry in sorted(matrix["chassis"].items()):
        component_definition = build_chassis_component_definition(chassis, chassis_entry)
        group = chassis_component_groups.setdefault(
            schema_key(component_definition),
            {
                "definition": component_definition,
                "chassis": [],
                "mode": deployment_mode(chassis, chassis_entry),
            },
        )
        group["chassis"].append(chassis)

    node_rules: list[dict[str, Any]] = []
    for group in sorted(chassis_component_groups.values(), key=lambda group: group["chassis"][0]):
        chassis_values = group["chassis"]
        name = f"srsim-component-{definition_suffix(chassis_values[0])}"
        definitions[name] = group["definition"]
        type_condition = (
            {"const": chassis_values[0]}
            if len(chassis_values) == 1
            else {"enum": chassis_values}
        )
        node_rules.append(
            {
                "if": {
                    "properties": {"type": type_condition},
                    "required": ["type"],
                },
                "then": {
                    "properties": {
                        "components": node_components_schema(name, group["mode"])
                    }
                },
            }
        )

    definitions["srsim-node"] = {
        "type": "object",
        "properties": {
            "type": {"$ref": "#/definitions/srsim-chassis-types"},
            "components": {
                "type": "array",
                "items": {"$ref": "#/definitions/srsim-component"},
                "uniqueItems": True,
            },
        },
        "allOf": node_rules,
    }

    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": CLAB_SRSIM_SCHEMA,
        "title": "Containerlab SR-SIM hardware compatibility schema",
        "definitions": definitions,
        "x-srsim-metadata": {
            "source": schema.get("source", ""),
            "generated_at": schema.get("generated_at", ""),
            "models": len(schema.get("models", {})),
            "chassis": len(values["chassis"]),
            "default_rows": sum(len(entry["default_layout"]) for entry in matrix["chassis"].values()),
            "supported_rows": sum(len(entry["supported_hardware"]) for entry in matrix["chassis"].values()),
            "allow_unknown_values": allow_unknown,
            "component_definitions": len(chassis_component_groups),
        },
    }


def build_clab_fragment(
    schema: dict[str, Any],
    allow_unknown: bool = False,
    *,
    srsim_schema_ref: str = DEFAULT_SRSIM_SCHEMA_REF,
) -> dict[str, Any]:
    srsim_schema = build_srsim_schema_module(schema, allow_unknown)
    metadata = deepcopy(srsim_schema["x-srsim-metadata"])

    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": CLAB_FRAGMENT_SCHEMA,
        "title": "SR-SIM clab schema fragment",
        "x-srsim-schema-ref": srsim_schema_ref,
        "x-srsim-metadata": metadata,
    }


def load_hardware_schema(schema_path: str | None, source: str) -> dict[str, Any]:
    if schema_path:
        return json.loads(Path(schema_path).read_text(encoding="utf-8"))
    html = load_source(source)
    return build_schema(html, source)


def dumps_json(
    data: dict[str, Any],
    *,
    sort_keys: bool = True,
    compact: bool = False,
) -> str:
    if compact:
        return json.dumps(data, separators=(",", ":"), sort_keys=sort_keys) + "\n"
    return json.dumps(data, indent=4, sort_keys=sort_keys) + "\n"


def write_json_output(
    data: dict[str, Any],
    output: str,
    *,
    sort_keys: bool = True,
    compact: bool = False,
) -> None:
    text = dumps_json(data, sort_keys=sort_keys, compact=compact)
    if output == "-":
        print(text, end="")
        return
    Path(output).write_text(text, encoding="utf-8")
    print(f"wrote {output}")


def find_srsim_branch(clab_schema: dict[str, Any]) -> dict[str, Any]:
    branches = clab_schema["definitions"]["node-config"].setdefault("allOf", [])
    for branch in branches:
        pattern = (
            branch.get("if", {})
            .get("properties", {})
            .get("kind", {})
            .get("pattern", "")
        )
        if "nokia_srsim" in pattern:
            return branch
    branch = {
        "if": {
            "properties": {"kind": {"pattern": "(nokia_srsim)"}},
            "required": ["kind"],
        },
        "then": {"properties": {}},
    }
    branches.append(branch)
    return branch


def component_items_reference(item: dict[str, Any], ref: str) -> bool:
    if item.get("$ref") == ref:
        return True
    return any(child.get("$ref") == ref for child in item.get("anyOf", []))


def apply_clab_fragment(clab_schema: dict[str, Any], fragment: dict[str, Any]) -> dict[str, Any]:
    updated = deepcopy(clab_schema)
    srsim_schema_ref = fragment["x-srsim-schema-ref"]
    definitions = updated.setdefault("definitions", {})
    node_config = definitions["node-config"]
    component_schema = node_config["properties"]["components"]
    current_component_item = component_schema["items"]

    if "sros-component" not in definitions:
        if component_items_reference(current_component_item, "#/definitions/srsim-component"):
            raise SystemExit("cannot infer original sros component schema from already-rewired components")
        definitions["sros-component"] = deepcopy(current_component_item)

    for name in list(definitions):
        if name in CLAB_SRSIM_DEFINITION_NAMES or name.startswith("srsim-component-"):
            definitions.pop(name, None)

    component_schema["items"] = {
        "anyOf": [
            {"$ref": "#/definitions/sros-component"},
            {"$ref": f"{srsim_schema_ref}#/definitions/srsim-component"},
        ]
    }

    srsim_branch = find_srsim_branch(updated)
    srsim_branch["then"] = {
        "allOf": [
            {"$ref": f"{srsim_schema_ref}#/definitions/srsim-node"}
        ]
    }

    updated["x-srsim-metadata"] = deepcopy(fragment["x-srsim-metadata"])
    updated["x-srsim-schema-ref"] = srsim_schema_ref
    updated.pop("x-srsim-compatibility-matrix", None)
    updated.pop("x-srsim-compatibility-matrix-ref", None)

    return updated


def default_srsim_schema_output_path(schema_output: str) -> Path:
    if schema_output == "-":
        return Path(DEFAULT_SRSIM_SCHEMA_FILE)
    return Path(schema_output).with_name(DEFAULT_SRSIM_SCHEMA_FILE)


def srsim_schema_file_matches(sidecar_output_path: Path, srsim_schema: dict[str, Any]) -> bool:
    return (
        sidecar_output_path.exists()
        and json.loads(sidecar_output_path.read_text(encoding="utf-8")) == srsim_schema
    )


def cmd_generate_clab_fragment(args: argparse.Namespace) -> int:
    schema = load_hardware_schema(args.schema, args.source)
    srsim_schema_output = args.srsim_schema_output
    srsim_schema_ref = args.srsim_schema_ref or DEFAULT_SRSIM_SCHEMA_REF
    fragment = build_clab_fragment(
        schema,
        args.allow_unknown_values,
        srsim_schema_ref=srsim_schema_ref,
    )
    if srsim_schema_output:
        srsim_schema = build_srsim_schema_module(schema, args.allow_unknown_values)
        write_json_output(srsim_schema, srsim_schema_output)
    write_json_output(fragment, args.output)
    return 0


def cmd_update_clab_schema(args: argparse.Namespace) -> int:
    hardware_schema = load_hardware_schema(args.hardware_schema, args.source)
    clab_schema_path = Path(args.schema)
    schema_output = args.output or args.schema
    sidecar_output_path = (
        Path(args.srsim_schema_output)
        if args.srsim_schema_output
        else default_srsim_schema_output_path(schema_output)
    )
    srsim_schema_ref = args.srsim_schema_ref or DEFAULT_SRSIM_SCHEMA_REF

    fragment = build_clab_fragment(
        hardware_schema,
        args.allow_unknown_values,
        srsim_schema_ref=srsim_schema_ref,
    )
    srsim_schema = build_srsim_schema_module(hardware_schema, args.allow_unknown_values)
    clab_schema = json.loads(clab_schema_path.read_text(encoding="utf-8"))
    updated = apply_clab_fragment(clab_schema, fragment)
    sidecar_up_to_date = srsim_schema_file_matches(sidecar_output_path, srsim_schema)

    if args.check:
        if clab_schema == updated and sidecar_up_to_date:
            print(f"{clab_schema_path}: SR-SIM schema is up to date")
            return 0
        print(f"{clab_schema_path}: SR-SIM schema is stale")
        return 1

    if args.dry_run:
        if clab_schema == updated and sidecar_up_to_date:
            print(f"{clab_schema_path}: SR-SIM schema is already up to date")
            return 0
        print(
            f"would update {clab_schema_path}: "
            f"{len(srsim_schema['definitions'])} sidecar definitions"
        )
        return 0

    write_json_output(srsim_schema, str(sidecar_output_path))
    write_json_output(updated, schema_output, sort_keys=False)
    return 0


def cmd_generate(args: argparse.Namespace) -> int:
    html = load_source(args.source)
    schema = build_schema(html, args.source)
    output = json.dumps(schema, indent=2, sort_keys=True)
    if args.output == "-":
        print(output)
    else:
        Path(args.output).write_text(output + "\n", encoding="utf-8")
        print(f"wrote {args.output}")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    return check_schema(schema, args)


def load_topology(path: str) -> dict[str, Any]:
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a YAML mapping at document root")
    return data


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    raise TypeError(f"expected list, got {type(value).__name__}")


def component_name(node_name: str, slot: Any) -> str:
    return f"{node_name}[slot={slot if slot is not None else '?'}]"


def validate_criteria(
    *,
    schema: dict[str, Any],
    node_name: str,
    location: str,
    model_name: str,
    criteria: dict[str, str],
    strict: bool,
) -> list[str]:
    errors: list[str] = []
    try:
        _, model = find_chassis_entry(schema, model_name)
    except SystemExit as exc:
        return [f"{node_name}: {exc}"]

    mda_slot = criteria.get("_mda_slot", "")
    clean_criteria = {k: v for k, v in criteria.items() if v and not k.startswith("_")}
    supported_matches = matching_rows(model.get("supported_hardware", []), clean_criteria)
    default_matches = matching_rows(model.get("default_layout", []), clean_criteria)
    matches = supported_matches + default_matches
    if not matches:
        errors.append(
            f"{location}: unsupported tuple {json.dumps(clean_criteria, sort_keys=True)}"
        )
        return errors

    if strict and supported_matches and not default_matches:
        missing = missing_required_fields(supported_matches, clean_criteria)
        try:
            matrix_entry = build_clab_matrix(schema)["chassis"][clab_chassis_token(model_name)]
            if deployment_mode(model_name, matrix_entry) in {"standalone", "integrated_redundant"}:
                missing.discard("card")
        except KeyError:
            pass
        if missing:
            if re.fullmatch(r"[A-Za-z]", clean_criteria.get("slot", "")) and card_is_cpm(clean_criteria.get("card", "")):
                missing.discard("mda")
                missing.discard("xiom")
        if missing:
            errors.append(
                f"{location}: missing required field(s): {', '.join(sorted(missing))}; "
                f"tuple {json.dumps(clean_criteria, sort_keys=True)}"
            )

    mda_type = clean_criteria.get("mda", "")
    if mda_type and mda_slot:
        try:
            slot_number = int(mda_slot)
        except ValueError:
            slot_number = 0
        restricted_slots = mda_slot_restriction(model_name, mda_type)
        if restricted_slots and slot_number not in restricted_slots:
            errors.append(
                f"{location}: {mda_type} must use MDA slot(s) "
                f"{', '.join(str(slot) for slot in restricted_slots)}"
            )

    return errors


def validate_component(
    *,
    schema: dict[str, Any],
    node_name: str,
    chassis: str,
    component: dict[str, Any],
    strict: bool,
) -> list[str]:
    errors: list[str] = []
    slot = component.get("slot")
    location = component_name(node_name, slot)
    base = {
        "chassis": chassis,
        "slot": str(slot) if slot is not None else "",
        "sfm": str(component.get("sfm", "")),
        "card": str(component.get("type", "")),
    }

    try:
        xioms = as_list(component.get("xiom"))
        mdas = as_list(component.get("mda"))
    except TypeError as exc:
        return [f"{location}: {exc}"]

    if not xioms and not mdas:
        return validate_criteria(
            schema=schema,
            node_name=node_name,
            location=location,
            model_name=chassis,
            criteria=base,
            strict=strict,
        )

    for mda in mdas:
        if not isinstance(mda, dict):
            errors.append(f"{location}: MDA entries must be mappings")
            continue
        criteria = {
            **base,
            "mda": str(mda.get("type", "")),
            "_mda_slot": str(mda.get("slot", "")),
        }
        errors.extend(
            validate_criteria(
                schema=schema,
                node_name=node_name,
                location=f"{location}.mda[{mda.get('slot', '?')}]",
                model_name=chassis,
                criteria=criteria,
                strict=strict,
            )
        )

    for xiom in xioms:
        if not isinstance(xiom, dict):
            errors.append(f"{location}: XIOM entries must be mappings")
            continue
        try:
            xiom_mdas = as_list(xiom.get("mda"))
        except TypeError as exc:
            errors.append(f"{location}.xiom[{xiom.get('slot', '?')}]: mda {exc}")
            continue
        xiom_base = {**base, "xiom": str(xiom.get("type", ""))}
        if not xiom_mdas:
            errors.extend(
                validate_criteria(
                    schema=schema,
                    node_name=node_name,
                    location=f"{location}.xiom[{xiom.get('slot', '?')}]",
                    model_name=chassis,
                    criteria=xiom_base,
                    strict=strict,
                )
            )
            continue
        for mda in xiom_mdas:
            if not isinstance(mda, dict):
                errors.append(f"{location}.xiom[{xiom.get('slot', '?')}]: MDA entries must be mappings")
                continue
            criteria = {
                **xiom_base,
                "mda": str(mda.get("type", "")),
                "_mda_slot": str(mda.get("slot", "")),
            }
            errors.extend(
                validate_criteria(
                    schema=schema,
                    node_name=node_name,
                    location=(
                        f"{location}.xiom[{xiom.get('slot', '?')}].mda[{mda.get('slot', '?')}]"
                    ),
                    model_name=chassis,
                    criteria=criteria,
                    strict=strict,
                )
            )

    return errors


def inferred_component_slot_count(chassis: str, chassis_entry: dict[str, Any]) -> int:
    value = clab_chassis_token(chassis)
    sr_a = re.match(r"^sr-a(\d+)$", value)
    if sr_a:
        return int(sr_a.group(1))
    ixr_r = re.match(r"^ixr-r(\d+)", value)
    if ixr_r:
        return int(ixr_r.group(1))
    modular = re.match(r"^(?:ess|ixr|sr|xrs)-(\d+)(?:[a-z]*)$", value)
    if modular:
        return int(modular.group(1))
    matrix_slots = [
        int(slot)
        for row in chassis_entry.get("default_layout", []) + chassis_entry.get("supported_hardware", [])
        for slot in row.get("slot", [])
        if str(slot).isdigit()
    ]
    return max(matrix_slots, default=1)


def validate_component_list_shape(
    *,
    schema: dict[str, Any],
    node_name: str,
    chassis: str,
    components: list[Any],
) -> list[str]:
    try:
        matrix_entry = build_clab_matrix(schema)["chassis"][clab_chassis_token(chassis)]
    except KeyError:
        return []

    mode = deployment_mode(chassis, matrix_entry)
    errors: list[str] = []

    def slot_value(component: Any) -> str:
        if not isinstance(component, dict) or component.get("slot") is None:
            return ""
        return str(component.get("slot")).strip()

    slots = [slot_value(component) for component in components]
    alpha_slots = [slot for slot in slots if re.fullmatch(r"[A-Za-z]", slot)]
    numeric_slots = [slot for slot in slots if slot.isdigit()]

    if mode == "standalone":
        if len(components) > 1:
            errors.append(f"{node_name}: standalone SR-SIM chassis {chassis} accepts at most one component override")
        for component in components:
            slot = slot_value(component)
            if slot and slot.upper() != "A":
                errors.append(f"{component_name(node_name, slot)}: standalone component slot must be omitted or A")
            if isinstance(component, dict) and component.get("sfm"):
                errors.append(f"{component_name(node_name, slot)}: standalone component must not set sfm")
            if isinstance(component, dict) and component.get("xiom"):
                errors.append(f"{component_name(node_name, slot)}: standalone component must not set xiom")
        return errors

    if mode == "integrated_redundant":
        if len(components) > 2:
            errors.append(f"{node_name}: {chassis} accepts at most two redundant integrated components")
        for component in components:
            slot = slot_value(component)
            if slot and slot.upper() not in {"A", "B"}:
                errors.append(f"{component_name(node_name, slot)}: redundant integrated component slot must be A or B")
        return errors

    if components and len(components) < 2:
        errors.append(f"{node_name}: distributed SR-SIM chassis {chassis} requires at least two components")
    if components and not alpha_slots:
        errors.append(f"{node_name}: distributed SR-SIM chassis {chassis} requires a CPM component slot")
    if components and not numeric_slots:
        errors.append(f"{node_name}: distributed SR-SIM chassis {chassis} requires a numeric line-card component slot")

    max_slot = inferred_component_slot_count(chassis, matrix_entry)
    for slot in numeric_slots:
        number = int(slot)
        if number < 1 or number > max_slot:
            errors.append(f"{component_name(node_name, slot)}: slot must be between 1 and {max_slot}")

    for component, slot in zip(components, slots, strict=False):
        if isinstance(component, dict) and not slot:
            errors.append(f"{component_name(node_name, slot)}: distributed components require a slot")

    return errors


def cmd_validate_topology(args: argparse.Namespace) -> int:
    schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    topology = load_topology(args.topology)
    nodes = topology.get("topology", {}).get("nodes", {})
    if not isinstance(nodes, dict):
        raise SystemExit(f"{args.topology}: expected topology.nodes mapping")

    errors: list[str] = []
    checked = 0
    for node_name, node in nodes.items():
        if not isinstance(node, dict) or node.get("kind") != "nokia_srsim":
            continue
        components = node.get("components")
        if components is None:
            continue
        chassis = str(node.get("type", ""))
        if not chassis:
            errors.append(f"{node_name}: nokia_srsim node with components requires a type/chassis")
            continue
        try:
            component_list = as_list(components)
        except TypeError as exc:
            errors.append(f"{node_name}: components {exc}")
            continue
        errors.extend(
            validate_component_list_shape(
                schema=schema,
                node_name=node_name,
                chassis=chassis,
                components=component_list,
            )
        )
        for component in component_list:
            checked += 1
            if not isinstance(component, dict):
                errors.append(f"{node_name}: component entries must be mappings")
                continue
            errors.extend(
                validate_component(
                    schema=schema,
                    node_name=node_name,
                    chassis=chassis,
                    component=component,
                    strict=not args.no_strict,
                )
            )

    if errors:
        print(f"{args.topology}: unsupported SR-SIM hardware ({len(errors)} issue(s))")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"{args.topology}: OK ({checked} SR-SIM component(s) checked)")
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    generate = sub.add_parser("generate", help="generate JSON schema from a Nokia appendix")
    generate.add_argument("--source", default=DEFAULT_APPENDIX_URL, help="appendix URL or local HTML file")
    generate.add_argument("--output", "-o", default="srsim-supported-hardware.json", help="output JSON path or '-'")
    generate.set_defaults(func=cmd_generate)

    fragment = sub.add_parser(
        "generate-clab-fragment",
        help="generate a clab.schema.json-compatible SR-SIM schema fragment",
    )
    fragment.add_argument("--source", default=DEFAULT_APPENDIX_URL, help="appendix URL or local HTML file")
    fragment.add_argument(
        "--schema",
        help="existing srsim-supported-hardware.json to use instead of parsing --source",
    )
    fragment.add_argument("--output", "-o", default="-", help="output JSON path or '-'")
    fragment.add_argument(
        "--srsim-schema-output",
        help="write the SR-SIM compatibility schema sidecar to this path",
    )
    fragment.add_argument(
        "--srsim-schema-ref",
        help="schema reference to embed in the fragment; defaults to the raw GitHub URL used by SchemaStore",
    )
    fragment.add_argument(
        "--allow-unknown-values",
        action="store_true",
        help="keep known values as hints while allowing arbitrary strings",
    )
    fragment.set_defaults(func=cmd_generate_clab_fragment)

    update = sub.add_parser(
        "update-clab-schema",
        help="update an existing containerlab clab.schema.json with SR-SIM definitions",
    )
    update.add_argument("--schema", required=True, help="target clab.schema.json path")
    update.add_argument("--source", default=DEFAULT_APPENDIX_URL, help="appendix URL or local HTML file")
    update.add_argument(
        "--hardware-schema",
        help="existing srsim-supported-hardware.json to use instead of parsing --source",
    )
    update.add_argument(
        "--output",
        help="write updated schema to this path instead of updating --schema in place",
    )
    update.add_argument(
        "--srsim-schema-output",
        help="write the SR-SIM compatibility schema sidecar to this path; defaults to srsim-hw.schema.json next to the schema output",
    )
    update.add_argument(
        "--srsim-schema-ref",
        help="schema reference to embed in clab.schema.json; defaults to the raw GitHub URL used by SchemaStore",
    )
    update.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero when the target clab schema is not up to date",
    )
    update.add_argument(
        "--dry-run",
        action="store_true",
        help="print the update summary without writing files",
    )
    update.add_argument(
        "--allow-unknown-values",
        action="store_true",
        help="keep known values as hints while allowing arbitrary strings",
    )
    update.set_defaults(func=cmd_update_clab_schema)

    check = sub.add_parser("check", help="check a component tuple against a generated schema")
    check.add_argument("--schema", default="srsim-supported-hardware.json", help="generated JSON schema")
    check.add_argument("--model", required=True, help='model/table name or chassis, for example "7750 SR-7s"')
    check.add_argument("--chassis", help='chassis value, for example "SR-7s"; defaults to --model')
    check.add_argument("--slot", help="slot value, for example A or 1")
    check.add_argument("--sfm", help="SFM type")
    check.add_argument("--card", help="card type")
    check.add_argument("--xiom", help="XIOM type")
    check.add_argument("--mda", help="MDA type")
    check.add_argument(
        "--strict",
        action="store_true",
        help="fail when a matching row requires fields omitted from the criteria",
    )
    check.set_defaults(func=cmd_check)

    validate = sub.add_parser("validate-topology", help="validate nokia_srsim components in a clab YAML")
    validate.add_argument("topology", help="containerlab topology YAML file")
    validate.add_argument("--schema", default="srsim-supported-hardware.json", help="generated JSON schema")
    validate.add_argument(
        "--no-strict",
        action="store_true",
        help="do not require fields present in matching appendix rows, such as SFM",
    )
    validate.set_defaults(func=cmd_validate_topology)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
