from glob import glob
from os.path import basename, exists, getsize

import yaml
from click import option
from utz import err, check, run

from path_data.cli.base import path_data, commit_opt
from path_data.paths import hourly_pdf, monthly_pdf
from path_data.utils import last_month, git_has_staged_changes, pdf_pages, verify_no_staged_changes

BASE_URL = 'https://www.panynj.gov/content/dam/path/about/statistics'


def update_pdf(name: str) -> bool:
    """Update or import a PDF via DVX, return True if content changed."""
    dvc_path = f'data/{name}.dvc'
    url = f'{BASE_URL}/{name}'
    err(f'\tchecking {name}')
    if exists(dvc_path):
        # Existing import — check for updates
        run('dvx', 'update', dvc_path)
        run('git', 'add', f'data/{name}', dvc_path)
        return True
    else:
        # New PDF — try to import (404 = doesn't exist yet)
        if check('dvx', 'import-url', '-G', url, '-o', f'data/{name}'):
            err(f'\t  imported (new)')
            run('git', 'add', f'data/{name}', dvc_path)
            return True
        else:
            err(f'\t  not found')
            return False


def ensure_year_pipeline(year: int):
    """Create computation .dvc stubs for a new year, and add the year to all.pqt deps."""
    pqt_dvc = f'data/{year}.pqt.dvc'
    day_types_dvc = f'data/{year}-day-types.pqt.dvc'
    files_created = []

    for dvc_path, out_path in [(pqt_dvc, f'{year}.pqt'), (day_types_dvc, f'{year}-day-types.pqt')]:
        if not exists(dvc_path):
            err(f'\tcreating computation stub: {dvc_path}')
            stub = {
                'outs': [{'path': out_path}],
                'meta': {
                    'computation': {
                        'cmd': f'juq papermill run monthly.ipynb -o out/monthly-{year}.ipynb -p year={year}',
                    }
                },
            }
            with open(dvc_path, 'w') as f:
                yaml.dump(stub, f, default_flow_style=False, sort_keys=False)
            files_created.append(dvc_path)

    # Add new year to deps in all .dvc files that depend on per-year parquets
    dep_key = f'data/{year}.pqt'
    dvc_files = ['data/all.pqt.dvc'] + sorted(glob('www/public/*.dvc'))
    for dvc_path in dvc_files:
        with open(dvc_path) as f:
            dvc_data = yaml.safe_load(f)
        deps = dvc_data.get('meta', {}).get('computation', {}).get('deps', {})
        if deps is not None and dep_key not in deps and any(k.startswith('data/') and k.endswith('.pqt') for k in deps):
            err(f'\tadding {dep_key} to {dvc_path} deps')
            deps[dep_key] = None
            with open(dvc_path, 'w') as f:
                yaml.dump(dvc_data, f, default_flow_style=False, sort_keys=False)
            files_created.append(dvc_path)

    if files_created:
        run('git', 'add', *files_created)


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
