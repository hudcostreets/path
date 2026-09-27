from subprocess import CalledProcessError

import pytest
from click.testing import CliRunner

from path_data.cli import deploy as dep
from path_data.cli.base import path_data
from path_data.cli.deploy import public_dvcs
from path_data.paths import ROOT, WWW

WRANGLER = ['npx', 'wrangler', 'pages', 'deploy', 'dist', '--project-name', 'pa', '--branch', 'main', '--commit-dirty=true']


def test_dry_run():
    result = CliRunner().invoke(path_data, ['deploy', '-n'])
    assert result.exit_code == 0, result.output
    dvcs = ' '.join(public_dvcs())
    assert result.stdout.splitlines() == [
        f'(.) dvx pull {dvcs}',
        f'(.) dvx push {dvcs}',
        '(www) pnpm install',
        '(www) pnpm run build',
        '(www) cp dist/index.html dist/404.html',
        '(www) npx playwright test',
        f"(www) {' '.join(WRANGLER)}",
    ]


@pytest.fixture
def steps(monkeypatch):
    """Mock `subprocess.run`; collect `(argv, cwd, CF env)` of each step."""
    for var in ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'DVX_COMMIT_MSG_FILE']:
        monkeypatch.delenv(var, raising=False)
    steps = []

    def run(argv, cwd, env, check):
        assert check
        steps.append((argv, cwd, env.get('CLOUDFLARE_API_TOKEN'), env.get('CLOUDFLARE_ACCOUNT_ID')))

    monkeypatch.setattr(dep, 'run', run)
    return steps


def test_deploy(steps, tmp_path, monkeypatch):
    monkeypatch.setenv('CLOUDFLARE_API_TOKEN', 'cf-token')
    commit_msg = tmp_path / 'commit-msg'
    commit_msg.write_text('')
    monkeypatch.setenv('DVX_COMMIT_MSG_FILE', str(commit_msg))
    result = CliRunner().invoke(path_data, ['deploy', '-E'])
    assert result.exit_code == 0, result.output
    dvcs = public_dvcs()
    cf = ('cf-token', '2363642879f18d37d52dca114059937e')
    assert steps == [
        (['dvx', 'pull', *dvcs], ROOT, *cf),
        (['dvx', 'push', *dvcs], ROOT, *cf),
        (['pnpm', 'install'], WWW, *cf),
        (['pnpm', 'run', 'build'], WWW, *cf),
        (['cp', 'dist/index.html', 'dist/404.html'], WWW, *cf),
        (WRANGLER, WWW, *cf),
    ]
    assert commit_msg.read_text() == 'Deploy www to CF Pages (pa@main)\n'


def test_requires_cf_token(steps):
    result = CliRunner().invoke(path_data, ['deploy'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == 'Error: $CLOUDFLARE_API_TOKEN required'
    assert steps == []


def test_failed_step(tmp_path, monkeypatch):
    """A failing step (e.g. e2e) aborts before deploying, and fails the stage."""
    monkeypatch.setenv('CLOUDFLARE_API_TOKEN', 'cf-token')
    commit_msg = tmp_path / 'commit-msg'
    commit_msg.write_text('')
    monkeypatch.setenv('DVX_COMMIT_MSG_FILE', str(commit_msg))
    ran = []

    def run(argv, cwd, env, check):
        ran.append(argv[:3])
        if argv[:2] == ['npx', 'playwright']:
            raise CalledProcessError(1, argv)

    monkeypatch.setattr(dep, 'run', run)
    result = CliRunner().invoke(path_data, ['deploy'])
    assert result.exit_code == 1
    assert ran == [
        ['dvx', 'pull', public_dvcs()[0]],
        ['dvx', 'push', public_dvcs()[0]],
        ['pnpm', 'install'],
        ['pnpm', 'run', 'build'],
        ['cp', 'dist/index.html', 'dist/404.html'],
        ['npx', 'playwright', 'test'],
    ]
    assert commit_msg.read_text() == ''
