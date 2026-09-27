"""The DVX semantics `www/{deploy,announce}.dvc` rely on, exercised against the
pinned `dvx` in a scratch repo mirroring their layout (with stub cmds):

- a side-effect stage runs iff a dep's recorded md5 differs from the dep's `.dvc`;
- a failed cmd leaves the stage's `.dvc` untouched (so it stays stale → retried);
- `announce.dvc`'s `git_dep` on `deploy.dvc` makes it run only after a
  successful deploy (which is what rewrites `deploy.dvc`)."""
import sys
from hashlib import md5
from os import environ
from pathlib import Path
from subprocess import run

import pytest
import yaml

DVX = str(Path(sys.executable).parent / 'dvx')
GIT_ENV = {
    'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com',
}


def sh(*args, cwd, env=None, check=True):
    return run(args, cwd=cwd, env={**environ, **GIT_ENV, **(env or {})}, check=check, capture_output=True, text=True)


def write_artifact(repo: Path, content: str):
    """Stand-in for a `www/public` pipeline output + its `.dvc`."""
    (repo / 'www/public/a.txt').write_text(content)
    (repo / 'www/public/a.txt.dvc').write_text(yaml.safe_dump({'outs': [{
        'md5': md5(content.encode()).hexdigest(),
        'size': len(content),
        'hash': 'md5',
        'path': 'a.txt',
    }]}, sort_keys=False))


def write_stage(path: Path, cmd: str, **deps):
    path.write_text(yaml.safe_dump({'meta': {'computation': {'cmd': cmd, **deps}}}, sort_keys=False))


@pytest.fixture
def repo(tmp_path):
    sh('git', 'init', '-q', cwd=tmp_path)
    (tmp_path / 'www/public').mkdir(parents=True)
    write_artifact(tmp_path, 'v1')
    # Stub cmds log to `<repo>/log`; `$FAIL` makes the deploy fail. (cwd = `.dvc` dir)
    write_stage(tmp_path / 'www/deploy.dvc', 'echo deploy >> ../log && exit ${FAIL:-0}', deps={'public/a.txt': None})
    write_stage(tmp_path / 'www/announce.dvc', 'echo announce >> ../log', git_deps={'deploy.dvc': None})
    sh('git', 'add', '.', cwd=tmp_path)
    sh('git', 'commit', '-qm', 'init', cwd=tmp_path)
    return tmp_path


def dvx_run(repo: Path, target: str, fail: bool = False):
    return sh(DVX, 'run', '--commit', target, cwd=repo, env={'FAIL': '1' if fail else '0'}, check=False)


def log(repo: Path) -> list[str]:
    path = repo / 'log'
    return path.read_text().splitlines() if path.exists() else []


def test_deploy_then_announce(repo):
    # Initial run records dep hashes (the real `.dvc`s are committed pre-recorded)
    assert dvx_run(repo, 'www/deploy.dvc').returncode == 0
    assert dvx_run(repo, 'www/announce.dvc').returncode == 0
    assert log(repo) == ['deploy', 'announce']
    deploy_dvc = (repo / 'www/deploy.dvc').read_text()
    assert yaml.safe_load(deploy_dvc) == {'meta': {'computation': {
        'cmd': 'echo deploy >> ../log && exit ${FAIL:-0}',
        'deps': {'public/a.txt': md5(b'v1').hexdigest()},
    }}}

    # Nothing changed: both fresh
    assert dvx_run(repo, 'www/deploy.dvc').returncode == 0
    assert dvx_run(repo, 'www/announce.dvc').returncode == 0
    assert log(repo) == ['deploy', 'announce']

    # New data, deploy fails: `deploy.dvc` untouched ⇒ no announcement
    write_artifact(repo, 'v2')
    sh('git', 'commit', '-qam', 'new data', cwd=repo)
    assert dvx_run(repo, 'www/deploy.dvc', fail=True).returncode == 1
    assert (repo / 'www/deploy.dvc').read_text() == deploy_dvc
    assert dvx_run(repo, 'www/announce.dvc').returncode == 0
    assert log(repo) == ['deploy', 'announce', 'deploy']

    # Next run retries the deploy; its success gates the announcement
    assert dvx_run(repo, 'www/deploy.dvc').returncode == 0
    assert dvx_run(repo, 'www/announce.dvc').returncode == 0
    assert log(repo) == ['deploy', 'announce', 'deploy', 'deploy', 'announce']
    assert sh('git', 'status', '--porcelain', '--untracked-files=no', cwd=repo).stdout == ''

    # …once
    assert dvx_run(repo, 'www/deploy.dvc').returncode == 0
    assert dvx_run(repo, 'www/announce.dvc').returncode == 0
    assert log(repo) == ['deploy', 'announce', 'deploy', 'deploy', 'announce']
