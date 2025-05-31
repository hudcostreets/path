#!/usr/bin/env python

import pandas as pd
from dateutil.parser import parse

from path_data.paths import ALL_PQT

df = pd.read_parquet(ALL_PQT)
last_month = parse(df.month.max())
print(f"""<div>

As of {last_month.strftime("%B %Y")}:
- Weekday ridership was 71.2% of {last_month.strftime("%B")} '19 (pre-COVID)
- Weekend ridership was 99.6% of {last_month.strftime("%B")} '19 (pre-COVID)
</div>
""")
