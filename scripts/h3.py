#!/usr/bin/env python

import pandas as pd
from dateutil.parser import parse

from path_data.paths import ALL_PQT

df = pd.read_parquet(ALL_PQT)
last_month = parse(df.month.max())

print(f"""<h3>
Jan 2012 – {last_month.strftime('%b %Y')} <a id="weekdays"></a>
</h3>""")
