"""Mirror select `www/public/` files to stable public R2 URLs.

DVX-tracked files land in `s3://path/.dvc/cache/files/md5/...` (R2) under
content-hash paths that rotate on every regeneration. For a handful of assets
(the pie-map gif/mp4 linked from the README and `/map` footer) we want a
stable, branded URL — `https://pub-6decbf7387344f99ab25449bb7c89849.r2.dev/{name}`
— that survives regenerations. This subcommand mirrors those files there.

Wired up as a DVX side-effect stage (`www/public/publish-static.dvc`), so
whenever the underlying blob's md5 changes, `dvx run` re-invokes this cmd to
re-publish. Idempotent (R2 PUT of identical content is a no-op semantically).
"""
import subprocess
from pathlib import Path

from utz import err

from path_data.cli.base import path_data

# R2 bucket `path` in the HCCS CF account (S3-compatible endpoint). The
# aws CLI needs `--endpoint-url` since there's no per-command profile here — CI
# provides R2 creds via the `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env.
BUCKET = 'path'
R2_ENDPOINT = 'https://2363642879f18d37d52dca114059937e.r2.cloudflarestorage.com'
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
    """Mirror pie-map .gif/.mp4 to stable public R2 URLs."""
    for name, ctype in STATIC_ASSETS.items():
        src = PUBLIC_ROOT / name
        if not src.exists():
            raise FileNotFoundError(
                f'{src} missing — run `dvx pull www/public/{name}.dvc` first'
            )
        dst = f's3://{BUCKET}/{name}'
        err(f'Publishing {src} → {dst}')
        subprocess.run(
            ['aws', 's3', 'cp', str(src), dst, '--endpoint-url', R2_ENDPOINT, '--content-type', ctype],
            check=True,
        )
