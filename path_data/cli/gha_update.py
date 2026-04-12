import json
from glob import glob
from os import environ
from os.path import basename, exists, getmtime
from subprocess import CalledProcessError
from sys import exit
from textwrap import dedent
from traceback import format_exc

import yaml
from utz import err, lines, run

from path_data.cli.base import path_data
from path_data.cli.slack import post_message
from path_data.utils import git_has_staged_changes


def _run_url() -> str | None:
    server = environ.get('GITHUB_SERVER_URL', 'https://github.com')
    repo = environ.get('GITHUB_REPOSITORY')
    run_id = environ.get('GITHUB_RUN_ID')
    if not (repo and run_id):
        return None
    return f'{server}/{repo}/actions/runs/{run_id}'


def _append_summary(md: str) -> None:
    path = environ.get('GITHUB_STEP_SUMMARY')
    if not path:
        err(md)
        return
    with open(path, 'a') as f:
        f.write(md.rstrip() + '\n')


def _slack(text: str, emoji: str = ':train:') -> None:
    if environ.get('PATH_DATA_SKIP_SLACK'):
        err(f"Slack skipped ($PATH_DATA_SKIP_SLACK): {text}")
        return
    token = environ.get('SLACK_BOT_TOKEN')
    channel = environ.get('SLACK_CHANNEL_ID')
    if not (token and channel):
        err(f"Slack skipped (no token/channel): {text}")
        return
    try:
        post_message(
            text=text,
            channel=channel,
            token=token,
            icon_emoji=emoji,
            username='PATH Data',
        )
    except Exception as e:
        err(f"Slack post failed: {e}")


def _staged_paths(path_filter: str | None = None) -> list[str]:
    paths = [p for p in lines('git', 'diff', '--cached', '--name-only', log=False) if p]
    if path_filter:
        paths = [p for p in paths if path_filter in p]
    return paths


ANSI_RE = None


def _strip_ansi(s: str) -> str:
    global ANSI_RE
    if ANSI_RE is None:
        import re
        ANSI_RE = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')
    return ANSI_RE.sub('', s)


def _notebook_errors(nb_path: str) -> str | None:
    """Return a formatted traceback from the first errored cell in nb_path."""
    if not exists(nb_path):
        return None
    try:
        with open(nb_path) as f:
            nb = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    for i, cell in enumerate(nb.get('cells', []) or []):
        for output in cell.get('outputs', []) or []:
            if output.get('output_type') != 'error':
                continue
            ename = output.get('ename', 'Error')
            evalue = output.get('evalue', '')
            tb = '\n'.join(_strip_ansi(line) for line in (output.get('traceback') or []))
            src = ''.join(cell.get('source', []) or [])
            return f"Cell {i} raised `{ename}: {evalue}`\n\n```python\n{src}\n```\n\n```\n{tb}\n```"
    return None


def _latest_out_notebook_error() -> str | None:
    """Find the most recently modified `out/*.ipynb` and extract its first error cell."""
    candidates = glob('out/*.ipynb')
    if not candidates:
        return None
    candidates.sort(key=getmtime, reverse=True)
    for nb in candidates:
        msg = _notebook_errors(nb)
        if msg:
            return f"**{nb}**\n\n{msg}"
    return None


def _pdf_last_modified(dvc_path: str) -> str | None:
    if not exists(dvc_path):
        return None
    with open(dvc_path) as f:
        data = yaml.safe_load(f)
    for dep in data.get('deps', []) or []:
        if 'mtime' in dep:
            return dep['mtime']
    return None


def _run_link_md(url: str | None) -> str:
    return f'[View GHA run]({url})' if url else 'View GHA run'


def _run_link_slack(url: str | None) -> str:
    return f'<{url}|View GHA run>' if url else 'GHA run'


def _summarize_new_data(updated_pdfs: list[str]) -> str:
    lines = ['## :train: New PATH ridership data', '']
    if updated_pdfs:
        lines.append('### Upstream PDFs updated')
        lines.append('')
        lines.append('| PDF | Last-Modified |')
        lines.append('|---|---|')
        for p in sorted(updated_pdfs):
            dvc = f'{p}.dvc' if not p.endswith('.dvc') else p
            lm = _pdf_last_modified(dvc) or '—'
            lines.append(f'| `{basename(p)}` | `{lm}` |')
        lines.append('')
    lines.append('Deployed to https://path.hudcostreets.org')
    return '\n'.join(lines)


@path_data.command('gha-update')
def gha_update():
    """End-to-end daily update: refresh, run pipeline, push, commit, notify.

    Posts to Slack + $GITHUB_STEP_SUMMARY on every run (success / no-change /
    failure) so the #path-data-bot channel reflects daily pipeline health.
    """
    url = _run_url()
    slack_link = _run_link_slack(url)
    md_link = _run_link_md(url)

    try:
        err('=== path-data refresh ===')
        run('path-data', 'refresh')

        pdf_paths = _staged_paths(path_filter='data/')
        updated_pdfs = [p for p in pdf_paths if p.endswith('.pdf')]

        err('=== dvx run ===')
        dvc_targets = sorted(glob('data/*.dvc')) + sorted(glob('www/public/*.dvc'))
        run('dvx', 'run', '-v', *dvc_targets)

        run('git', 'add', 'data/', 'www/public/', 'img/')

        if not git_has_staged_changes():
            _append_summary(dedent(f"""\
                ## :white_check_mark: No new data

                Upstream PDFs unchanged since last check.

                {md_link}
                """))
            _slack(
                f":white_check_mark: PATH data check: no new data found\n{slack_link}",
                emoji=':white_check_mark:',
            )
            return

        err('=== dvx push ===')
        run('dvx', 'push')

        run('git', 'commit', '-m', 'Update PATH ridership data')
        run('git', 'push')

        _append_summary(_summarize_new_data(updated_pdfs) + f'\n\n{md_link}\n')
        _slack(
            f":train: *New PATH ridership data* published and deployed\n"
            f"{slack_link} · <https://path.hudcostreets.org|View site>",
        )
    except CalledProcessError as e:
        tb = format_exc()
        err(tb)
        prog = e.cmd[0] if hasattr(e, 'cmd') and e.cmd else '?'
        nb_err = _latest_out_notebook_error()
        nb_section = f"\n\n### Notebook cell error\n\n{nb_err}" if nb_err else ""
        _append_summary(dedent(f"""\
            ## :rotating_light: Pipeline error

            `{prog}` exited with status {e.returncode}. See the GHA run log
            for the underlying command's output.

            ```
            {tb[-1500:]}
            ```{nb_section}

            {md_link}
            """))
        slack_nb = f"\n```\n{nb_err[:500]}\n```" if nb_err else ""
        _slack(
            f":rotating_light: *PATH pipeline failed* (`{prog}` exit {e.returncode})\n{slack_link}{slack_nb}",
            emoji=':rotating_light:',
        )
        exit(e.returncode or 1)
    except Exception:
        tb = format_exc()
        err(tb)
        _append_summary(dedent(f"""\
            ## :rotating_light: Unexpected error

            ```
            {tb[-2000:]}
            ```

            {md_link}
            """))
        _slack(
            f":rotating_light: *PATH pipeline crashed* (see run log)\n{slack_link}",
            emoji=':rotating_light:',
        )
        exit(1)
