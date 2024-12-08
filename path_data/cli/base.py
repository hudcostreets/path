from click import group, option

commit_opt = option('-c', '--commit', count=True, help='1x: commit changes, 2x: commit and push')


@group
def path_data():
    """Download, analyze, and visualize PATH ridership data."""
    pass
