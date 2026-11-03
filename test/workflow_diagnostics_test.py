"""Strict metadata projections; never use live credentials or transports."""

import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
PREFIX = "Workflow diagnostic: "


class DiagnosticTests(unittest.TestCase):
    def module(self):
        self.assertTrue(
            (ROOT / "scripts/workflow_diagnostics.py").exists(),
            "shared diagnostic projection must exist",
        )
        return importlib.import_module("workflow_diagnostics")

    def test_emit_projects_only_valid_explicit_metadata_to_one_stderr_line(self):
        module = self.module()
        sink = io.StringIO()
        with contextlib.redirect_stderr(sink):
            module.emit(
                "planner",
                "plan",
                "complete",
                version="1.2.3",
                tag="v1.2.3",
                commit="a" * 40,
                digest="b" * 64,
                count=3,
                http_status=201,
                exit_code=0,
                verified=True,
                bump="patch",
                outcome="verified",
                runtime_version="3.14.0",
                response="synthetic-credential-sentinel",
            )
        lines = sink.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith(PREFIX))
        self.assertEqual(
            json.loads(lines[0][len(PREFIX) :]),
            {
                "component": "planner",
                "stage": "plan",
                "event": "complete",
                "version": "1.2.3",
                "tag": "v1.2.3",
                "commit": "a" * 40,
                "digest": "b" * 64,
                "count": 3,
                "http_status": 201,
                "exit_code": 0,
                "verified": True,
                "bump": "patch",
                "outcome": "verified",
                "runtime_version": "3.14.0",
            },
        )

    def test_firefox_projection_fields_are_explicit_bounded_metadata(self):
        module = self.module()
        fields = {
            "observed_version": "1.2.3",
            "present": True,
            "processed": False,
            "valid": True,
            "version_matches": False,
            "file_state": "public",
            "channel": "listed",
            "schema": "unexpected",
            "error_count": 2,
            "warning_count": 3,
        }
        sink = io.StringIO()
        with contextlib.redirect_stderr(sink):
            module.emit("firefox", "validation", "response", **fields)
            module.emit(
                "firefox",
                "validation",
                "response",
                observed_version="1.2.3\nsynthetic-credential-sentinel",
                present=1,
                processed="true",
                valid=None,
                version_matches=0,
                file_state="synthetic-credential-sentinel",
                channel="synthetic-credential-sentinel",
                schema="synthetic-credential-sentinel",
                error_count=-1,
                warning_count=True,
            )
        records = [
            json.loads(line[len(PREFIX) :]) for line in sink.getvalue().splitlines()
        ]
        self.assertEqual(
            records[0],
            {
                "component": "firefox",
                "stage": "validation",
                "event": "response",
                **fields,
            },
        )
        self.assertEqual(
            records[1],
            {"component": "firefox", "stage": "validation", "event": "response"},
        )

    def test_rejected_labels_and_metadata_never_echo_values_or_raise(self):
        module = self.module()
        rejected = (
            "synthetic-credential-sentinel",
            "1.2.3\nsynthetic-credential-sentinel",
            "１２.2.3",
            "9" * 1000,
            None,
            [],
            {},
            True,
        )
        sink = io.StringIO()
        with contextlib.redirect_stderr(sink):
            for value in rejected:
                module.emit(
                    value,
                    value,
                    value,
                    version=value,
                    tag=value,
                    commit=value,
                    digest=value,
                    runtime_version=value,
                    http_status=value,
                    count=value,
                    exit_code=value,
                    verified=value,
                    bump=value,
                    outcome=value,
                    url=value,
                )
            module.emit(
                "release",
                "source",
                "complete",
                http_status=600,
                count=-1,
                exit_code=256,
                byte_count=1_000_000_001,
                draft=1,
            )
        lines = sink.getvalue().splitlines()
        self.assertEqual(len(lines), len(rejected) + 1)
        self.assertNotIn("synthetic-credential-sentinel", sink.getvalue())
        records = [json.loads(line[len(PREFIX) :]) for line in lines]
        for value, record in zip(rejected, records):
            expected = {"component": "unknown", "stage": "unknown", "event": "unknown"}
            if value is True:
                expected["verified"] = True
            self.assertEqual(record, expected)
        self.assertEqual(
            records[-1],
            {"component": "release", "stage": "source", "event": "complete"},
        )

    @unittest.skipUnless(Path("/dev/full").exists(), "requires the ENOSPC sink device")
    def test_real_stderr_write_failure_cannot_change_success_to_shutdown_exit_120(self):
        commands = (
            [sys.executable, "-B", "-c", "import sys; sys.path.insert(0, 'scripts'); from workflow_diagnostics import emit; emit('release', 'publish', 'complete'); print('completed')"],
            [sys.executable, "-B", "scripts/release_plan.py", "--help"],
        )
        for command in commands:
            with self.subTest(command=command[2:]):
                with open("/dev/full", "wb", buffering=0) as sink:
                    result = subprocess.run(command, cwd=ROOT, env={key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}, stdout=subprocess.PIPE, stderr=sink, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertTrue(result.stdout)

    def test_sink_failures_are_best_effort_but_serialization_errors_are_not_hidden(
        self,
    ):
        module = self.module()
        from unittest.mock import patch

        class Sink:
            def __init__(self, error):
                self.error = error
                self.writes = []

            def write(self, line):
                self.writes.append(line)
                raise self.error

        for error in (
            BrokenPipeError("synthetic-sink"),
            OSError("synthetic-sink"),
            ValueError("I/O operation on closed file."),
            ValueError("unrelated invalid sink"),
        ):
            sink = Sink(error)
            with patch.object(sys, "stderr", sink):
                module.write_record("Preserved prefix: ", {"safe": True})
                module.emit("release", "publish", "complete")
            self.assertEqual(len(sink.writes), 2)
            self.assertTrue(sink.writes[0].startswith("Preserved prefix: "))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(TypeError):
            module.write_record("Preserved prefix: ", {"bad": object()})



if __name__ == "__main__":
    unittest.main()
