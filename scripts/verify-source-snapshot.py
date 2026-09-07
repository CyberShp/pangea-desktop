"""Verify the staged Agent with the same Python runtime used by Desktop.

Run locally with the Agent src directory on PYTHONPATH. The Windows assembly
entrypoint runs this script against its embedded Python and staged Agent.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pangea_agent.documents import source_snapshot as snapshot


def windows_error(code: int) -> OSError:
    error = PermissionError(13, f"simulated WinError {code}")
    error.winerror = code
    return error


@contextmanager
def simulated_rename(rename, *, platform="nt"):
    # Replacing global os.name makes pathlib instantiate WindowsPath on Linux.
    # Give only the module under test a separate os namespace instead.
    module_os = SimpleNamespace(**vars(os))
    module_os.name = platform
    module_os.rename = rename
    with (
        patch.object(snapshot, "os", module_os),
        patch.object(snapshot, "_filesystem_path", os.fspath),
        patch.object(snapshot.time, "sleep") as sleep,
    ):
        yield sleep


class SourceSnapshotAcceptance(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pangea-snapshot-check-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repository = self.root / "source repository"
        self.repository.mkdir()
        self.contents = {
            "driver.c": b"int driver(void) { return 7; }\n",
            "include/driver.h": b"int driver(void);\n",
        }
        for relative, content in self.contents.items():
            path = self.repository / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.scope = [{"raw": ".", "verified": str(self.repository)}]
        self.target = self.root / "inputs" / "source"

    def create(self, target=None):
        return snapshot.create_source_snapshot(
            self.repository, self.scope, target or self.target,
            repo_id="snapshot-check-repository", run_id="snapshot-check-run",
        )

    def verify(self, target=None):
        return snapshot.verify_source_snapshot(
            target or self.target,
            repo_id="snapshot-check-repository", run_id="snapshot-check-run",
        )

    def test_real_copy_and_manifest_hashes(self):
        manifest = self.create()
        self.assertEqual(self.verify(), manifest)
        self.assertEqual(manifest["file_count"], len(self.contents))
        for item in manifest["files"]:
            content = self.contents[item["path"]]
            self.assertEqual(item["sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual(item["size"], len(content))
            self.assertEqual(
                (self.target / "repository" / item["path"]).read_bytes(), content,
            )
        (self.target / "repository" / "driver.c").write_bytes(b"changed\n")
        with self.assertRaises(ValueError):
            self.verify()

    def test_transient_windows_errors_retry_same_copy(self):
        for code in (5, 32, 33):
            with self.subTest(winerror=code):
                target = self.target.with_name(f"source-{code}")
                calls = []

                def rename(source, destination):
                    calls.append((source, destination))
                    if len(calls) <= 2:
                        raise windows_error(code)
                    os.rename(source, destination)

                with (
                    simulated_rename(rename) as sleep,
                    patch.object(snapshot.shutil, "copy2", wraps=snapshot.shutil.copy2) as copy,
                ):
                    manifest = self.create(target)
                self.assertEqual(self.verify(target), manifest)
                self.assertEqual(len(calls), 3)
                self.assertEqual(len(set(calls)), 1, "Retries must reuse the same staging directory")
                self.assertEqual(copy.call_count, len(self.contents), "A retry must not recopy sources")
                self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.05, 0.1])

    def test_persistent_access_denial_is_bounded_and_preserves_cause(self):
        error = windows_error(5)
        rename = Mock(side_effect=error)
        with (
            simulated_rename(rename) as sleep,
            patch.object(snapshot.shutil, "copy2", wraps=snapshot.shutil.copy2) as copy,
        ):
            with self.assertRaises(OSError) as caught:
                self.create()
        self.assertIs(caught.exception.__cause__, error)
        self.assertIn("stage=publish_snapshot", str(caught.exception))
        self.assertEqual(rename.call_count, 6)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.05, 0.1, 0.2, 0.4, 0.8])
        self.assertEqual(len({call.args for call in rename.call_args_list}), 1)
        self.assertEqual(copy.call_count, len(self.contents))
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.target.parent.iterdir()), [], "Failed staging must be cleaned up")

    def test_unrelated_errors_and_non_windows_errors_are_not_retried(self):
        for platform, code in (("nt", 112), ("posix", 5)):
            with self.subTest(platform=platform, winerror=code):
                error = windows_error(code)
                rename = Mock(side_effect=error)
                with simulated_rename(rename, platform=platform) as sleep:
                    with self.assertRaises(OSError) as caught:
                        self.create()
                self.assertIs(caught.exception.__cause__, error)
                rename.assert_called_once()
                sleep.assert_not_called()
                self.assertFalse(self.target.exists())

    def test_existing_target_is_never_replaced(self):
        self.target.mkdir(parents=True)
        marker = self.target / "previous-run.txt"
        marker.write_text("keep previous run", encoding="utf-8")
        staging = self.root / "staging"
        staging.mkdir()
        rename = Mock(wraps=os.rename)
        with simulated_rename(rename) as sleep:
            with self.assertRaises(FileExistsError):
                snapshot._publish_snapshot(staging, self.target)
        rename.assert_not_called()
        sleep.assert_not_called()
        self.assertTrue(staging.is_dir())
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep previous run")

    def test_target_appearing_during_retry_is_not_replaced(self):
        self.target.parent.mkdir()
        staging = self.root / "staging"
        staging.mkdir()
        marker = self.target / "another-run.txt"

        def destination_appears(source, destination):
            Path(destination).mkdir()
            marker.write_text("keep another run", encoding="utf-8")
            raise windows_error(32)

        rename = Mock(side_effect=destination_appears)
        with simulated_rename(rename):
            with self.assertRaises(FileExistsError):
                snapshot._publish_snapshot(staging, self.target)
        rename.assert_called_once()
        self.assertTrue(staging.is_dir())
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep another run")

    @unittest.skipUnless(os.name == "nt", "Requires a real Windows directory handle")
    def test_real_windows_directory_handle_is_released_before_retry(self):
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        publish = snapshot._publish_snapshot
        real_sleep = snapshot.time.sleep

        def publish_with_open_handle(staging, target):
            # GENERIC_READ, SHARE_READ | SHARE_WRITE (no SHARE_DELETE),
            # OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS for a directory handle.
            # Attribute-only access does not enforce the sharing restriction.
            handle = kernel32.CreateFileW(
                snapshot._filesystem_path(staging), 0x80000000, 0x03, None, 3, 0x02000000, None,
            )
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())

            def release_handle():
                nonlocal handle
                if handle is not None:
                    if not kernel32.CloseHandle(handle):
                        raise ctypes.WinError(ctypes.get_last_error())
                    handle = None

            def release_and_wait(delay):
                release_handle()
                real_sleep(delay)

            try:
                # Release only after the actual Windows rename fails. No timing
                # race or worker thread is needed; retain bounded waits in case
                # a background scanner briefly holds an additional handle.
                with patch.object(snapshot.time, "sleep", side_effect=release_and_wait) as sleep:
                    publish(staging, target)
                self.assertGreaterEqual(sleep.call_count, 1)
                self.assertEqual(sleep.call_args_list[0].args, (0.05,))
            finally:
                release_handle()

        with patch.object(snapshot, "_publish_snapshot", side_effect=publish_with_open_handle):
            manifest = self.create()
        self.assertEqual(self.verify(), manifest)


if __name__ == "__main__":
    unittest.main(verbosity=2)
