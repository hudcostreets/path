from datetime import datetime
from glob import glob
from os.path import basename

import requests
from PyPDF2 import PdfReader
from dateutil.parser import parse
from utz import YM, check

from path_data.paths import DATA


def last_month() -> YM:
    last_pdf = max(glob(f'{DATA}/*-PATH-Monthly-Ridership-Report.pdf'))
    year = int(basename(last_pdf)[:4])
    n_pages = pdf_pages(last_pdf)
    month = n_pages - 1
    return YM(year, month)


def get_url_mtime(url: str) -> datetime | None:
    response = requests.head(url, allow_redirects=True)
    response.raise_for_status()

    # Try Last-Modified header first
    last_modified = response.headers.get('Last-Modified')
    if last_modified:
        return parse(last_modified)

    # Try Content-Date header as fallback
    content_date = response.headers.get('Date')
    if content_date:
        return parse(content_date)

    return None


def git_has_staged_changes():
    return not check('git', 'diff', '--cached', '--exit-code', log=False)


def verify_no_staged_changes():
    if git_has_staged_changes():
        raise SystemExit("Found existing staged changes; please commit or stash, then re-run")


def pdf_pages(path: str) -> int:
    with open(path, 'rb') as file:
        pdf = PdfReader(file)
        return len(pdf.pages)
