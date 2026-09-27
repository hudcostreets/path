"""Consistency of the `www/{deploy,announce}.dvc` side-effect stages."""
import json
from os.path import basename
from pathlib import Path

import yaml

from path_data.cli.deploy import public_dvcs

WWW = Path(__file__).parent.parent / 'www'


def computation(name: str) -> dict:
    """A side-effect stage: `cmd` and no `outs`. (No explicit `side_effect:
    true`; the pinned `dvx` infers it, and drops the key when rewriting.)"""
    with open(WWW / name) as f:
        d = yaml.safe_load(f)
    assert list(d) == ['meta']
    return d['meta']['computation']


def test_deploy_stage():
    """Every `www/public` artifact is a dep (the build embeds each one's
    content-addressed URL), so any data update redeploys."""
    c = computation('deploy.dvc')
    assert c['cmd'] == 'path-data deploy'
    assert sorted(c['deps']) == [f"public/{basename(dvc)[:-len('.dvc')]}" for dvc in public_dvcs()]
    assert 'git_deps' not in c


def test_announce_stage():
    """Gated on a successful deploy: `www/deploy.dvc` only changes when `dvx
    run` records a successful `path-data deploy`."""
    c = computation('announce.dvc')
    assert c['cmd'] == 'path-data announce'
    assert list(c['git_deps']) == ['deploy.dvc']
    assert 'deps' not in c


def test_announced_json():
    with open(WWW / 'announced.json') as f:
        assert list(json.load(f)) == ['path', 'bt']
