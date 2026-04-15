from os.path import dirname, join

PKG = dirname(__file__)
ROOT = dirname(PKG)

MONTHS_NB = join(ROOT, "months.ipynb")

DATA = join(ROOT, 'data')
ALL_PQT = join(DATA, 'all.pqt')
ALL_XLSX = join(DATA, 'all.xlsx')

IMG = join(ROOT, 'img')
OUT = join(ROOT, 'out')

WWW = join(ROOT, 'www')
WWW_PUBLIC = join(WWW, 'public')
WWW_ALL_PQT = join(WWW_PUBLIC, 'all.pqt')
TEMPLATES = join(ROOT, 'templates')
TEMPLATE_2023 = join(TEMPLATES, '2023-PATH-Monthly-Ridership-Report.tabula-template.json')
TEMPLATE_2022 = join(TEMPLATES, '2022-PATH-Monthly-Ridership-Report.tabula-template.json')

def template(year):
    return TEMPLATE_2023 if year >= 2023 else TEMPLATE_2022

def year_pqt(year: int) -> str:
    return join(DATA, f'{year}.pqt')

def year_day_types_pqt(year: int) -> str:
    return join(DATA, f'{year}-day-types.pqt')

def monthly_pdf(year: int) -> str:
    return join(DATA, f'{year}-PATH-Monthly-Ridership-Report.pdf')

def hourly_pdf(year: int) -> str:
    """Return the on-disk hourly PDF path for `year`. PANYNJ used lowercase
    `hourly` for 2017–2022 reports and capitalized `Hourly` starting 2023.
    Return the one that actually exists; fall back to the capitalized form
    (post-2023 is the long-term convention)."""
    from os.path import exists
    lower = join(DATA, f'{year}-PATH-hourly-Ridership-Report.pdf')
    upper = join(DATA, f'{year}-PATH-Hourly-Ridership-Report.pdf')
    if exists(lower) and not exists(upper):
        return lower
    return upper
