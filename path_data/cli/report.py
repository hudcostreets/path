import json
import re
import subprocess
from datetime import datetime, timezone
from glob import glob
from os import environ, listdir
from os.path import exists, getmtime, isdir
from pathlib import Path
from sys import exit
from textwrap import dedent

from click import Choice, option
from utz import err, lines, run

from path_data.cli.base import path_data
from path_data.cli.slack import get_client, latest_bot_message, post_message
from path_data.utils import last_month


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
    """Convert a diagnostic markdown string (a failing stage's output,
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


def _failing_stage_output(dvx_output: str) -> str | None:
    """Output of the first stage `dvx run` reports as failed (`✗ <path>: …`),
    from the per-stage log DVX writes (`tmp/dvx-run-<stem>.log`)."""
    for target in _parse_failing_targets(dvx_output):
        log = f'tmp/dvx-run-{Path(target).stem}.log'
        if not exists(log):
            continue
        with open(log) as f:
            out = f.read()
        if len(out) > 5000:
            out = out[:1500] + f'\n\n…[{len(out) - 5000} chars omitted]…\n\n' + out[-3500:]
        return f"`{target}` output (`{log}`):\n\n```\n{out}\n```"
    return None


def _unpushed_commits() -> list[str]:
    run('git', 'fetch', '--quiet')
    return lines('git', 'log', '--format=%h %s', '@{u}..HEAD', log=False)


@path_data.command('daily-report')
@option('-b', '--base', required=True, help='Commit the run started from; `www/announced.json` changing since means new data was announced')
@option('-l', '--log', 'logs', multiple=True, help='Captured `dvx run` output; on failure, parsed for the failing stage')
@option('-n', '--dry-run', is_flag=True, help="Log Slack posts instead of sending them")
@option('-s', '--status', type=Choice(['success', 'failure']), required=True, help='Status of the pipeline steps (`job.status`)')
def daily_report(base: str, logs: tuple[str, ...], dry_run: bool, status: str):
    """Final step of the DVX daily workflow: Slack + step-summary report.

    On success: if no new data was announced (`www/announce.dvc` posts that),
    add a reply to the "no new data" Slack thread. On failure: post an alert,
    with the failing stage's output (or notebook error) as a thread reply."""
    if dry_run:
        environ['PATH_DATA_SKIP_SLACK'] = '1'
    url = _run_url()
    slack_link = _run_link_slack(url)
    md_link = _run_link_md(url)
    problem = None
    if status == 'success':
        unpushed = _unpushed_commits()
        if unpushed:
            # `dvx run --push each` only warns when a `git push` fails
            problem = f"{len(unpushed)} commit(s) not pushed:\n```\n" + '\n'.join(unpushed) + "\n```"
        else:
            announced = subprocess.run(
                ['git', 'diff', '--quiet', base, 'HEAD', '--', 'www/announced.json'],
                check=False,
            ).returncode != 0
            if announced:
                err("New data was announced by `www/announce.dvc`")
            else:
                summary = _latest_summary()
                _append_summary(dedent(f"""\
                    ## No new data

                    Latest: **{summary}**.

                    {md_link}
                    """))
                _post_no_new_data(slack_link)
            return
    else:
        dvx_output = ''
        for log in logs:
            if exists(log):
                with open(log) as f:
                    dvx_output += f.read()
        problem = _latest_out_notebook_error() or _failing_stage_output(dvx_output)
    _append_summary(f"## :rotating_light: Pipeline error\n\n{problem or 'See the run log.'}\n\n{md_link}\n")
    ts = _slack(
        f":rotating_light: *PATH pipeline failed*\n{slack_link}",
        emoji=':rotating_light:',
    )
    if ts and problem:
        truncated = problem[:2800]
        _slack(
            truncated,
            emoji=':rotating_light:',
            thread_ts=ts,
            blocks=_diagnostic_blocks(truncated),
        )
    if status == 'success':
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
