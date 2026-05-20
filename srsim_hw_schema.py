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
    "https://documentation.nokia.com/sr/25-7/7x50-shared/"
    "srsim-installation-setup/appendices.html"
)


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


def split_values(value: str) -> list[str]:
    value = clean_text(value)
    if is_empty_value(value):
        return []

    parts: list[str] = []
    for line in value.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line or is_empty_value(line):
            continue
        parts.append(line)
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

        if tag in {"script", "style", "nav"}:
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
        if tag in {"script", "style", "nav"} and self._skip_depth:
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


def find_header_row(rows: list[list[dict[str, Any]]]) -> tuple[int, list[str]] | None:
    known = {"chassis", "slot", "memory", "card", "mda", "xiom", "sfm"}
    for idx, row in enumerate(rows):
        keys = [normalized_key(cell["text"]) for cell in row]
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
        value = clean_text(row[idx]["text"])
        if is_empty_value(value):
            continue
        record[key] = value
    return record


def model_name_from_caption(caption: str) -> str:
    caption = re.sub(r"\s+", " ", clean_text(caption))
    caption = re.sub(r"^Table\s+\d+\.\s*", "", caption)
    caption = re.sub(r"\s+(default system layout|supported hardware)$", "", caption, flags=re.I)
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
            continue
        values = {canonical_token(v) for v in split_values(record.get(field, ""))}
        if canonical_token(expected) not in values:
            return False
    return True


def missing_required_fields(matches: list[dict[str, str]], criteria: dict[str, str]) -> set[str]:
    missing: set[str] = set()
    for row in matches:
        for field, value in row.items():
            if field == "chassis" or field in criteria or is_empty_value(value):
                continue
            missing.add(field)
    return missing


def candidate_rows(model: dict[str, Any]) -> list[dict[str, str]]:
    return model.get("supported_hardware", []) + model.get("default_layout", [])


def check_schema(schema: dict[str, Any], args: argparse.Namespace) -> int:
    model_name, model = find_model(schema, args.model)
    criteria = {
        "chassis": args.chassis or args.model,
        "slot": args.slot,
        "sfm": args.sfm,
        "card": args.card,
        "xiom": args.xiom,
        "mda": args.mda,
    }
    criteria = {k: v for k, v in criteria.items() if v}

    matches = [row for row in candidate_rows(model) if record_matches(row, criteria)]

    print(f"model: {model_name}")
    print(f"criteria: {json.dumps(criteria, sort_keys=True)}")
    if matches:
        print("supported: yes")
        print(json.dumps(matches, indent=2, sort_keys=True))
        if args.strict:
            missing = missing_required_fields(matches, criteria)
            if missing:
                print(f"strict: missing required field(s): {', '.join(sorted(missing))}")
                return 2
        return 0

    print("supported: no")
    print("known supported values:")
    print(json.dumps(model.get("supported_values", {}), indent=2, sort_keys=True))
    return 1


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
        _, model = find_model(schema, model_name)
    except SystemExit as exc:
        return [f"{node_name}: {exc}"]

    clean_criteria = {k: v for k, v in criteria.items() if v}
    matches = [row for row in candidate_rows(model) if record_matches_topology(row, clean_criteria)]
    if not matches:
        errors.append(
            f"{location}: unsupported tuple {json.dumps(clean_criteria, sort_keys=True)}"
        )
        return errors

    if strict:
        missing = missing_required_fields(matches, clean_criteria)
        if missing:
            errors.append(
                f"{location}: missing required field(s): {', '.join(sorted(missing))}; "
                f"tuple {json.dumps(clean_criteria, sort_keys=True)}"
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
        criteria = {**base, "mda": str(mda.get("type", ""))}
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
            criteria = {**xiom_base, "mda": str(mda.get("type", ""))}
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
