import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from glob import glob
from os import environ, listdir
from os.path import basename, exists, getmtime, isdir
from subprocess import CalledProcessError
from sys import exit
from textwrap import dedent
from traceback import format_exc

import yaml
from click import option
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


def _slack(text: str, emoji: str = ':train:', thread_ts: str | None = None, blocks: list | None = None) -> str | None:
    """Post a Slack message; return the message's `ts` (for threading
    follow-ups), or None if posting was skipped/failed. Pass `blocks` for
    Block Kit rich rendering; `text` is then the notification fallback."""
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
            blocks=blocks,
        )
        return result.get('ts')
    except Exception as e:
        err(f"Slack post failed: {e}")
        return None


_BOLD_INLINE = re.compile(r'\*([^*\n]+)\*')
_CODE_INLINE = re.compile(r'`([^`\n]+)`')


def _rich_text_section_elements(text: str) -> list:
    """Split prose text into Block Kit inline elements, honoring `*bold*`
    and `` `code` `` markers. Everything else is plain text."""
    out: list = []
    i = 0
    while i < len(text):
        # Find the earliest `*...*` or `` `...` `` match starting at i
        best = None
        for pat, style in [(_BOLD_INLINE, 'bold'), (_CODE_INLINE, 'code')]:
            m = pat.search(text, i)
            if m and (best is None or m.start() < best[0].start()):
                best = (m, style)
        if best is None:
            out.append({'type': 'text', 'text': text[i:]})
            break
        m, style = best
        if m.start() > i:
            out.append({'type': 'text', 'text': text[i:m.start()]})
        if style == 'code':
            out.append({'type': 'text', 'text': m.group(1), 'style': {'code': True}})
        else:
            out.append({'type': 'text', 'text': m.group(1), 'style': {'bold': True}})
        i = m.end()
    return out


def _diagnostic_blocks(details: str) -> list:
    """Convert a diagnostic markdown string (produced by `_rerun_failing_dvc`
    or `_notebook_errors`) into Slack Block Kit rich_text so the code fences
    render reliably. Slack's mrkdwn parser drops `### heading` and treats
    triple-backticks inconsistently in threaded replies; Block Kit
    `rich_text_preformatted` sections render as proper code blocks.

    Splits `details` on triple-backtick fences: even-index chunks are prose
    (with `*bold*` and `` `code` `` markers rendered via `style` flags), odd-index
    chunks are code blocks.
    """
    parts = details.split('```')
    elements: list = []
    for i, chunk in enumerate(parts):
        text = chunk.strip('\n')
        if not text:
            continue
        if i % 2 == 0:
            inline = _rich_text_section_elements(text + '\n')
            elements.append({'type': 'rich_text_section', 'elements': inline})
        else:
            elements.append({
                'type': 'rich_text_preformatted',
                'elements': [{'type': 'text', 'text': text}],
            })
    return [{'type': 'rich_text', 'elements': elements}]


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
    from os.path import dirname
    makedirs('out', exist_ok=True)
    run_env = {**environ, 'PYTHONUNBUFFERED': '1'}
    # Match DVX's cwd-from-.dvc-dir behavior so cmds with relative `cd`s
    # (e.g. `cd ../.. && python ...` for B&T) don't double up on `_rerun`.
    cmd_cwd = dirname(dvc_path) or None
    err(f"_rerun_failing_dvc: re-running `{cmd}` (cwd={cmd_cwd or '.'})")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=600, env=run_env, cwd=cmd_cwd)
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

    # Slack's mrkdwn doesn't render `###` headings and treats triple-backtick
    # fences inconsistently in threaded replies (see the 2026-07-01 incident
    # where `### stderr` showed raw and the code fences vanished). Use plain
    # `stderr:` / `stdout:` labels and Slack-native `*bold*` — this renders
    # readably on both Slack and GitHub Step Summary (where `*bold*` italicizes,
    # which is fine; the important thing is the section is delimited).
    return dedent("""\
        Re-ran `{cmd}` directly (exit {rc}); no cell-error in `out/*.ipynb`.

        *stderr:*
        ```
        {stderr}
        ```

        *stdout:*
        ```
        {stdout}
        ```
        """).format(
        cmd=cmd,
        rc=result.returncode,
        stderr=_head_tail(result.stderr),
        stdout=_head_tail(result.stdout, head_n=1500, tail_n=500),
    )


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


def _staged_in_head(predicate) -> bool:
    """Return True if any file matching `predicate` differs between HEAD~1 and HEAD.

    Used to gate the "published and deployed" Slack message on whether the
    artifacts the FE actually reads (`www/public/*.dvc`) changed in the
    just-pushed commit — not just whether `last_month()` happened to flip.
    """
    try:
        out = subprocess.check_output(
            ['git', 'diff', '--name-only', 'HEAD~1', 'HEAD'],
            text=True,
        )
    except CalledProcessError as e:
        err(f"_staged_in_head: git diff failed: {e}")
        return False
    return any(predicate(line) for line in out.splitlines() if line)


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
# Matches OP format: "Latest: PATH Mar '26, B&T Dec '25. Polled Nx 🧵".
# `conversations.history` returns emojis as `:shortcode:` (e.g. `:thread:`),
# so accept either form — otherwise the thread-continuity check silently
# falls through to "start a new thread" on every call.
_NO_DATA_OP_RE = re.compile(
    r"Latest: .+\. Polled (\d+)x (?:\U0001f9f5|:thread:)"
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


def _post_no_new_data(
    slack_link: str,
    *,
    run_url: str | None = None,
    now: datetime | None = None,
) -> None:
    """Post or update a "no new data" thread in Slack using thrds.

    Builds the desired thread state (OP + all replies) and calls ``sync()``
    which diffs against existing messages — editing the OP and appending
    the new reply with minimal API calls.

    ``run_url`` + ``now`` default to the current env's GHA run + wall-clock;
    override them to backfill a "no new data" reply for a past run whose
    Slack step failed (see the ``backfill-slack`` command).
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

    now = now or datetime.now(timezone.utc)
    now_et = now.astimezone(ZoneInfo('America/New_York'))
    timestamp_et = now_et.strftime('%b %-d, %-I:%M %p')

    summary = _latest_summary()

    # Build new reply text
    run_url = run_url if run_url is not None else _run_url()
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
        # Snapshot `last_month()` BEFORE refresh — PATH Monthly PDFs are
        # git-tracked, so reading them now (pre-refresh) gives the previous
        # month; `path-data refresh` then overwrites with the new content.
        prev_ym = _safe_last_month()

        err('=== path-data refresh ===')
        run('path-data', 'refresh')

        curr_ym = _safe_last_month()

        pdf_paths = _staged_paths(path_filter='data/')
        updated_pdfs = [p for p in pdf_paths if p.endswith('.pdf')]

        # Pre-fetch S3-cached outputs so `dvx run` can hash-verify against
        # `.dvc` outs and skip stages whose deps haven't changed. Without
        # this, fresh CI runners (empty `.dvc/cache`) recompute every stage
        # from upstream PDFs (~25min). `check=False` so a partial cache
        # miss (e.g. brand-new `.dvc` not yet pushed) doesn't fail the run
        # — `dvx run` will recompute whatever pull missed.
        err('=== dvx pull ===')
        run('dvx', 'pull', check=False)

        # `_bt_latest_month()` reads `data/bt/traffic.pqt` which isn't git-tracked,
        # so snapshot the "previous" BT month AFTER the pull (which hydrates the
        # last-committed parquet) but BEFORE `dvx run` (which may re-parse from
        # any new PDF).
        prev_bt = _bt_latest_month()

        err('=== dvx run ===')
        dvc_targets = sorted(glob('data/*.dvc')) + sorted(glob('data/bt/*.dvc')) + sorted(glob('www/public/*.dvc'))
        # Stream output live (so step log shows progress per-stage) while
        # also accumulating it for the failure parser (`✗ <path>: failed`).
        # `subprocess.run(capture_output=True)` would buffer everything
        # until exit — silent for ~25min, then a wall of text.
        proc = subprocess.Popen(
            ['dvx', 'run', '-v', *dvc_targets],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        captured_lines: list[str] = []
        assert proc.stdout is not None
        for line in proc.stdout:
            sys.stderr.write(line)
            sys.stderr.flush()
            captured_lines.append(line)
        proc.wait()
        captured = ''.join(captured_lines)
        if proc.returncode != 0:
            e = CalledProcessError(proc.returncode, ['dvx', 'run', '-v', '…'])
            e.stdout = captured
            e.stderr = ''
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
            # `dvx add -f` rewrites each input's .dvc with the fresh md5/size.
            # Re-stage so the commit captures those rewrites — otherwise
            # `www/public/bt-{traffic,ezpass}.pqt.dvc` (which have no `cmd`,
            # so `dvx run` doesn't touch them) stay at the pre-update md5
            # and the FE's `dvcResolve('bt-traffic.pqt')` URL keeps pointing
            # at the old parquet on S3.
            run('git', 'add', 'data/', 'www/public/', 'img/')
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
        curr_bt = _bt_latest_month()

        # Compare parsed-data snapshots, not staged PDFs: a re-uploaded PDF
        # with the same content can stage a new `.pdf.dvc` (new etag/mtime)
        # without producing any new parsed rows.
        label_flipped_path = bool(curr_label and prev_label and prev_label != curr_label)
        label_flipped_bt = bool(curr_bt and curr_bt != prev_bt)

        # Only claim "published and deployed" when the FE-facing artifacts
        # *actually* changed in this commit. `last_month()`/`_bt_latest_month()`
        # alone can flip while parsing/the dvx run silently no-ops (see the
        # 2026-06-17 incident: PDF page count flipped April→May, Slack
        # claimed "through 2026-05 — published and deployed", but
        # `www/public/all.pqt.dvc` didn't change, so the FE stayed on April).
        path_outs_changed = _staged_in_head(
            lambda f: (
                f.startswith('www/public/')
                and f.endswith('.dvc')
                and not basename(f).startswith('bt-')
            )
        )
        bt_outs_changed = _staged_in_head(
            lambda f: f.startswith('www/public/bt-') and f.endswith('.dvc')
        )
        new_path = label_flipped_path and path_outs_changed
        new_bt = label_flipped_bt and bt_outs_changed

        if new_path or new_bt:
            # At least one source has genuinely new upstream data
            parts = []
            if new_path:
                parts.append(f"PATH through {curr_label} (was {prev_label})")
            if new_bt:
                if prev_bt:
                    parts.append(f"B&T through {curr_bt} (was {prev_bt})")
                else:
                    parts.append(f"B&T through {curr_bt}")
            headline = ":white_check_mark: *New data:* " + ", ".join(parts) + " — published and deployed"
            # Link to /bt when only BT changed; otherwise the headline page.
            site_path = '/bt' if new_bt and not new_path else '/'
            site_url = 'https://path.hudcostreets.org' + site_path
            _slack(
                f"{headline}\n{slack_link} · <{site_url}|View site>",
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
        _append_summary(dedent("""\
            ## :rotating_light: Pipeline error

            `{prog}` exited with status {rc}. See the GHA run log
            for the underlying command's output.

            ```
            {tb}
            ```{diag}

            {link}
            """).format(
            prog=prog,
            rc=e.returncode,
            tb=tb[-1500:],
            diag=diag_section,
            link=md_link,
        ))
        # Main message stays short; the full diagnostic (cell error or
        # re-run output) lands as a thread reply so the channel isn't
        # spammed with stack traces.
        ts = _slack(
            f":rotating_light: *PATH pipeline failed* (`{prog}` exit {e.returncode})\n{slack_link}",
            emoji=':rotating_light:',
        )
        details = nb_err or rerun_err
        if ts and details:
            # Post via Block Kit rich_text so code fences reliably render as
            # code blocks (Slack mrkdwn drops `### heading` and rendered
            # triple-backticks inconsistently in threaded replies — see the
            # 2026-07-01 incident where `### stderr` showed raw and stderr
            # content lost monospace styling).
            truncated = details[:2800]
            _slack(
                truncated,
                emoji=':rotating_light:',
                thread_ts=ts,
                blocks=_diagnostic_blocks(truncated),
            )
        exit(e.returncode or 1)
    except Exception:
        tb = format_exc()
        err(tb)
        _append_summary(dedent("""\
            ## :rotating_light: Unexpected error

            ```
            {tb}
            ```

            {link}
            """).format(
            tb=tb[-2000:],
            link=md_link,
        ))
        ts = _slack(
            f":rotating_light: *PATH pipeline crashed* (see run log)\n{slack_link}",
            emoji=':rotating_light:',
        )
        if ts:
            tb_tail = tb[-2800:]
            _slack(
                tb_tail,
                emoji=':rotating_light:',
                thread_ts=ts,
                blocks=_diagnostic_blocks(f"```\n{tb_tail}\n```"),
            )
        exit(1)


@path_data.command('backfill-slack')
@option('-r', '--run-id', required=True, help='GHA run ID whose Slack post never landed')
def backfill_slack(run_id: str):
    """Post a "no new data" Slack reply for a past CI run whose Slack step failed.

    Fetches the run's `updatedAt` (completion time) for the reply timestamp
    and the run's URL for the link. Appends the reply directly to the
    latest "no new data" thread via `SlackClient.post(thread_id=...)` —
    skipping the full thrds `sync()` path because Slack rejects
    `chat.update` on OPs more than a few days old, which kicks thrds into
    a delete+repost fallback that re-posts the OP inside the thread.
    Summary ("PATH Mar '26, B&T Dec '25") comes from the current
    working-tree data — fine for no-data backfills since latest-month
    metadata hasn't changed.
    """
    from subprocess import check_output
    from zoneinfo import ZoneInfo

    token = environ.get('SLACK_BOT_TOKEN')
    channel = environ.get('SLACK_CHANNEL_ID')
    if not (token and channel):
        err("Slack skipped (no token/channel)")
        return

    data = json.loads(check_output(
        ['gh', 'run', 'view', run_id, '--json', 'updatedAt,url']
    ))
    run_url = data['url']
    now = datetime.fromisoformat(data['updatedAt'].replace('Z', '+00:00'))
    now_et = now.astimezone(ZoneInfo('America/New_York'))
    timestamp_et = now_et.strftime('%b %-d, %-I:%M %p')
    summary = _latest_summary()
    reply_text = f"<{run_url}|{timestamp_et}> · No new data ({summary})"

    client = get_client(token=token, channel=channel)
    latest = latest_bot_message(client)
    if not latest or not _NO_DATA_OP_RE.match(latest.get('text', '')):
        err(f"No matching 'Latest: ...' OP found in recent history — aborting")
        exit(1)
    op_ts = latest['ts']
    err(f"Backfilling NND reply for run {run_id} ({data['updatedAt']}) → thread {op_ts}")
    client.post(reply_text, thread_id=op_ts)
