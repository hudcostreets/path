"""Aggregate per-month per-station entries/exits avg-per-day-of-type from the
hourly PDF + day-type counts from the monthly PDF. Writes
`www/public/entries_vs_exits.json` for the dashboard mirror-bars chart."""

import json
import re
import subprocess
from os.path import join
from pathlib import Path

from click import option
from pypdf import PdfReader
from utz import err, now

from path_data.cli.base import path_data
from path_data.parse_hourly import STATIONS as HOURLY_STATIONS, SECTION_PAGES
from path_data.paths import DATA, WWW_PUBLIC, hourly_pdf, monthly_pdf


# Per-station stations list excludes the "System-wide" entry that lives in
# `path_data.parse_hourly.STATIONS` (which has 14 entries: 13 stations + the
# Systemwide summary). The hourly PDF section layout still uses the 14-slot
# offset, so SECTION_PAGES (= 15) is correct.
STATIONS = [s for s in HOURLY_STATIONS if s != 'System-wide']
DAY_TYPES = ('weekday', 'saturday', 'sunday', 'holiday')


def _pdftotext(pdf: str, page: int) -> str:
    return subprocess.check_output(
        ['pdftotext', '-layout', '-f', str(page), '-l', str(page), pdf, '-'],
        text=True,
    )


def _parse_total_row(pdf: str, page: int) -> dict[str, int]:
    """Parse the per-station Total row. Months with 0 holidays may render
    only 6 numbers (no holiday columns); pad with zeros in that case."""
    txt = _pdftotext(pdf, page)
    m = re.search(r'^Total\s+([\d,\s]+)$', txt, re.MULTILINE)
    nums = [int(n.replace(',', '')) for n in m.group(1).split()]
    if len(nums) == 6:
        nums = nums + [0, 0]
    assert len(nums) == 8, (page, nums)
    return {
        'weekday_entries':  nums[0],
        'saturday_entries': nums[1],
        'sunday_entries':   nums[2],
        'weekday_exits':    nums[3],
        'saturday_exits':   nums[4],
        'sunday_exits':     nums[5],
        'holiday_entries':  nums[6],
        'holiday_exits':    nums[7],
    }


def _parse_per_month_day_counts(monthly_pdf_path: str) -> dict[int, dict[str, int]]:
    """Per-month day-type counts from each monthly per-month page.
    Returns {month_idx (1-based): {weekday, saturday, sunday, holiday}}.

    Handles two layouts seen in the wild:
      - 2017-2022 Jan/Feb/Mar/Apr + 2023+ all months: `Totals  20  4  5  2`
        — inline with the `Totals` label.
      - 2017-2022 May-Dec: header row `Totals  Weekday Saturday Sunday Holiday`
        with the counts dropped onto the next line, prefixed by
        `NEW YORK STATIONS`."""
    n_pages = len(PdfReader(monthly_pdf_path).pages)
    per_month: dict[int, dict[str, int]] = {}
    for month in range(1, n_pages):  # last page is the YTD summary
        txt = _pdftotext(monthly_pdf_path, month)
        m = re.search(r'Totals\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s', txt)
        if not m:
            m = re.search(r'NEW YORK STATIONS\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s', txt)
        if not m:
            continue
        per_month[month] = dict(zip(DAY_TYPES, map(int, m.groups())))
    return per_month


def _build_year(year: int) -> dict:
    """Parse the hourly+monthly PDFs for `year` into a partial JSON payload
    ({all_yms, months}). Raises if either PDF is missing."""
    h_pdf = hourly_pdf(year)
    m_pdf = monthly_pdf(year)
    if not Path(h_pdf).exists():
        raise SystemExit(f"Hourly PDF not found: {h_pdf}")
    if not Path(m_pdf).exists():
        raise SystemExit(f"Monthly PDF not found: {m_pdf}")

    month_days = _parse_per_month_day_counts(m_pdf)
    months = [f'{year}-{mo:02d}' for mo in sorted(month_days.keys())]
    err(f'{year}: {len(months)} months: {months[0]}..{months[-1]}')

    out = {'all_yms': months, 'months': {}}
    for month_idx, ym in zip(sorted(month_days.keys()), months):
        section_start = 4 + month_idx * SECTION_PAGES
        stations_data = []
        for i, station in enumerate(STATIONS):
            page = section_start + i
            avgs = _parse_total_row(h_pdf, page)
            stations_data.append({
                'name': station,
                'by_day_type': {
                    dt: {
                        'avg_entries': avgs[f'{dt}_entries'],
                        'avg_exits': avgs[f'{dt}_exits'],
                    }
                    for dt in DAY_TYPES
                },
            })
        out['months'][ym] = {
            'days': month_days[month_idx],
            'stations': stations_data,
        }
    return out


def _available_years() -> list[int]:
    """Years with both an hourly and a monthly PDF on disk. Full-year hourly
    PDFs start in 2017 (earlier files are single-month snapshots)."""
    years = []
    for y in range(2017, now().year + 1):
        if Path(hourly_pdf(y)).exists() and Path(monthly_pdf(y)).exists():
            years.append(y)
    return years


def run_entries_vs_exits(years: list[int]) -> None:
    out = {'all_yms': [], 'months': {}}
    for y in sorted(years):
        part = _build_year(y)
        out['all_yms'].extend(part['all_yms'])
        out['months'].update(part['months'])
    out['all_yms'].sort()

    out_path = join(WWW_PUBLIC, 'entries_vs_exits.json')
    Path(out_path).write_text(json.dumps(out, indent=2) + '\n')
    err(f"wrote {out_path} ({Path(out_path).stat().st_size:,} bytes, {len(out['months'])} months over {len(years)} years)")


@path_data.command('entries-vs-exits')
@option('-y', '--year', 'years', type=int, multiple=True, help="Year(s) to parse. Repeatable; unset → all years with both hourly + monthly PDFs (2017+).")
def entries_vs_exits(years: tuple[int, ...]):
    """Aggregate entries-vs-exits totals per station + day-type, write
    `www/public/entries_vs_exits.json` for the dashboard mirror-bars chart."""
    selected = list(years) if years else _available_years()
    if not selected:
        raise SystemExit("No years with both hourly + monthly PDFs on disk")
    run_entries_vs_exits(selected)
