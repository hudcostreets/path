#!/usr/bin/env bash
# Update PATH ridership data: download PDFs, parse data, combine and generate plots
set -e

echo "🚂 PATH Ridership Data Update"
echo "=============================="
echo

# Step 1: Download latest PDFs
echo "📥 Step 1/3: Downloading latest PDFs..."
path-data refresh
echo

# Step 2: Parse current year data
echo "📊 Step 2/3: Parsing data for current year..."
path-data update
echo

# Step 3: Combine all years and generate outputs
echo "🔄 Step 3/3: Combining all years and generating outputs..."
path-data combine || {
    echo "⚠️  Warning: Combine step had errors (likely PNG generation)"
    echo "    Data files (all.pqt, all.xlsx) should still be updated"
}
echo

echo "✅ Update complete!"
echo
echo "Updated files:"
ls -lh data/all.{pqt,xlsx} data/202*.pqt 2>/dev/null | tail -5

echo
echo "To commit changes:"
echo "  git add -u data/ out/ months.ipynb"
echo "  git commit -m 'Update PATH data ($(date +%Y-%m))'"
