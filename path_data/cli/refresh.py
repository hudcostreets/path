from os.path import basename
from os.path import join

import requests
from click import option
from utz import err, run

from path_data.cli.base import path_data, commit_opt
from path_data.paths import hourly_pdf, monthly_pdf
from path_data.utils import last_month, git_has_staged_changes, pdf_pages, verify_no_staged_changes


@path_data.command
@commit_opt
@option('-y', '--year', type=int, help='Year to update PATH data PDFs for')
def refresh(commit: int, year: int | None):
    """Refresh local copies of PATH ridership data PDFs."""
    verify_no_staged_changes()

    last_ym = last_month()
    if year is None:
        next_ym = last_ym + 1
        year = next_ym.y
        err(f"Checking {year} (most recent local data: {last_ym})")

    monthly_pdf_path = monthly_pdf(year)
    pdf_paths = [
        monthly_pdf_path,
        *([hourly_pdf(year)] if year >= 2017 else [])
    ]
    for pdf_path in pdf_paths:
        name = basename(pdf_path)
        dst = join('data', name)
        src = f'https://www.panynj.gov/content/dam/path/about/statistics/{name}'
        err(f'\tupdating {name}')
        response = requests.get(src)
        response.raise_for_status()
        with open(dst, 'wb') as f:
            f.write(response.content)
        run('git', 'add', dst)

    if git_has_staged_changes():
        if year == last_ym.year:
            n_pages = pdf_pages(monthly_pdf_path)
            updated_month = n_pages - 1
            ym_str = f'{year}{updated_month:02d}'
        else:
            ym_str = f'{year}'
        if commit > 0:
            run('git', 'commit', '-m', f'Update PATH data PDFs ({ym_str})')
            if commit > 1:
                run('git', 'push')
    else:
        err("No updated PDFs found")
