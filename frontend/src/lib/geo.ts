// Shared scene geometry for the Skryer demo: the protected-asset / array origin, the
// three perimeter sensor nodes, and the local-metre <-> lat/lon projection. Imported
// by BOTH the map (MapView) and the synthetic contact source (mockSource) so node
// positions and the coordinate frame can never drift between them.

export const ORIGIN_LAT = 45.4807; // Fitzroy Harbour, ON — the protected site / array centroid
export const ORIGIN_LON = -76.209;
const METRES_PER_DEG_LAT = 111_320;

export function metresPerDegLon(latDeg: number): number {
  return METRES_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

/** Local east(x)/north(y) metres from the origin → [lat, lon]. */
export function projectXY(x: number, y: number): [number, number] {
  return [ORIGIN_LAT + y / METRES_PER_DEG_LAT, ORIGIN_LON + x / metresPerDegLon(ORIGIN_LAT)];
}

/** Same projection but in GeoJSON order, [lon, lat]. */
export function lonlat(x: number, y: number): [number, number] {
  const [lat, lon] = projectXY(x, y);
  return [lon, lat];
}

/** Inverse of projectXY: lat/lon → local east(x)/north(y) metres from the origin. */
export function toLocal(lat: number, lon: number): [number, number] {
  return [(lon - ORIGIN_LON) * metresPerDegLon(ORIGIN_LAT), (lat - ORIGIN_LAT) * METRES_PER_DEG_LAT];
}

// Defense-in-depth node network. A premium ($50K-class) long-range EO/IR PTZ can ID a
// small UAS much further out than the cheap 20× cam, so the OUTER ring of nodes is pushed
// out to that camera's confirm range. But each node is still only an *acoustic* sensor
// (hears ~1.25 km — mockSource), so a single far ring would leave the asset at the centre
// acoustically blind. Hence an INNER ring covers the centre and an OUTER ring forms the
// perimeter at the PTZ's reach — coverage in depth, the "array of arrays" deployment.
export const INNER_RING_M = 800; // covers the asset (≤ the per-node acoustic edge)
export const OUTER_RING_M = 2000; // perimeter = the premium PTZ's effective confirm range
export const PTZ_RANGE_M = OUTER_RING_M; // the camera can ID any track within the outer fence

export interface NodeDef {
  id: string;
  x: number; // metres east of the asset
  y: number; // metres north of the asset
  lonlat: [number, number];
}

// One ring of `count` nodes evenly spaced at `radius` (first node due north, clockwise).
function ring(count: number, radius: number, idOffset: number): NodeDef[] {
  return Array.from({ length: count }, (_, i) => {
    const a = ((i * 360) / count) * (Math.PI / 180);
    const x = radius * Math.sin(a);
    const y = radius * Math.cos(a);
    return { id: `N${idOffset + i + 1}`, x, y, lonlat: lonlat(x, y) };
  });
}

// 5 inner + 10 outer = 15 perched nodes. (Bench build is 3; this is the scaled vision.)
export const NODES: NodeDef[] = [...ring(5, INNER_RING_M, 0), ...ring(10, OUTER_RING_M, 5)];
