from os.path import basename, exists, getsize

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

    for year in years:
        monthly_name = basename(monthly_pdf(year))
        update_pdf(monthly_name)
        if year >= 2017:
            hourly_name = basename(hourly_pdf(year))
            update_pdf(hourly_name)

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
