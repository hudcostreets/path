# Fix OG image dimensions

## Problem
The current GitHub social preview is **1200x600** (2:1). The standard OG image size is **1200x630** (~1.91:1). While close, it's slightly off and renders inconsistently alongside other cards on the `ryan-williams` profile README.

## Context
The `ryan-williams` profile README now prefers site OG images when available. This repo's homepage field is not set on GitHub, so it falls back to the GH social preview. The 1200x600 dimensions are 30px short vertically.

## Tasks

### Resize OG image to 1200x630
Regenerate or resize the existing OG image to **1200x630**. This can be done by:
- Adding 15px padding top and bottom, or
- Re-screenshotting at the correct dimensions via `scrns`

Keep under 300KB.

### Update GitHub social preview
Upload the corrected image as the repo's social preview (Settings → Social preview).

### Set homepage URL on GitHub
Set the repo's homepage URL so the `ryan-williams` build can find and prefer the site's OG image in the future.
