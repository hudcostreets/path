from os.path import splitext, basename, relpath, join
from shutil import copy2

from juq.papermill.run import papermill_run_cmd
from utz import run, err

from path_data.cli.base import path_data, commit_opt
from path_data.paths import (
    MONTHS_NB, IMG, ALL_PQT, ALL_XLSX,
    IRE, WWW_PUBLIC, WWW_ALL_PQT,
)
from path_data.utils import git_has_staged_changes, last_month

WWW_JSONS = [
    'weekdays.json',
    'weekends.json',
    'avg_weekday_month_grouped.json',
    'avg_weekend_month_grouped.json',
]


@path_data.command
@commit_opt
def combine(commit: int):
    """Combine per-year PATH data Parquets into a single file."""
    path = MONTHS_NB
    nb_name = splitext(basename(path))[0]
    papermill_run_cmd.callback(nb_path=path, in_place=True, keep_tags=False)

    # Copy outputs to www/public/ for DVX tracking
    copy2(ALL_PQT, WWW_ALL_PQT)
    for name in WWW_JSONS:
        src = join(IRE, name)
        copy2(src, join(WWW_PUBLIC, name))

    # DVX-track data and www/public files
    www_public_files = [WWW_ALL_PQT] + [join(WWW_PUBLIC, n) for n in WWW_JSONS]
    run('dvx', 'add', ALL_PQT, ALL_XLSX, *www_public_files)

    dvc_files = [f'{f}.dvc' for f in [ALL_PQT, ALL_XLSX] + www_public_files]
    paths = [path, IMG, *dvc_files]
    run('git', 'add', '-u', *paths)
    if commit > 0 and git_has_staged_changes():
        ym = last_month()
        run('git', 'commit', '-m', f'{nb_name} ({ym})')
        if commit > 1:
            run('git', 'push')
    else:
        err(f"No changes found: {', '.join(map(relpath, paths))}")
