import json
from contextlib import contextmanager
from io import BytesIO

import pandas as pd
import pytest
from click.testing import CliRunner

from path_data.cli import announce as ann
from path_data.cli import slack
from path_data.cli.announce import (
    Latest,
    announcement,
    latest_bt_month,
    latest_path_month,
)
from path_data.cli.base import path_data

RUN_URL = 'https://github.com/hudcostreets/path/actions/runs/1'


def test_announcement():
    prev = Latest(path='2026-07', bt='2026-06')
    assert announcement(prev, prev) is None
    assert announcement(prev, Latest(path='2026-08', bt='2026-06')) == ('PATH through 2026-08 (was 2026-07)', '/')
    assert announcement(prev, Latest(path='2026-07', bt='2026-07')) == ("B&T through Jul '26 (was Jun '26)", '/bt')
    assert announcement(prev, Latest(path='2026-08', bt='2026-07')) == (
        "PATH through 2026-08 (was 2026-07), B&T through Jul '26 (was Jun '26)",
        '/',
    )
    assert announcement(Latest(path=None, bt=None), prev) == ("PATH through 2026-07, B&T through Jun '26", '/')


def write_pqts(dir, path_months: list[str], bt: list[tuple[int, str, str, str, int]]):
    all_pqt = dir / 'all.pqt'
    pd.DataFrame({'month': path_months, 'station': 'Hoboken'}).to_parquet(all_pqt)
    bt_pqt = dir / 'bt-traffic.pqt'
    pd.DataFrame(bt, columns=['Year', 'Crossing', 'Type', 'Month', 'Count']).to_parquet(bt_pqt)
    return all_pqt, bt_pqt


BT_ROWS = [
    (2025, 'All Crossings', 'Total Vehicles', 'Dec', 10),
    (2026, 'All Crossings', 'Total Vehicles', 'Jun', 10),
    (2026, 'All Crossings', 'Total Vehicles', 'Jul', 10),
    # Not-yet-reported months are zero-filled
    (2026, 'All Crossings', 'Total Vehicles', 'Aug', 0),
    # Other crossings / types don't count
    (2026, 'Holland Tunnel', 'Total Vehicles', 'Sep', 10),
    (2026, 'All Crossings', 'Buses', 'Oct', 10),
]


def test_latest_months(tmp_path):
    all_pqt, bt_pqt = write_pqts(tmp_path, ['2026-06', '2026-08', '2026-07'], BT_ROWS)
    assert latest_path_month(all_pqt) == '2026-08'
    assert latest_bt_month(bt_pqt) == '2026-07'


@pytest.fixture
def site(tmp_path, monkeypatch):
    """FE data showing PATH 2026-08 / B&T 2026-07; `announced.json` one PATH month behind."""
    all_pqt, bt_pqt = write_pqts(tmp_path, ['2026-07', '2026-08'], BT_ROWS)
    monkeypatch.setattr(ann, 'latest_path_month', lambda: latest_path_month(all_pqt))
    monkeypatch.setattr(ann, 'latest_bt_month', lambda: latest_bt_month(bt_pqt))
    announced = tmp_path / 'announced.json'
    announced.write_text('{"path": "2026-07", "bt": "2026-07"}\n')
    monkeypatch.setattr(ann, 'ANNOUNCED_JSON', str(announced))
    for var in ['GITHUB_STEP_SUMMARY', 'DVX_COMMIT_MSG_FILE', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID']:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv('GITHUB_REPOSITORY', 'hudcostreets/path')
    monkeypatch.setenv('GITHUB_RUN_ID', '1')
    return announced


@pytest.fixture
def slack_requests(monkeypatch):
    """Mock Slack's HTTP API; collect the `(url, headers, payload)` of each request."""
    requests = []

    @contextmanager
    def urlopen(req):
        requests.append((req.full_url, dict(req.header_items()), json.loads(req.data)))
        yield BytesIO(b'{"ok": true, "ts": "123.456"}')

    monkeypatch.setattr(slack, 'urlopen', urlopen)
    return requests


EXPECTED_TEXT = '\n'.join([
    ':white_check_mark: *New data:* PATH through 2026-08 (was 2026-07) — published and deployed',
    f'<{RUN_URL}|View deploy run> · <https://pa.hccs.dev/|View site>',
])


def test_announce(site, slack_requests, tmp_path, monkeypatch):
    commit_msg = tmp_path / 'commit-msg'
    commit_msg.write_text('')
    monkeypatch.setenv('DVX_COMMIT_MSG_FILE', str(commit_msg))
    result = CliRunner().invoke(path_data, ['announce', '-c', 'C123', '-t', 'xoxb-test'])
    assert result.exit_code == 0, result.output
    assert slack_requests == [(
        'https://slack.com/api/chat.postMessage',
        {'Authorization': 'Bearer xoxb-test', 'Content-type': 'application/json'},
        {
            'channel': 'C123',
            'text': EXPECTED_TEXT,
            'username': 'PATH Data',
            'icon_emoji': ':white_check_mark:',
        },
    )]
    assert json.loads(site.read_text()) == {'path': '2026-08', 'bt': '2026-07'}
    assert commit_msg.read_text() == 'Announce new data: PATH through 2026-08 (was 2026-07)\n'

    # Re-running (e.g. a redeploy without new months) posts nothing
    requests = list(slack_requests)
    result = CliRunner().invoke(path_data, ['announce', '-c', 'C123', '-t', 'xoxb-test'])
    assert result.exit_code == 0, result.output
    assert slack_requests == requests
    assert json.loads(site.read_text()) == {'path': '2026-08', 'bt': '2026-07'}


def test_announce_dry_run(site, slack_requests):
    result = CliRunner().invoke(path_data, ['announce', '-n'])
    assert result.exit_code == 0, result.output
    assert result.stdout == EXPECTED_TEXT + '\n'
    assert slack_requests == []
    assert json.loads(site.read_text()) == {'path': '2026-07', 'bt': '2026-07'}


def test_announce_requires_slack_creds(site, slack_requests):
    """A missing token fails the stage (so `dvx` leaves it stale, to retry)."""
    result = CliRunner().invoke(path_data, ['announce'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == 'Error: Slack token and channel required (`-t`/`$SLACK_BOT_TOKEN`, `-c`/`$SLACK_CHANNEL_ID`)'
    assert slack_requests == []
    assert json.loads(site.read_text()) == {'path': '2026-07', 'bt': '2026-07'}


def test_announce_slack_error(site, monkeypatch):
    """A Slack API error fails the stage, leaving the announced months unchanged."""
    @contextmanager
    def urlopen(req):
        yield BytesIO(b'{"ok": false, "error": "channel_not_found"}')

    monkeypatch.setattr(slack, 'urlopen', urlopen)
    result = CliRunner().invoke(path_data, ['announce', '-c', 'C123', '-t', 'xoxb-test'])
    assert result.exit_code == 1
    assert repr(result.exception) == "RuntimeError('Slack API error: channel_not_found')"
    assert json.loads(site.read_text()) == {'path': '2026-07', 'bt': '2026-07'}


def test_announce_init(site, slack_requests):
    result = CliRunner().invoke(path_data, ['announce', '-i'])
    assert result.exit_code == 0, result.output
    assert slack_requests == []
    assert json.loads(site.read_text()) == {'path': '2026-08', 'bt': '2026-07'}
