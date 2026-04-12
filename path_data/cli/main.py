from path_data.cli.base import path_data
from . import combine, gha_update, refresh, slack
from path_data import monthly, months  # noqa: F401  registers `path-data monthly` + `months`

def main():
    path_data()


if __name__ == '__main__':
    main()
