import json
import re
import subprocess
from datetime import datetime, timezone
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
from path_data.cli.slack import get_client, latest_bot_message, post_message
from path_data.utils import git_has_staged_changes, last_month


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


def _slack(text: str, emoji: str = ':train:', thread_ts: str | None = None) -> str | None:
    """Post a Slack message; return the message's `ts` (for threading
    follow-ups), or None if posting was skipped/failed."""
    if environ.get('PATH_DATA_SKIP_SLACK'):
        suffix = f" [thread reply to {thread_ts}]" if thread_ts else ""
        err(f"Slack skipped ($PATH_DATA_SKIP_SLACK){suffix}: {text}")
        return None
    token = environ.get('SLACK_BOT_TOKEN')
    channel = environ.get('SLACK_CHANNEL_ID')
    if not (token and channel):
        err(f"Slack skipped (no token/channel): {text}")
        return None
    try:
        result = post_message(
            text=text,
            channel=channel,
            token=token,
            icon_emoji=emoji,
            username='PATH Data',
            thread_ts=thread_ts,
        )
        return result.get('ts')
    except Exception as e:
        err(f"Slack post failed: {e}")
        return None


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


_FAILED_TARGET_RE = None


def _parse_failing_targets(dvx_output: str) -> list[str]:
    """Parse DVX's `✗ <path>: …` lines (any failure reason) out of
    combined stdout/stderr. DVX emits multiple failure phrases, e.g.:
    `✗ data/X: failed`, `✗ data/X: co-output not produced`."""
    global _FAILED_TARGET_RE
    if _FAILED_TARGET_RE is None:
        import re
        _FAILED_TARGET_RE = re.compile(r'✗\s+(\S+?):\s', re.MULTILINE)
    return _FAILED_TARGET_RE.findall(dvx_output or '')


def _dvc_for_output(out_path: str) -> str | None:
    """Given an output path like `data/2017-hourly-system.pqt`, return its .dvc."""
    candidate = f'{out_path}.dvc'
    if exists(candidate):
        return candidate
    return None


def _rerun_failing_dvc(captured_output: str = '') -> str | None:
    """On failure, re-run the first failing target's stored cmd directly with
    captured stderr. Identifies the failing target by parsing `✗ … failed`
    lines out of the DVX output (not by heuristic on newest PDF, which is
    wrong when the failure is in a downstream stage like hourly)."""
    failed = _parse_failing_targets(captured_output)
    if failed:
        out_path = failed[0]
        dvc_path = _dvc_for_output(out_path)
    else:
        # No `✗ … failed` parsed — fall back to newest-monthly heuristic
        pdfs = sorted(glob('data/*-PATH-Monthly-Ridership-Report.pdf'), key=getmtime, reverse=True)
        if not pdfs:
            return None
        year = basename(pdfs[0])[:4]
        dvc_path = f'data/{year}-day-types.pqt.dvc'
        if not exists(dvc_path):
            return None
    if not dvc_path:
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
        Re-ran `{cmd}` directly (exit {result.returncode}); no cell-error in `out/*.ipynb`.

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


def _ym_label(ym) -> str | None:
    """Render a `utz.YM` as `YYYY-MM`, tolerant of None / exceptions."""
    if ym is None:
        return None
    try:
        return f'{ym.year}-{ym.month:02d}'
    except Exception:
        return None


def _safe_last_month():
    """Return `last_month()` or None if the refresh/PDF state doesn't yet
    allow inferring one (e.g. no PDFs locally)."""
    try:
        return last_month()
    except Exception as e:
        err(f"_safe_last_month: {type(e).__name__}: {e}")
        return None


def _bt_latest_month() -> str | None:
    """Return the latest B&T data month as "Mon 'YY", or None."""
    try:
        import pandas as pd
        df = pd.read_parquet('data/bt/traffic.pqt')
        months_order = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        total = df[(df['Type'] == 'Total Vehicles') &
                   (df['Crossing'] == 'All Crossings') &
                   (df['Month'].isin(months_order)) &
                   (df['Count'] > 0)]
        if total.empty:
            return None
        # Find latest year, then latest month within it
        max_year = int(total['Year'].max())
        year_data = total[total['Year'] == max_year]
        month_indices = year_data['Month'].map(lambda m: months_order.index(m))
        max_month_idx = int(month_indices.max())
        return f"{months_order[max_month_idx]} '{max_year % 100:02d}"
    except Exception as e:
        err(f"_bt_latest_month: {type(e).__name__}: {e}")
        return None


def _classify_updated_pdfs(staged: list[str]) -> dict[str, list[str]]:
    """Classify staged PDF paths by source type."""
    result: dict[str, list[str]] = {'path_monthly': [], 'path_hourly': [], 'bt': []}
    for p in staged:
        if not p.endswith('.pdf'):
            continue
        name = basename(p)
        if 'traffic-e-zpass' in name:
            result['bt'].append(p)
        elif 'Hourly' in name or 'hourly' in name:
            result['path_hourly'].append(p)
        elif 'Monthly' in name:
            result['path_monthly'].append(p)
    return result


def _summarize_new_data(updated_pdfs: list[str], prev_ym=None, curr_ym=None) -> str:
    curr_label = _ym_label(curr_ym)
    prev_label = _ym_label(prev_ym)
    heading = '## :train: New PATH ridership data'
    if curr_label:
        heading += f' — through {curr_label}'
        if prev_label and prev_label != curr_label:
            heading += f' (was {prev_label})'
    lines = [heading, '']
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


NO_DATA_EMOJI = ':hourglass_flowing_sand:'
# Matches OP format: "Latest: PATH Mar '26, B&T Dec '25. Polled Nx 🧵"
_NO_DATA_OP_RE = re.compile(
    r"Latest: .+\. Polled (\d+)x \U0001f9f5"
)


def _data_label(ym_label: str) -> str:
    """Format '2026-03' → "Mar '26"."""
    try:
        from utz import to_dt
        return to_dt(ym_label).strftime("%b '%y")
    except Exception:
        return ym_label


def _next_month_label(ym_label: str) -> str:
    """Format '2026-03' → "Apr '26" (the next expected month)."""
    try:
        from utz import to_dt
        dt = to_dt(ym_label)
        if dt.month == 12:
            nxt = dt.replace(year=dt.year + 1, month=1)
        else:
            nxt = dt.replace(month=dt.month + 1)
        return nxt.strftime("%b '%y")
    except Exception:
        return ym_label


def _latest_summary() -> str:
    """Build a "Latest: PATH Mar '26, B&T Dec '25" string from current data."""
    parts = []
    path_ym = _safe_last_month()
    if path_ym:
        parts.append(f"PATH {_data_label(_ym_label(path_ym))}")
    bt = _bt_latest_month()
    if bt:
        parts.append(f"B&T {bt}")
    return ', '.join(parts) if parts else '—'


def _post_no_new_data(slack_link: str) -> None:
    """Post or update a "no new data" thread in Slack using thrds.

    Builds the desired thread state (OP + all replies) and calls ``sync()``
    which diffs against existing messages — editing the OP and appending
    the new reply with minimal API calls.
    """
    token = environ.get('SLACK_BOT_TOKEN')
    channel = environ.get('SLACK_CHANNEL_ID')
    if not (token and channel):
        err("Slack skipped (no token/channel)")
        return
    if environ.get('PATH_DATA_SKIP_SLACK'):
        err("Slack skipped ($PATH_DATA_SKIP_SLACK)")
        return

    from thrds import Thread
    from zoneinfo import ZoneInfo

    now = datetime.now(timezone.utc)
    now_et = now.astimezone(ZoneInfo('America/New_York'))
    timestamp_et = now_et.strftime('%b %-d, %-I:%M %p')

    summary = _latest_summary()

    # Build new reply text
    run_url = _run_url()
    if run_url:
        new_reply = f"<{run_url}|{timestamp_et}> \u00b7 No new data ({summary})"
    else:
        new_reply = f"{timestamp_et} \u00b7 No new data ({summary})"

    client = get_client(token=token, channel=channel)
    latest = latest_bot_message(client)
    latest_text = (latest or {}).get('text', '')
    m = _NO_DATA_OP_RE.match(latest_text) if latest else None

    try:
        if m and latest:
            # Existing "no new data" thread — read replies, build desired state
            thread_ts = latest['ts']
            existing = client.list_messages(thread_ts)
            existing_replies = [msg.content for msg in existing[1:]]
            poll_count = len(existing_replies) + 1
            op = f"Latest: {summary}. Polled {poll_count}x \U0001f9f5"
            desired = [op] + existing_replies + [new_reply]
            client.sync(Thread(messages=desired), thread_ts=thread_ts)
        else:
            # Start a new "no new data" thread
            op = f"Latest: {summary}. Polled 1x \U0001f9f5"
            client.sync(Thread(messages=[op, new_reply]))
    except Exception as e:
        err(f"No-data thread sync failed: {e}")


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
        # Snapshot `last_month()` BEFORE refresh so we can report
        # "through YYYY-MM (was YYYY-MM)" in Slack + summary.
        prev_ym = _safe_last_month()

        err('=== path-data refresh ===')
        run('path-data', 'refresh')

        curr_ym = _safe_last_month()

        pdf_paths = _staged_paths(path_filter='data/')
        updated_pdfs = [p for p in pdf_paths if p.endswith('.pdf')]

        err('=== dvx run ===')
        dvc_targets = sorted(glob('data/*.dvc')) + sorted(glob('data/bt/*.dvc')) + sorted(glob('www/public/*.dvc'))
        # Capture output so the failure handler can parse `✗ <path>: failed`
        # lines. Echo it live so the step log still reflects progress.
        dvx_res = subprocess.run(
            ['dvx', 'run', '-v', *dvc_targets],
            capture_output=True, text=True,
        )
        err(dvx_res.stdout)
        err(dvx_res.stderr)
        if dvx_res.returncode != 0:
            e = CalledProcessError(dvx_res.returncode, ['dvx', 'run', '-v', '…'])
            e.stdout = dvx_res.stdout
            e.stderr = dvx_res.stderr
            raise e

        run('git', 'add', 'data/', 'www/public/', 'img/')

        if not git_has_staged_changes():
            summary = _latest_summary()
            _append_summary(dedent(f"""\
                ## No new data

                Upstream PDFs unchanged since last check.
                Latest: **{summary}**.

                {md_link}
                """))
            _post_no_new_data(slack_link)
            return

        err('=== dvx add + push ===')
        # `dvx run` produces outputs in the workspace but doesn't cache them,
        # so a plain `dvx push` uploads nothing. Explicit `dvx add -f` on each
        # stage's output populates `.dvc/cache/` before push. Pass the output
        # file paths (not `.dvc` paths — dvx would re-track those as regular
        # files, causing "DVC file cannot be an output" on push).
        to_cache: list[str] = []
        for t in dvc_targets:
            if t.endswith('.pdf.dvc'):
                continue  # `import-url` PDFs already handled by `dvx update`
            try:
                with open(t) as f:
                    d = yaml.safe_load(f) or {}
            except (OSError, yaml.YAMLError):
                continue
            for o in d.get('outs') or []:
                p = o.get('path')
                if not p:
                    continue
                # .dvc `outs.path` is relative to the .dvc file's dir
                from os.path import dirname, join as pjoin
                to_cache.append(pjoin(dirname(t), p))
        existing = [p for p in to_cache if exists(p)]
        if existing:
            run('dvx', 'add', '-f', *existing)
        run('dvx', 'push')

        run('git', 'commit', '-m', 'Update PATH ridership data')
        run('git', 'push')

        # GITHUB_TOKEN pushes don't trigger other workflows (GH loop-prevention),
        # so www.yml won't auto-deploy the new data. Kick it off explicitly.
        if environ.get('GITHUB_RUN_ID'):
            try:
                run('gh', 'workflow', 'run', 'www.yml')
                err('=== dispatched www.yml ===')
            except CalledProcessError as e:
                err(f"Failed to dispatch www.yml: {e}")

        _append_summary(_summarize_new_data(updated_pdfs, prev_ym, curr_ym) + f'\n\n{md_link}\n')
        curr_label = _ym_label(curr_ym)
        prev_label = _ym_label(prev_ym)

        # Classify what actually changed upstream
        by_source = _classify_updated_pdfs(updated_pdfs)
        new_path = bool(curr_label and prev_label and prev_label != curr_label)
        new_bt = bool(by_source['bt'])
        prev_bt = _bt_latest_month()  # already reflects new data if parsed

        if new_path or new_bt:
            # At least one source has genuinely new upstream data
            parts = []
            if new_path:
                parts.append(f"PATH through {curr_label} (was {prev_label})")
            if new_bt and prev_bt:
                parts.append(f"B&T through {prev_bt}")
            headline = ":white_check_mark: *New data:* " + ", ".join(parts) + " — published and deployed"
            _slack(
                f"{headline}\n{slack_link} · <https://path.hudcostreets.org|View site>",
                emoji=':white_check_mark:',
            )
        else:
            # Artifacts regenerated but no new upstream data — thread
            _post_no_new_data(slack_link)
    except CalledProcessError as e:
        tb = format_exc()
        err(tb)
        prog = e.cmd[0] if hasattr(e, 'cmd') and e.cmd else '?'
        nb_err = _latest_out_notebook_error()
        rerun_err = None
        if not nb_err:
            try:
                captured = (e.stdout or '') + '\n' + (e.stderr or '')
                rerun_err = _rerun_failing_dvc(captured_output=captured)
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
        # Main message stays short; the full diagnostic (cell error or
        # re-run output) lands as a thread reply so the channel isn't
        # spammed with stack traces.
        ts = _slack(
            f":rotating_light: *PATH pipeline failed* (`{prog}` exit {e.returncode})\n{slack_link}",
            emoji=':rotating_light:',
        )
        details = nb_err or rerun_err
        if ts and details:
            _slack(
                f"```\n{details[:2800]}\n```",
                emoji=':rotating_light:',
                thread_ts=ts,
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
        ts = _slack(
            f":rotating_light: *PATH pipeline crashed* (see run log)\n{slack_link}",
            emoji=':rotating_light:',
        )
        if ts:
            _slack(f"```\n{tb[-2800:]}\n```", emoji=':rotating_light:', thread_ts=ts)
        exit(1)
