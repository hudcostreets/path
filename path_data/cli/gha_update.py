import json
import subprocess
from glob import glob
from os import environ, listdir
from os.path import basename, exists, getmtime, isdir
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
    # Always echo to stderr so the step log has the full content too (the
    # Summary tab only shows on the run page, whereas logs can be searched +
    # piped).
    err('---- summary ----')
    err(md)
    err('---- /summary ----')
    path = environ.get('GITHUB_STEP_SUMMARY')
    if not path:
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
    out_listing = listdir('out') if isdir('out') else '(no out/ dir)'
    err(f"_latest_out_notebook_error: out/ contents = {out_listing}")
    candidates = glob('out/*.ipynb')
    if not candidates:
        return None
    candidates.sort(key=getmtime, reverse=True)
    for nb in candidates:
        msg = _notebook_errors(nb)
        err(f"_notebook_errors({nb}): {'error cell found' if msg else 'no error cell'}")
        if msg:
            return f"**{nb}**\n\n{msg}"
    return None


def _papermill_direct_cmd(juq_cmd: str) -> list[str] | None:
    """Translate `juq papermill run <nb> -o <out> -p year=<y>` into a bare
    `papermill --log-output <nb> <out> -p year <y>` argv."""
    import shlex
    try:
        toks = shlex.split(juq_cmd)
    except ValueError:
        return None
    if toks[:3] != ['juq', 'papermill', 'run']:
        return None
    nb_path = None
    out_path = None
    params: list[tuple[str, str]] = []
    i = 3
    while i < len(toks):
        t = toks[i]
        if t in ('-o', '--out-path'):
            out_path = toks[i + 1]
            i += 2
        elif t in ('-p', '--parameter'):
            k, _, v = toks[i + 1].partition('=')
            params.append((k, v))
            i += 2
        elif nb_path is None and not t.startswith('-'):
            nb_path = t
            i += 1
        else:
            i += 1
    if not (nb_path and out_path):
        return None
    argv = ['papermill', '--log-output', '--request-save-on-cell-execute',
            '--autosave-cell-every', '5', nb_path, out_path]
    for k, v in params:
        argv += ['-p', k, v]
    return argv


def _rerun_failing_dvc() -> str | None:
    """On failure, find the most-recently-touched yearly .dvc and re-run its cmd
    directly with captured stderr, so we get the actual papermill error that
    DVX is hiding behind its '✗ failed' summary."""
    # Heuristic: the newest PDF in data/ is likely the one that triggered the rerun
    pdfs = sorted(glob('data/*-PATH-Monthly-Ridership-Report.pdf'), key=getmtime, reverse=True)
    if not pdfs:
        return None
    newest_pdf = pdfs[0]
    year = basename(newest_pdf)[:4]
    dvc_path = f'data/{year}-day-types.pqt.dvc'
    if not exists(dvc_path):
        return None
    try:
        with open(dvc_path) as f:
            dvc_data = yaml.safe_load(f)
        cmd = dvc_data.get('meta', {}).get('computation', {}).get('cmd')
    except (yaml.YAMLError, OSError):
        return None
    if not cmd:
        return None
    # Re-run the EXACT stored cmd (e.g. `juq papermill run ...`) so we capture
    # any wrapper-level errors (e.g. juq's AlignmentError in its post-papermill
    # validation) that the original invocation produced. juq uses a temp dir
    # internally, so if it fails, the `-o` path is never written — we have to
    # rely on captured stderr.
    from os import makedirs
    makedirs('out', exist_ok=True)
    run_env = {**environ, 'PYTHONUNBUFFERED': '1'}
    err(f"_rerun_failing_dvc: re-running `{cmd}`")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=600, env=run_env)
    err(f"_rerun_failing_dvc: exit={result.returncode} stdout_len={len(result.stdout or '')} stderr_len={len(result.stderr or '')}")
    # Papermill writes cell errors to the output notebook even on failure;
    # parse that first.
    nb_out = glob('out/*.ipynb')
    if nb_out:
        nb_out.sort(key=getmtime, reverse=True)
        for nb in nb_out:
            cell_err = _notebook_errors(nb)
            if cell_err:
                return f"**{nb}**\n\n{cell_err}"
    # Fallback: show captured stderr/stdout. Errors usually appear at the TOP of
    # stderr (traceback header + cause), so prefer showing head + tail over just tail.
    def _head_tail(s: str | None, head_n: int = 4000, tail_n: int = 2000) -> str:
        if not s:
            return '(empty)'
        if len(s) <= head_n + tail_n + 100:
            return s
        return s[:head_n] + f'\n\n…[{len(s) - head_n - tail_n} chars omitted]…\n\n' + s[-tail_n:]

    return dedent(f"""\
        Re-ran `{' '.join(direct) if direct else cmd}` directly (exit {result.returncode}); no cell-error in `out/*.ipynb`.

        ### stderr

        ```
        {_head_tail(result.stderr)}
        ```

        ### stdout

        ```
        {_head_tail(result.stdout, head_n=1500, tail_n=500)}
        ```
        """)


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
        rerun_err = None
        if not nb_err:
            try:
                rerun_err = _rerun_failing_dvc()
            except Exception as ex:
                err(f"_rerun_failing_dvc failed: {ex}")
        diag_section = ""
        if nb_err:
            diag_section = f"\n\n### Notebook cell error\n\n{nb_err}"
        elif rerun_err:
            diag_section = f"\n\n### Direct command re-run\n\n{rerun_err}"
        _append_summary(dedent(f"""\
            ## :rotating_light: Pipeline error

            `{prog}` exited with status {e.returncode}. See the GHA run log
            for the underlying command's output.

            ```
            {tb[-1500:]}
            ```{diag_section}

            {md_link}
            """))
        slack_snip = ''
        if nb_err:
            slack_snip = f"\n```\n{nb_err[:500]}\n```"
        elif rerun_err:
            slack_snip = f"\n```\n{rerun_err[:500]}\n```"
        _slack(
            f":rotating_light: *PATH pipeline failed* (`{prog}` exit {e.returncode})\n{slack_link}{slack_snip}",
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
