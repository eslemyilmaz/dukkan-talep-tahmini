"""Minimal JSON-Schema (draft 2020-12 subset) validator, so that the CLI can
check ``tahmin.json`` without extra dependencies. Supported keywords: type,
properties, required, additionalProperties, items, enum, const, minimum,
maximum, minItems, maxItems, pattern, anyOf, $ref (local ``#/$defs/...``).
Tests additionally validate with the reference ``jsonschema`` package when it
is installed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "tahmin.schema.json"

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "null": type(None),
}


def _is_type(v: Any, t: str) -> bool:
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "integer":
        return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())
    return isinstance(v, _TYPES[t])


def validate(instance: Any, schema: dict[str, Any], root: dict[str, Any] | None = None, path: str = "$") -> list[str]:
    root = root or schema
    errs: list[str] = []
    if "$ref" in schema:
        ref = schema["$ref"]
        assert ref.startswith("#/"), ref
        node: Any = root
        for part in ref[2:].split("/"):
            node = node[part]
        errs += validate(instance, node, root, path)
    if "anyOf" in schema:
        if all(validate(instance, s, root, path) for s in schema["anyOf"]):
            errs.append(f"{path}: anyOf alternatiflerinin hiçbiri uymuyor")
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_is_type(instance, x) for x in types):
            return errs + [f"{path}: tip {types} bekleniyordu, {type(instance).__name__} geldi"]
    if "enum" in schema and instance not in schema["enum"]:
        errs.append(f"{path}: {instance!r} izinli değerlerden değil")
    if "const" in schema and instance != schema["const"]:
        errs.append(f"{path}: {instance!r} != {schema['const']!r}")
    if _is_type(instance, "number"):
        if "minimum" in schema and instance < schema["minimum"]:
            errs.append(f"{path}: {instance} < {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errs.append(f"{path}: {instance} > {schema['maximum']}")
    if isinstance(instance, str) and "pattern" in schema and not re.search(schema["pattern"], instance):
        errs.append(f"{path}: {instance!r} desene uymuyor")
    if isinstance(instance, dict):
        for k in schema.get("required", []):
            if k not in instance:
                errs.append(f"{path}: zorunlu alan eksik: {k}")
        props = schema.get("properties", {})
        for k, v in instance.items():
            if k in props:
                errs += validate(v, props[k], root, f"{path}.{k}")
            elif "additionalProperties" in schema:
                ap = schema["additionalProperties"]
                if ap is False:
                    errs.append(f"{path}: beklenmeyen alan: {k}")
                elif isinstance(ap, dict):
                    errs += validate(v, ap, root, f"{path}.{k}")
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errs.append(f"{path}: en az {schema['minItems']} öğe")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errs.append(f"{path}: en fazla {schema['maxItems']} öğe")
        if "items" in schema:
            for i, v in enumerate(instance):
                errs += validate(v, schema["items"], root, f"{path}[{i}]")
    return errs


def load_schema(path: Path | None = None) -> dict[str, Any] | None:
    p = path or SCHEMA_PATH
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))
