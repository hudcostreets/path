from glob import glob
from os.path import basename, exists, getsize

import yaml
from click import option
from utz import err, check, run

from path_data.cli.base import path_data, commit_opt
from path_data.paths import hourly_pdf, monthly_pdf
from path_data.utils import last_month, git_has_staged_changes, pdf_pages, verify_no_staged_changes

BASE_URL = 'https://www.panynj.gov/content/dam/path/about/statistics'
BT_BASE_URL = 'https://www.panynj.gov/content/dam/bridges-tunnels/pdfs'


def update_pdf(name: str, base_url: str = BASE_URL, data_dir: str = 'data') -> bool:
    """Update or import a PDF via DVX, return True if content changed."""
    dvc_path = f'{data_dir}/{name}.dvc'
    out_path = f'{data_dir}/{name}'
    url = f'{base_url}/{name}'
    err(f'\tchecking {name}')
    if exists(dvc_path):
        # Existing import — check for updates
        run('dvx', 'update', dvc_path)
        run('git', 'add', out_path, dvc_path)
        return True
    else:
        # New PDF — try to import (404 = doesn't exist yet)
        if check('dvx', 'import-url', '-G', url, '-o', out_path):
            err(f'\t  imported (new)')
            run('git', 'add', out_path, dvc_path)
            return True
        else:
            err(f'\t  not found')
            return False


def ensure_year_pipeline(year: int):
    """Create computation .dvc stubs for a new year, and add the year to all.pqt deps."""
    files_created = []

    # `git_deps` values left as null; dvx populates real blob SHAs on first
    # run. Without these, dvx can't see the upstream PDF/script changing and
    # the stage is treated as eternally up-to-date (the 2026 bug).
    monthly_git_deps = {
        f'{year}-PATH-Monthly-Ridership-Report.pdf': None,
        '/path_data/monthly.py': None,
    }
    hourly_git_deps = {
        f'{year}-PATH-Hourly-Ridership-Report.pdf': None,
        '/path_data/parse_hourly.py': None,
    }
    monthly_stubs = [
        (f'data/{year}.pqt.dvc',           f'{year}.pqt',            f'path-data monthly -y {year}', monthly_git_deps),
        (f'data/{year}-day-types.pqt.dvc', f'{year}-day-types.pqt',  f'path-data monthly -y {year}', monthly_git_deps),
    ]
    hourly_stubs = [
        (f'data/{year}-hourly.pqt.dvc',        f'{year}-hourly.pqt',        f'path-data parse-hourly -y {year}', hourly_git_deps),
        (f'data/{year}-hourly-total.pqt.dvc',  f'{year}-hourly-total.pqt',  f'path-data parse-hourly -y {year}', hourly_git_deps),
        (f'data/{year}-hourly-system.pqt.dvc', f'{year}-hourly-system.pqt', f'path-data parse-hourly -y {year}', hourly_git_deps),
    ]
    # Hourly PDFs are only published from 2017 onward.
    stubs = monthly_stubs + (hourly_stubs if year >= 2017 else [])

    for dvc_path, out_path, cmd, git_deps in stubs:
        if not exists(dvc_path):
            err(f'\tcreating computation stub: {dvc_path}')
            stub = {
                'outs': [{'path': out_path}],
                'meta': {
                    'computation': {
                        'cmd': cmd,
                        'git_deps': dict(git_deps),
                    }
                },
            }
            with open(dvc_path, 'w') as f:
                yaml.dump(stub, f, default_flow_style=False, sort_keys=False)
            files_created.append(dvc_path)

    # Add new year to deps in all .dvc files that depend on per-year parquets.
    # Monthly .dvc files get `data/{year}.pqt`; hourly gets `data/{year}-hourly.pqt`.
    dvc_files = ['data/all.pqt.dvc'] + sorted(glob('www/public/*.dvc'))
    for dvc_path in dvc_files:
        with open(dvc_path) as f:
            dvc_data = yaml.safe_load(f)
        comp = dvc_data.get('meta', {}).get('computation', {})
        deps = comp.get('deps', {})
        git_deps = comp.get('git_deps', {})
        added = False
        if deps:
            # Detect whether this .dvc depends on monthly or hourly parquets
            has_monthly = any(k.endswith('.pqt') and '-hourly' not in k for k in deps)
            has_hourly = any('-hourly.pqt' in k for k in deps)
            if has_monthly:
                dep_key = f'data/{year}.pqt'
                if dep_key not in deps:
                    err(f'\tadding {dep_key} to {dvc_path} deps')
                    deps[dep_key] = None
                    added = True
            if has_hourly and year >= 2017:
                dep_key = f'data/{year}-hourly.pqt'
                if dep_key not in deps:
                    err(f'\tadding {dep_key} to {dvc_path} deps')
                    deps[dep_key] = None
                    added = True
        # Stages that parse PDFs directly (e.g. entries_vs_exits) carry the
        # per-year PDFs in `git_deps`. Extend any such set so a new year's PDFs
        # invalidate the cache.
        if git_deps:
            has_monthly_pdf = any('-PATH-Monthly-Ridership-Report.pdf' in k for k in git_deps)
            has_hourly_pdf = any('-PATH-hourly-Ridership-Report.pdf' in k.lower() for k in git_deps)
            if has_monthly_pdf:
                dep_key = f'/data/{year}-PATH-Monthly-Ridership-Report.pdf'
                if dep_key not in git_deps:
                    err(f'\tadding {dep_key} to {dvc_path} git_deps')
                    git_deps[dep_key] = None
                    added = True
            if has_hourly_pdf and year >= 2017:
                dep_key = f'/data/{year}-PATH-Hourly-Ridership-Report.pdf'
                if dep_key not in git_deps:
                    err(f'\tadding {dep_key} to {dvc_path} git_deps')
                    git_deps[dep_key] = None
                    added = True
        if added:
            with open(dvc_path, 'w') as f:
                yaml.dump(dvc_data, f, default_flow_style=False, sort_keys=False)
            files_created.append(dvc_path)

    if files_created:
        run('git', 'add', *files_created)


def ensure_bt_year(year: int):
    """Declare a newly-imported B&T PDF as a `git_dep` of the parse-BT stages.

    `parse_bt.py` auto-discovers every `traffic-e-zpass-usage-*.pdf`, but
    `dvx run` only re-runs the stage when a *declared* dep changes. Without
    this, a new year's PDF is invisible to dvx and `data/bt/{traffic,ezpass}.pqt`
    are treated as eternally up-to-date (the 2026 B&T bug). Value left null;
    dvx populates the real blob SHA on first run."""
    pdf_dep = f'data/traffic-e-zpass-usage-{year}.pdf'
    files_changed = []
    for dvc_path in ('data/bt/traffic.pqt.dvc', 'data/bt/ezpass.pqt.dvc'):
        if not exists(dvc_path):
            continue
        with open(dvc_path) as f:
            dvc_data = yaml.safe_load(f)
        git_deps = dvc_data.get('meta', {}).get('computation', {}).get('git_deps')
        if git_deps is None or pdf_dep in git_deps:
            continue
        err(f'\tadding {pdf_dep} to {dvc_path} git_deps')
        git_deps[pdf_dep] = None
        with open(dvc_path, 'w') as f:
            yaml.dump(dvc_data, f, default_flow_style=False, sort_keys=False)
        files_changed.append(dvc_path)
    if files_changed:
        run('git', 'add', *files_changed)


@path_data.command
@commit_opt
@option('-y', '--year', type=int, help='Year to update PATH data PDFs for')
def refresh(commit: int, year: int | None):
    """Refresh local copies of PATH ridership data PDFs."""
    verify_no_staged_changes()

    last_ym = last_month()
    if year is not None:
        years = [year]
    else:
        # Check both current year (may have new months) and next year (may have started)
        next_ym = last_ym + 1
        years = sorted({last_ym.y, next_ym.y})
        err(f"Most recent local data: {last_ym}, checking year(s): {', '.join(map(str, years))}")

    new_years = []
    for year in years:
        monthly_name = basename(monthly_pdf(year))
        is_new = not exists(f'data/{monthly_name}.dvc')
        update_pdf(monthly_name)
        if year >= 2017:
            hourly_name = basename(hourly_pdf(year))
            update_pdf(hourly_name)
        if is_new and exists(f'data/{monthly_name}'):
            new_years.append(year)

    # Bridge & Tunnel PDFs (2011–present)
    err('=== Bridge & Tunnel PDFs ===')
    for bt_year in years:
        bt_name = f'traffic-e-zpass-usage-{bt_year}.pdf'
        bt_is_new = not exists(f'data/{bt_name}.dvc')
        update_pdf(bt_name, base_url=BT_BASE_URL)
        if bt_is_new and exists(f'data/{bt_name}'):
            ensure_bt_year(bt_year)

    # Create pipeline stages for any newly imported years
    for y in new_years:
        ensure_year_pipeline(y)

    if git_has_staged_changes():
        # Determine the latest month from the most recent monthly PDF
        last_pdf_year = max(years)
        monthly_pdf_path = monthly_pdf(last_pdf_year)
        if exists(monthly_pdf_path) and getsize(monthly_pdf_path) > 0:
            n_pages = pdf_pages(monthly_pdf_path)
            updated_month = n_pages - 1
            if updated_month > 0:
                ym_str = f'{last_pdf_year}{updated_month:02d}'
            else:
                ym_str = f'{last_pdf_year}'
        else:
            ym_str = f'{last_pdf_year}'
        if commit > 0:
            run('git', 'commit', '-m', f'Update PATH data PDFs ({ym_str})')
            if commit > 1:
                run('git', 'push')
    else:
        err("No updated PDFs found")
