"""Run on GitHub Actions: publish verified packages, then commit one catalog."""

from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile

REPOSITORY = "Proberen/typepro-plugins"
MAX_PACKAGE = 2 * 1024 * 1024
MAX_CATALOG = 1024 * 1024
PERMISSIONS = {"commands", "panels", "editor.insert", "notes.read", "notes.write"}
ID = re.compile(r"[a-z][a-z0-9._-]{2,63}\Z", re.ASCII)
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\Z", re.ASCII)
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def utf16_length(text):
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def valid_version(version):
    if not isinstance(version, str) or len(version) > 40 or not VERSION.fullmatch(version):
        return False
    core, separator, prerelease = version.partition("-")
    identifiers = prerelease.split(".") if separator else []
    numeric = core.split(".") + [value for value in identifiers if value.isdigit()]
    return not any(not value for value in identifiers) and not any(
        len(value) > 1 and value.startswith("0") for value in numeric
    )


def validate_manifest(raw, code):
    if len(raw) > 16 * 1024 or len(code) > 512 * 1024:
        raise ValueError("manifest 最多 16 KiB，main.js 最多 512 KiB")
    manifest = json.loads(raw.decode("utf-8"))
    script = code.decode("utf-8")
    if not isinstance(manifest, dict):
        raise ValueError("manifest 必须为 JSON 对象")
    identifier = manifest.get("id")
    name = manifest.get("name")
    version = manifest.get("version")
    permissions = manifest.get("permissions")
    if not isinstance(identifier, str) or not ID.fullmatch(identifier):
        raise ValueError("插件 id 格式不正确")
    if not isinstance(name, str) or not name.strip(JS_WHITESPACE) or utf16_length(name) > 60:
        raise ValueError("插件名称应为 1–60 个字符")
    if not valid_version(version):
        raise ValueError("插件版本格式不正确")
    api_version = manifest.get("apiVersion")
    if isinstance(api_version, bool) or not isinstance(api_version, (int, float)) or api_version != 1:
        raise ValueError("只支持 apiVersion: 1")
    if "description" in manifest and (
        not isinstance(manifest["description"], str) or utf16_length(manifest["description"]) > 300
    ):
        raise ValueError("插件说明最多 300 个字符")
    if not isinstance(permissions, list) or any(
        not isinstance(permission, str) or permission not in PERMISSIONS for permission in permissions
    ):
        raise ValueError("插件权限不受支持")
    if not script.strip(JS_WHITESPACE):
        raise ValueError("main.js 不能为空")
    normalized = {
        "id": identifier,
        "name": name.strip(JS_WHITESPACE),
        "version": version,
        "apiVersion": 1,
        "permissions": list(dict.fromkeys(permissions)),
    }
    if manifest.get("description"):
        normalized["description"] = manifest["description"]
    return normalized


def package_plugin(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f"插件必须使用普通目录：{directory.name}")
    files = {}
    for name in ("manifest.json", "main.js"):
        path = directory / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"缺少普通文件：{directory.name}/{name}")
        limit = 16 * 1024 if name == "manifest.json" else 512 * 1024
        if path.stat().st_size > limit:
            raise ValueError(f"文件过大：{directory.name}/{name}")
        files[name] = path.read_bytes()
    manifest = validate_manifest(files["manifest.json"], files["main.js"])
    if directory.name != manifest["id"]:
        raise ValueError(f"目录名必须与插件 id 一致：{directory.name}")
    output = BytesIO()
    # Stored entries keep bytes reproducible across runner Python/zlib upgrades.
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    package = output.getvalue()
    if len(package) > MAX_PACKAGE or sum(map(len, files.values())) > MAX_PACKAGE:
        raise ValueError(f"插件包超过 2 MiB：{directory.name}")
    identity = f'{manifest["id"]}@{manifest["version"]}'
    tag = "plugin-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
    entry = {
        **manifest,
        "downloadUrl": f'https://github.com/{REPOSITORY}/releases/download/{tag}/{manifest["id"]}.zip',
        "sha256": hashlib.sha256(package).hexdigest(),
        "size": len(package),
    }
    return entry, tag, package


def compare_versions(left, right):
    if not valid_version(left) or not valid_version(right):
        raise ValueError("清单版本格式不正确")
    left_core, _, left_pre = left.partition("-")
    right_core, _, right_pre = right.partition("-")
    a, b = tuple(map(int, left_core.split("."))), tuple(map(int, right_core.split(".")))
    if a != b:
        return (a > b) - (a < b)
    if not left_pre or not right_pre:
        return (not left_pre) - (not right_pre)
    for a, b in zip(left_pre.split("."), right_pre.split(".")):
        if a.isascii() and a.isdigit() and b.isascii() and b.isdigit():
            a, b = int(a), int(b)
        elif a.isascii() and a.isdigit():
            return -1
        elif b.isascii() and b.isdigit():
            return 1
        if a != b:
            return (a > b) - (a < b)
    return (len(left_pre.split(".")) > len(right_pre.split("."))) - (
        len(left_pre.split(".")) < len(right_pre.split("."))
    )


def collect_plugins(root, previous):
    if previous.get("schemaVersion") != 1 or not isinstance(previous.get("plugins"), list):
        raise ValueError("现有市场清单格式不正确")
    old = {}
    for entry in previous["plugins"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or entry["id"] in old:
            raise ValueError("现有市场清单包含无效或重复插件")
        if not valid_version(entry.get("version")):
            raise ValueError("现有市场清单版本不正确")
        old[entry["id"]] = entry
    if (root / "plugins").is_symlink() or not (root / "plugins").is_dir():
        raise ValueError("plugins 必须为普通目录")
    packages = []
    for directory in sorted((root / "plugins").iterdir()):
        if directory.name.startswith("."):
            continue
        entry, tag, package = package_plugin(directory)
        prior = old.get(entry["id"])
        if prior and entry["version"] != prior["version"] and compare_versions(entry["version"], prior["version"]) <= 0:
            raise ValueError(f'更新必须提高版本号：{entry["id"]}')
        if prior and entry["version"] == prior["version"] and (
            entry["sha256"] != prior.get("sha256") or entry["size"] != prior.get("size")
        ):
            raise ValueError(f'相同版本禁止修改内容，请提高版本号：{entry["id"]}')
        packages.append((entry, tag, package))
    if len(packages) > 500:
        raise ValueError("市场清单最多 500 个插件")
    return packages


def run(*args, check=True):
    return subprocess.run(list(map(str, args)), check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def release_for(tag):
    result = run("gh", "api", f"repos/{REPOSITORY}/releases/tags/{tag}", check=False)
    if result.returncode:
        if "HTTP 404" in result.stderr:
            return None
        raise RuntimeError(f"无法读取 Release：{tag}；{result.stderr.strip()}")
    return json.loads(result.stdout)


def publish_package(entry, tag, package, output):
    name = entry["id"] + ".zip"
    path = output / name
    path.write_bytes(package)
    release = release_for(tag)
    if release is None:
        run("gh", "release", "create", tag, path, "--repo", REPOSITORY,
            "--target", run("git", "rev-parse", "HEAD").stdout.strip(),
            "--title", f'{entry["name"]} {entry["version"]}',
            "--notes", f'TypePro 插件 {entry["id"]} {entry["version"]}。')
        release = release_for(tag)
    if not any(asset["name"] == name for asset in release["assets"]):
        run("gh", "release", "upload", tag, path, "--repo", REPOSITORY)
        release = release_for(tag)
    assets = [asset for asset in release["assets"] if asset["name"] == name]
    if len(assets) != 1 or assets[0]["size"] != len(package):
        raise ValueError(f"已发布安装包大小不同，禁止覆盖：{name}")
    with tempfile.TemporaryDirectory(prefix="typepro-release-") as temporary:
        run("gh", "release", "download", tag, "--repo", REPOSITORY, "--pattern", name, "--dir", temporary)
        downloaded = Path(temporary) / name
        if downloaded.stat().st_size != len(package) or hashlib.sha256(downloaded.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"已发布安装包内容不同，禁止覆盖：{name}")
    print(f'已核对安装包：{entry["id"]} {entry["version"]}', flush=True)


def main():
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("发布只能在 Proberen/typepro-plugins 的 main 分支运行")
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    previous = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    packages = collect_plugins(root, previous)
    entries = [entry for entry, _, _ in packages]
    catalog = {"schemaVersion": 1, "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"), "plugins": entries}
    raw_catalog = (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(raw_catalog) > MAX_CATALOG:
        raise ValueError("市场清单超过 1 MiB")
    output = root / ".publish"
    output.mkdir(exist_ok=True)
    previous_by_id = {entry["id"]: entry for entry in previous["plugins"]}
    for entry, tag, package in packages:
        if previous_by_id.get(entry["id"]) != entry:
            publish_package(entry, tag, package, output)
    if previous["plugins"] == entries:
        print("市场清单无变化")
        return
    (root / "catalog.json").write_bytes(raw_catalog)
    run("git", "config", "user.name", "github-actions[bot]")
    run("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    run("git", "add", "catalog.json")
    run("git", "commit", "-m", "Update plugin catalog [skip ci]")
    run("git", "push", "origin", "HEAD:main")
    print("市场清单已发布")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"发布失败：{error}", file=sys.stderr)
        sys.exit(1)
