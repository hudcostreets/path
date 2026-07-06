"""Mirror select `www/public/` files to stable public S3 URLs.

DVX-tracked files land in `s3://hudcostreets/path/.dvc/cache/files/md5/...`
under content-hash paths that rotate on every regeneration. For a handful of
assets (the pie-map gif/mp4 linked from the README and `/map` footer) we want
a stable, branded URL — `https://hudcostreets.s3.amazonaws.com/path/{name}` —
that survives regenerations. This subcommand mirrors those files there.

Wired up as a DVX side-effect stage (`www/public/publish-static.dvc`), so
whenever the underlying blob's md5 changes, `dvx run` re-invokes this cmd to
re-publish. Idempotent (S3 PUT of identical content is a no-op semantically).
"""
import subprocess
from pathlib import Path

from utz import err

from path_data.cli.base import path_data

BUCKET = 'hudcostreets'
KEY_PREFIX = 'path'
# Resolve `www/public/` relative to this file so the cmd works regardless of
# cwd (DVX invokes `cmd` with cwd = the `.dvc` file's parent dir).
PUBLIC_ROOT = Path(__file__).resolve().parent.parent / 'www' / 'public'

# {filename: Content-Type header}. Set explicitly because S3 otherwise applies
# `application/octet-stream` from unknown extensions, which breaks inline
# rendering (the .gif wouldn't display in the browser).
STATIC_ASSETS = {
    'pie-map-24h.gif': 'image/gif',
    'pie-map-24h.mp4': 'video/mp4',
}


@path_data.command('publish-static')
def publish_static():
    """Mirror pie-map .gif/.mp4 to stable public S3 URLs."""
    for name, ctype in STATIC_ASSETS.items():
        src = PUBLIC_ROOT / name
        if not src.exists():
            raise FileNotFoundError(
                f'{src} missing — run `dvx pull www/public/{name}.dvc` first'
            )
        dst = f's3://{BUCKET}/{KEY_PREFIX}/{name}'
        err(f'Publishing {src} → {dst}')
        subprocess.run(
            ['aws', 's3', 'cp', str(src), dst, '--content-type', ctype],
            check=True,
        )
