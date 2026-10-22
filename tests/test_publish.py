from io import BytesIO
from pathlib import Path
import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).resolve().parents[1] / "scripts/publish.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "plugins").mkdir()
        self.empty = {"schemaVersion": 1, "updatedAt": "2026-10-22T00:00:00Z", "plugins": []}
        (self.root / "catalog.json").write_text(json.dumps(self.empty), encoding="utf-8")

    def plugin(self, identifier="test.example", version="1.0.0", **overrides):
        directory = self.root / "plugins" / identifier
        directory.mkdir(exist_ok=True)
        manifest = {"id": identifier, "name": "示例插件", "version": version, "apiVersion": 1, "permissions": ["commands"]}
        manifest.update(overrides)
        (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        (directory / "main.js").write_text("await notebook.commands.register('test', '测试', async () => {});\n", encoding="utf-8")
        return directory

    def test_package_is_repeatable_and_has_only_supported_root_files(self):
        directory = self.plugin(permissions=["commands", "commands", "panels"], name="  示例插件\ufeff")
        entry, tag, data = publisher.package_plugin(directory)
        self.assertEqual((entry, tag, data), publisher.package_plugin(directory))
        self.assertEqual(entry["name"], "示例插件")
        self.assertEqual(entry["permissions"], ["commands", "panels"])
        self.assertRegex(tag, r"^plugin-[0-9a-f]{64}$")
        with zipfile.ZipFile(BytesIO(data)) as archive:
            self.assertEqual(archive.namelist(), ["manifest.json", "main.js"])
            self.assertIsNone(archive.testzip())
            self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()))
        (directory / "main.js").write_text("different source", encoding="utf-8")
        self.assertNotEqual(publisher.package_plugin(directory)[2], data)

    def test_js_utf16_limits_strict_api_and_permissions(self):
        for overrides in [{"name": "😀" * 31}, {"description": "😀" * 151}, {"apiVersion": True},
                          {"permissions": ["network"]}, {"permissions": [{}]}, {"name": "\ufeff "}]:
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    publisher.package_plugin(self.plugin(**overrides))
        directory = self.plugin(name="😀" * 30)
        self.assertEqual(publisher.package_plugin(directory)[0]["name"], "😀" * 30)
        self.assertEqual(publisher.package_plugin(self.plugin(apiVersion=1.0))[0]["apiVersion"], 1)
        (directory / "main.js").write_text("\ufeff \n", encoding="utf-8")
        with self.assertRaises(ValueError):
            publisher.package_plugin(directory)
        (directory / "main.js").write_bytes(b"a" * (512 * 1024 + 1))
        with self.assertRaises(ValueError):
            publisher.package_plugin(directory)

    def test_same_version_change_and_downgrade_are_rejected(self):
        directory = self.plugin(version="1.0.0")
        original = publisher.collect_plugins(self.root, self.empty)[0][0]
        previous = {**self.empty, "plugins": [original]}
        self.assertEqual(publisher.collect_plugins(self.root, previous)[0][0], original)
        (directory / "main.js").write_text("modified", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "相同版本"):
            publisher.collect_plugins(self.root, previous)
        self.plugin(version="0.9.9")
        with self.assertRaisesRegex(ValueError, "提高版本号"):
            publisher.collect_plugins(self.root, previous)
        self.plugin(version="1.0.1")
        self.assertEqual(publisher.collect_plugins(self.root, previous)[0][0]["version"], "1.0.1")

    def test_version_order_is_numeric_and_handles_prereleases(self):
        for newer, older in [("1.10.0", "1.9.0"), ("1.0.0", "1.0.0-rc.9"),
                             ("1.0.0-rc.10", "1.0.0-rc.2"), ("1.0.0-beta", "1.0.0-9")]:
            with self.subTest(newer=newer, older=older):
                self.assertGreater(publisher.compare_versions(newer, older), 0)
                self.assertLess(publisher.compare_versions(older, newer), 0)

    def test_market_versions_are_strict_semver(self):
        for version in ["01.0.0", "1.0.0-rc.01", "1.0.0-a..b"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                publisher.package_plugin(self.plugin(version=version))
        self.assertEqual(publisher.package_plugin(self.plugin(version="1.0.0-rc.10"))[0]["version"], "1.0.0-rc.10")

    def test_api2_permissions_require_api2(self):
        manifest = {"id": "test.example", "name": "扩展", "version": "1.0.0",
                    "apiVersion": 2, "permissions": ["storage", "home.activity", "assistant", "notes.read"]}
        validated = publisher.validate_manifest(json.dumps(manifest).encode(), b"await notebook.notes.list();")
        self.assertEqual(validated["apiVersion"], 2)
        self.assertEqual(validated["permissions"], manifest["permissions"])
        for api in [1, True, 3, "2"]:
            with self.subTest(api=api), self.assertRaises(ValueError):
                publisher.validate_manifest(json.dumps({**manifest, "apiVersion": api}).encode(), b"x")
        with self.assertRaises(ValueError):
            publisher.validate_manifest(json.dumps({**manifest, "permissions": ["shell"]}).encode(), b"x")

    def test_legacy_catalog_excludes_api2_entries_and_uses_same_timestamp(self):
        entries = [{"id": "old.example", "apiVersion": 1}, {"id": "new.example", "apiVersion": 2}]
        views = publisher.catalogs(entries, "2026-10-22T12:00:00Z")
        self.assertEqual(views["catalog.json"]["plugins"], entries[:1])
        self.assertEqual(views["catalog-v2.json"]["plugins"], entries)
        self.assertEqual(views["catalog.json"]["updatedAt"], views["catalog-v2.json"]["updatedAt"])
        self.assertEqual(entries[1]["apiVersion"], 2)

    def test_previous_catalog_prefers_v2_and_falls_back_only_when_absent(self):
        self.assertEqual(publisher.read_previous(self.root), self.empty)
        current = {**self.empty, "plugins": [{"id": "new.example", "apiVersion": 2}]}
        (self.root / "catalog-v2.json").write_text(json.dumps(current), encoding="utf-8")
        self.assertEqual(publisher.read_previous(self.root), current)
        (self.root / "catalog-v2.json").write_text("broken", encoding="utf-8")
        with self.assertRaises(ValueError):
            publisher.read_previous(self.root)

    def test_both_catalogs_are_committed_once_after_all_packages_succeed(self):
        entries = [{"id": "old.example", "apiVersion": 1}, {"id": "new.example", "apiVersion": 2}]
        packages = [(entry, entry["id"], b"bytes") for entry in entries]
        previous_cwd = Path.cwd()
        with patch.object(publisher, "__file__", str(self.root / "scripts/publish.py")), \
             patch.dict(os.environ, {"GITHUB_REPOSITORY": publisher.REPOSITORY, "GITHUB_REF": "refs/heads/main"}), \
             patch.object(publisher, "collect_plugins", return_value=packages), \
             patch.object(publisher, "publish_package") as publish, \
             patch.object(publisher, "run") as run:
            try:
                publisher.main()
            finally:
                os.chdir(previous_cwd)
        self.assertEqual(publish.call_count, 2)
        self.assertEqual(json.loads((self.root / "catalog.json").read_text())["plugins"], entries[:1])
        self.assertEqual(json.loads((self.root / "catalog-v2.json").read_text())["plugins"], entries)
        self.assertEqual(sum(call.args[:2] == ("git", "commit") for call in run.call_args_list), 1)
        run.assert_any_call("git", "add", "catalog.json", "catalog-v2.json")
        run.assert_any_call("git", "push", "origin", "HEAD:main")

    def test_failed_package_publication_leaves_catalog_untouched(self):
        self.plugin("a.example")
        self.plugin("b.example")
        before = (self.root / "catalog.json").read_bytes()
        (self.root / "catalog-v2.json").write_bytes(before)
        previous_cwd = Path.cwd()
        with patch.object(publisher, "__file__", str(self.root / "scripts/publish.py")), \
             patch.dict(os.environ, {"GITHUB_REPOSITORY": publisher.REPOSITORY, "GITHUB_REF": "refs/heads/main"}), \
             patch.object(publisher, "publish_package", side_effect=[None, ValueError("upload failed")]) as publish, \
             patch.object(publisher, "run") as run:
            try:
                with self.assertRaisesRegex(ValueError, "upload failed"):
                    publisher.main()
            finally:
                os.chdir(previous_cwd)
            self.assertEqual(publish.call_count, 2)
            run.assert_not_called()
        self.assertEqual((self.root / "catalog.json").read_bytes(), before)
        self.assertEqual((self.root / "catalog-v2.json").read_bytes(), before)

    def test_existing_release_cannot_replace_changed_bytes(self):
        directory = self.plugin()
        entry, tag, data = publisher.package_plugin(directory)
        release = {"draft": False, "assets": [{"name": entry["id"] + ".zip", "size": len(data)}]}
        calls = []

        def run(*args):
            calls.append(args)
            if args[:3] == ("gh", "release", "download"):
                folder = Path(args[args.index("--dir") + 1])
                (folder / (entry["id"] + ".zip")).write_bytes(b"x" * len(data))

        with patch.object(publisher, "release_for", return_value=release), patch.object(publisher, "run", side_effect=run):
            with self.assertRaisesRegex(ValueError, "禁止覆盖"):
                publisher.publish_package(entry, tag, data, self.root)
        self.assertEqual([args[2] for args in calls], ["download"])


if __name__ == "__main__":
    unittest.main()
