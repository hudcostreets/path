from os.path import dirname, join

PKG = dirname(__file__)
ROOT = dirname(PKG)

MONTHLY_NB = join(ROOT, "monthly.ipynb")
MONTHS_NB = join(ROOT, "months.ipynb")

DATA = join(ROOT, 'data')
ALL_PQT = join(DATA, 'all.pqt')

IMG = join(ROOT, 'img')
OUT = join(ROOT, 'out')
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
    return join(DATA, f'{year}-PATH-Hourly-Ridership-Report.pdf')
