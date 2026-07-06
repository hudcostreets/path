"""Scrape PANYNJ Airport Traffic Dashboard (ATD) → Ground Transportation section.

The ATD is served as a Power BI "publish-to-web" report at
https://app.powerbigov.us/view?r=<resourceKey>. The Ground Transport tab isn't
in the linked bulk CSV (`PANYNJ_Airport_Traffic_Data.csv` — that's aviation
only), so we hit the Power BI `querydata` REST endpoint directly with a
synthesized SemanticQueryDataShapeCommand.

Discovery notes (worth keeping when the Power BI schema shifts):
- Endpoint is anonymous — no OAuth, no embed token. Requires the
  `X-PowerBI-ResourceKey` + `Origin: app.powerbigov.us` headers.
- `Calendar.Month` stores full month names ("January"), not short ("Jan").
- `queries[0].CacheKey` MUST mirror the Commands array or the server serves the
  cached response for the wrong query.
- Response is dictionary-compressed: string columns → indices into
  `dsr.DS[0].ValueDicts.D{N}`; each row's `R` bitmap marks columns copied
  from the previous row (LSB = column 0).
"""
import copy
import json
from datetime import datetime
from pathlib import Path
from shutil import copy2

import pandas as pd
import requests
from click import argument, option
from utz import err

from path_data.cli.base import path_data
from path_data.paths import WWW_PUBLIC

ENDPOINT = 'https://wabi-us-gov-virginia-api.analysis.usgovcloudapi.net/public/reports/querydata?synchronous=true'
RESOURCE_KEY = 'e3465680-4a72-4c34-9860-d6ae446d9a95'
HEADERS = {
    'Content-Type': 'application/json',
    'Origin': 'https://app.powerbigov.us',
    'Referer': 'https://app.powerbigov.us/',
    'X-PowerBI-ResourceKey': RESOURCE_KEY,
    'ActivityId': '00000000-0000-0000-0000-000000000000',
    'RequestId':  '00000000-0000-0000-0000-000000000000',
}
AIRPORTS = ('EWR', 'JFK', 'LGA', 'SWF')
GROUND_CATEGORIES = ('Coach Bus', 'For-Hire Vehicles', 'Parked Cars', 'Taxi Dispatched')
AIRTRAIN_CATEGORIES = ('Paid-EWR', 'Paid-Hwrd Beach', 'Paid-Jamaica', 'Unpaid-On Airport')
ALL_CATEGORIES = GROUND_CATEGORIES + AIRTRAIN_CATEGORIES
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December']


def _in(source: str, prop: str, values: list[str]) -> dict:
    return {
        'Condition': {'In': {
            'Expressions': [{'Column': {'Expression': {'SourceRef': {'Source': source}}, 'Property': prop}}],
            'Values': [[{'Literal': {'Value': v}}] for v in values],
        }}
    }


def _build_query(airport: str, timeframe: str = 'Monthly',
                 categories: tuple[str, ...] = ALL_CATEGORIES) -> dict:
    """Return the Power BI query body for one airport across all months/years.

    Widens the base widget query (which is one month/year/category) by dropping
    the month + year filters and adding `Calendar.{Year,Month}` +
    `MiscellaneousTrafficType.Misc Desc. New` to the Select clause, so a single
    POST returns every (year, month, category) row for the airport.
    """
    query = {
        'Version': 2,
        'From': [
            {'Name': 'm2', 'Entity': 'MiscellaneousTrafficType', 'Type': 0},
            {'Name': 'm1', 'Entity': 'MiscTrafficData',           'Type': 0},
            {'Name': 'a',  'Entity': 'Airports',                  'Type': 0},
            {'Name': 'c',  'Entity': 'Calendar',                  'Type': 0},
            {'Name': 't',  'Entity': 'Timeframe Categories',      'Type': 0},
        ],
        'Select': [
            {'Column':  {'Expression': {'SourceRef': {'Source': 'c'}},  'Property': 'Year'},              'Name': 'Calendar.Year'},
            {'Column':  {'Expression': {'SourceRef': {'Source': 'c'}},  'Property': 'Month'},             'Name': 'Calendar.Month'},
            {'Column':  {'Expression': {'SourceRef': {'Source': 'm2'}}, 'Property': 'Misc Desc. New'},    'Name': 'MiscellaneousTrafficType.Misc Desc. New'},
            {'Measure': {'Expression': {'SourceRef': {'Source': 'm1'}}, 'Property': 'Misc Data Timeframe'}, 'Name': 'MiscTrafficData.Misc Data Timeframe'},
        ],
        'Where': [
            _in('a',  'Airport Code',        [f"'{airport}'"]),
            _in('m2', 'Misc Description',    [f"'{c}'" for c in categories]),
            _in('t',  'Timeframe Categories', [f"'{timeframe}'"]),
        ],
    }
    commands = [{
        'SemanticQueryDataShapeCommand': {
            'Query': query,
            'Binding': {
                'Primary':   {'Groupings': [{'Projections': [0, 1, 2, 3]}]},
                'DataReduction': {'DataVolume': 4, 'Primary': {'Window': {'Count': 5000}}},
                'Version': 1,
            },
            'ExecutionMetricsKind': 1,
        }
    }]
    return {
        'version': '1.0.0',
        'queries': [{
            'Query': {'Commands': commands},
            'CacheKey': json.dumps({'Commands': commands}, separators=(',', ':')),
            'QueryId': '',
            'ApplicationContext': {
                'DatasetId': '9ccba6da-b2d4-45f8-8a1a-86867973f518',
                'Sources': [{'ReportId': 'f6596a19-fd18-4cd0-a1dd-115e4d093e71', 'VisualId': '9a9b04f93c57a36003c5'}],
            },
        }],
        'cancelQueries': [],
        'modelId': 1189757,
    }


def _decode_dsr(resp: dict) -> list[list]:
    """Decode PBI DSR response into a flat list of [year, month_name, category, value] rows.

    The DM0 rows are dictionary-compressed:
      - `S` (schema) is present only on the first row; subsequent rows inherit.
      - `R` bitmap marks columns copied from prev row (LSB = column 0).
      - `Ø` bitmap (if present) marks null columns; those don't consume from `C`.
      - String columns' values in `C` are indices into `ValueDicts.D{N}` where N
        is given by the schema entry's `DN` field.
    """
    ds = resp['results'][0]['result']['data']['dsr']['DS'][0]
    ph = ds['PH'][0]
    dm = ph.get('DM0', [])
    if not dm:
        return []
    schema = dm[0]['S']
    dicts = ds.get('ValueDicts', {})
    ncols = len(schema)
    dict_names = [col.get('DN') for col in schema]
    prev = [None] * ncols
    out = []
    for row in dm:
        R = row.get('R', 0)
        N = row.get('Ø', 0)  # null bitmap
        C = row.get('C', [])
        ci = 0
        cur = [None] * ncols
        for col in range(ncols):
            if N & (1 << col):
                cur[col] = None
            elif R & (1 << col):
                cur[col] = prev[col]
            else:
                cur[col] = C[ci]
                ci += 1
        prev = cur
        # Resolve dict-indexed string columns.
        resolved = []
        for col, dn in enumerate(dict_names):
            v = cur[col]
            resolved.append(dicts[dn][v] if dn is not None and v is not None else v)
        out.append(resolved)
    return out


def fetch_ground(airport: str, timeframe: str = 'Monthly',
                 categories: tuple[str, ...] = ALL_CATEGORIES,
                 session: requests.Session | None = None) -> pd.DataFrame:
    """Fetch one airport's Ground Transport rows as a DataFrame."""
    q = _build_query(airport, timeframe, categories)
    s = session or requests
    resp = s.post(ENDPOINT, json=q, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    rows = _decode_dsr(resp.json())
    df = pd.DataFrame(rows, columns=['year', 'month_name', 'category', 'value'])
    df.insert(0, 'airport', airport)
    df.insert(1, 'timeframe', timeframe)
    df['month'] = df['month_name'].map({m: i + 1 for i, m in enumerate(MONTHS)})
    df = df.drop(columns='month_name')
    df = df[['airport', 'timeframe', 'year', 'month', 'category', 'value']]
    df = df.astype({'year': 'int16', 'month': 'int8', 'value': 'int64'})
    df = df.sort_values(['airport', 'year', 'month', 'category']).reset_index(drop=True)
    return df


@path_data.command('atd-ground')
@option('-a', '--airport', 'airports', multiple=True, help=f'Restrict to specific airport(s) (default: {"+".join(AIRPORTS)})')
@option('-o', '--out', default='data/atd/ground.pqt', help='Output parquet path')
@option('-t', '--timeframe', default='Monthly', type=str, help="One of 'Monthly', 'Year-To-Date', '12 Month Rolling'")
def atd_ground(airports: tuple[str, ...], out: str, timeframe: str):
    """Scrape ATD Ground Transportation rows for each airport → parquet.

    One POST per airport (4 total by default); each returns all (year, month,
    category) combinations for that airport.
    """
    airports = airports or AIRPORTS
    sess = requests.Session()
    dfs = []
    for ap in airports:
        err(f'Fetching ATD Ground Transport: {ap} ({timeframe})')
        df = fetch_ground(ap, timeframe=timeframe, session=sess)
        err(f'  {len(df)} rows, {df["year"].min()}–{df["year"].max()}')
        dfs.append(df)
    all_df = pd.concat(dfs, ignore_index=True)
    all_df.attrs.clear()  # avoid embedding metadata that varies run-to-run

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    all_df.to_parquet(out_path, index=False, engine='fastparquet', compression='zstd')
    err(f'\nWrote {out_path}: {len(all_df)} rows, {out_path.stat().st_size:,} bytes')

    # Mirror to `www/public/` so the FE (`dvcResolve('atd-ground.pqt')`) picks
    # it up in dev + gets copied to `dist/` in prod. Same pattern as
    # `months.py`'s `copy2(ALL_PQT, WWW_ALL_PQT)`.
    www_path = Path(WWW_PUBLIC) / 'atd-ground.pqt'
    copy2(out_path, www_path)
    err(f'Mirrored to {www_path}')


FLIGHTS_CSV_URL = 'https://pacorpredevblobstorage.blob.core.windows.net/csv-trafficdata/PANYNJ_Airport_Traffic_Data.csv'


@path_data.command('atd-flights')
@option('-o', '--out', default='data/atd/flights.pqt', help='Output parquet path')
@option('-c', '--csv-cache', default='data/atd/panynj-flights.csv', help='Local cache path for raw CSV')
@option('-F', '--no-fetch', is_flag=True, help='Skip re-download; use existing cached CSV')
def atd_flights(out: str, csv_cache: str, no_fetch: bool):
    """Download PANYNJ aviation CSV → pre-aggregated parquet for the FE.

    Raw CSV is per (month, airport, terminal, airline, direction, market, region).
    We aggregate across terminal + airline for a compact
    (ym, airport, direction, market, region) rollup — small enough (~215 KB) to
    ship in the FE bundle for on-demand plotting. Airline-level breakouts can
    be added as a separate stage if/when needed.
    """
    csv_path = Path(csv_cache)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    if not no_fetch or not csv_path.exists():
        err(f'Fetching {FLIGHTS_CSV_URL}')
        r = requests.get(FLIGHTS_CSV_URL, stream=True, timeout=120)
        r.raise_for_status()
        with open(csv_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                f.write(chunk)
        err(f'  wrote {csv_path}: {csv_path.stat().st_size:,} bytes')

    err(f'Aggregating {csv_path}…')
    df = pd.read_csv(csv_path)
    df['ym'] = pd.to_datetime(df['Activity Period']).dt.to_period('M').dt.to_timestamp()
    agg = df.groupby(
        ['ym', 'Airport Code', 'Direction', 'Market', 'World Region'],
        as_index=False,
    ).agg({
        'Revenue Passenger Volume': 'sum',
        'Non-Revenue Passenger Volume': 'sum',
        'Freight Volume': 'sum',
        'Mail Volume': 'sum',
        'Total Flights': 'sum',
    })
    agg.columns = ['ym', 'airport', 'direction', 'market', 'region',
                   'pax_rev', 'pax_nonrev', 'freight', 'mail', 'flights']
    agg = agg.astype({
        'airport': 'category',
        'direction': 'category',
        'market': 'category',
        'region': 'category',
        'pax_rev': 'int64',
        'pax_nonrev': 'int64',
        'flights': 'int32',
    })
    agg = agg.sort_values(['ym', 'airport', 'direction', 'market', 'region']).reset_index(drop=True)

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    agg.to_parquet(out_path, index=False, engine='fastparquet', compression='zstd')
    err(f'Wrote {out_path}: {len(agg):,} rows, {out_path.stat().st_size:,} bytes')

    www_path = Path(WWW_PUBLIC) / 'atd-flights.pqt'
    copy2(out_path, www_path)
    err(f'Mirrored to {www_path}')
