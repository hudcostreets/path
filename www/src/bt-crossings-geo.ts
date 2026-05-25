import type { LatLon } from 'geo-sankey'

/** Multi-waypoint paths for each PANYNJ Bridge & Tunnel crossing.
 *  Direction: NJ side → NY/SI side (mirrors `traffic.pqt` "Eastbound (tolled
 *  direction)" framing). Coordinates approximate, sourced from Wikipedia /
 *  the toll-plaza locations. Mid-water point gives the ribbon a slight
 *  curve through the Bezier renderer. */
export const BT_CROSSING_PATHS: Record<string, LatLon[]> = {
  // Hudson River (NJ → Manhattan)
  'George Washington Bridge': [
    [40.8663, -73.9746],
    [40.8580, -73.9578],
    [40.8520, -73.9460],
  ],
  'Lincoln Tunnel': [
    [40.7678, -74.0316],
    [40.7645, -74.0126],
    [40.7590, -73.9990],
  ],
  'Holland Tunnel': [
    [40.7305, -74.0473],
    [40.7275, -74.0287],
    [40.7260, -74.0070],
  ],

  // NJ → Staten Island (Arthur Kill / Kill Van Kull)
  'Bayonne Bridge': [
    [40.6394, -74.1322],
    [40.6339, -74.1357],
    [40.6257, -74.1405],
  ],
  'Goethals Bridge': [
    [40.6429, -74.2041],
    [40.6372, -74.1929],
    [40.6300, -74.1815],
  ],
  'Outerbridge Crossing': [
    [40.5198, -74.2607],
    [40.5188, -74.2471],
    [40.5193, -74.2317],
  ],
} as const

/** Bounding box of all crossings (lat min/max, lon min/max). Used for the
 *  initial map fit. */
export const BT_BBOX = {
  minLat: 40.5188,
  maxLat: 40.8663,
  minLon: -74.2607,
  maxLon: -73.9460,
}

/** Short labels for on-map placement (saves horizontal room vs the full
 *  "George Washington Bridge" / "Outerbridge Crossing" names). */
export const BT_CROSSING_LABELS: Record<string, string> = {
  'George Washington Bridge': 'GWB',
  'Lincoln Tunnel': 'Lincoln',
  'Holland Tunnel': 'Holland',
  'Bayonne Bridge': 'Bayonne',
  'Goethals Bridge': 'Goethals',
  'Outerbridge Crossing': 'Outerbridge',
}
