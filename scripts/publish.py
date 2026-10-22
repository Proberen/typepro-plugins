"""Run on GitHub Actions: publish verified packages, then commit versioned catalogs."""

from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from urllib.parse import urlsplit

REPOSITORY = "Proberen/typepro-plugins"
MAX_PACKAGE = 8 * 1024 * 1024
MAX_RESOURCE = 4 * 1024 * 1024
MAX_CATALOG = 1024 * 1024
LEGACY_PERMISSIONS = {"commands", "panels", "editor.insert", "notes.read", "notes.write"}
API2_PERMISSIONS = LEGACY_PERMISSIONS | {"storage", "home.activity", "assistant"}
PERMISSIONS = LEGACY_PERMISSIONS | {"storage", "editor.read", "ui", "network", "secrets", "files.pick", "files.export"}
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
    if isinstance(api_version, bool) or not isinstance(api_version, (int, float)) or api_version not in (1, 2, 3):
        raise ValueError("只支持 apiVersion: 1、2 或 3")
    if "description" in manifest and (
        not isinstance(manifest["description"], str) or utf16_length(manifest["description"]) > 300
    ):
        raise ValueError("插件说明最多 300 个字符")
    allowed = LEGACY_PERMISSIONS if api_version == 1 else API2_PERMISSIONS if api_version == 2 else PERMISSIONS
    if not isinstance(permissions, list) or any(
        not isinstance(permission, str) or permission not in allowed for permission in permissions
    ):
        raise ValueError("插件权限不受支持")
    if not script.strip(JS_WHITESPACE):
        raise ValueError("main.js 不能为空")
    normalized = {
        "id": identifier,
        "name": name.strip(JS_WHITESPACE),
        "version": version,
        "apiVersion": int(api_version),
        "permissions": list(dict.fromkeys(permissions)),
    }
    if manifest.get("description"):
        normalized["description"] = manifest["description"]
    if "networkOrigins" in manifest:
        if api_version != 3 or "network" not in permissions:
            raise ValueError("网络来源需要 API 3 和 network 权限")
        origins = manifest["networkOrigins"]
        if not isinstance(origins, list) or len(origins) > 32:
            raise ValueError("网络来源最多 32 项")
        normalized["networkOrigins"] = sorted(set(normalize_origin(value) for value in origins))
    return normalized


def normalize_origin(value):
    if not isinstance(value, str) or len(value) > 2048 or any(c in value for c in ("\\", "*", "%")) or any(ord(c) <= 32 or ord(c) == 127 for c in value) or not value.isascii():
        raise ValueError("网络来源必须为 ASCII HTTPS 来源")
    try:
        url = urlsplit(value)
        host = url.hostname
        port = url.port
    except ValueError as error:
        raise ValueError("网络来源无效") from error
    if not host or url.scheme != "https" or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("网络来源只能包含协议、主机和端口")
    try:
        if ":" in host:
            host = f"[{ipaddress.IPv6Address(host).compressed}]"
        elif re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", host.rstrip(".").split(".")[-1]):
            host = str(ipaddress.IPv4Address(host))
        elif not re.fullmatch(r"[a-z0-9._-]+", host):
            raise ValueError("主机格式无效")
    except ValueError as error:
        raise ValueError("网络来源主机必须使用规范写法") from error
    origin = f"https://{host}" + (f":{port}" if port is not None and port != 443 else "")
    if value not in (origin, origin + "/"):
        raise ValueError("网络来源必须使用规范 HTTPS 来源")
    return origin


def valid_resource_path(name):
    return len(name) <= 200 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:js|css|json|txt|md|svg)", name) and all(
        part and part not in (".", "..", "__proto__", "prototype", "constructor") for part in name.split("/"))


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
    resources = directory / "files"
    if resources.exists():
        if resources.is_symlink() or not resources.is_dir() or manifest["apiVersion"] != 3:
            raise ValueError("files 资源需要 API 3 和普通目录")
        for path in sorted(resources.rglob("*")):
            if path.is_symlink():
                raise ValueError("资源不允许符号链接")
            if path.is_dir():
                continue
            name = path.relative_to(resources).as_posix()
            if not path.is_file() or not valid_resource_path(name) or path.stat().st_size > MAX_RESOURCE:
                raise ValueError(f"资源路径、类型或大小无效：{name}")
            data = path.read_bytes()
            data.decode("utf-8")
            files["files/" + name] = data
    if len(files) > 128:
        raise ValueError("插件包最多 128 个文件")
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
        raise ValueError(f"插件包超过 8 MiB：{directory.name}")
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


def read_previous(root):
    for name in ("catalog-v3.json", "catalog-v2.json", "catalog.json"):
        path = root / name
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    raise ValueError("缺少市场清单")


def catalogs(entries, updated_at, previous_views=None):
    """Keep the last compatible release for an ID that moved to a newer API."""
    previous_views = previous_views or {}
    views = {}
    for name, api in (("catalog.json", 1), ("catalog-v2.json", 2), ("catalog-v3.json", 3)):
        old = {entry["id"]: entry for entry in previous_views.get(name, {}).get("plugins", [])}
        compatible = []
        for entry in entries:
            if entry["apiVersion"] <= api:
                compatible.append(entry)
            elif entry["id"] in old and old[entry["id"]]["apiVersion"] <= api:
                compatible.append(old[entry["id"]])
        views[name] = {"schemaVersion": 1, "updatedAt": updated_at, "plugins": compatible}
    return views


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
    previous = read_previous(root)
    packages = collect_plugins(root, previous)
    entries = [entry for entry, _, _ in packages]
    updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    previous_views = {name: json.loads((root / name).read_text(encoding="utf-8"))
                      for name in ("catalog.json", "catalog-v2.json", "catalog-v3.json") if (root / name).exists()}
    views = catalogs(entries, updated_at, previous_views)
    encoded = {name: (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
               for name, catalog in views.items()}
    if any(len(raw) > MAX_CATALOG for raw in encoded.values()):
        raise ValueError("市场清单超过 1 MiB")
    changed = any(not (root / name).exists() or
                  json.loads((root / name).read_text(encoding="utf-8")).get("plugins") != catalog["plugins"]
                  for name, catalog in views.items())
    output = root / ".publish"
    output.mkdir(exist_ok=True)
    previous_by_id = {entry["id"]: entry for entry in previous["plugins"]}
    for entry, tag, package in packages:
        if previous_by_id.get(entry["id"]) != entry:
            publish_package(entry, tag, package, output)
    if not changed:
        print("市场清单无变化")
        return
    for name, raw in encoded.items():
        (root / name).write_bytes(raw)
    run("git", "config", "user.name", "github-actions[bot]")
    run("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    run("git", "add", "catalog.json", "catalog-v2.json", "catalog-v3.json")
    run("git", "commit", "-m", "Update plugin catalogs [skip ci]")
    run("git", "push", "origin", "HEAD:main")
    print("市场清单已发布")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"发布失败：{error}", file=sys.stderr)
        sys.exit(1)
