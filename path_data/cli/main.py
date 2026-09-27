from path_data.cli.base import path_data
from . import announce, combine, deploy, gha_update, refresh, slack  # noqa: F401  registers CLIs
from path_data import atd, entries_vs_exits, monthly, months, parse_hourly, publish_static  # noqa: F401  registers CLIs

def main():
    path_data()


if __name__ == '__main__':
    main()
