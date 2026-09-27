"""`www/announce.dvc` side-effect stage: announce newly-deployed data in Slack.

The stage's only dep is `www/deploy.dvc` (as a `git_dep`), which `dvx run`
rewrites only after `path-data deploy` succeeds; so this runs only after a
successful deploy, and never after a failed one. What it announces is the
latest month in the deployed FE data (`www/public/{all,bt-traffic}.pqt`),
compared against `www/announced.json` (the months last announced), so a deploy
without new months (e.g. regenerated artifacts) posts nothing."""
import json
from dataclasses import asdict, dataclass
from datetime import date
from os import environ
from os.path import join

import pandas as pd
from click import UsageError, option
from utz import err

from path_data.cli.base import path_data
from path_data.cli.gha_update import _append_summary, _run_url
from path_data.cli.slack import BOT_USERNAME, deploy_message, post_message
from path_data.paths import WWW, WWW_ALL_PQT, WWW_PUBLIC

ANNOUNCED_JSON = join(WWW, 'announced.json')
WWW_BT_TRAFFIC_PQT = join(WWW_PUBLIC, 'bt-traffic.pqt')
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


@dataclass(frozen=True)
class Latest:
    """Latest month (`YYYY-MM`) of each data source."""
    path: str | None
    bt: str | None


def latest_path_month(all_pqt: str = WWW_ALL_PQT) -> str:
    return pd.read_parquet(all_pqt)['month'].max()


def latest_bt_month(bt_traffic_pqt: str = WWW_BT_TRAFFIC_PQT) -> str:
    df = pd.read_parquet(bt_traffic_pqt)
    total = df[
        (df['Type'] == 'Total Vehicles')
        & (df['Crossing'] == 'All Crossings')
        & (df['Count'] > 0)
    ]
    return max(f"{year}-{MONTHS.index(month) + 1:02d}" for year, month in zip(total['Year'], total['Month']))


def current_latest() -> Latest:
    return Latest(path=latest_path_month(), bt=latest_bt_month())


def load_announced(path: str) -> Latest:
    with open(path) as f:
        return Latest(**json.load(f))


def save_announced(latest: Latest, path: str) -> None:
    with open(path, 'w') as f:
        json.dump(asdict(latest), f, indent=2)
        f.write('\n')


def bt_label(ym: str) -> str:
    """`2026-07` → `Jul '26`."""
    return date.fromisoformat(f'{ym}-01').strftime("%b '%y")


def announcement(prev: Latest, curr: Latest) -> tuple[str, str] | None:
    """`(summary, site_path)` describing what's new in `curr` vs. `prev`, e.g.
    `("PATH through 2026-08 (was 2026-07)", "/")`; None if nothing changed."""
    parts = []
    if curr.path != prev.path:
        was = f" (was {prev.path})" if prev.path else ""
        parts.append(f"PATH through {curr.path}{was}")
    if curr.bt != prev.bt:
        was = f" (was {bt_label(prev.bt)})" if prev.bt else ""
        parts.append(f"B&T through {bt_label(curr.bt)}{was}")
    if not parts:
        return None
    site_path = '/bt' if curr.path == prev.path else '/'
    return ', '.join(parts), site_path


@path_data.command('announce')
@option('-c', '--channel', envvar='SLACK_CHANNEL_ID', help='Slack channel ID')
@option('-i', '--init', is_flag=True, help=f'Record the current data months in `{ANNOUNCED_JSON}` without posting')
@option('-n', '--dry-run', is_flag=True, help='Print the announcement instead of posting it; leave the announced months unchanged')
@option('-t', '--token', envvar='SLACK_BOT_TOKEN', help='Slack bot token')
def announce(channel: str | None, init: bool, dry_run: bool, token: str | None):
    """Announce newly-deployed data in Slack (the `www/announce.dvc` stage)."""
    curr = current_latest()
    if init:
        save_announced(curr, ANNOUNCED_JSON)
        err(f"Recorded {curr} in {ANNOUNCED_JSON}")
        return
    prev = load_announced(ANNOUNCED_JSON)
    ann = announcement(prev, curr)
    if ann is None:
        err(f"Nothing new to announce ({curr})")
        return
    summary, site_path = ann
    text, emoji = deploy_message('success', summary, None, _run_url(), site_path)
    if dry_run:
        err(f"Would post, and record {curr}:")
        print(text)
        return
    if not (token and channel):
        raise UsageError('Slack token and channel required (`-t`/`$SLACK_BOT_TOKEN`, `-c`/`$SLACK_CHANNEL_ID`)')
    result = post_message(
        text=text,
        channel=channel,
        token=token,
        username=BOT_USERNAME,
        icon_emoji=emoji,
    )
    err(f"Posted to #{channel}: ts={result.get('ts')}")
    save_announced(curr, ANNOUNCED_JSON)
    _append_summary(f"## :train: New data: {summary}\n\nDeployed and announced in Slack.\n")
    commit_msg_file = environ.get('DVX_COMMIT_MSG_FILE')
    if commit_msg_file:
        with open(commit_msg_file, 'w') as f:
            f.write(f'Announce new data: {summary}\n')
