"""Bounded, explicitly projected workflow metadata on stderr, never raw I/O."""

import json
import os
import re
import sys

COMPONENTS = frozenset("release planner firefox chrome dispatch runtime".split())
STAGES = frozenset(
    "context plan tag build provenance draft asset_upload asset_verify publish release_readback dispatch verify_release prerequisites receipt preflight upload validation version_create readback source assets archive manifest runtime metadata".split()
)
EVENTS = frozenset("start response complete failed skipped uncertain".split())
OUTCOMES = frozenset(
    "verified created existing published absent unchanged prepared pending rejected unknown".split()
)
VERSION = r"[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}"
STRINGS = {
    "version": VERSION,
    "observed_version": VERSION,
    "tag": "v" + VERSION,
    "runtime_version": r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:(?:a|b|rc)[0-9]{1,3})?",
    "commit": r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}",
    "digest": r"[0-9a-fA-F]{64}",
    "tag_object": r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}",
}
INTEGERS = {
    "count": (0, 1_000_000),
    "error_count": (0, 1_000_000),
    "warning_count": (0, 1_000_000),
    "asset_count": (0, 1_000_000),
    "release_count": (0, 1_000_000),
    "byte_count": (0, 1_000_000_000),
    "http_status": (100, 599),
    "exit_code": (-255, 255),
}
BOOLEANS = frozenset(
    "verified draft prerelease write present processed valid version_matches".split()
)
ENUMS = {
    "file_state": frozenset("public unreviewed disabled unknown".split()),
    "channel": frozenset("listed unlisted unknown".split()),
    "schema": frozenset("unexpected unknown".split()),
    "bump": frozenset("major minor patch none".split()),
    "outcome": OUTCOMES,
}


def write_record(prefix, record):
    """Internal writer for already-safe records; serialization errors propagate."""
    line = prefix + json.dumps(record, sort_keys=True, ensure_ascii=True) + "\n"
    data = line.encode("utf-8")
    try:
        descriptor = sys.stderr.fileno()
    except (AttributeError, OSError, ValueError):
        descriptor = None
    try:
        if type(descriptor) is int and descriptor >= 0:
            # Bypass TextIO buffering so a failed sink cannot force exit 120 at shutdown.
            os.write(descriptor, data)
        elif sys.stderr is not None:
            sys.stderr.write(line)
    except (OSError, ValueError):
        # Only sink operations are guarded; serialization errors remain visible.
        pass


def emit(component, stage, event, **fields):
    """Omit rejected metadata, including its value; unknown labels stay static."""
    record: dict[str, object] = {
        "component": component
        if type(component) is str and component in COMPONENTS
        else "unknown",
        "stage": stage if type(stage) is str and stage in STAGES else "unknown",
        "event": event if type(event) is str and event in EVENTS else "unknown",
    }
    for key, value in fields.items():
        if (
            key in STRINGS
            and type(value) is str
            and re.fullmatch(STRINGS[key], value, re.ASCII)
        ):
            record[key] = value
        elif (
            key in INTEGERS
            and type(value) is int
            and INTEGERS[key][0] <= value <= INTEGERS[key][1]
        ):
            record[key] = value
        elif key in BOOLEANS and type(value) is bool:
            record[key] = value
        elif key in ENUMS and type(value) is str and value in ENUMS[key]:
            record[key] = value
    write_record("Workflow diagnostic: ", record)
