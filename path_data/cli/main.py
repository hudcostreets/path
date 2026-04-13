from path_data.cli.base import path_data
from . import combine, gha_update, refresh, slack
from path_data import monthly, months, parse_hourly  # noqa: F401  registers CLIs

def main():
    path_data()


if __name__ == '__main__':
    main()
