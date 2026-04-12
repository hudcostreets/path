"""Combine per-year PATH data parquets into `data/all.pqt` + `data/all.xlsx`,
generate summary plot JSONs/PNGs under `img/`, and copy web-facing outputs
into `www/public/`. Ported from `months.ipynb`."""

import glob
import re
from calendar import month_abbr
from datetime import timedelta
from os.path import basename, exists, join, relpath
from shutil import copy2

import numpy as np
import pandas as pd
import plotly.express as px
from click import option
from utz import concat, err, plots, sxs, to_dt
from utz.colors import colors_lengthen

from path_data.cli.base import path_data
from path_data.paths import ALL_PQT, ALL_XLSX, DATA, IMG, WWW_ALL_PQT, WWW_PUBLIC
from path_data.utils import mo_str


RENAME_STATIONS = {
    '9thStreet': '9th Street',
    '14thStreet': '14th Street',
    '23rdStreet': '23rd Street',
    '33rdStreet': '33rd Street',
    'Pavonia/ Newport': 'Newport',
}

WWW_JSONS = [
    'weekdays.json',
    'weekends.json',
    'avg_weekday_month_grouped.json',
    'avg_weekend_month_grouped.json',
]

PLOT_W = 1200
PLOT_H = 600
GRIDCOLOR = '#ddd'


def _load_yearly_parquets() -> pd.DataFrame:
    """Concat all `data/<YYYY>.pqt` files into a single DataFrame."""
    frames = [
        pd.read_parquet(p, engine='fastparquet')
        for p in sorted(glob.glob(f'{DATA}/2*.pqt'))
        if re.fullmatch(r'\d{4}\.pqt', basename(p))
    ]
    df = pd.concat(frames).reset_index()
    df['station'] = df.station.apply(lambda s: RENAME_STATIONS.get(s, s))
    df = df[~df.station.str.contains('TOTAL')].reset_index(drop=True)
    df['dt'] = df['month']
    # Cast to int64: the day_hists index is int64 and pandas 3.0 no longer
    # auto-coerces int32↔int64 in merge/join, silently producing NaN.
    df['year'] = df.dt.dt.year.astype('int64')
    df['month_idx'] = df.dt.dt.month.astype('int64')
    return df


def _load_day_type_histograms() -> pd.DataFrame:
    """Concat all `data/<YYYY>-day-types.pqt` files into a single DataFrame
    indexed by (year, month)."""
    frames = []
    for p in sorted(glob.glob(f'{DATA}/2*-day-types.pqt')):
        m = re.fullmatch(r'(?P<y>\d{4})-day-types\.pqt', basename(p))
        if not m:
            continue
        year = int(m['y'])
        # Match the write engine (fastparquet) so the int index roundtrips
        # faithfully; pandas 3.0's default `pyarrow` read of a fastparquet-
        # written file loses the index name/values and ends up with month=0.
        frames.append(pd.read_parquet(p, engine='fastparquet').assign(year=year))
    out = concat(frames).reset_index(drop=True)
    out['year'] = out['year'].astype('int64')
    out['month'] = out['month'].astype('int64')
    return out.set_index(['year', 'month'])


def _merge_and_recompute(df: pd.DataFrame, day_hists: pd.DataFrame) -> pd.DataFrame:
    m = (
        df.merge(
            day_hists,
            how='left',
            left_on=['year', 'month_idx'],
            right_index=True,
        )
        .rename(columns={'saturdays': 'sats', 'sundays': 'suns'})
        .drop(columns=['year', 'month_idx', 'dt', 'avg daily', 'total'])
    )
    for k in ['weekday', 'sat', 'sun', 'holiday']:
        tk = f'total {k}'
        ak = f'avg {k}'
        nk = f'{k}s'
        avg = m[tk] / m[nk]
        mask = (abs(avg - m[ak]) < .51) | ((m[nk] == 0) & (m[tk] == 0))
        if not all(mask):
            raise ValueError(f"{k}: mismatched avg recomputation\n{m.loc[~mask, [tk, nk, ak]]}")
        m[ak] = avg
    m['weekends'] = m.sats + m.suns
    m['total weekend'] = m['total sat'] + m['total sun']
    m['avg weekend'] = m['total weekend'] / m['weekends']

    cols = ['month', 'station'] + [
        p + k + s
        for p, s in [('total ', ''), ('avg ', ''), ('', 's')]
        for k in ['weekday', 'weekend', 'sat', 'sun', 'holiday']
    ]
    cols += [c for c in m if c not in cols]
    m = m[cols]
    for c in m:
        if m[c].dtype == np.int64:
            m[c] = m[c].astype('int32')
    return m


def _write_all_outputs(m: pd.DataFrame, force: bool = True, xlsx_float_precision: int = 10,
                      sheet_name: str = 'Months') -> None:
    """Write `all.pqt` and (if changed) `all.xlsx`. Store `month` as a string
    to avoid tz-ambiguity when the webapp parses it."""
    out = m.assign(month=m.month.apply(mo_str))

    if force or not exists(ALL_PQT):
        out.to_parquet(ALL_PQT, index=False, engine='fastparquet')
        err(f"Wrote {relpath(ALL_PQT)}")

    if force or not exists(ALL_XLSX):
        out_normalized = pd.DataFrame({
            k: (
                round(out[k], xlsx_float_precision)
                if out[k].dtype is np.dtype('float64')
                else out[k].astype('int64')
                if out[k].dtype is np.dtype('int32')
                else out[k]
            )
            for k in out
        })
        write_xlsx = True
        if exists(ALL_XLSX):
            out_existing = pd.read_excel(ALL_XLSX, sheet_name)
            if out_normalized.equals(out_existing):
                err(f"Skipping {ALL_XLSX} write (no changes detected)")
                write_xlsx = False
        if write_xlsx:
            out_normalized.to_excel(ALL_XLSX, index=False, engine='xlsxwriter',
                                    freeze_panes=(1, 0), sheet_name=sheet_name)
            err(f"Wrote {relpath(ALL_XLSX)}")


def _default_plot(fig: "plotly.graph_objects.Figure", hoverformat: str = ',') -> "plotly.graph_objects.Figure":
    return (
        fig
        .update_layout(
            title_x=0.5,
            paper_bgcolor='white',
            plot_bgcolor='white',
            legend=dict(traceorder='reversed'),
            hovermode='x',
        )
        .update_xaxes(tickangle=-45, gridcolor=GRIDCOLOR)
        .update_traces(hovertemplate=None)
        .update_yaxes(gridcolor=GRIDCOLOR, hoverformat=hoverformat)
    )


def _save_json(fig, name: str, dir: str = IMG) -> None:
    path = join(dir, f'{name}.json')
    with open(path, 'w') as f:
        f.write(fig.to_json())
    err(f"Saved {relpath(path)}")


def _save_png(fig, name: str, dir: str = IMG, width: int = PLOT_W, height: int = PLOT_H) -> None:
    """PNG writes require kaleido + a working browser; treat as best-effort."""
    path = join(dir, f'{name}.png')
    try:
        fig.write_image(path, width=width, height=height)
        err(f"Saved {relpath(path)}")
    except Exception as e:
        err(f"PNG skip ({relpath(path)}): {type(e).__name__}: {e}")


def _stations_stack(m: pd.DataFrame, *, y: str, title: str, name: str | None = None,
                    start=None, end=None, dtick=None, end_month: str | None = None) -> None:
    if isinstance(start, str):
        start = to_dt(start)
    start = start or to_dt('2012')
    start -= timedelta(days=15)
    if isinstance(end, str):
        end = to_dt(end)
    end = end or to_dt(end_month)
    end -= timedelta(days=15)

    fig = _default_plot(
        px.bar(
            m.reset_index(),
            x='month', y=y, color='station',
            title=title,
            labels={'station': 'Station', y: title, 'month': ''},
        )
    ).update_xaxes(range=[start, end], dtick=dtick).update_layout(width=PLOT_W, height=PLOT_H)
    if name:
        _save_json(fig, name)
        _save_png(fig, name)


def _grouped_month_plot(mt: pd.DataFrame, *, y: str, title: str, colors: list[str],
                        month_names: list[str]) -> None:
    fig = px.bar(
        mt,
        x='month_idx', y=y,
        color=mt.year.astype(str),
        color_discrete_sequence=colors,
        labels={'color': 'Year', 'month_idx': '', y: title},
        barmode='group',
    ).update_layout(
        title=f'{title} (grouped by month)',
        title_x=0.5,
        xaxis=dict(
            tickmode='array',
            tickvals=list(range(1, 13)),
            ticktext=month_names,
        ),
        width=PLOT_W,
        height=PLOT_H,
    )
    json_name = y.replace(' ', '_') + '_month_grouped'
    _save_json(fig, json_name)
    _save_png(fig, json_name)


def _lines_plot(df: pd.DataFrame, *, name: str, xname: str, y_fmt: str,
                xtick: str | None = None, ytickformat: str | None = None,
                ax_offset: int, ay_offsets: list[float],
                h_line: float | None = None,
                legend_lr: bool = False,
                hovertemplate: str | None = None,
                w: int = 1000, h: int = 600) -> None:
    fig = px.line(df, labels={'variable': '', 'value': xname, 'month': ''})
    idx = df.index.to_series()
    for k, ay_offset in zip(df, ay_offsets):
        x = idx.iloc[-1]
        y = df[k].iloc[-1]
        x_str = x.strftime("%b '%y")
        y_str = format(y, y_fmt)
        fig.add_annotation(
            x=x, axref='x',
            y=y, ayref='y',
            ax=idx.iloc[-ax_offset],
            ay=y + ay_offset,
            text=f'{x_str}: {y_str}',
        )
    if h_line is not None:
        fig.add_hline(y=h_line, line=dict(color='#777', width=1))
    legend = dict(yanchor='bottom', y=0.03, xanchor='right', x=0.99) if legend_lr else \
             dict(yanchor='top', y=0.99, xanchor='right', x=0.99)
    # Apply utz.plots styling but swallow PNG-write errors (kaleido may fail in
    # sandboxes without a browser).
    try:
        fig = plots.save(
            fig,
            name=name,
            x=dict(dtick=xtick),
            y=dict(tickformat=ytickformat),
            legend=legend,
            hoverx=True,
            dir=IMG,
            w=w, h=h,
            hovertemplate=hovertemplate,
        )
    except Exception as e:
        err(f"plots.save PNG skip ({name}): {type(e).__name__}: {e}")
    _save_json(fig, name)


def _publish_to_www_public() -> None:
    """Copy web-facing outputs into www/public/ and DVX-track them."""
    copy2(ALL_PQT, WWW_ALL_PQT)
    for name in WWW_JSONS:
        copy2(join(IMG, name), join(WWW_PUBLIC, name))


def run_months(*, force: bool = True, end_month: str | None = None, publish: bool = True) -> None:
    df = _load_yearly_parquets()
    day_hists = _load_day_type_histograms()
    m = _merge_and_recompute(df, day_hists)
    _write_all_outputs(m, force=force)

    # Monthly aggregates for grouped plots
    mt = m.drop(columns='station').groupby('month').sum()
    month_dt = to_dt(mt.index.to_series())
    months = month_dt.dt
    mt = sxs(months.year.rename('year'), months.month.rename('month_idx'), mt)

    if end_month is None:
        end_month = (df.month.max() + pd.Timedelta('32d')).strftime('%Y-%m')

    # Weekday/Weekend stations stacks
    _stations_stack(m, y='avg weekday',
                    title='Average weekday PATH ridership',
                    dtick='M12', name='weekdays', end_month=end_month)
    _stations_stack(m, y='avg weekday',
                    title='Average weekday PATH ridership (2020-Present)',
                    dtick='M3', name='weekdays_2020:', start='2020', end_month=end_month)
    _stations_stack(m, y='avg weekend',
                    title='Average Weekend PATH ridership',
                    dtick='M12', name='weekends', end_month=end_month)
    _stations_stack(m, y='avg weekend',
                    title='Average Weekend PATH ridership (2020-Present)',
                    dtick='M3', name='weekends_2020:', start='2020', end_month=end_month)

    # Grouped-by-month plots
    num_years = len(mt.year.unique())
    colors = list(reversed(colors_lengthen(px.colors.sequential.Inferno, num_years)))
    month_names = [to_dt(f'2022-{i:02d}').strftime('%b') for i in range(1, 13)]
    _grouped_month_plot(mt, y='avg weekday', title='Average Weekday Rides',
                        colors=colors, month_names=month_names)
    _grouped_month_plot(mt, y='avg weekend', title='Average Weekend Rides',
                        colors=colors, month_names=month_names)

    # Combined "Average Daily PATH Ridership" line plot
    _lines_plot(
        mt[['avg weekday', 'avg weekend']].rename(columns={
            'avg weekday': 'Avg Weekday',
            'avg weekend': 'Avg Weekend',
        }),
        name='avg_day_types',
        xname='Daily Rides',
        xtick='M12',
        hovertemplate='%{y:,.0f}',
        y_fmt=',.0f',
        ax_offset=13, ay_offsets=[50_000, -50_000],
        legend_lr=False,
    )

    # vs-2019 recovery
    mt20 = mt[month_dt >= to_dt('2020')]
    mt19 = mt[mt.year == 2019]
    mt19s = pd.concat([mt19 for _ in range((len(mt20) + len(mt19) - 1) // len(mt19))]).iloc[:len(mt20)]
    keys = ['avg weekday', 'avg weekend']
    cmp19 = (
        sxs(
            mt19s.reset_index(drop=True)[keys].rename(columns={key: f'{key} 2019' for key in keys}),
            mt20.reset_index()[keys + ['month']],
        )
        .set_index('month')
    )
    for k in keys:
        cmp19[f'{k} frac'] = cmp19[k] / cmp19[f'{k} 2019']
    _lines_plot(
        cmp19[[f'{k} frac' for k in keys]].rename(columns={
            'avg weekday frac': 'Avg Weekday (% of 2019)',
            'avg weekend frac': 'Avg Weekend (% of 2019)',
        }),
        name='vs_2019',
        xname='% of 2019 ridership',
        xtick='M3',
        ytickformat='.0%',
        ax_offset=5, ay_offsets=[-.15, .15],
        h_line=1,
        hovertemplate='%{y:.1%}',
        y_fmt='.1%',
        legend_lr=True,
    )

    # Station × month matrix for webapp
    df.set_index(['month', 'station']).to_parquet(join(IMG, 'path.parquet'))
    err(f"Wrote {relpath(join(IMG, 'path.parquet'))}")

    if publish:
        _publish_to_www_public()


@path_data.command('months')
@option('--force/--no-force', default=True, help="Rewrite all.pqt/all.xlsx even if they exist (default: force).")
@option('--publish/--no-publish', default=True, help="Copy outputs into www/public/ (default: publish).")
@option('-e', '--end-month', help="Override plot end-month (default: inferred from data).")
def months(force: bool, publish: bool, end_month: str | None):
    """Combine per-year parquets → all.pqt/all.xlsx + plot JSONs/PNGs."""
    run_months(force=force, end_month=end_month, publish=publish)
