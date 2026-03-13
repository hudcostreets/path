#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pdfplumber", "pyarrow"]
# ///
"""Parse PANYNJ Bridge & Tunnel traffic PDFs into parquet files."""
from pathlib import Path
from re import match

import click
import pdfplumber
import pyarrow as pa
import pyarrow.parquet as pq

CROSSINGS = [
    "All Crossings",
    "George Washington Bridge",
    "Lincoln Tunnel",
    "Holland Tunnel",
    "Goethals Bridge",
    "Outerbridge Crossing",
    "Bayonne Bridge",
]
VEHICLE_TYPES = ["Automobiles", "Buses", "Trucks", "Total Vehicles"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def rejoin_split_numbers(parts: list[str], expected: int | None = None) -> list[str]:
    """Rejoin numbers split by PDF extraction.

    E.g. ['2', '4,325'] → ['24,325'], ['1', ',802'] → ['1,802'], ['9', '89'] → ['989'].

    When `expected` is given, uses it to decide whether short digit pairs should be joined:
    if we have more parts than expected, greedily join short-digit pairs.
    """
    result: list[str] = []
    i = 0
    while i < len(parts):
        cur = parts[i]
        if i + 1 < len(parts) and cur.isdigit() and len(cur) <= 2 and cur != "0":
            nxt = parts[i + 1]
            # Next starts with comma (e.g. ",802") — clearly a continuation
            if nxt.startswith(",") and len(nxt) >= 4:
                result.append(cur + nxt)
                i += 2
                continue
            # Next is a comma-formatted number (e.g. "4,325" or "0,103")
            if nxt[0:1].isdigit() and "," in nxt and nxt.replace(",", "").isdigit():
                result.append(cur + nxt)
                i += 2
                continue
            # Next is a short digit-only number (e.g. "89", "954") — join if we have too many parts
            if nxt.isdigit() and len(nxt) <= 3 and expected is not None:
                remaining = len(parts) - i
                remaining_expected = expected - len(result)
                if remaining > remaining_expected:
                    result.append(cur + nxt)
                    i += 2
                    continue
        result.append(cur)
        i += 1
    return result


def parse_int(s: str) -> int | None:
    s = s.replace(",", "")
    if s in ("-", "#DIV/0!", "N/A"):
        return None
    return int(s)


def parse_pct(s: str) -> float | None:
    s = s.rstrip("%")
    if s in ("-", "#DIV/0!", "N/A", ""):
        return None
    return float(s)


INDIVIDUAL_CROSSINGS = [c for c in CROSSINGS if c != "All Crossings"]
INDIVIDUAL_TYPES = [t for t in VEHICLE_TYPES if t != "Total Vehicles"]


def parse_pdf(path: Path) -> tuple[list[dict], list[dict]]:
    """Parse a single year's B&T traffic PDF. Returns (traffic_rows, ezpass_rows)."""
    pdf = pdfplumber.open(path)
    text = pdf.pages[0].extract_text()
    lines = text.split("\n")

    # Extract year from title line
    year_match = match(r"(\d{4})\s+Monthly", lines[0])
    if not year_match:
        raise ValueError(f"Could not parse year from title: {lines[0]!r}")
    year = int(year_match.group(1))

    # Determine how many months are present from header
    header_line = next(l for l in lines if l.startswith("(Eastbound Traffic)"))
    header_parts = header_line.split()
    month_cols = [part for part in header_parts if part in MONTHS]
    n_months = len(month_cols)

    traffic_rows: list[dict] = []
    ezpass_rows: list[dict] = []
    current_crossing: str | None = None
    # Store parsed counts for validation: {(crossing, type): {month: count}}
    parsed: dict[tuple[str, str], dict[str, int]] = {}
    # Store YTD values for validation: {(crossing, type): ytd_count}
    ytd_vals: dict[tuple[str, str], int] = {}

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Check if it's a crossing header
        if line in CROSSINGS:
            current_crossing = line
            continue

        if current_crossing is None:
            continue

        # E-ZPass row
        if line.startswith("E-ZPass Usage"):
            parts = line.split()
            pcts = [p for p in parts if "%" in p and p != "(%)"]
            for i, mo in enumerate(month_cols):
                if i < len(pcts):
                    val = parse_pct(pcts[i])
                    if val is not None:
                        ezpass_rows.append({
                            "Year": year,
                            "Crossing": current_crossing,
                            "Month": mo,
                            "E-Z Pass Percent": val,
                        })
            if len(pcts) > n_months:
                val = parse_pct(pcts[-1])
                if val is not None:
                    ezpass_rows.append({
                        "Year": year,
                        "Crossing": current_crossing,
                        "Month": "Annual",
                        "E-Z Pass Percent": val,
                    })
            continue

        # Vehicle type row
        for vtype in VEHICLE_TYPES:
            if line.startswith(vtype):
                parts = rejoin_split_numbers(line[len(vtype):].split(), expected=n_months + 1)
                counts = [parse_int(p) for p in parts]
                key = (current_crossing, vtype)
                parsed[key] = {}
                for i, mo in enumerate(month_cols):
                    if i < len(counts) and counts[i] is not None:
                        parsed[key][mo] = counts[i]
                        traffic_rows.append({
                            "Year": year,
                            "Crossing": current_crossing,
                            "Type": vtype,
                            "Month": mo,
                            "Count": counts[i],
                        })
                # YTD/Annual is the value after the month columns
                if len(counts) > n_months and counts[n_months] is not None:
                    ytd_vals[key] = counts[n_months]
                break

    validate(year, parsed, ytd_vals, month_cols)
    return traffic_rows, ezpass_rows


def validate(
    year: int,
    parsed: dict[tuple[str, str], dict[str, int]],
    ytd_vals: dict[tuple[str, str], int],
    month_cols: list[str],
) -> None:
    """Cross-check parsed data: Total Vehicles, All Crossings, and YTD sums."""
    errors: list[str] = []

    for crossing in CROSSINGS:
        for mo in month_cols:
            # Check 1: Total Vehicles = sum of individual types
            parts_sum = sum(parsed.get((crossing, t), {}).get(mo, 0) for t in INDIVIDUAL_TYPES)
            total = parsed.get((crossing, "Total Vehicles"), {}).get(mo)
            if total is not None and parts_sum != total:
                errors.append(f"  {crossing} {mo}: Total Vehicles={total}, sum(A+B+T)={parts_sum} (Δ{total - parts_sum})")

    for vtype in VEHICLE_TYPES:
        for mo in month_cols:
            # Check 2: All Crossings = sum of individual crossings
            parts_sum = sum(parsed.get((c, vtype), {}).get(mo, 0) for c in INDIVIDUAL_CROSSINGS)
            total = parsed.get(("All Crossings", vtype), {}).get(mo)
            if total is not None and parts_sum != total:
                errors.append(f"  All Crossings {vtype} {mo}: total={total}, sum={parts_sum} (Δ{total - parts_sum})")

    for (crossing, vtype), ytd in ytd_vals.items():
        # Check 3: YTD = sum of monthly values
        monthly_sum = sum(parsed.get((crossing, vtype), {}).get(mo, 0) for mo in month_cols)
        if monthly_sum != ytd:
            errors.append(f"  {crossing} {vtype} YTD: ytd={ytd}, sum={monthly_sum} (Δ{ytd - monthly_sum})")

    if errors:
        print(f"  ⚠ {year} VALIDATION ({len(errors)} mismatches):")
        for e in errors:
            print(e)
    else:
        print(f"  ✓ {year} validation passed")


@click.command()
@click.option('-d', '--data-dir', default='data', help='Directory containing PDF files')
@click.option('-o', '--output-dir', default='data/bt', help='Output directory for parquet files')
@click.option('-y', '--years', default='2011-2025', help='Year range (e.g. 2011-2025)')
def main(data_dir: str, output_dir: str, years: str):
    data_path = Path(data_dir)
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    start, end = years.split("-")
    year_range = range(int(start), int(end) + 1)

    all_traffic: list[dict] = []
    all_ezpass: list[dict] = []

    for year in year_range:
        pdf_path = data_path / f"traffic-e-zpass-usage-{year}.pdf"
        if not pdf_path.exists():
            print(f"  SKIP {year} (not found)")
            continue
        traffic, ezpass = parse_pdf(pdf_path)
        print(f"  {year}: {len(traffic)} traffic rows, {len(ezpass)} ezpass rows")
        all_traffic.extend(traffic)
        all_ezpass.extend(ezpass)

    # Write traffic parquet
    traffic_table = pa.table({
        "Year": [r["Year"] for r in all_traffic],
        "Crossing": [r["Crossing"] for r in all_traffic],
        "Type": [r["Type"] for r in all_traffic],
        "Month": [r["Month"] for r in all_traffic],
        "Count": [r["Count"] for r in all_traffic],
    })
    traffic_out = out_path / "traffic.pqt"
    pq.write_table(traffic_table, traffic_out)
    print(f"\n{traffic_out}: {len(all_traffic)} rows")

    # Write ezpass parquet
    if all_ezpass:
        ezpass_table = pa.table({
            "Year": [r["Year"] for r in all_ezpass],
            "Crossing": [r["Crossing"] for r in all_ezpass],
            "Month": [r["Month"] for r in all_ezpass],
            "E-Z Pass Percent": [r["E-Z Pass Percent"] for r in all_ezpass],
        })
        ezpass_out = out_path / "ezpass.pqt"
        pq.write_table(ezpass_table, ezpass_out)
        print(f"{ezpass_out}: {len(all_ezpass)} rows")
    else:
        print("No E-ZPass data found")


if __name__ == "__main__":
    main()
