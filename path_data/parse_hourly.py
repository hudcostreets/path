"""Parse a year's PATH hourly ridership PDF into:
- `data/<year>-hourly.pqt`         (per-station hourly entry/exit counts)
- `data/<year>-hourly-total.pqt`   (per-station daily totals)
- `data/<year>-hourly-system.pqt`  (system-wide hourly counts)

Ported from `parse-hourly.ipynb`."""

import json
import re
from os.path import basename, dirname, exists, join, relpath

import pandas as pd
from click import option
from joblib import Parallel, delayed
from tabula import read_pdf
from utz import err, to_dt

from path_data.cli.base import path_data
from path_data.paths import DATA, TEMPLATES, hourly_pdf


STATIONS = [
    'Christopher St.',
    '9th Street',
    '14th Street',
    '23rd Street',
    '33rd Street',
    'WTC',
    'Newark',
    'Harrison',
    'Journal Square',
    'Grove Street',
    'Exchange Place',
    'Newport',
    'Hoboken',
    'System-wide',
]
STATION_OFFSETS = {station: idx for idx, station in enumerate(STATIONS)}
SECTION_PAGES = len(STATIONS) + 1  # stations + title page

BASED_ON_RE = re.compile(r'\(Based on (?P<month>\w+) (?P<year>\d{4}) Turnstile Count\)')
CROSS_HONOR_RE = re.compile(r'\(Cross[‐\-]honor (?:Entry )?Count not Included\)')

TEMPLATE_PATH = join(TEMPLATES, '2022-PATH-hourly-Ridership-Report.tabula-template.json')


def _month_page_range(month: int) -> tuple[int, int]:
    start = 4 + month * SECTION_PAGES
    return start, start + len(STATIONS)


def _clean(s: str) -> str:
    """Normalize U+2010 (‐, 8210) → ASCII hyphen. Appears in various titles."""
    return s.replace('‐', '-')


def _read_station_month_tables(pdf: str, rects: list[dict], year: int, month: int, station: str) -> list:
    station_offset = STATION_OFFSETS[station]
    start, _ = _month_page_range(month)
    pg = start + station_offset
    month_name = to_dt(f'{year:d}-{month:02d}').strftime('%B')
    err(f'Reading {basename(pdf)} pg.{pg}: {month_name}, {station}')
    return [
        read_pdf(
            pdf,
            pages=pg,
            area=[rect[k] for k in ['y1', 'x1', 'y2', 'x2']],
            pandas_options={'header': None},
        )
        for rect in rects
    ]


def _to_hour(r) -> int:
    hour, AM = r['hour'], r['am'] == 'AM'
    return (0 if hour == 12 else hour) + (0 if AM else 12)


def _coerce_numeric(hrs: pd.DataFrame) -> pd.DataFrame:
    """Column dtypes vary across PDFs/pandas versions; coerce the non-key
    columns (everything after Year/Month/Station/Hour) to int."""
    for k in hrs.columns[4:]:
        col = hrs[k]
        dt = col.dtype
        if pd.api.types.is_object_dtype(dt) or pd.api.types.is_string_dtype(dt):
            hrs[k] = col.astype(str).str.replace(',', '').astype(int)
        elif pd.api.types.is_float_dtype(dt):
            hrs[k] = col.astype(int)
        elif pd.api.types.is_integer_dtype(dt):
            pass
        else:
            raise RuntimeError(f'Unexpected dtype, col {k}: {dt}')
    return hrs


def parse_station_month(pdf: str, rects: list[dict], year: int, month: int, station: str) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Parse one (station, month) page → (hourly, totals, system_wide) frames."""
    [hrs], [header], [actual_station] = _read_station_month_tables(pdf, rects, year, month, station)
    [[actual_station]] = actual_station.values
    actual_station = _clean(actual_station)
    if actual_station != station:
        raise RuntimeError(f"Parsed station {actual_station!r} != {station!r}")

    [[title], [based_on_msg], [cross_msg]] = header.values
    if _clean(title) != 'PATH - Average Hourly Entry and Exit Counts by Station':
        raise RuntimeError(f'Unexpected title: {title!r}')

    m = BASED_ON_RE.fullmatch(based_on_msg)
    if not m:
        raise RuntimeError(f'Unrecognized "based on" message: {based_on_msg!r}')
    parsed_year = int(m['year'])
    if year != parsed_year:
        raise RuntimeError(f"Parsed year {parsed_year} != {year}")
    parsed_month = m['month']
    month_name = to_dt(f'{year:d}-{month:02d}').strftime('%B')
    if parsed_month != month_name:
        raise RuntimeError(f"Parsed month {parsed_month!r} != {month}")

    if not CROSS_HONOR_RE.fullmatch(cross_msg):
        raise RuntimeError(f'Unexpected cross-honor message: {cross_msg!r}')

    hrs = hrs.dropna(axis=1, how='all')
    headers = (hrs.iloc[0].fillna('') + ' ' + hrs.iloc[1]).str.strip()
    hrs = hrs.copy().iloc[2:]
    hrs = hrs.dropna(axis=1, how='all')
    headers = headers.dropna()
    hrs.columns = headers
    hrs['Year'] = year
    hrs['Month'] = month
    hrs['Station'] = station
    hrs = hrs[['Year', 'Month', 'Station'] + headers.tolist()]
    hrs = _coerce_numeric(hrs)

    total_rows = hrs.Hour == 'Total'
    totals = hrs[total_rows]
    if len(totals) != 1:
        raise RuntimeError(f'{len(totals)} total rows')
    hrs = hrs[~total_rows]

    hrs['Hour'] = (
        hrs.Hour.str.extract(r'(?P<hour>\d\d?):00:00 (?P<am>AM|PM)')
        .astype({'hour': int})
        .apply(_to_hour, axis=1)
    )

    system_wide_rows = hrs.Station == 'System-wide'
    system_wide = hrs[system_wide_rows]
    hrs = hrs[~system_wide_rows]
    return hrs.copy(), totals.copy(), system_wide.copy()


def _read_month(pdf: str, rects: list[dict], year: int, month: int, n_jobs: int | None) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    if n_jobs and n_jobs > 1:
        rvs = Parallel(n_jobs=n_jobs)(
            delayed(parse_station_month)(pdf, rects, year, month, s) for s in STATIONS
        )
    else:
        rvs = [parse_station_month(pdf, rects, year, month, s) for s in STATIONS]
    return tuple(pd.concat(dfs) for dfs in zip(*rvs))


def _read_year(pdf: str, rects: list[dict], year: int, last_month: int | None, n_jobs: int | None) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    end = 13 if last_month is None else (last_month + 1)
    rvs = [_read_month(pdf, rects, year, m, n_jobs) for m in range(1, end)]
    return tuple(pd.concat(dfs) for dfs in zip(*rvs))


def run_parse_hourly(year: int, last_month: int | None = None, n_jobs: int = 4, overwrite: bool = False) -> None:
    pdf = hourly_pdf(year)
    if not exists(pdf):
        raise FileNotFoundError(f"Hourly PDF not found: {pdf}")
    with open(TEMPLATE_PATH) as f:
        rects = json.load(f)

    # 2022's PDF only has data through October (historical quirk).
    if year == 2022 and last_month is None:
        last_month = 10

    suffixes = ['', '-total', '-system']
    paths = [join(DATA, f'{year}-hourly{s}.pqt') for s in suffixes]
    extant = list(filter(exists, paths))
    if extant and overwrite:
        err(f'Overwriting {", ".join(extant)}')
    if extant == paths and not overwrite:
        err(f'All {year} hourly outputs exist; skipping. Use --overwrite to force.')
        return

    hrs, totals, system_wide = _read_year(pdf, rects, year, last_month, n_jobs)
    for df, path in zip([hrs, totals, system_wide], paths):
        df.to_parquet(path, index=False, engine='fastparquet')
        err(f'Wrote {relpath(path)}')


@path_data.command('parse-hourly')
@option('-j', '--n-jobs', type=int, default=4, help="Parallel workers for per-station parsing (default: 4; 0/1 = serial).")
@option('-l', '--last-month', type=int, help="Last month to parse (1–12). Inferred from PDF if omitted.")
@option('-O', '--overwrite/--no-overwrite', default=False, help="Overwrite outputs if they already exist.")
@option('-y', '--year', type=int, required=True, help="Year to parse.")
def parse_hourly(n_jobs: int, last_month: int | None, overwrite: bool, year: int):
    """Parse PATH hourly ridership PDF into per-station parquets."""
    run_parse_hourly(year, last_month=last_month, n_jobs=n_jobs, overwrite=overwrite)
