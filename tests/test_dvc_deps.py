"""Repo-consistency checks on the DVX stage declarations.

`dvx run` orders stages, and decides freshness, purely from each `.dvc`'s
declared `deps` / `git_deps`. A dep path that resolves to nothing (e.g.
`data/2012.pqt` written in `www/public/all.pqt.dvc`, which DVX resolves
relative to the `.dvc`'s dir → `www/public/data/2012.pqt`) silently drops the
ordering edge and makes the stage permanently stale."""
from os import listdir
from pathlib import Path
from subprocess import check_output

import yaml
from dvx.run.dvc_files import read_dvc_file

ROOT = Path(__file__).parent.parent

# Upstream artifacts that are produced by hand, not by a DVX stage
MANUAL_ARTIFACTS = {
    'www/public/pie-map-24h.gif',
    'www/public/pie-map-24h.mp4',
}


def tracked_dvc_files() -> list[str]:
    return check_output(['git', 'ls-files', '*.dvc'], cwd=ROOT, text=True).split()


def exists_exact(path: str) -> bool:
    """Case-sensitive `exists` (macOS' default FS isn't; CI's is)."""
    cur = ROOT
    for part in Path(path).parts:
        if not cur.is_dir() or part not in listdir(cur):
            return False
        cur = cur / part
    return True


def stage_deps() -> list[tuple[str, str, str]]:
    """`(dvc, kind, dep)` for every declared dep, resolved repo-root-relative
    the way `dvx run` (cwd = repo root) sees them."""
    deps = []
    for dvc in tracked_dvc_files():
        info = read_dvc_file(Path(dvc))
        assert info is not None, dvc
        for kind, ds in [('deps', info.deps), ('git_deps', info.git_deps)]:
            deps += [(dvc, kind, dep) for dep in ds]
    return deps


def test_deps_resolve(monkeypatch):
    monkeypatch.chdir(ROOT)
    missing = [
        (dvc, kind, dep)
        for dvc, kind, dep in stage_deps()
        if not (exists_exact(dep) or exists_exact(f'{dep}.dvc'))
    ]
    assert missing == []


def test_md5_deps_have_producers(monkeypatch):
    """Every md5-`deps` entry is an import or a stage output with a `cmd`;
    otherwise `dvx run` never re-records its md5 and downstream stages read a
    stale hash (e.g. `data/2026-hourly.pqt`, a co-output whose `.dvc` had no
    `computation`)."""
    monkeypatch.chdir(ROOT)
    orphans = []
    for dvc, kind, dep in stage_deps():
        if kind != 'deps' or dep in MANUAL_ARTIFACTS:
            continue
        with open(f'{dep}.dvc') as f:
            d = yaml.safe_load(f)
        is_import = bool(d.get('deps'))
        has_cmd = bool(((d.get('meta') or {}).get('computation') or {}).get('cmd'))
        if not (is_import or has_cmd):
            orphans.append((dvc, dep))
    assert orphans == []
