from os.path import splitext, basename, relpath

from juq.cli import papermill_run_cmd
from utz import run, err

from path_data.cli.base import path_data, commit_opt
from path_data.paths import MONTHS_NB, IMG, ALL_PQT, ALL_XLSX
from path_data.utils import git_has_staged_changes, last_month


@path_data.command
@commit_opt
def combine(commit: int):
    """Combine per-year PATH data Parquets into a single file."""
    path = MONTHS_NB
    nb_name = splitext(basename(path))[0]
    papermill_run_cmd.callback((path,), in_place=True)
    paths = [ path, IMG, ALL_PQT, ALL_XLSX, ]
    run('git', 'add', '-u', *paths)
    if commit > 0 and git_has_staged_changes():
        ym = last_month()
        run('git', 'commit', '-m', f'{nb_name} ({ym})')
        if commit > 1:
            run('git', 'push')
    else:
        err(f"No changes found: {', '.join(map(relpath, paths))}")
