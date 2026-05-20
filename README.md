# SR-SIM Hardware Schema

Generate a local JSON schema from the Nokia SR-SIM appendix tables and query
whether a chassis/card/SFM/XIOM/MDA tuple appears in the documented support
matrix.

## Generate

```sh
uv run srsim-hw-schema generate \
  --source https://documentation.nokia.com/sr/26-3/7x50-shared/srsim-installation-setup/appendices.html \
  --output srsim-supported-hardware.json
```

`--source` can also point at a saved local HTML file.

## Check

```sh
uv run srsim-hw-schema check \
  --schema srsim-supported-hardware.json \
  --model "7750 SR-7s" \
  --chassis SR-7s \
  --sfm sfm-s \
  --card xcm-7s \
  --xiom iom-s-1.5t \
  --mda ms2-400gb-qsfpdd+2-100gb-qsfp28
```

Add `--strict` to fail when the matching row requires a field you did not
provide. For example, checking the SR-7s `xcm-7s` XIOM MDA tuple without
`--sfm sfm-s` exits with status `2` and reports the missing `sfm` field.

## Validate A Containerlab Topology

```sh
uv run srsim-hw-schema validate-topology \
  --schema srsim-supported-hardware.json \
  ../srsim.clab.yml
```

Topology validation checks `topology.nodes.*` entries with
`kind: nokia_srsim` and validates their `components` list against the schema.
It is strict by default so missing required fields, such as `sfm` for an
`xcm-7s` XIOM tuple, are reported. Use `--no-strict` to only check explicit
values that are present in the YAML.

The generated JSON keeps both the raw normalized rows and per-model aggregate
values so it can be consumed by other tools.
