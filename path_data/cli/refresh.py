import re
from glob import glob
from os.path import basename, dirname, exists, getsize, join, normpath

import yaml
from click import option
from utz import check, err, run

from path_data.cli.base import commit_opt, path_data
from path_data.paths import hourly_pdf, monthly_pdf
from path_data.utils import (
    git_has_staged_changes,
    last_month,
    pdf_pages,
    verify_no_staged_changes,
)

BASE_URL = 'https://www.panynj.gov/content/dam/path/about/statistics'
BT_BASE_URL = 'https://www.panynj.gov/content/dam/bridges-tunnels/pdfs'

# Repo-root-relative paths of per-year pipeline inputs
MONTHLY_PQT_RE = re.compile(r'data/\d{4}\.pqt')
HOURLY_PQT_RE = re.compile(r'data/\d{4}-hourly\.pqt')
MONTHLY_PDF_RE = re.compile(r'data/\d{4}-PATH-Monthly-Ridership-Report\.pdf')
HOURLY_PDF_RE = re.compile(r'data/\d{4}-PATH-[Hh]ourly-Ridership-Report\.pdf')
BT_PDF_RE = re.compile(r'data/traffic-e-zpass-usage-\d{4}\.pdf')


def resolve_dep(dvc_path: str, key: str) -> str:
    """Repo-root-relative path of a `.dvc` dep key, as `dvx run` resolves it:
    `/`-prefixed keys are repo-root-relative, others `.dvc`-dir-relative."""
    if key.startswith('/'):
        return key[1:]
    dvc_dir = dirname(dvc_path)
    return normpath(join(dvc_dir, key)) if dvc_dir else key


def spell_dep(dvc_path: str, path: str) -> str:
    """Inverse of `resolve_dep`, in DVX's own spelling: `.dvc`-dir-relative for
    paths under the `.dvc`'s dir, `/`-prefixed repo-root-relative otherwise."""
    dvc_dir = dirname(dvc_path)
    if not dvc_dir:
        return path
    if path.startswith(f'{dvc_dir}/'):
        return path[len(dvc_dir) + 1:]
    return f'/{path}'


def add_dep(dvc_path: str, deps: dict | None, pattern: re.Pattern, new_dep: str) -> bool:
    """If `deps` has an entry matching `pattern` (a per-year family, e.g. all
    monthly parquets), add `new_dep` (repo-root-relative) to it, with a null
    value (`dvx run` records the real hash on its next run). Returns whether
    `deps` changed."""
    if not deps:
        return False
    resolved = {resolve_dep(dvc_path, k) for k in deps}
    if new_dep in resolved or not any(pattern.fullmatch(p) for p in resolved):
        return False
    deps[spell_dep(dvc_path, new_dep)] = None
    return True


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

    # Add the new year to every stage that depends on the per-year parquets
    # (`{year}.pqt` / `{year}-hourly.pqt`) or parses the per-year PDFs directly
    # (e.g. `entries_vs_exits`).
    dvc_files = ['data/all.pqt.dvc', 'data/all.xlsx.dvc'] + sorted(glob('www/public/*.dvc'))
    for dvc_path in dvc_files:
        with open(dvc_path) as f:
            dvc_data = yaml.safe_load(f)
        comp = (dvc_data.get('meta') or {}).get('computation') or {}
        added = False
        for kind, pattern, new_dep in [
            ('deps', MONTHLY_PQT_RE, f'data/{year}.pqt'),
            ('deps', HOURLY_PQT_RE, f'data/{year}-hourly.pqt'),
            ('git_deps', MONTHLY_PDF_RE, f'data/{year}-PATH-Monthly-Ridership-Report.pdf'),
            ('git_deps', HOURLY_PDF_RE, f'data/{year}-PATH-Hourly-Ridership-Report.pdf'),
        ]:
            if pattern in (HOURLY_PQT_RE, HOURLY_PDF_RE) and year < 2017:
                continue
            if add_dep(dvc_path, comp.get(kind), pattern, new_dep):
                err(f'\tadding {new_dep} to {dvc_path} {kind}')
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
        git_deps = ((dvc_data.get('meta') or {}).get('computation') or {}).get('git_deps')
        if not add_dep(dvc_path, git_deps, BT_PDF_RE, pdf_dep):
            continue
        err(f'\tadding {pdf_dep} to {dvc_path} git_deps')
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
