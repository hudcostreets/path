"""`www/deploy.dvc` side-effect stage: build the site and deploy it to
Cloudflare Pages.

The build embeds each `www/public` DVX artifact's content-addressed URL (via
`vite-plugin-dvc`), so the stage depends on all of them: new data ⇒ rebuild +
redeploy. The artifacts are pushed to the DVX remote first, so every URL the
new build references resolves before it goes live."""
from glob import glob
from os import environ
from os.path import join, relpath
from subprocess import run

import yaml
from click import UsageError, option
from utz import err

from path_data.cli.base import path_data
from path_data.paths import ROOT, WWW, WWW_PUBLIC

HCCS_CF_ACCOUNT_ID = '2363642879f18d37d52dca114059937e'


def public_dvcs() -> list[str]:
    """Repo-root-relative `www/public/*.dvc` artifacts (i.e. with `outs`; not
    side-effect stages like `publish-static.dvc`)."""
    dvcs = []
    for path in sorted(glob(join(WWW_PUBLIC, '*.dvc'))):
        with open(path) as f:
            if yaml.safe_load(f).get('outs'):
                dvcs.append(relpath(path, ROOT))
    return dvcs


def deploy_steps(
    project: str,
    branch: str,
    e2e: bool,
) -> list[tuple[list[str], str]]:
    """`(argv, cwd)` for each deploy step."""
    dvcs = public_dvcs()
    steps = [
        (['dvx', 'pull', *dvcs], ROOT),
        (['dvx', 'push', *dvcs], ROOT),
        (['pnpm', 'install'], WWW),
        (['pnpm', 'run', 'build'], WWW),
        # SPA routing: CF Pages serves `404.html` for unknown paths
        (['cp', 'dist/index.html', 'dist/404.html'], WWW),
    ]
    if e2e:
        steps.append((['npx', 'playwright', 'test'], WWW))
    steps.append((
        ['npx', 'wrangler', 'pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, '--commit-dirty=true'],
        WWW,
    ))
    return steps


@path_data.command('deploy')
@option('-b', '--branch', default='main', help='CF Pages branch (`main` = production)')
@option('-E', '--no-e2e', is_flag=True, help="Skip the Playwright e2e tests (run between build and deploy)")
@option('-n', '--dry-run', is_flag=True, help='Print the steps instead of running them')
@option('-p', '--project', default='pa', help='CF Pages project')
def deploy(branch: str, no_e2e: bool, dry_run: bool, project: str):
    """Build `www/` and deploy it to Cloudflare Pages (the `www/deploy.dvc` stage).

    Requires `$CLOUDFLARE_API_TOKEN`; `$CLOUDFLARE_ACCOUNT_ID` defaults to HCCS'."""
    steps = deploy_steps(project=project, branch=branch, e2e=not no_e2e)
    if dry_run:
        for argv, cwd in steps:
            print(f"({relpath(cwd, ROOT)}) {' '.join(argv)}")
        return
    if not environ.get('CLOUDFLARE_API_TOKEN'):
        raise UsageError('$CLOUDFLARE_API_TOKEN required')
    env = {**environ}
    env.setdefault('CLOUDFLARE_ACCOUNT_ID', HCCS_CF_ACCOUNT_ID)
    for argv, cwd in steps:
        err(f"=== ({relpath(cwd, ROOT)}) {' '.join(argv)}")
        run(argv, cwd=cwd, env=env, check=True)
    commit_msg_file = environ.get('DVX_COMMIT_MSG_FILE')
    if commit_msg_file:
        with open(commit_msg_file, 'w') as f:
            f.write(f'Deploy www to CF Pages ({project}@{branch})\n')
