from os.path import basename, splitext, relpath

from click import option
from juq.papermill.run import papermill_run_cmd
from utz import run, err

from path_data.cli.base import path_data, commit_opt
from path_data.paths import OUT, MONTHLY_NB, year_day_types_pqt, year_pqt
from path_data.utils import last_month, verify_no_staged_changes, git_has_staged_changes


@path_data.command
@commit_opt
@option('-y', '--year', type=int, default=None, help='Year to update PATH data Parquets for')
def update(commit: int, year: int | None):
    """Extract data from PATH ridership PDFs to Parquet files."""
    verify_no_staged_changes()

    last_ym = last_month()
    if year is None:
        year = last_ym.year

    nb_name = splitext(basename(MONTHLY_NB))[0]
    out_path = f'{OUT}/{nb_name}-{year}.ipynb'
    papermill_run_cmd.callback(
        nb_path=MONTHLY_NB,
        out_path=out_path,
        parameter_strs=(f"year={year}",),
        keep_tags=False,
    )
    paths = [
        out_path,
        year_pqt(year),
        year_day_types_pqt(year)
    ]
    run('git', 'add', *paths)
    if commit > 0 and git_has_staged_changes():
        ym_str = f'{last_ym if year == last_ym.year else year}'
        run('git', 'commit', '-m', f'{nb_name} ({ym_str})')
        if commit > 1:
            run('git', 'push')
    else:
        err(f"No changes found: {', '.join(map(relpath, paths))}")
