"""Parse a year's PATH monthly ridership PDF into `<year>.pqt` +
`<year>-day-types.pqt`. Ported from `monthly.ipynb`."""

from datetime import date
import json

import pandas as pd
from PyPDF2 import PdfReader
from click import option
from tabula import read_pdf
from utz import err, now, relpath, sxs

from path_data import paths
from path_data.cli.base import path_data
from path_data.paths import monthly_pdf, year_day_types_pqt, year_pqt


COLS_AVG = ['station', 'total', 'avg weekday', 'avg sat', 'avg sun', 'avg holiday']
COLS_SUM = ['station', 'avg daily', 'total weekday', 'total sat', 'total sun', 'total holiday']


def _read_tables(pdf: str, last_month: int, template_path: str) -> dict[int, list[pd.DataFrame]]:
    with open(template_path) as f:
        rects = json.load(f)
    area = [[r[k] for k in ['y1', 'x1', 'y2', 'x2']] for r in rects]
    tables: dict[int, list[pd.DataFrame]] = {}
    for month in range(1, last_month + 1):
        dfs = read_pdf(
            pdf,
            pages=month,
            area=area,
            pandas_options={'header': None},
            stream=True,
        )
        n = len(dfs)
        msg = f'Pg {month}: {n} tables'
        if n == 5:
            print(msg)
        else:
            err(msg)
        tables[month] = dfs
    return tables


def _parse_avgs_sums(tables: dict[int, list[pd.DataFrame]], year: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    avgs = pd.concat([
        df.assign(date=date(year, month, 1)).astype({'date': 'datetime64[s]'})
        for month, dfs in tables.items()
        for df in dfs[:2]
    ])
    avgs.columns = COLS_AVG + ['month']
    avgs = avgs.assign(**{
        k: avgs[k].astype(str).str.replace(',', '').astype(int)
        for k in COLS_AVG[1:]
    })

    sums = pd.concat([
        df.assign(date=date(year, month, 1)).astype({'date': 'datetime64[s]'})
        for month, dfs in tables.items()
        for df in dfs[2:4]
    ])
    sums.columns = COLS_SUM + ['month']
    sums = sums.assign(**{
        k: sums[k].astype(str).str.replace(',', '').astype(int)
        for k in COLS_SUM[1:]
    })
    return avgs, sums


def _parse_day_type_counts(tables: dict[int, list[pd.DataFrame]]) -> pd.DataFrame:
    def parse_nums(month: int, tbl: pd.DataFrame) -> pd.DataFrame:
        assert len(tbl) == 3
        assert all(tbl.iloc[0] == 'Average')
        tbl.columns = tbl.iloc[1].str.lower()
        tbl.columns.name = None
        tbl = tbl.iloc[2:]
        tbl.index = [month]
        tbl.index.name = 'month'
        return tbl.astype(int)

    nums = pd.concat([
        parse_nums(month=month, tbl=dfs[-1])
        for month, dfs in tables.items()
    ])
    nums.columns = [f'{c}s' for c in nums.columns]
    return nums


def run_monthly(year: int, last_month: int | None = None, template_path: str | None = None) -> None:
    pdf = monthly_pdf(year)
    if last_month is None:
        n_pages = len(PdfReader(pdf).pages)
        last_month = max(1, n_pages - 1)
        err(f"Inferred last_month={last_month}")
    if template_path is None:
        template_path = paths.template(year)

    tables = _read_tables(pdf, last_month, template_path)
    avgs, sums = _parse_avgs_sums(tables, year)
    nums = _parse_day_type_counts(tables)

    df = sxs(
        avgs.set_index(['month', 'station']),
        sums.set_index(['month', 'station']),
    )
    df = df[[COLS_SUM[1]] + COLS_AVG[2:] + [COLS_AVG[1]] + COLS_SUM[2:]]

    pqt_path = year_pqt(year)
    df.to_parquet(pqt_path, engine='fastparquet')
    err(f"Wrote {relpath(pqt_path)}")

    day_types_path = year_day_types_pqt(year)
    # Store `month` as a regular column so it roundtrips deterministically
    # across pandas versions (pandas 3.0's default parquet index handling
    # doesn't always preserve named indexes like `month`).
    nums.reset_index().to_parquet(day_types_path, engine='fastparquet', index=False)
    err(f"Wrote {relpath(day_types_path)}")


@path_data.command('monthly')
@option('-l', '--last-month', type=int, help="Last month to parse (1–12). Inferred from PDF page count if omitted.")
@option('-t', '--template', 'template_path', help="Path to tabula template JSON. Inferred from year if omitted.")
@option('-y', '--year', type=int, help="Year to parse. Defaults to current year.")
def monthly(last_month: int | None, template_path: str | None, year: int | None):
    """Parse PATH monthly ridership PDF for YEAR into `<year>.pqt` + `<year>-day-types.pqt`."""
    if year is None:
        year = now().year
    run_monthly(year, last_month=last_month, template_path=template_path)
