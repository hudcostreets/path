from os import environ
from subprocess import run

import pytest
from click.testing import CliRunner

from path_data.cli import report as rp
from path_data.cli.base import path_data

GIT_ENV = {
    'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com',
}


def git(*args, cwd) -> str:
    return run(['git', *args], cwd=cwd, env={**environ, **GIT_ENV}, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """Scratch repo at a run's starting commit; records Slack posts / NND-thread updates."""
    git('init', '-q', cwd=tmp_path)
    (tmp_path / 'www').mkdir()
    (tmp_path / 'www/announced.json').write_text('{"path": "2026-07", "bt": "2026-07"}\n')
    git('add', '.', cwd=tmp_path)
    git('commit', '-qm', 'init', cwd=tmp_path)
    monkeypatch.chdir(tmp_path)
    for var in ['GITHUB_RUN_ID', 'GITHUB_REPOSITORY', 'GITHUB_STEP_SUMMARY', 'PATH_DATA_SKIP_SLACK']:
        monkeypatch.delenv(var, raising=False)
    posts = []
    monkeypatch.setattr(rp, '_slack', lambda text, emoji=None, thread_ts=None, blocks=None: posts.append((text, thread_ts)) or f'ts{len(posts)}')
    monkeypatch.setattr(rp, '_post_no_new_data', lambda slack_link: posts.append(('no-new-data', slack_link)))
    monkeypatch.setattr(rp, '_latest_summary', lambda: "PATH Aug '26, B&T Jul '26")
    monkeypatch.setattr(rp, '_unpushed_commits', list)
    return tmp_path, git('rev-parse', 'HEAD', cwd=tmp_path), posts


def report(*args):
    return CliRunner().invoke(path_data, ['daily-report', *args])


def test_no_new_data(repo):
    tmp_path, base, posts = repo
    # A data stage committed, but nothing was announced
    (tmp_path / 'x').write_text('x')
    git('add', 'x', cwd=tmp_path)
    git('commit', '-qm', 'Run 2026', cwd=tmp_path)
    result = report('-b', base, '-s', 'success')
    assert result.exit_code == 0, result.output
    assert posts == [('no-new-data', 'GHA run')]


def test_new_data(repo):
    tmp_path, base, posts = repo
    (tmp_path / 'www/announced.json').write_text('{"path": "2026-08", "bt": "2026-07"}\n')
    git('commit', '-qam', 'Announce new data', cwd=tmp_path)
    result = report('-b', base, '-s', 'success')
    assert result.exit_code == 0, result.output
    assert posts == []


def test_unpushed(repo, monkeypatch):
    """`dvx run --push each` only warns on a failed `git push`; surface it."""
    _, base, posts = repo
    monkeypatch.setattr(rp, '_unpushed_commits', lambda: ['abc1234 Announce new data'])
    result = report('-b', base, '-s', 'success')
    assert result.exit_code == 1
    assert posts == [
        (':rotating_light: *PATH pipeline failed*\nGHA run', None),
        ('1 commit(s) not pushed:\n```\nabc1234 Announce new data\n```', 'ts1'),
    ]


def test_failure(repo):
    tmp_path, base, posts = repo
    (tmp_path / 'tmp').mkdir()
    (tmp_path / 'tmp/daily-pipeline.log').write_text(
        'Level 1/2: 2 computation(s)\n'
        '  ○ data/2025.pqt: up-to-date\n'
        '  ✗ data/2026.pqt: failed (exit code 1)\n'
    )
    # Written by `dvx run` for each executed stage
    (tmp_path / 'tmp/dvx-run-2026.log').write_text('=== stderr ===\nValueError: bad page\n')
    result = report('-b', base, '-s', 'failure', '-l', 'tmp/daily-pipeline.log', '-l', 'tmp/daily-deploy.log')
    assert result.exit_code == 0, result.output
    assert posts == [
        (':rotating_light: *PATH pipeline failed*\nGHA run', None),
        ('`data/2026.pqt` output (`tmp/dvx-run-2026.log`):\n\n```\n=== stderr ===\nValueError: bad page\n\n```', 'ts1'),
    ]
