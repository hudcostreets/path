import type { LatLon } from 'geo-sankey'

/** Multi-waypoint paths for each PANYNJ Bridge & Tunnel crossing.
 *  Direction: NJ side → NY/SI side (mirrors `traffic.pqt` "Eastbound (tolled
 *  direction)" framing). Coordinates approximate, sourced from Wikipedia /
 *  the toll-plaza locations. Mid-water point gives the ribbon a slight
 *  curve through the Bezier renderer. */
export const BT_CROSSING_PATHS: Record<string, LatLon[]> = {
  // Hudson River (NJ → Manhattan)
  'George Washington Bridge': [
    [40.851, -73.974],  // NJ approach (Fort Lee)
    [40.852, -73.957],  // mid-Hudson
    [40.852, -73.946],  // NY (Washington Heights, 178th)
  ],
  'Lincoln Tunnel': [
    [40.766, -74.023],  // NJ portal (Weehawken)
    [40.762, -74.011],  // mid-Hudson
    [40.759, -73.999],  // NY portal (39th St / 10th Ave)
  ],
  'Holland Tunnel': [
    [40.729, -74.037],  // NJ portal (Jersey City, 14th St)
    [40.727, -74.020],  // mid-Hudson
    [40.726, -74.007],  // NY portal (Broome St / Hudson Sq)
  ],

  // NJ → Staten Island (Arthur Kill / Kill Van Kull)
  'Bayonne Bridge': [
    [40.642, -74.131],  // NJ approach (Bayonne)
    [40.640, -74.137],  // mid-channel (Kill Van Kull)
    [40.638, -74.143],  // SI side (Port Richmond)
  ],
  'Goethals Bridge': [
    [40.640, -74.196],  // NJ approach (Elizabeth)
    [40.638, -74.187],  // mid-channel (Arthur Kill)
    [40.636, -74.176],  // SI side (Howland Hook)
  ],
  'Outerbridge Crossing': [
    [40.521, -74.250],  // NJ approach (Perth Amboy)
    [40.523, -74.246],  // mid-channel (Arthur Kill)
    [40.525, -74.243],  // SI side (Tottenville)
  ],
} as const

/** Bounding box of all crossings (lat min/max, lon min/max). Used for the
 *  initial map fit. */
export const BT_BBOX = {
  minLat: 40.521,
  maxLat: 40.852,
  minLon: -74.250,
  maxLon: -73.946,
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
