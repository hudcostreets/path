from os.path import basename, exists, getsize
from os.path import join

import requests
from click import option
from utz import err, run

from path_data.cli.base import path_data, commit_opt
from path_data.paths import hourly_pdf, monthly_pdf
from path_data.utils import last_month, git_has_staged_changes, pdf_pages, verify_no_staged_changes

BASE_URL = 'https://www.panynj.gov/content/dam/path/about/statistics'


def download_pdf(name: str) -> bool:
    """Download a PDF from PANYNJ, return True if content changed."""
    dst = join('data', name)
    src = f'{BASE_URL}/{name}'
    err(f'\tchecking {name}')
    response = requests.get(src)
    if response.status_code == 404:
        err(f'\t  not found (404)')
        return False
    response.raise_for_status()
    new_content = response.content
    if exists(dst) and open(dst, 'rb').read() == new_content:
        err(f'\t  unchanged')
        return False
    err(f'\t  updated ({len(new_content)} bytes)')
    with open(dst, 'wb') as f:
        f.write(new_content)
    run('git', 'add', dst)
    return True


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
        changed = download_pdf(monthly_name)
        if year >= 2017:
            hourly_name = basename(hourly_pdf(year))
            download_pdf(hourly_name)

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
