import React, { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const DAYS_TO_SHOW = 4;

function MapBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 13);
      return;
    }
    map.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 13 });
  }, [map, points]);
  return null;
}

function markerIcon(index) {
  return L.divIcon({
    className: "wayfare-map-marker",
    html: `<span>${index + 1}</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 29],
    popupAnchor: [0, -27]
  });
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${minutes} min`;
  return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
}

function formatDistance(meters) {
  return meters >= 10000
    ? `${(meters / 1000).toFixed(0)} km`
    : `${(meters / 1000).toFixed(1)} km`;
}

export default function TripMap({ trip, call }) {
  const days = useMemo(() => [...new Set([
    ...Array.from({ length: DAYS_TO_SHOW }, (_, index) => index + 1),
    ...trip.items.map(item => Number(item.day)).filter(value => Number.isInteger(value) && value > 0)
  ])].sort((a, b) => a - b), [trip.items]);
  const [day, setDay] = useState(1);
  const [locations, setLocations] = useState({});
  const [savingId, setSavingId] = useState("");
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [routeData, setRouteData] = useState(null);

  useEffect(() => {
    setLocations(Object.fromEntries(trip.items.map(item => [item._id, item.location || ""])));
    setRouteData(null);
  }, [trip.items]);

  const dayItems = useMemo(() => trip.items
    .filter(item => Number(item.day) === day)
    .sort((a, b) => (a.time || "").localeCompare(b.time || "")), [trip.items, day]);
  const locatedStops = useMemo(
    () => routeData?.stops.filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) || [],
    [routeData]
  );
  const missingStops = useMemo(
    () => routeData?.stops.filter(stop => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) || [],
    [routeData]
  );
  const mapPoints = useMemo(() => routeData?.route?.coordinates.length
    ? routeData.route.coordinates
    : locatedStops.map(stop => [stop.lat, stop.lon]), [routeData, locatedStops]);

  async function saveLocation(event, item) {
    event.preventDefault();
    setSavingId(item._id);
    const updated = await call(`/items/${item._id}/location`, {
      method: "PATCH",
      body: { location: locations[item._id] || "" }
    });
    if (updated) setLocations(Object.fromEntries(updated.items.map(activity => [activity._id, activity.location || ""])));
    setSavingId("");
  }

  async function findRoute() {
    setLoadingRoute(true);
    const result = await call("/map/route", { method: "POST", body: { day } });
    if (result) setRouteData(result);
    setLoadingRoute(false);
  }

  return (
    <section className="map-view">
      <div className="card map-controls">
        <div className="map-intro">
          <div>
            <h3>Map &amp; travel time</h3>
            <p className="meta">Add a place for each activity, then see the stops in itinerary order.</p>
          </div>
          <label className="map-day-select">Itinerary day
            <select value={day} onChange={event => { setDay(Number(event.target.value)); setRouteData(null); }}>
              {days.map(value => <option key={value} value={value}>Day {value}</option>)}
            </select>
          </label>
        </div>

        {dayItems.length ? (
          <div className="map-stop-list">
            {dayItems.map((item, index) => (
              <form className="map-stop-edit" key={item._id} onSubmit={event => saveLocation(event, item)}>
                <span className="map-stop-number" aria-hidden="true">{index + 1}</span>
                <div className="map-stop-info">
                  <strong>{item.title}</strong>
                  <span>{item.time || "Time not set"}</span>
                </div>
                <input
                  aria-label={`Map location for ${item.title}`}
                  placeholder="Place or full address"
                  maxLength={200}
                  value={locations[item._id] || ""}
                  onChange={event => setLocations(current => ({ ...current, [item._id]: event.target.value }))}
                />
                <button className="btn ghost" type="submit" disabled={savingId === item._id}>
                  {savingId === item._id ? "Saving…" : "Save"}
                </button>
              </form>
            ))}
          </div>
        ) : (
          <p className="meta map-empty">No activities planned for this day yet. Add activities in Itinerary first.</p>
        )}

        <div className="map-actions">
          <button
            className="btn"
            type="button"
            disabled={loadingRoute || !dayItems.some(item => (item.location || "").trim())}
            onClick={findRoute}
          >
            {loadingRoute ? "Finding places…" : "Show map & travel time"}
          </button>
          <span className="map-attribution-note">
            Search: OpenStreetMap · Driving estimates: OSRM · Internet required
          </span>
        </div>
      </div>

      {routeData && (
        <>
          {routeData.routeError && <p className="err" role="status">{routeData.routeError}</p>}
          {routeData.route && (
            <div className="card route-summary">
              <div><span className="meta">Estimated drive</span><strong>{formatDuration(routeData.route.durationSeconds)}</strong></div>
              <div><span className="meta">Route distance</span><strong>{formatDistance(routeData.route.distanceMeters)}</strong></div>
              <span className="route-disclaimer">Approximate driving time; traffic and road conditions may change it.</span>
            </div>
          )}
          {locatedStops.length > 0 && (
            <div className="card map-card">
              <MapContainer
                className="trip-leaflet-map"
                bounds={mapPoints.length > 1 ? L.latLngBounds(mapPoints) : undefined}
                center={mapPoints[0]}
                zoom={13}
                scrollWheelZoom
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {routeData.route && <Polyline positions={routeData.route.coordinates} pathOptions={{ color: "#167c69", weight: 5 }} />}
                {locatedStops.map((stop, index) => (
                  <Marker key={stop.itemId} position={[stop.lat, stop.lon]} icon={markerIcon(index)}>
                    <Popup>
                      <strong>{index + 1}. {stop.title}</strong>
                      <br />
                      {stop.time && <>{stop.time}<br /></>}
                      {stop.displayName || stop.location}
                    </Popup>
                  </Marker>
                ))}
                <MapBounds points={mapPoints} />
              </MapContainer>
            </div>
          )}
          {missingStops.length > 0 && (
            <p className="map-unresolved" role="status">
              Could not find a map position for: {missingStops.map(stop => `${stop.title} (${stop.location})`).join(", ")}.
              Try a more specific address.
            </p>
          )}
          {locatedStops.length > 0 && (
            <div className="card located-stops">
              <h3>Stops for Day {day}</h3>
              {locatedStops.map((stop, index) => (
                <div className="located-stop-row" key={stop.itemId}>
                  <span className="map-stop-number" aria-hidden="true">{index + 1}</span>
                  <div><strong>{stop.title}</strong><span>{stop.time}{stop.time ? " · " : ""}{stop.displayName || stop.location}</span></div>
                </div>
              ))}
            </div>
          )}
          <p className="map-provider-disclosure">
            Place searches are sent to OpenStreetMap Nominatim, and route requests to the public OSRM demo service.
            Public services may be rate-limited or unavailable; estimated times are not live traffic.
          </p>
        </>
      )}
    </section>
  );
}
