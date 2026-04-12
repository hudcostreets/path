from os.path import join, relpath

from utz import err, run

from path_data.cli.base import commit_opt, path_data
from path_data.months import WWW_JSONS, run_months
from path_data.paths import ALL_PQT, ALL_XLSX, WWW_ALL_PQT, WWW_PUBLIC
from path_data.utils import git_has_staged_changes, last_month


@path_data.command
@commit_opt
def combine(commit: int):
    """Combine per-year PATH data Parquets into a single file (publishes to `www/public/`)."""
    run_months(force=True, publish=True)

    # DVX-track data and www/public files
    www_public_files = [WWW_ALL_PQT] + [join(WWW_PUBLIC, n) for n in WWW_JSONS]
    run('dvx', 'add', ALL_PQT, ALL_XLSX, *www_public_files)

    dvc_files = [f'{f}.dvc' for f in [ALL_PQT, ALL_XLSX] + www_public_files]
    run('git', 'add', '-u', *dvc_files)
    if commit > 0 and git_has_staged_changes():
        ym = last_month()
        run('git', 'commit', '-m', f'combine ({ym})')
        if commit > 1:
            run('git', 'push')
    else:
        err(f"No changes found: {', '.join(map(relpath, dvc_files))}")
