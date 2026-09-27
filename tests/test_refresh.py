from pathlib import Path
from shutil import copy

import yaml
from dvx.run.dvc_files import read_dvc_file

from path_data.cli import refresh
from path_data.cli.refresh import ensure_bt_year, ensure_year_pipeline

ROOT = Path(__file__).parent.parent


def copy_stages(dst: Path):
    for pattern in ['data/*.dvc', 'data/bt/*.dvc', 'www/public/*.dvc']:
        for src in ROOT.glob(pattern):
            rel = src.relative_to(ROOT)
            (dst / rel).parent.mkdir(parents=True, exist_ok=True)
            copy(src, dst / rel)


def new_deps(dvc: str) -> dict[str, dict[str, str | None]]:
    """Resolved (repo-root-relative, as `dvx run` sees them) deps whose
    recorded value is null, i.e. just added."""
    info = read_dvc_file(Path(dvc))
    return {
        kind: {k: v for k, v in deps.items() if v is None}
        for kind, deps in [('deps', info.deps), ('git_deps', info.git_deps)]
    }


def test_ensure_year_pipeline(tmp_path, monkeypatch):
    copy_stages(tmp_path)
    monkeypatch.chdir(tmp_path)
    added = []
    monkeypatch.setattr(refresh, 'run', lambda *args: added.extend(args[2:]))

    ensure_year_pipeline(2027)
    ensure_bt_year(2027)

    assert added == [
        'data/2027.pqt.dvc',
        'data/2027-day-types.pqt.dvc',
        'data/2027-hourly.pqt.dvc',
        'data/2027-hourly-total.pqt.dvc',
        'data/2027-hourly-system.pqt.dvc',
        'data/all.pqt.dvc',
        'data/all.xlsx.dvc',
        'www/public/all.pqt.dvc',
        'www/public/avg_weekday_month_grouped.json.dvc',
        'www/public/avg_weekend_month_grouped.json.dvc',
        'www/public/entries_vs_exits.pqt.dvc',
        'www/public/hourly.pqt.dvc',
        'www/public/og.png.dvc',
        'www/public/weekdays.json.dvc',
        'www/public/weekends.json.dvc',
        'data/bt/traffic.pqt.dvc',
        'data/bt/ezpass.pqt.dvc',
    ]
    months = {'deps': {'data/2027.pqt': None}, 'git_deps': {}}
    assert new_deps('data/all.pqt.dvc') == months
    assert new_deps('www/public/all.pqt.dvc') == months
    assert new_deps('www/public/hourly.pqt.dvc') == {'deps': {'data/2027-hourly.pqt': None}, 'git_deps': {}}
    assert new_deps('www/public/entries_vs_exits.pqt.dvc') == {'deps': {}, 'git_deps': {
        'data/2027-PATH-Monthly-Ridership-Report.pdf': None,
        'data/2027-PATH-Hourly-Ridership-Report.pdf': None,
    }}
    bt = {'deps': {}, 'git_deps': {'data/traffic-e-zpass-usage-2027.pdf': None}}
    assert new_deps('data/bt/traffic.pqt.dvc') == bt
    assert new_deps('data/bt/ezpass.pqt.dvc') == bt
    # Written in DVX's own spelling: `.dvc`-dir-relative within the dir, else `/`-rooted
    with open('data/all.pqt.dvc') as f:
        assert list(yaml.safe_load(f)['meta']['computation']['deps'])[-1] == '2027.pqt'
    with open('www/public/all.pqt.dvc') as f:
        assert list(yaml.safe_load(f)['meta']['computation']['deps'])[-1] == '/data/2027.pqt'
    # `bt-*.pqt` copy stages depend on `data/bt/*.pqt`, not per-year parquets
    assert new_deps('www/public/bt-traffic.pqt.dvc') == {'deps': {}, 'git_deps': {}}

    # Idempotent
    added.clear()
    ensure_year_pipeline(2027)
    ensure_bt_year(2027)
    assert added == []
