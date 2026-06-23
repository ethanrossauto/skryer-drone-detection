import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Contact } from "../types";
import { ICONS, CAMERA_COLOR, ASSET_COLOR, addIcons } from "../lib/icons";
import { NODES, ORIGIN_LAT, ORIGIN_LON, lonlat, toLocal } from "../lib/geo";
import { SLEW_DEG_PER_S } from "../lib/ptz";

// Satellite "operator console" basemap — Esri World Imagery raster tiles. Free, needs
// no API key, and shows the actual terrain around the node, so the picture reads like
// a real air-defense console. (Note ArcGIS tiles use {z}/{y}/{x} order.)
const STYLE: StyleSpecification = {
  version: 8,
  // Font glyphs for symbol-layer text labels. Without this, MapLibre can't shape the
  // `text-field` on a symbol layer and drops the whole symbol — icon included — which
  // is why marker icons silently fail to render. MapLibre's own demotiles CDN serves a
  // real "Noto Sans Regular" PBF, keyless (the OpenMapTiles host returns HTML, not glyphs).
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    basemap: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0b0e14" } },
    { id: "basemap", type: "raster", source: "basemap" },
  ],
};

// The acoustic sensor array — three perched nodes on a ~600 m perimeter ring around the
// protected asset (defined in lib/geo so the map and the mock can't drift). A single
// node is *bearing-only*; range comes from fusing the bearings of ≥2 spread-out nodes
// (AoA triangulation). The map is centred on the asset / array centroid.
const NODE_COLOR = "#4cd5ff";

// The protected critical-infrastructure site at the centre — what the array defends.
const ASSET: [number, number] = [ORIGIN_LON, ORIGIN_LAT];

// The single ground/mast PTZ camera (the vision layer), sited just off the asset. It's
// cued by the fused track and slews to one target at a time; the operator picks the
// target with the ◂ ▸ arrow keys.
const CAM_LOCAL: [number, number] = [55, 40]; // camera position in local east/north metres
const CAMERA: [number, number] = lonlat(...CAM_LOCAL); // ~70 m NE of the asset, so both glyphs read

// id → local east/north metres, for drawing each node's acoustic cone.
const NODE_LOCAL = new Map(NODES.map((n) => [n.id, [n.x, n.y] as [number, number]]));

// Cone geometry. Acoustic cones show a node's measured bearing ± its DoA uncertainty, out
// to its hearing range; the PTZ cone shows the camera's field of view, 2 km deep.
const ACOUSTIC_CONE_HALF = 9; // deg — bearing uncertainty of a 4-mic DoA array
const CONE_BEARING = "#ffcc33"; // yellow — bearing lock only (not yet triangulated)
const CONE_RANGELOCK = "#ff4d4d"; // red — range lock (≥3 cones triangulated)
const PTZ_FOV_HALF = 8; // deg — the camera's viewing half-angle
const PTZ_CONE_LEN = 2000; // m — keep the viewing cone 2 km long (= PTZ range)

// A drone marker is only placed for a FUSED track — one with a triangulated range fix
// (range_m != null). A bearing-only cue has no known point, just a direction, so it
// renders as the beam alone (bearingFeatures) with no icon.
function contactFeatures(contacts: Contact[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: contacts
      .filter((c) => c.lat != null && c.lon != null && c.range_m != null)
      .map((c) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon as number, c.lat as number] },
        properties: {
          icon: c.kind === "drone" ? ICONS.droneConfirmed : ICONS.droneUnknown,
          label: `${c.id} · ${Math.round(c.confidence * 100)}%`,
        },
      })),
  };
}

// A filled sector (cone) ring from an apex in local east/north metres, opening ±halfDeg
// around bearingDeg out to `range` metres. Returns a closed [lon,lat] ring.
function sectorRing(
  ax: number,
  ay: number,
  bearingDeg: number,
  halfDeg: number,
  range: number,
  steps = 10,
): [number, number][] {
  const ring: [number, number][] = [lonlat(ax, ay)];
  for (let i = 0; i <= steps; i++) {
    const a = ((bearingDeg - halfDeg + (2 * halfDeg * i) / steps) * Math.PI) / 180;
    ring.push(lonlat(ax + range * Math.sin(a), ay + range * Math.cos(a)));
  }
  ring.push(lonlat(ax, ay));
  return ring;
}

function polygon(ring: [number, number][], color?: string): GeoJSON.Feature {
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { color } };
}

// One translucent acoustic cone per hearing node, for every detected contact. Yellow
// while the track is bearing-only; red once ≥3 cones triangulate it (range lock). The
// cones persist after triangulation — a red marker also appears at the intersection.
function coneFeatures(contacts: Contact[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const c of contacts) {
    const color = c.range_m != null ? CONE_RANGELOCK : CONE_BEARING;
    for (const cone of c.cones ?? []) {
      const loc = NODE_LOCAL.get(cone.node);
      if (loc) {
        features.push(polygon(sectorRing(loc[0], loc[1], cone.bearing_deg, ACOUSTIC_CONE_HALF, cone.range_m), color));
      }
    }
  }
  return { type: "FeatureCollection", features };
}

function nodeFeatures(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: NODES.map((n) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: n.lonlat },
      properties: { id: n.id, label: n.id },
    })),
  };
}

function cameraFeatures(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: CAMERA },
        properties: { label: "PTZ" },
      },
    ],
  };
}

function ptzTarget(contacts: Contact[], targetId: string | null): Contact | undefined {
  if (!targetId) return undefined;
  return contacts.find((c) => c.id === targetId && c.lat != null && c.lon != null);
}

// The PTZ viewing cone — a wedge from the camera along where it's *actually* pointing
// (the requestAnimationFrame loop eases the bearing toward the cued target at the physical
// slew rate), opening ±PTZ_FOV_HALF out to PTZ_CONE_LEN.
function ptzConeFC(bearingDeg: number): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [polygon(sectorRing(CAM_LOCAL[0], CAM_LOCAL[1], bearingDeg, PTZ_FOV_HALF, PTZ_CONE_LEN))],
  };
}

// A ring around the contact the PTZ is locked onto (makes the ◂ ▸ switch obvious).
function ringFeatures(contacts: Contact[], targetId: string | null): GeoJSON.FeatureCollection {
  const t = ptzTarget(contacts, targetId);
  if (!t) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [t.lon as number, t.lat as number] },
        properties: {},
      },
    ],
  };
}

// Screen-space pixel offsets for the four mics when a node is hovered — an upward
// fan arc. The mics share the node's coordinate (they're ~10 cm apart in reality);
// fanning in *pixels* shows "one array of 4" without implying geographic spread.
const FAN_OFFSETS: Array<[number, number]> = [
  [-24, -24],
  [-9, -33],
  [9, -33],
  [24, -24],
];

function fanFeatures(lonlat: [number, number]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: FAN_OFFSETS.map((offset) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: lonlat },
      properties: { offset },
    })),
  };
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function MapView({
  contacts,
  ptzTargetId,
}: {
  contacts: Contact[];
  ptzTargetId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);

  // PTZ pointing animation: the loop reads the latest contacts/target through refs (so
  // it isn't tied to React's render cadence) and eases a real pointing bearing toward
  // the cued target. ptzBearing/beamLen persist the camera's current aim across frames.
  const contactsRef = useRef(contacts);
  const targetRef = useRef(ptzTargetId);
  const ptzBearingRef = useRef<number | null>(null); // degrees, 0 = N, +CW; null until first cue
  const rafRef = useRef<number | null>(null);
  contactsRef.current = contacts;
  targetRef.current = ptzTargetId;

  // Initialise the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [ORIGIN_LON, ORIGIN_LAT], // protected asset / array centroid
      zoom: 13.0, // wide enough for the 2 km outer ring + drones detected out to ~3.25 km
      keyboard: false, // ◂ ▸ drive the PTZ, not the map — don't let arrows pan it
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      addIcons(map);

      // Translucent acoustic cones — one per hearing node for each not-yet-fused contact.
      // Overlapping amber wedges brighten where bearings agree; when ≥3 cross, the mock
      // fuses the track and the cones give way to a drone marker.
      map.addSource("cones", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "acoustic-cones",
        type: "fill",
        source: "cones",
        paint: {
          "fill-color": ["get", "color"], // yellow = bearing lock, red = range lock
          "fill-opacity": 0.08, // low, so overlapping wedges build up toward the intersection
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      });

      // PTZ viewing cone (green = vision layer) + lock ring; the cone is driven by the
      // pointing loop below so it shows where the camera is actually looking.
      map.addSource("ptzcone", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "ptz-cone",
        type: "fill",
        source: "ptzcone",
        paint: {
          "fill-color": CAMERA_COLOR,
          "fill-opacity": 0.18,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      });
      map.addSource("ptz-ring", { type: "geojson", data: ringFeatures([], ptzTargetId) });
      map.addLayer({
        id: "ptz-ring",
        type: "circle",
        source: "ptz-ring",
        paint: {
          "circle-radius": 16,
          "circle-color": "transparent",
          "circle-stroke-color": CAMERA_COLOR,
          "circle-stroke-width": 2,
          "circle-opacity": 0,
        },
      });

      // The protected asset at the centre — what the drones are ingressing toward.
      map.addSource("asset", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: ASSET },
              properties: { label: "PROTECTED SITE" },
            },
          ],
        },
      });
      map.addLayer({
        id: "asset-icon",
        type: "symbol",
        source: "asset",
        layout: {
          "icon-image": ICONS.asset,
          "icon-size": 1.1,
          "icon-allow-overlap": true,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10,
          "text-offset": [0, 1.5],
          "text-anchor": "top",
          "text-allow-overlap": true,
        },
        paint: { "text-color": ASSET_COLOR, "text-halo-color": "#0b0e14", "text-halo-width": 1 },
      });

      map.addSource("node", { type: "geojson", data: nodeFeatures() });
      map.addLayer({
        id: "node-icons",
        type: "symbol",
        source: "node",
        layout: {
          "icon-image": ICONS.array,
          "icon-size": 1,
          "icon-allow-overlap": true,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": true,
        },
        paint: { "text-color": NODE_COLOR, "text-halo-color": "#0b0e14", "text-halo-width": 1 },
      });

      map.addSource("camera", { type: "geojson", data: cameraFeatures() });
      map.addLayer({
        id: "camera-icon",
        type: "symbol",
        source: "camera",
        layout: {
          "icon-image": ICONS.camera,
          "icon-size": 1,
          "icon-allow-overlap": true,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": true,
        },
        paint: { "text-color": CAMERA_COLOR, "text-halo-color": "#0b0e14", "text-halo-width": 1 },
      });

      // The hovered node's 4 mics, fanned out in screen-space (empty until hover).
      map.addSource("node-fan", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "node-fan-icons",
        type: "symbol",
        source: "node-fan",
        layout: {
          "icon-image": ICONS.mic,
          "icon-size": 0.85,
          "icon-offset": ["array", "number", 2, ["get", "offset"]],
          "icon-allow-overlap": true,
        },
      });

      // Fan the 4 mics out while a node is hovered; collapse back on leave.
      const showFan = (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id;
        const node = NODES.find((n) => n.id === id);
        if (!node) return;
        (map.getSource("node-fan") as maplibregl.GeoJSONSource).setData(fanFeatures(node.lonlat));
        map.getCanvas().style.cursor = "pointer";
      };
      const hideFan = () => {
        (map.getSource("node-fan") as maplibregl.GeoJSONSource).setData(EMPTY_FC);
        map.getCanvas().style.cursor = "";
      };
      map.on("mouseenter", "node-icons", showFan);
      map.on("mousemove", "node-icons", showFan); // re-target when sliding between nodes
      map.on("mouseleave", "node-icons", hideFan);

      map.addSource("contacts", { type: "geojson", data: contactFeatures([]) });
      map.addLayer({
        id: "contact-icons",
        type: "symbol",
        source: "contacts",
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#e6edf3", "text-halo-color": "#0b0e14", "text-halo-width": 1 },
      });

      // PTZ pointing loop: every frame, ease the camera's actual aim toward the cued
      // target at the physical slew rate, then redraw the viewing cone from that aim. With
      // no target the camera holds its last heading (parked), so the cone always shows
      // where the PTZ is genuinely pointing — not where it has been told to look.
      const ptzConeSrc = map.getSource("ptzcone") as maplibregl.GeoJSONSource;
      let lastTs = performance.now();
      const animate = () => {
        const now = performance.now();
        const dt = Math.min((now - lastTs) / 1000, 0.1); // clamp a backgrounded tab
        lastTs = now;

        const tid = targetRef.current;
        const t = tid
          ? contactsRef.current.find((c) => c.id === tid && c.lat != null && c.lon != null)
          : undefined;

        if (t) {
          const [tx, ty] = toLocal(t.lat as number, t.lon as number);
          const desired = ((Math.atan2(tx - CAM_LOCAL[0], ty - CAM_LOCAL[1]) * 180) / Math.PI + 360) % 360;
          if (ptzBearingRef.current == null) {
            ptzBearingRef.current = desired; // first cue: snap (camera was idle/home)
          } else {
            const diff = ((desired - ptzBearingRef.current + 540) % 360) - 180; // shortest path
            const step = Math.sign(diff) * Math.min(Math.abs(diff), SLEW_DEG_PER_S * dt);
            ptzBearingRef.current = (ptzBearingRef.current + step + 360) % 360;
          }
        }

        if (ptzBearingRef.current != null) {
          ptzConeSrc.setData(ptzConeFC(ptzBearingRef.current));
        }
        rafRef.current = requestAnimationFrame(animate);
      };
      rafRef.current = requestAnimationFrame(animate);

      readyRef.current = true;
    });

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // Push contact updates into the existing sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource("contacts") as maplibregl.GeoJSONSource | undefined)?.setData(
      contactFeatures(contacts),
    );
    (map.getSource("cones") as maplibregl.GeoJSONSource | undefined)?.setData(
      coneFeatures(contacts),
    );
    // (the "ptzcone" source is driven by the PTZ pointing loop, not here)
    (map.getSource("ptz-ring") as maplibregl.GeoJSONSource | undefined)?.setData(
      ringFeatures(contacts, ptzTargetId),
    );
  }, [contacts, ptzTargetId]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
