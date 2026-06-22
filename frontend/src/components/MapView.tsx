import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Contact } from "../types";

// Satellite "operator console" basemap — Esri World Imagery raster tiles. Free, needs
// no API key, and shows the actual terrain around the node, so the picture reads like
// a real air-defense console. (Note ArcGIS tiles use {z}/{y}/{x} order.)
const STYLE: StyleSpecification = {
  version: 8,
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

// The perched sensor node — Fitzroy Harbour, ON. Map is centred here because
// every contact is a bearing *from the node*, not a city-wide picture.
const NODE: [number, number] = [-76.209, 45.481];

const KIND_COLORS: Record<string, string> = {
  unknown: "#ffcc33", // acoustic cue, unconfirmed
  drone: "#ff4d4d", // vision-confirmed drone
};

function contactFeatures(contacts: Contact[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: contacts
      .filter((c) => c.lat != null && c.lon != null)
      .map((c) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon as number, c.lat as number] },
        properties: {
          color: KIND_COLORS[c.kind] ?? KIND_COLORS.unknown,
          label: `${c.id} · ${Math.round(c.confidence * 100)}%`,
        },
      })),
  };
}

// A line from the node out to each contact — the acoustic bearing ray.
function bearingFeatures(contacts: Contact[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: contacts
      .filter((c) => c.lat != null && c.lon != null)
      .map((c) => ({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [NODE, [c.lon as number, c.lat as number]],
        },
        properties: { color: KIND_COLORS[c.kind] ?? KIND_COLORS.unknown },
      })),
  };
}

function nodeFeature(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: NODE },
        properties: { label: "NODE" },
      },
    ],
  };
}

export function MapView({ contacts }: { contacts: Contact[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);

  // Initialise the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: NODE,
      zoom: 14,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      map.addSource("bearings", { type: "geojson", data: bearingFeatures([]) });
      map.addLayer({
        id: "bearing-lines",
        type: "line",
        source: "bearings",
        paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-opacity": 0.5 },
      });

      map.addSource("node", { type: "geojson", data: nodeFeature() });
      map.addLayer({
        id: "node-dot",
        type: "circle",
        source: "node",
        paint: {
          "circle-radius": 7,
          "circle-color": "#4cd5ff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0b0e14",
        },
      });
      map.addLayer({
        id: "node-label",
        type: "symbol",
        source: "node",
        layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top" },
        paint: { "text-color": "#4cd5ff", "text-halo-color": "#0b0e14", "text-halo-width": 1 },
      });

      map.addSource("contacts", { type: "geojson", data: contactFeatures([]) });
      map.addLayer({
        id: "contact-dots",
        type: "circle",
        source: "contacts",
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#0b0e14",
        },
      });
      map.addLayer({
        id: "contact-labels",
        type: "symbol",
        source: "contacts",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
        },
        paint: { "text-color": "#e6edf3", "text-halo-color": "#0b0e14", "text-halo-width": 1 },
      });
      readyRef.current = true;
    });

    return () => {
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
    (map.getSource("bearings") as maplibregl.GeoJSONSource | undefined)?.setData(
      bearingFeatures(contacts),
    );
  }, [contacts]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
