import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, connectSocket, currentUser } from "./api.js";
import ProfileMenu from "./ProfileMenu.jsx";
import TripMap from "./TripMap.jsx";

const fmt = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const COLORS = ["#0E7C86", "#E04F5F", "#7A5AF8", "#D98A12", "#2F8F5B"];
const TABS = ["Itinerary", "Checklist", "Packing", "Polls", "Bookings", "Reminders", "Weather", "Map & travel", "Stay vote", "Budget", "Chat", "Discover"];
const inputDate = value => value ? new Date(value).toISOString().slice(0, 10) : "";
const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const tripCacheKey = (userId, tripId) => `wayfare:trip-cache:${userId}:${tripId}`;

function readOfflineTrip(userId, tripId) {
  try {
    const saved = localStorage.getItem(tripCacheKey(userId, tripId));
    if (!saved) return null;
    const trip = JSON.parse(saved);
    if (String(trip._id) !== tripId || !Array.isArray(trip.items) || !Array.isArray(trip.members))
      throw new Error("Saved trip data is incomplete.");
    return trip;
  } catch (error) {
    console.error("Could not read the saved offline trip:", error);
    return null;
  }
}

function writeOfflineTrip(userId, tripId, trip) {
  const cachedTrip = {
    ...trip,
    inviteCode: undefined,
    members: (trip.members || []).map(member => ({ _id: member._id, name: member.name })),
    expenses: (trip.expenses || []).map(expense => ({
      ...expense,
      paidBy: expense.paidBy && typeof expense.paidBy === "object"
        ? { _id: expense.paidBy._id, name: expense.paidBy.name }
        : expense.paidBy
    }))
  };
  localStorage.setItem(tripCacheKey(userId, tripId), JSON.stringify(cachedTrip));
}

function getTripReminders(trip) {
  const today = new Date();
  const todayKey = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())).toISOString().slice(0, 10);
  const dayNumber = date => Date.parse(`${date}T00:00:00.000Z`) / 86400000;
  const todayNumber = dayNumber(todayKey);
  const startDate = inputDate(trip.startDate);
  const startOffset = startDate ? dayNumber(startDate) - todayNumber : null;

  const upcomingTasks = (trip.checklist || [])
    .filter(task => !task.completed && task.dueDate && dayNumber(inputDate(task.dueDate)) - todayNumber <= 7)
    .sort((a, b) => inputDate(a.dueDate).localeCompare(inputDate(b.dueDate)));
  const unpackedItems = (trip.packing || []).filter(item => !item.packed);
  const upcomingActivities = startDate
    ? trip.items.filter(item => {
      const activityDate = new Date(Date.parse(`${startDate}T00:00:00.000Z`) + (Math.max(1, Number(item.day) || 1) - 1) * 86400000)
        .toISOString().slice(0, 10);
      const offset = dayNumber(activityDate) - todayNumber;
      return offset >= 0 && offset <= 7;
    }).map(item => ({
      ...item,
      date: new Date(Date.parse(`${startDate}T00:00:00.000Z`) + (Math.max(1, Number(item.day) || 1) - 1) * 86400000)
        .toISOString().slice(0, 10)
    })).sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""))
    : [];

  return {
    startOffset: startOffset !== null && startOffset >= 0 && startOffset <= 30 ? startOffset : null,
    upcomingTasks,
    unpackedItems,
    upcomingActivities
  };
}

function formatTripDates(startDate, endDate) {
  const format = value => value ? new Date(value).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
  }) : "";
  if (startDate && endDate) return `${format(startDate)} – ${format(endDate)}`;
  if (startDate) return `From ${format(startDate)}`;
  if (endDate) return `Until ${format(endDate)}`;
  return "Dates not set";
}

function mergeMessages(current, incoming) {
  const messagesById = new Map(current.map(message => [String(message._id), message]));
  incoming.forEach(message => messagesById.set(String(message._id), message));
  return [...messagesById.values()].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

function escapeIcs(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icsDate(date) {
  return date.replace(/-/g, "");
}

function icsDateTime(date, time, minutesToAdd = 0) {
  const [year, month, day] = date.split("-").map(Number);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || "");
  const hour = match ? Number(match[1]) : 10;
  const minute = match ? Number(match[2]) : 0;
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute + minutesToAdd));
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function downloadCalendar(trip) {
  if (!trip.startDate) return;
  const start = inputDate(trip.startDate);
  const end = inputDate(trip.endDate || trip.startDate);
  const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const events = [
    [
      "BEGIN:VEVENT",
      `UID:wayfare-trip-${trip._id}@wayfare.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(start)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(end))}`,
      `SUMMARY:${escapeIcs(trip.name)}`,
      `LOCATION:${escapeIcs(trip.destination)}`,
      "END:VEVENT"
    ].join("\r\n")
  ];

  trip.items.forEach((item, index) => {
    const day = Math.max(1, Number(item.day) || 1) - 1;
    const eventDate = new Date(Date.parse(`${start}T00:00:00Z`) + day * 86400000).toISOString().slice(0, 10);
    const eventEnd = icsDateTime(eventDate, item.time, 60);
    events.push([
      "BEGIN:VEVENT",
      `UID:wayfare-item-${trip._id}-${item._id || index}@wayfare.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDateTime(eventDate, item.time)}`,
      `DTEND:${eventEnd}`,
      `SUMMARY:${escapeIcs(item.title)}`,
      `DESCRIPTION:${escapeIcs([`${item.category || "Activity"}${item.cost ? ` · ₹${item.cost}` : ""}`, item.notes].filter(Boolean).join("\n"))}`,
      `LOCATION:${escapeIcs(item.location || trip.destination)}`,
      "END:VEVENT"
    ].join("\r\n"));
  });

  const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wayfare//Trip Planner//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR"].join("\r\n");
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(trip.name || "wayfare-trip").replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").trim() || "wayfare-trip"}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function TripRoom() {
  const { id } = useParams();
  const me = currentUser();
  const [trip, setTrip] = useState(null);
  const [tab, setTab] = useState("Itinerary");
  const [messages, setMessages] = useState([]);
  const [typing, setTyping] = useState("");
  const [chatStatus, setChatStatus] = useState("connecting");
  const [chatError, setChatError] = useState("");
  const [err, setErr] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [usingOfflineCopy, setUsingOfflineCopy] = useState(false);
  const [offlineCacheError, setOfflineCacheError] = useState("");
  const socketRef = useRef(null);

  const applyTrip = useCallback(freshTrip => {
    setTrip(freshTrip);
    try {
      writeOfflineTrip(me.id, id, freshTrip);
      setUsingOfflineCopy(false);
      setOfflineCacheError("");
    } catch (error) {
      console.error("Could not save the trip for offline viewing:", error);
      setOfflineCacheError("Could not save an offline copy. Check this browser's available storage.");
    }
  }, [id, me.id]);

  useEffect(() => {
    const cachedTrip = readOfflineTrip(me.id, id);
    if (cachedTrip) {
      setTrip(cachedTrip);
      setUsingOfflineCopy(true);
    }
    setIsOnline(navigator.onLine);
    api("/trips/" + id).then(applyTrip).catch(e => {
      if (!cachedTrip) setErr(e.message);
    });
    api(`/trips/${id}/messages`)
      .then(history => setMessages(current => mergeMessages(current, history)))
      .catch(error => setChatError(error.message));
    const s = connectSocket(); socketRef.current = s;
    s.on("connect", () => {
      setChatStatus("joining");
      setChatError("");
      s.emit("trip:join", id, result => {
        if (result?.ok) {
          setChatStatus("connected");
          setChatError("");
        } else {
          setChatStatus("disconnected");
          setChatError(result?.error || "Could not join this trip's chat.");
        }
      });
    });
    s.on("trip:updated", applyTrip);
    s.on("disconnect", () => setChatStatus("disconnected"));
    s.on("connect_error", error => {
      setChatStatus("disconnected");
      setChatError(error.message === "unauthorized"
        ? "Please sign in again to use trip chat."
        : "Chat connection failed. Check the server and try again.");
    });
    s.on("chat:message", message => setMessages(current => mergeMessages(current, [message])));
    s.on("chat:typing", n => { setTyping(n + " is typing…"); setTimeout(() => setTyping(""), 1500); });
    return () => s.disconnect();
  }, [id, me.id, applyTrip]);

  useEffect(() => {
    const updateOnlineStatus = () => {
      setIsOnline(navigator.onLine);
      if (navigator.onLine) {
        api("/trips/" + id).then(applyTrip).catch(error => {
          setUsingOfflineCopy(true);
          console.error("Could not refresh the trip after reconnecting:", error);
        });
      } else {
        setUsingOfflineCopy(true);
      }
    };
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, [id, applyTrip]);

  useEffect(() => {
    setNotificationsEnabled(
      localStorage.getItem(`wayfare:notifications:${id}`) === "enabled" &&
      "Notification" in window && Notification.permission === "granted"
    );
    setNotificationMessage("");
  }, [id]);

  useEffect(() => {
    if (!trip || !notificationsEnabled || !("Notification" in window) || Notification.permission !== "granted") return undefined;

    const sendDailyNotification = (kind, title, body) => {
      const today = localDateKey(new Date());
      const key = `wayfare:notification:${id}:${today}:${kind}`;
      if (localStorage.getItem(key)) return;
      new Notification(title, { body, tag: `${id}-${kind}-${today}` });
      localStorage.setItem(key, "sent");
    };

    const notify = () => {
      const current = getTripReminders(trip);
      const today = localDateKey(new Date());
      if (current.startOffset !== null && current.startOffset <= 7) {
        sendDailyNotification("trip", `Trip starts in ${current.startOffset} ${current.startOffset === 1 ? "day" : "days"}`,
          `${trip.name}${trip.destination ? ` · ${trip.destination}` : ""}`);
      }
      if (current.upcomingTasks.length) {
        const todayNumber = Date.parse(`${today}T00:00:00.000Z`) / 86400000;
        const overdue = current.upcomingTasks.filter(task =>
          Date.parse(`${inputDate(task.dueDate)}T00:00:00.000Z`) / 86400000 < todayNumber
        ).length;
        const dueToday = current.upcomingTasks.length -
          current.upcomingTasks.filter(task =>
            Date.parse(`${inputDate(task.dueDate)}T00:00:00.000Z`) / 86400000 > todayNumber
          ).length - overdue;
        const dueSoon = current.upcomingTasks.length - dueToday - overdue;
        const details = [
          dueToday ? `${dueToday} due today` : "",
          overdue ? `${overdue} overdue` : "",
          dueSoon ? `${dueSoon} due soon` : ""
        ].filter(Boolean).join(" · ");
        sendDailyNotification("tasks", "Trip checklist reminder", details);
      }
      if (current.startOffset !== null && current.startOffset <= 7 && current.unpackedItems.length) {
        sendDailyNotification("packing", "Packing reminder",
          `${current.unpackedItems.length} ${current.unpackedItems.length === 1 ? "item is" : "items are"} still unpacked for ${trip.name}.`);
      }
      const activitiesToday = current.upcomingActivities.filter(item =>
        item.date === today
      );
      if (activitiesToday.length) {
        sendDailyNotification("itinerary", "Today's trip itinerary",
          activitiesToday.map(item => `${item.time ? `${item.time} ` : ""}${item.title}`).join(" · "));
      }
    };

    notify();
    const intervalId = window.setInterval(notify, 30 * 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [trip, id, notificationsEnabled]);

  const call = async (path, opts) => {
    setErr("");
    try {
      const result = await api(`/trips/${id}${path}`, opts);
      if (result && String(result._id) === id && Array.isArray(result.items)) applyTrip(result);
      return result;
    } catch (e) {
      setErr(e.message);
    }
  };

  if (err && !trip) return <div className="wrap"><p className="err">{err}</p><Link to="/">Back to trips</Link></div>;
  if (!trip) return <div className="wrap"><p className="meta">Loading trip…</p></div>;

  const spent = trip.items.reduce((s, i) => s + (i.cost || 0), 0);
  const reminders = getTripReminders(trip);
  const reminderCount = reminders.upcomingTasks.length + reminders.unpackedItems.length +
    reminders.upcomingActivities.length + (reminders.startOffset !== null ? 1 : 0);

  return (
    <div className="wrap">
      <header>
        <div>
          <Link to="/" className="meta">← All trips</Link>
          <h1>{trip.name}</h1>
          <div className="meta">{trip.destination} · {formatTripDates(trip.startDate, trip.endDate)} · Invite code <b>{trip.inviteCode}</b></div>
        </div>
        <ProfileMenu user={me} />
      </header>
      <p className="analytics-disclosure">Page visits and successful sign-ins are recorded for site analytics. Signed-in activity is linked to your account; signed-out visits are counted anonymously. IP addresses are not stored.</p>
      {(usingOfflineCopy || !isOnline) && (
        <div className="offline-banner" role="status">
          {isOnline
            ? "Could not refresh the trip. Showing the saved copy; changes will not sync."
            : "You’re offline. Showing the saved trip copy; changes will not sync."}
        </div>
      )}
      {offlineCacheError && <div className="err" role="alert">{offlineCacheError}</div>}
      <TripDates trip={trip} call={call} />
      <nav className="tabs" role="tablist">
        {TABS.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
          {t === "Reminders" ? `Reminders${reminderCount ? ` (${reminderCount})` : ""}` : t}
        </button>)}
      </nav>
      {err && <div className="err" role="alert">{err}</div>}

      {tab === "Itinerary" && <Itinerary trip={trip} call={call} />}
      {tab === "Checklist" && <Checklist trip={trip} call={call} />}
      {tab === "Packing" && <PackingList trip={trip} call={call} />}
      {tab === "Polls" && <Polls trip={trip} call={call} meId={me.id} />}
      {tab === "Bookings" && <Bookings trip={trip} call={call} />}
      {tab === "Reminders" && <Reminders trip={trip} reminders={reminders}
        notificationsEnabled={notificationsEnabled} notificationMessage={notificationMessage}
        enableNotifications={async () => {
          if (!("Notification" in window)) {
            setNotificationMessage("This browser does not support notifications.");
            return;
          }
          try {
            const permission = await Notification.requestPermission();
            if (permission === "granted") {
              localStorage.setItem(`wayfare:notifications:${id}`, "enabled");
              setNotificationsEnabled(true);
              setNotificationMessage("Browser notifications are enabled while this app is open.");
            } else {
              setNotificationsEnabled(false);
              localStorage.removeItem(`wayfare:notifications:${id}`);
              setNotificationMessage(permission === "denied"
                ? "Notifications are blocked in browser settings."
                : "Notification permission was not granted.");
            }
          } catch (error) {
            setNotificationsEnabled(false);
            localStorage.removeItem(`wayfare:notifications:${id}`);
            setNotificationMessage(error.message || "Could not enable browser notifications.");
          }
        }} />}
      {tab === "Weather" && <TripWeather id={id} trip={trip} />}
      {tab === "Map & travel" && <TripMap trip={trip} call={call} />}
      {tab === "Stay vote" && <Stays trip={trip} call={call} meId={me.id} />}
      {tab === "Budget" && <Budget trip={trip} call={call} spent={spent} id={id} />}
      {tab === "Chat" && <Chat messages={messages} typing={typing} meId={me.id}
        socket={socketRef} status={chatStatus} error={chatError} />}
      {tab === "Discover" && <Discover id={id} call={call} />}

      <button className="fab" onClick={() => setAiOpen(true)}>Ask concierge</button>
      {aiOpen && <Concierge id={id} close={() => setAiOpen(false)} />}
    </div>
  );
}

function weatherDetails(code) {
  if (code === 0) return { icon: "☀️", label: "Clear sky" };
  if (code === 1) return { icon: "🌤️", label: "Mostly clear" };
  if (code === 2) return { icon: "⛅", label: "Partly cloudy" };
  if (code === 3) return { icon: "☁️", label: "Overcast" };
  if (code === 45 || code === 48) return { icon: "🌫️", label: "Fog" };
  if (code >= 51 && code <= 57) return { icon: "🌦️", label: "Drizzle" };
  if (code >= 61 && code <= 67) return { icon: "🌧️", label: "Rain" };
  if (code >= 71 && code <= 77) return { icon: "❄️", label: "Snow" };
  if (code >= 80 && code <= 82) return { icon: "🌧️", label: "Rain showers" };
  if (code === 85 || code === 86) return { icon: "🌨️", label: "Snow showers" };
  if (code >= 95) return { icon: "⛈️", label: "Thunderstorm" };
  return { icon: "🌡️", label: "Weather update" };
}

function TripWeather({ id, trip }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api(`/trips/${id}/weather`)
      .then(result => { if (active) setData(result); })
      .catch(e => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, trip.destination, trip.startDate, trip.endDate, refreshKey]);

  return (
    <section className="weather-panel card" aria-label="Trip weather forecast">
      <div className="row sp weather-heading">
        <div>
          <h3>Weather forecast</h3>
          <p className="meta">{data?.location || trip.destination || "Trip destination"}</p>
        </div>
        <button type="button" className="btn ghost" onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {loading && <p className="meta" role="status">Loading forecast…</p>}
      {!loading && error && <p className="err" role="alert">{error}</p>}
      {!loading && data && !data.forecast.length && (
        <p className="meta" role="status">
          No forecast is available for {formatTripDates(data.startDate, data.endDate)}.
          Forecasts cover up to 16 days ahead ({data.availableFrom} – {data.availableTo}).
        </p>
      )}
      {!loading && data?.forecast.length > 0 && (
        <>
          <div className="weather-grid">
            {data.forecast.map(day => {
              const details = weatherDetails(day.code);
              return (
                <article className="weather-day" key={day.date}>
                  <strong>{new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</strong>
                  <span className="weather-icon" aria-hidden="true">{details.icon}</span>
                  <span>{details.label}</span>
                  <strong>{day.high === null ? "—" : `${Math.round(day.high)}°`} <span className="weather-low">{day.low === null ? "" : `${Math.round(day.low)}°`}</span></strong>
                  {day.precipitationChance !== null && <small>Rain {Math.round(day.precipitationChance)}%</small>}
                  {day.windSpeed !== null && <small>Wind {Math.round(day.windSpeed)} km/h</small>}
                </article>
              );
            })}
          </div>
          <p className="weather-attribution">Daily forecast from Open-Meteo. Forecasts are available up to 16 days ahead.</p>
        </>
      )}
    </section>
  );
}

function TripDates({ trip, call }) {
  const [dates, setDates] = useState({ startDate: inputDate(trip.startDate), endDate: inputDate(trip.endDate) });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDates({ startDate: inputDate(trip.startDate), endDate: inputDate(trip.endDate) });
  }, [trip.startDate, trip.endDate]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    const updated = await call("/dates", { method: "PUT", body: dates });
    if (updated) setDates({ startDate: inputDate(updated.startDate), endDate: inputDate(updated.endDate) });
    setSaving(false);
  }

  return (
    <form className="trip-dates-panel card row" onSubmit={save}>
      <div className="trip-dates-copy">
        <strong>Trip dates</strong>
        <span className="meta">{formatTripDates(trip.startDate, trip.endDate)}</span>
      </div>
      <label className="date-field">Start
        <input type="date" value={dates.startDate} max={dates.endDate || undefined}
          onChange={e => setDates({ ...dates, startDate: e.target.value })} />
      </label>
      <label className="date-field">End
        <input type="date" value={dates.endDate} min={dates.startDate || undefined}
          onChange={e => setDates({ ...dates, endDate: e.target.value })} />
      </label>
      <button className="btn ghost" type="submit" disabled={saving}>{saving ? "Saving…" : "Save dates"}</button>
      <button className="btn" type="button" disabled={!trip.startDate} onClick={() => downloadCalendar(trip)}>
        Download calendar
      </button>
    </form>
  );
}

function Itinerary({ trip, call }) {
  const [f, setF] = useState({ day: 1, time: "10:00", durationMinutes: 60, title: "", location: "", notes: "", cost: "", category: "Activity" });
  const [scheduleChecks, setScheduleChecks] = useState({});
  const [checkingDay, setCheckingDay] = useState(0);
  const add = async e => {
    e.preventDefault();
    const result = await call("/items", { method: "POST", body: f });
    if (result) setF(current => ({ ...current, title: "", location: "", notes: "", cost: "" }));
  };
  useEffect(() => setScheduleChecks({}), [trip.items]);
  const days = Math.max(4, ...trip.items.map(item => Number(item.day) || 1));
  const printDays = Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const items = trip.items
      .filter(item => Number(item.day) === day)
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const date = trip.startDate
      ? new Date(Date.parse(`${inputDate(trip.startDate)}T00:00:00.000Z`) + index * 86400000)
      : null;
    return { day, items, date };
  });
  const printDate = date => date?.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC"
  });
  const checkSchedule = async (day, items) => {
    setCheckingDay(day);
    const locatedItems = items.filter(item => item.location?.trim());
    const route = locatedItems.length
      ? await call("/map/route", { method: "POST", body: { day } })
      : null;
    setScheduleChecks(current => ({
      ...current,
      [day]: {
        items,
        route,
        noLocations: locatedItems.length === 0
      }
    }));
    setCheckingDay(0);
  };
  return (
    <>
      <div className="row sp itinerary-actions">
        <h3>Trip itinerary</h3>
        <button type="button" className="btn ghost" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>
      <form className="card row" style={{ flexWrap: "wrap", marginBottom: 18 }} onSubmit={add}>
        <select value={f.day} onChange={e => setF({ ...f, day: +e.target.value })} aria-label="Day">
          {Array.from({ length: days }, (_, i) => <option key={i} value={i + 1}>Day {i + 1}</option>)}
        </select>
        <input type="time" value={f.time} onChange={e => setF({ ...f, time: e.target.value })} aria-label="Time" />
        <label className="activity-duration-field">Duration
          <input type="number" min="15" max="720" step="15" value={f.durationMinutes}
            onChange={e => setF({ ...f, durationMinutes: Number(e.target.value) })} aria-label="Activity duration in minutes" required />
        </label>
        <input placeholder="Add an activity" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} required style={{ flex: 1, minWidth: 140 }} />
        <input placeholder="Place or address (optional)" value={f.location} onChange={e => setF({ ...f, location: e.target.value })} maxLength={200} aria-label="Activity location" />
        <input type="number" min="0" placeholder="Cost ₹" value={f.cost} onChange={e => setF({ ...f, cost: e.target.value })} style={{ width: 96 }} />
        <select value={f.category} onChange={e => setF({ ...f, category: e.target.value })} aria-label="Category">
          <option>Activity</option><option>Food</option><option>Transport</option>
        </select>
        <textarea className="itinerary-notes-input" placeholder="Notes (optional)" value={f.notes} maxLength={1000}
          onChange={e => setF({ ...f, notes: e.target.value })} aria-label="Activity notes" />
        <button className="btn">Add to plan</button>
      </form>
      {Array.from({ length: days }, (_, i) => i + 1).map(d => {
        const it = trip.items.filter(x => x.day === d).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
        const check = scheduleChecks[d];
        const startMinutes = item => {
          const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(item.time || "");
          return match ? Number(match[1]) * 60 + Number(match[2]) : null;
        };
        const warnings = [];
        if (check) {
          for (let index = 0; index < it.length - 1; index += 1) {
            const current = it[index];
            const next = it[index + 1];
            const currentStart = startMinutes(current);
            const nextStart = startMinutes(next);
            if (currentStart === null || nextStart === null) continue;
            const currentEnd = currentStart + (Number(current.durationMinutes) || 60);
            if (nextStart < currentEnd) {
              warnings.push({
                key: `overlap-${current._id}-${next._id}`,
                text: `${current.title} and ${next.title} overlap by ${currentEnd - nextStart} min.`
              });
              continue;
            }
            const leg = check.route?.route?.legs?.find(item =>
              item.fromItemId === String(current._id) && item.toItemId === String(next._id)
            );
            if (leg) {
              const gap = nextStart - currentEnd;
              const travelMinutes = Math.ceil(leg.durationSeconds / 60);
              if (gap < travelMinutes) {
                warnings.push({
                  key: `travel-${current._id}-${next._id}`,
                  text: `Only ${gap} min between ${current.title} and ${next.title}, but the estimated drive is ${travelMinutes} min.`
                });
              }
            }
          }
        }
        return (
          <div key={d} className="day card">
            <div className="row sp itinerary-day-heading">
              <h3>Day {d}</h3>
              <div className="row">
                <small className="meta">{fmt(it.reduce((s, x) => s + x.cost, 0))}</small>
                {it.length > 1 && <button type="button" className="btn ghost schedule-check-button"
                  disabled={checkingDay !== 0} onClick={() => checkSchedule(d, it)}>
                  {checkingDay === d ? "Checking…" : "Check schedule"}
                </button>}
              </div>
            </div>
            {it.length ? it.map(x => (
              <div className="slot" key={x._id}>
                <div className="time">{x.time}<small>{x.durationMinutes || 60} min</small></div>
                <ActivityDetails item={x} call={call} />
                <div className="row"><b>{x.cost ? fmt(x.cost) : "Free"}</b>
                  <button className="x" aria-label={"Remove " + x.title} onClick={() => call("/items/" + x._id, { method: "DELETE" })}>×</button></div>
              </div>
            )) : <p className="meta">Nothing planned yet. Add an activity above or pick one in Discover.</p>}
            {check && (
              <div className="schedule-results" aria-live="polite">
                {warnings.map(warning => <p className="schedule-alert" key={warning.key}>⚠ {warning.text}</p>)}
                {!warnings.length && <p className="schedule-clear">
                  {check.noLocations
                    ? "No time overlaps found. Add locations to check travel time between activities."
                    : check.route?.route
                      ? "No time overlaps found. Estimated travel time fits the schedule."
                      : "No time overlaps found. Travel time could not be checked for this schedule."}
                </p>}
                {check.route?.routeError && <p className="meta schedule-note">{check.route.routeError}</p>}
                {check.noLocations && <p className="meta schedule-note">Add activity locations in Map &amp; travel to check driving time.</p>}
                {check.route?.route && <p className="meta schedule-note">Travel times are estimates and do not account for live traffic.</p>}
              </div>
            )}
          </div>
        );
      })}
      <section className="itinerary-print" aria-label="Printable trip itinerary">
        <header className="itinerary-print-header">
          <h1>{trip.name}</h1>
          <p>{trip.destination}</p>
          <p>{formatTripDates(trip.startDate, trip.endDate)}</p>
        </header>
        {printDays.map(({ day, items, date }) => (
          <section className="itinerary-print-day" key={day}>
            <h2>Day {day}{date ? ` · ${printDate(date)}` : ""}</h2>
            {items.length ? (
              <>
                <ol>
                  {items.map(item => (
                    <li key={item._id}>
                      <div className="itinerary-print-item-heading">
                        <strong>{item.time || "Time not set"} — {item.title}</strong>
                        <span>{fmt(item.cost)}</span>
                      </div>
                      <p>{item.category || "Activity"} · {item.durationMinutes || 60} min</p>
                      {item.location && <p>{item.location}</p>}
                      {item.notes && <p>{item.notes}</p>}
                    </li>
                  ))}
                </ol>
                <p className="itinerary-print-total">
                  Day total: {fmt(items.reduce((total, item) => total + Number(item.cost || 0), 0))}
                </p>
              </>
            ) : <p>No activities planned.</p>}
          </section>
        ))}
        <footer>Created with Wayfare · {new Date().toLocaleDateString()}</footer>
      </section>
    </>
  );
}

function ActivityDetails({ item, call }) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(item.notes || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setNotes(item.notes || ""), [item.notes]);

  async function saveNotes() {
    setSaving(true);
    const updated = await call(`/items/${item._id}/notes`, { method: "PATCH", body: { notes } });
    if (updated) setEditing(false);
    setSaving(false);
  }

  return (
    <div className="activity-details">
      <div>{item.title}<br /><small>{item.category}</small></div>
      {item.location && <div className="activity-location">{item.location}</div>}
      {editing ? (
        <div className="activity-note-editor">
          <textarea value={notes} maxLength={1000} aria-label={`Notes for ${item.title}`} onChange={e => setNotes(e.target.value)} />
          <div className="row">
            <button type="button" className="chip" onClick={() => { setNotes(item.notes || ""); setEditing(false); }}>Cancel</button>
            <button type="button" className="btn ghost" onClick={saveNotes} disabled={saving}>{saving ? "Saving…" : "Save notes"}</button>
          </div>
        </div>
      ) : (
        <div className="activity-notes">
          {item.notes && <p>{item.notes}</p>}
          <button type="button" className="chip" onClick={() => setEditing(true)}>{item.notes ? "Edit notes" : "Add notes"}</button>
        </div>
      )}
    </div>
  );
}

function Checklist({ trip, call }) {
  const [form, setForm] = useState({ title: "", description: "", assignedTo: "", dueDate: "" });
  const tasks = trip.checklist || [];
  const completed = tasks.filter(task => task.completed).length;

  async function addTask(event) {
    event.preventDefault();
    const result = await call("/checklist", { method: "POST", body: form });
    if (result) setForm({ title: "", description: "", assignedTo: "", dueDate: "" });
  }

  const memberName = memberId =>
    trip.members.find(member => String(member._id) === String(memberId))?.name || "Unassigned";

  return (
    <section className="checklist-panel">
      <div className="row sp checklist-heading">
        <div>
          <h3>Trip checklist</h3>
          <p className="meta">{completed} of {tasks.length} tasks completed</p>
        </div>
        <strong className="checklist-progress">{tasks.length ? Math.round(completed / tasks.length * 100) : 0}%</strong>
      </div>
      <form className="card checklist-form" onSubmit={addTask}>
        <input placeholder="Task (e.g. Book train tickets)" value={form.title} maxLength={160}
          onChange={event => setForm({ ...form, title: event.target.value })} required />
        <input placeholder="Details (optional)" value={form.description} maxLength={500}
          onChange={event => setForm({ ...form, description: event.target.value })} />
        <label className="date-field">Assign to
          <select value={form.assignedTo} onChange={event => setForm({ ...form, assignedTo: event.target.value })}>
            <option value="">Unassigned</option>
            {trip.members.map(member => <option key={member._id} value={member._id}>{member.name}</option>)}
          </select>
        </label>
        <label className="date-field">Due date
          <input type="date" value={form.dueDate} onChange={event => setForm({ ...form, dueDate: event.target.value })} />
        </label>
        <button className="btn">Add task</button>
      </form>

      <div className="card checklist-list">
        {tasks.map(task => (
          <article className={"checklist-task" + (task.completed ? " is-complete" : "")} key={task._id}>
            <label className="checklist-check">
              <input type="checkbox" checked={task.completed}
                aria-label={`${task.completed ? "Mark incomplete" : "Complete"}: ${task.title}`}
                onChange={event => call(`/checklist/${task._id}`, {
                  method: "PATCH", body: { completed: event.target.checked }
                })} />
            </label>
            <div className="checklist-task-copy">
              <strong>{task.title}</strong>
              {task.description && <span>{task.description}</span>}
              <small>
                {memberName(task.assignedTo?._id || task.assignedTo)}
                {task.dueDate && ` · Due ${new Date(task.dueDate).toLocaleDateString(undefined, {
                  month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
                })}`}
              </small>
            </div>
            <label className="checklist-assignee" aria-label={`Assign ${task.title}`}>
              <select value={task.assignedTo?._id || task.assignedTo || ""}
                onChange={event => call(`/checklist/${task._id}`, {
                  method: "PATCH", body: { assignedTo: event.target.value }
                })}>
                <option value="">Unassigned</option>
                {trip.members.map(member => <option key={member._id} value={member._id}>{member.name}</option>)}
              </select>
            </label>
            <button type="button" className="x" aria-label={`Remove ${task.title}`}
              onClick={() => call(`/checklist/${task._id}`, { method: "DELETE" })}>×</button>
          </article>
        ))}
        {!tasks.length && <p className="meta checklist-empty">No tasks yet. Add the first thing your group needs to do.</p>}
      </div>
    </section>
  );
}

function Reminders({ trip, reminders, notificationsEnabled, notificationMessage, enableNotifications }) {
  const memberName = memberId =>
    trip.members.find(member => String(member._id) === String(memberId))?.name || "Unassigned";

  return (
    <section className="reminders-panel">
      <div>
        <h3>Trip reminders</h3>
        <p className="meta">Upcoming trip plans, tasks and items to pack.</p>
      </div>
      <div className="card reminder-notification-settings">
        <div>
          <strong>Browser notifications</strong>
          <p className="meta">Get daily reminders while Wayfare is open in this browser.</p>
        </div>
        <button type="button" className="btn ghost" onClick={enableNotifications}
          disabled={notificationsEnabled || !("Notification" in window) || Notification.permission === "denied"}>
          {notificationsEnabled ? "Notifications on" : "Enable notifications"}
        </button>
        {notificationMessage && <p className="meta" role="status">{notificationMessage}</p>}
        {"Notification" in window && Notification.permission === "denied" &&
          <p className="meta" role="status">Allow notifications for this site in your browser settings, then reload.</p>}
      </div>
      {reminders.startOffset !== null && (
        <article className="card reminder-card reminder-trip">
          <strong>{reminders.startOffset === 0 ? "Your trip starts today!" :
            `Your trip starts in ${reminders.startOffset} ${reminders.startOffset === 1 ? "day" : "days"}`}</strong>
          <span>{formatTripDates(trip.startDate, trip.endDate)}</span>
        </article>
      )}
      {reminders.upcomingTasks.length > 0 && (
        <section className="card reminder-section">
          <h3>Checklist tasks due soon</h3>
          {reminders.upcomingTasks.map(task => {
            const dueDate = inputDate(task.dueDate);
            const remainingDays = Math.round(
              (Date.parse(`${dueDate}T00:00:00.000Z`) -
                Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)) / 86400000
            );
            return (
              <article className="reminder-row" key={task._id}>
                <span className="reminder-dot" aria-hidden="true">!</span>
                <div>
                  <strong>{task.title}</strong>
                  <small>{remainingDays < 0 ? `Overdue by ${Math.abs(remainingDays)} ${Math.abs(remainingDays) === 1 ? "day" : "days"}` :
                    remainingDays === 0 ? "Due today" : `Due in ${remainingDays} ${remainingDays === 1 ? "day" : "days"}`}
                    {" · "}{memberName(task.assignedTo?._id || task.assignedTo)}</small>
                </div>
              </article>
            );
          })}
        </section>
      )}
      {reminders.upcomingActivities.length > 0 && (
        <section className="card reminder-section">
          <h3>Itinerary coming up</h3>
          {reminders.upcomingActivities.map(item => (
            <article className="reminder-row" key={item._id}>
              <span className="reminder-dot" aria-hidden="true">›</span>
              <div>
                <strong>{item.title}</strong>
                <small>{new Date(`${item.date}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: "short", month: "short", day: "numeric"
                })}{item.time ? ` · ${item.time}` : ""}{item.location ? ` · ${item.location}` : ""}</small>
              </div>
            </article>
          ))}
        </section>
      )}
      {reminders.unpackedItems.length > 0 && (
        <section className="card reminder-section">
          <h3>Still to pack</h3>
          {reminders.unpackedItems.map(item => (
            <article className="reminder-row" key={item._id}>
              <span className="reminder-dot" aria-hidden="true">□</span>
              <div>
                <strong>{item.name}{item.quantity > 1 ? ` × ${item.quantity}` : ""}</strong>
                <small>{memberName(item.assignedTo?._id || item.assignedTo)}</small>
              </div>
            </article>
          ))}
        </section>
      )}
      {!reminders.startOffset && reminders.startOffset !== 0 &&
        !reminders.upcomingTasks.length && !reminders.unpackedItems.length && !reminders.upcomingActivities.length && (
          <div className="card reminders-empty">
            <strong>All caught up!</strong>
            <p className="meta">No upcoming reminders. Add trip dates, checklist due dates or packing items to see reminders here.</p>
          </div>
        )}
    </section>
  );
}

function PackingList({ trip, call }) {
  const [form, setForm] = useState({ name: "", quantity: 1, assignedTo: "" });
  const items = trip.packing || [];
  const packedCount = items.filter(item => item.packed).length;
  const memberName = memberId =>
    trip.members.find(member => String(member._id) === String(memberId))?.name || "Unassigned";

  async function addItem(event) {
    event.preventDefault();
    const result = await call("/packing", { method: "POST", body: form });
    if (result) setForm({ name: "", quantity: 1, assignedTo: "" });
  }

  return (
    <section className="checklist-panel">
      <div className="row sp checklist-heading">
        <div>
          <h3>Packing list</h3>
          <p className="meta">{packedCount} of {items.length} packed</p>
        </div>
        <strong className="checklist-progress">{items.length ? Math.round(packedCount / items.length * 100) : 0}%</strong>
      </div>
      <form className="card packing-form" onSubmit={addItem}>
        <input placeholder="Item (e.g. sunscreen)" value={form.name} maxLength={120}
          onChange={event => setForm({ ...form, name: event.target.value })} required />
        <label className="date-field">Quantity
          <input type="number" min="1" max="99" step="1" value={form.quantity}
            onChange={event => setForm({ ...form, quantity: event.target.value })} required />
        </label>
        <label className="date-field">Bringing it
          <select value={form.assignedTo} onChange={event => setForm({ ...form, assignedTo: event.target.value })}>
            <option value="">Unassigned</option>
            {trip.members.map(member => <option key={member._id} value={member._id}>{member.name}</option>)}
          </select>
        </label>
        <button className="btn">Add item</button>
      </form>

      <div className="card packing-list">
        {items.map(item => (
          <article className={"packing-item" + (item.packed ? " is-packed" : "")} key={item._id}>
            <label className="checklist-check">
              <input type="checkbox" checked={item.packed}
                aria-label={`${item.packed ? "Mark not packed" : "Mark packed"}: ${item.name}`}
                onChange={event => call(`/packing/${item._id}`, {
                  method: "PATCH", body: { packed: event.target.checked }
                })} />
            </label>
            <div className="checklist-task-copy">
              <strong>{item.name}</strong>
              <small>Qty {item.quantity} · {memberName(item.assignedTo?._id || item.assignedTo)}</small>
            </div>
            <label className="checklist-assignee" aria-label={`Assign ${item.name}`}>
              <select value={item.assignedTo?._id || item.assignedTo || ""}
                onChange={event => call(`/packing/${item._id}`, {
                  method: "PATCH", body: { assignedTo: event.target.value }
                })}>
                <option value="">Unassigned</option>
                {trip.members.map(member => <option key={member._id} value={member._id}>{member.name}</option>)}
              </select>
            </label>
            <button type="button" className="x" aria-label={`Remove ${item.name}`}
              onClick={() => call(`/packing/${item._id}`, { method: "DELETE" })}>×</button>
          </article>
        ))}
        {!items.length && <p className="meta checklist-empty">No packing items yet. Add what your group needs to bring.</p>}
      </div>
    </section>
  );
}

function Polls({ trip, call, meId }) {
  const [form, setForm] = useState({ question: "", options: ["", ""] });
  const polls = trip.polls || [];

  function updateOption(index, value) {
    setForm(current => ({
      ...current,
      options: current.options.map((option, optionIndex) => optionIndex === index ? value : option)
    }));
  }

  async function createPoll(event) {
    event.preventDefault();
    const result = await call("/polls", {
      method: "POST",
      body: { question: form.question, options: form.options }
    });
    if (result) setForm({ question: "", options: ["", ""] });
  }

  async function vote(pollId, optionId) {
    await call(`/polls/${pollId}/vote`, { method: "POST", body: { optionId } });
  }

  async function removePoll(poll) {
    if (!window.confirm(`Delete the poll "${poll.question}" and its votes?`)) return;
    await call(`/polls/${poll._id}`, { method: "DELETE" });
  }

  return (
    <section className="polls-panel">
      <div>
        <h3>Group polls</h3>
        <p className="meta">Vote together on where to eat, what to do, or anything else.</p>
      </div>
      <form className="card poll-form" onSubmit={createPoll}>
        <input placeholder="What should the group decide?" value={form.question} maxLength={200}
          onChange={event => setForm({ ...form, question: event.target.value })} required />
        <div className="poll-option-fields">
          {form.options.map((option, index) => (
            <div className="poll-option-input" key={index}>
              <input placeholder={`Option ${index + 1}`} value={option} maxLength={120}
                onChange={event => updateOption(index, event.target.value)} required />
              {form.options.length > 2 && (
                <button type="button" className="x" aria-label={`Remove option ${index + 1}`}
                  onClick={() => setForm(current => ({
                    ...current,
                    options: current.options.filter((_, optionIndex) => optionIndex !== index)
                  }))}>×</button>
              )}
            </div>
          ))}
        </div>
        <div className="row poll-form-actions">
          {form.options.length < 5 && <button type="button" className="btn ghost"
            onClick={() => setForm(current => ({ ...current, options: [...current.options, ""] }))}>
            Add option
          </button>}
          <button className="btn">Create poll</button>
        </div>
      </form>

      <div className="grid g2">
        {polls.map(poll => {
          const totalVotes = poll.options.reduce((total, option) => total + option.votes.length, 0);
          const isCreator = String(poll.createdBy?._id || poll.createdBy) === String(meId);
          const myVote = poll.options.find(option =>
            option.votes.some(voter => String(voter?._id || voter) === String(meId))
          )?._id;
          return (
            <article className={`card poll-card${poll.closed ? " poll-closed" : ""}`} key={poll._id}>
              <div className="poll-card-topline">
                <div className="row sp poll-card-heading">
                  <h3>{poll.question}</h3>
                  <span className="meta">{totalVotes} {totalVotes === 1 ? "vote" : "votes"}</span>
                </div>
                <div className="row poll-card-actions">
                  <span className={`poll-status${poll.closed ? " closed" : ""}`}>{poll.closed ? "Closed" : "Open"}</span>
                  {isCreator && (
                    <>
                      <button type="button" className="chip" onClick={() => call(`/polls/${poll._id}/status`, {
                        method: "PATCH", body: { closed: !poll.closed }
                      })}>{poll.closed ? "Reopen" : "Close poll"}</button>
                      <button type="button" className="x" aria-label={`Delete poll: ${poll.question}`}
                        onClick={() => removePoll(poll)}>×</button>
                    </>
                  )}
                </div>
              </div>
              <div className="poll-options">
                {poll.options.map(option => {
                  const votes = option.votes.length;
                  const percent = totalVotes ? Math.round(votes / totalVotes * 100) : 0;
                  const selected = String(myVote) === String(option._id);
                  return (
                    <button type="button" className={`poll-option${selected ? " selected" : ""}`}
                      key={option._id} aria-pressed={selected}
                      disabled={poll.closed}
                      onClick={() => vote(poll._id, option._id)}>
                      <span className="poll-option-label"><strong>{option.text}</strong><span>{votes} · {percent}%</span></span>
                      <span className="poll-option-bar"><i style={{ width: `${percent}%` }} /></span>
                    </button>
                  );
                })}
              </div>
              <p className="meta poll-hint">{poll.closed
                ? "This poll is closed. Results remain visible."
                : myVote ? "Your vote is counted. Choose another option to change it." : "Choose an option to vote."}</p>
            </article>
          );
        })}
        {!polls.length && <p className="meta poll-empty">No polls yet. Create one to decide as a group.</p>}
      </div>
    </section>
  );
}

function Bookings({ trip, call }) {
  const [form, setForm] = useState({
    type: "Flight", provider: "", confirmationCode: "", url: "", date: "", notes: ""
  });
  const bookings = trip.bookings || [];

  async function addBooking(event) {
    event.preventDefault();
    const result = await call("/bookings", { method: "POST", body: form });
    if (result) setForm({ type: "Flight", provider: "", confirmationCode: "", url: "", date: "", notes: "" });
  }

  return (
    <section className="bookings-panel">
      <div>
        <h3>Booking organizer</h3>
        <p className="meta">Keep shared booking references and links together. Avoid adding payment card details.</p>
      </div>
      <form className="card booking-form" onSubmit={addBooking}>
        <label className="date-field">Type
          <select value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}>
            {["Flight", "Train", "Bus", "Hotel", "Car rental", "Other"].map(type =>
              <option key={type}>{type}</option>
            )}
          </select>
        </label>
        <input placeholder="Provider (e.g. airline or hotel)" value={form.provider} maxLength={120}
          onChange={event => setForm({ ...form, provider: event.target.value })} required />
        <input placeholder="Confirmation number (optional)" value={form.confirmationCode} maxLength={120}
          onChange={event => setForm({ ...form, confirmationCode: event.target.value })} />
        <label className="date-field">Booking date
          <input type="date" value={form.date} onChange={event => setForm({ ...form, date: event.target.value })} />
        </label>
        <input type="url" placeholder="Booking link (https://…)" value={form.url} maxLength={500}
          onChange={event => setForm({ ...form, url: event.target.value })} />
        <input placeholder="Notes (optional)" value={form.notes} maxLength={500}
          onChange={event => setForm({ ...form, notes: event.target.value })} />
        <button className="btn">Add booking</button>
      </form>

      <div className="grid g2">
        {bookings.map(booking => (
          <article className="card booking-card" key={booking._id}>
            <div className="row sp booking-heading">
              <span className="chip">{booking.type}</span>
              <button type="button" className="x" aria-label={`Remove ${booking.type} booking`}
                onClick={() => call(`/bookings/${booking._id}`, { method: "DELETE" })}>×</button>
            </div>
            <h3>{booking.provider}</h3>
            {booking.confirmationCode && (
              <p className="booking-reference"><span>Confirmation</span><strong>{booking.confirmationCode}</strong></p>
            )}
            {booking.date && <p className="meta">Date: {new Date(booking.date).toLocaleDateString(undefined, {
              month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
            })}</p>}
            {booking.notes && <p className="booking-notes">{booking.notes}</p>}
            {booking.url && <a className="booking-link" href={booking.url} target="_blank" rel="noreferrer">Open booking link ↗</a>}
            <label className="booking-status">Status
              <select value={booking.status} onChange={event => call(`/bookings/${booking._id}/status`, {
                method: "PATCH", body: { status: event.target.value }
              })}>
                {["Pending", "Confirmed", "Cancelled"].map(status => <option key={status}>{status}</option>)}
              </select>
            </label>
          </article>
        ))}
        {!bookings.length && <p className="meta">No bookings yet. Add flight, train or stay details for the group.</p>}
      </div>
    </section>
  );
}

function Stays({ trip, call, meId }) {
  const [f, setF] = useState({ name: "", description: "", price: "" });
  const score = s => s.votes.reduce((a, v) => a + v.value, 0);
  const lead = [...trip.stays].sort((a, b) => score(b) - score(a))[0];
  const add = async e => { e.preventDefault(); await call("/stays", { method: "POST", body: { ...f, price: +f.price } }); setF({ name: "", description: "", price: "" }); };
  return (
    <>
      <form className="card row" style={{ flexWrap: "wrap", marginBottom: 18 }} onSubmit={add}>
        <input placeholder="Airbnb listing name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required style={{ flex: 1, minWidth: 140 }} />
        <input placeholder="Details" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} style={{ flex: 1, minWidth: 120 }} />
        <input type="number" placeholder="Total ₹" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} style={{ width: 110 }} required />
        <button className="btn">Add stay</button>
      </form>
      <div className="grid g2">
        {trip.stays.map((s, i) => {
          const mine = s.votes.find(v => v.user === meId)?.value;
          const vote = v => call(`/stays/${s._id}/vote`, { method: "POST", body: { value: mine === v ? 0 : v } });
          return (
            <div key={s._id} className={"card stay " + (lead?._id === s._id && score(s) > 0 ? "win" : "")}>
              <div className="swatch" style={{ background: COLORS[i % 5] }}>{lead?._id === s._id && score(s) > 0 ? "Leading" : ""}</div>
              <h3>{s.name}</h3><div className="meta">{s.description}</div>
              <div className="row sp" style={{ marginTop: 8 }}><b>{fmt(s.price)} total</b><span className="meta">{fmt(s.price / Math.max(trip.members.length, 1))} each</span></div>
              <div className="vote">
                <button className={mine === 1 ? "me" : ""} onClick={() => vote(1)}>👍 {s.votes.filter(v => v.value === 1).length}</button>
                <button className={mine === -1 ? "me" : ""} onClick={() => vote(-1)}>👎 {s.votes.filter(v => v.value === -1).length}</button>
              </div>
            </div>
          );
        })}
      </div>
      {!trip.stays.length && <p className="meta">No stays yet. Add Airbnb options and let the group vote.</p>}
    </>
  );
}

function Budget({ trip, call, spent, id }) {
  const [balances, setBalances] = useState([]);
  const [e, setE] = useState({ title: "", amount: "" });
  const [payerId, setPayerId] = useState(currentUser()?.id || "");
  const [splitAmong, setSplitAmong] = useState(() => trip.members.map(member => String(member._id)));
  useEffect(() => { api(`/trips/${id}/balances`).then(setBalances).catch(() => {}); }, [trip, id]);
  useEffect(() => {
    const memberIds = trip.members.map(member => String(member._id));
    setSplitAmong(selected => [...new Set([...selected.filter(memberId => memberIds.includes(memberId)), ...memberIds.filter(memberId => !selected.includes(memberId))])]);
    if (!trip.members.some(member => String(member._id) === payerId)) {
      setPayerId(currentUser()?.id || String(trip.members[0]?._id || ""));
    }
  }, [trip.members, payerId]);
  const left = trip.budget - spent;
  const add = async ev => {
    ev.preventDefault();
    const result = await call("/expenses", { method: "POST", body: { title: e.title, amount: +e.amount, payerId, splitAmong } });
    if (result) setE({ title: "", amount: "" });
  };
  const toggleSplitMember = memberId => setSplitAmong(selected =>
    selected.includes(memberId) ? selected.filter(id => id !== memberId) : [...selected, memberId]
  );
  const memberName = memberId => trip.members.find(member => String(member._id) === String(memberId))?.name || "Unknown member";
  const meId = String(currentUser()?.id || "");
  return (
    <div className="grid g2">
      <div className="card">
        <div className="meta">Planned spend</div><div className="stat">{fmt(spent)}</div>
        <div className="bar" style={{ margin: "12px 0" }}><i style={{ width: Math.min(100, trip.budget ? spent / trip.budget * 100 : 0) + "%", background: left < 0 ? "var(--acc2)" : "var(--acc)" }} /></div>
        <div className="row sp"><span className="meta">Budget {fmt(trip.budget)}</span>
          <b style={{ color: left < 0 ? "var(--acc2)" : "var(--acc)" }}>{left < 0 ? fmt(-left) + " over" : fmt(left) + " left"}</b></div>
      </div>
      <div className="card">
        <h3>Shared expenses</h3>
        <form className="expense-form" onSubmit={add}>
          <div className="expense-fields">
            <input placeholder="What was it?" value={e.title} onChange={x => setE({ ...e, title: x.target.value })} required />
            <input type="number" min="0.01" step="0.01" placeholder="Amount ₹" value={e.amount} onChange={x => setE({ ...e, amount: x.target.value })} required />
            <label className="expense-payer">Paid by
              <select value={payerId} onChange={event => setPayerId(event.target.value)} required>
                {trip.members.map(member => <option key={member._id} value={member._id}>{member.name}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="split-picker">
            <legend>Split equally between</legend>
            <div className="split-options">
              {trip.members.map(member => {
                const memberId = String(member._id);
                return (
                  <label key={memberId} className="split-option">
                    <input type="checkbox" checked={splitAmong.includes(memberId)} onChange={() => toggleSplitMember(memberId)} />
                    <span>{member.name}</span>
                  </label>
                );
              })}
            </div>
            <span className="split-hint">
              {splitAmong.length ? `${fmt(Number(e.amount || 0) / splitAmong.length)} per person · ${splitAmong.length} selected` : "Select at least one person"}
            </span>
          </fieldset>
          <button className="btn" disabled={!splitAmong.length}>Add expense</button>
        </form>
        <div className="expense-list">
          {[...trip.expenses].reverse().map(expense => {
            const payerIdValue = String(expense.paidBy?._id || expense.paidBy);
            const participantIds = (expense.splitAmong || []).map(member => String(member?._id || member));
            const share = expense.amount / Math.max(participantIds.length, 1);
            const settledIds = new Set((expense.settledBy || []).map(member => String(member?._id || member)));
            const owingIds = participantIds.filter(memberId => memberId !== payerIdValue);
            return (
              <div className="expense-item" key={expense._id}>
                <div className="expense-item-content">
                  <div className="expense-item-main">
                    <strong>{expense.title}</strong>
                    <span>{memberName(payerIdValue)} paid · split with {participantIds.map(memberName).join(", ") || "no one"}</span>
                  </div>
                  <div className="expense-item-amount">
                    <strong>{fmt(expense.amount)}</strong>
                    <span>{fmt(share)} each</span>
                  </div>
                  {owingIds.length > 0 && (
                    <div className="expense-settlements">
                      {owingIds.map(memberId => {
                        const settled = settledIds.has(memberId);
                        return (
                          <div className="expense-settlement-row" key={memberId}>
                            <span>{memberName(memberId)} {settled ? "paid" : `owes ${fmt(share)}`} to {memberName(payerIdValue)}</span>
                            {memberId === meId && (
                              <button type="button" className={`chip${settled ? "" : " settlement-action"}`}
                                onClick={() => call(`/expenses/${expense._id}/settle`, {
                                  method: "PATCH", body: { settled: !settled }
                                })}>
                                {settled ? "Undo" : "Mark paid"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {owingIds.every(memberId => settledIds.has(memberId)) &&
                        <strong className="expense-settled-label">Settled</strong>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {!trip.expenses.length && <p className="meta expense-empty">No shared expenses yet.</p>}
        </div>
        <h3 className="balance-heading">Trip balances</h3>
        {balances.map(b => (
          <div key={b.name} className="row sp"><span>{b.name}</span>
            <b style={{ color: b.net < 0 ? "var(--acc2)" : "var(--acc)" }}>{b.net < 0 ? "owes " + fmt(-b.net) : b.net > 0 ? "is owed " + fmt(b.net) : "settled"}</b></div>
        ))}
      </div>
    </div>
  );
}

function Chat({ messages, typing, meId, socket, status, error }) {
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState("");
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView(); }, [messages]);
  const connected = status === "connected" && socket.current?.connected;
  const send = e => {
    e.preventDefault();
    const message = text.trim();
    if (!message || !connected) return;
    setSendError("");
    socket.current.emit("chat:send", message, result => {
      if (result?.ok) {
        setText(current => current === message ? "" : current);
      } else {
        setSendError(result?.error || "Message could not be sent. Please try again.");
      }
    });
  };
  return (
    <div className="card chat">
      <p className="meta" role="status">
        {connected ? "Connected to trip chat" : status === "joining" ? "Joining trip chat…" :
          status === "disconnected" ? "Chat disconnected. Reconnecting…" : "Connecting to trip chat…"}
      </p>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="msgs">
        {messages.map(m => <div key={m._id} className={"m " + (m.user === meId ? "me" : "")}><b>{m.userName}</b>{m.text}</div>)}
        <div ref={end} />
      </div>
      <div className="typing">{typing}</div>
      <form className="row" onSubmit={send}>
        <input style={{ flex: 1 }} placeholder="Message the group" value={text} maxLength={2000}
          aria-label="Message the group" onChange={e => {
            setText(e.target.value);
            if (connected) socket.current.emit("chat:typing");
          }} />
        <button className="btn" disabled={!connected || !text.trim()}>Send</button>
      </form>
      {sendError && <p className="err" role="alert">{sendError}</p>}
    </div>
  );
}

function Discover({ id, call }) {
  const [recs, setRecs] = useState(null);
  useEffect(() => { api(`/trips/${id}/recommendations`).then(setRecs).catch(() => setRecs([])); }, [id]);
  if (!recs) return <p className="meta">Finding ideas that fit your budget…</p>;
  return (
    <div className="grid g2">
      {recs.map((r, i) => (
        <div key={i} className="card"><span className="chip">{r.category}</span>
          <h3 style={{ margin: "10px 0 4px" }}>{r.title}</h3><div className="meta">{r.why}</div>
          <div className="row sp" style={{ marginTop: 12 }}><b>{r.cost ? fmt(r.cost) : "Free"}</b>
            <button className="btn ghost" onClick={() => call("/items", { method: "POST", body: { day: 3, time: "15:00", title: r.title, cost: r.cost, category: r.category } })}>Add to Day 3</button></div>
        </div>
      ))}
    </div>
  );
}

function Concierge({ id, close }) {
  const [msgs, setMsgs] = useState([{ u: "Concierge", x: "Hi! I know your itinerary, votes and budget. What do you need?" }]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight); }, [msgs]);
  async function ask(text) {
    if (!text.trim() || busy) return;
    setMsgs(m => [...m, { u: "You", x: text }]); setQ(""); setBusy(true);
    try { const d = await api(`/trips/${id}/concierge`, { method: "POST", body: { message: text } }); setMsgs(m => [...m, { u: "Concierge", x: d.reply }]); }
    catch (e) { setMsgs(m => [...m, { u: "Concierge", x: e.message }]); }
    setBusy(false);
  }
  return (
    <section id="ai" className="open" aria-label="Travel concierge">
      <div className="row sp"><h3>Travel concierge</h3><button className="x" onClick={close} aria-label="Close">×</button></div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {["Plan day 2", "Budget status", "Suggest food", "Who owes what"].map(c => <button key={c} className="chip" onClick={() => ask(c)}>{c}</button>)}
      </div>
      <div className="msgs" ref={box}>{msgs.map((m, i) => <div key={i} className={"m " + (m.u === "You" ? "me" : "")}><b>{m.u}</b>{m.x}</div>)}{busy && <div className="typing">Thinking…</div>}</div>
      <form className="row" onSubmit={e => { e.preventDefault(); ask(q); }}>
        <input style={{ flex: 1 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Ask about plans, budget, places" aria-label="Message concierge" />
        <button className="btn">Send</button>
      </form>
    </section>
  );
}
