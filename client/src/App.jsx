import React, { useCallback, useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from "react-router-dom";
import { api, setSession, clearSession, getToken, currentUser } from "./api.js";
import TripRoom from "./TripRoom.jsx";
import ProfileMenu from "./ProfileMenu.jsx";

function Auth() {
  const nav = useNavigate();
  const [mode, setMode] = useState("login");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const set = k => e => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setErr("");
    try {
      const d = await api("/auth/" + mode, { method: "POST", body: f });
      setSession(d.token, d.user); nav("/");
    } catch (x) { setErr(x.message); }
  }
  return (
    <form className="auth card" onSubmit={submit}>
      <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
      <p className="analytics-disclosure">Page visits and successful sign-ins are recorded for site analytics. Signed-in activity is linked to your account; signed-out visits are counted anonymously. IP addresses are not stored.</p>
      {mode === "register" && <input placeholder="Your name" value={f.name} onChange={set("name")} required />}
      <input type="email" placeholder="Email" value={f.email} onChange={set("email")} required />
      <input type="password" placeholder="Password (6+ characters)" value={f.password} onChange={set("password")} required />
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn">{mode === "login" ? "Sign in" : "Create account"}</button>
      <button type="button" className="chip" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </form>
  );
}

function readCachedTrips(userId) {
  try {
    const saved = localStorage.getItem(`wayfare:trips-cache:${userId}`);
    if (!saved) return null;
    const trips = JSON.parse(saved);
    if (!Array.isArray(trips)) throw new Error("Saved trip list is incomplete.");
    return trips;
  } catch (error) {
    console.error("Could not read the saved offline trip list:", error);
    return null;
  }
}

function AnalyticsTracker() {
  const location = useLocation();

  useEffect(() => {
    const page = location.pathname === "/"
      ? "home"
      : location.pathname === "/login"
        ? "login"
        : location.pathname === "/analytics"
          ? "analytics"
          : /^\/trip\/[^/]+$/.test(location.pathname)
            ? "trip"
            : "other";
    api("/analytics/page-view", { method: "POST", body: { page } })
      .then(result => {
        if (result.recorded) return;
      })
      .catch(error => console.warn("Could not record this page visit:", error.message));
  }, [location.pathname]);

  return null;
}

function AnalyticsAccessLink() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    api("/analytics/access")
      .then(result => { if (active) setIsAdmin(result.isAdmin); })
      .catch(error => console.warn("Could not check analytics access:", error.message));
    return () => { active = false; };
  }, []);

  return isAdmin ? <Link className="btn ghost analytics-link" to="/analytics">View analytics</Link> : null;
}

function AnalyticsDashboard() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    api("/analytics/summary")
      .then(setSummary)
      .catch(requestError => setError(requestError.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return (
    <div className="wrap">
      <header>
        <div><Link to="/" className="meta">← Your trips</Link><h1>Site analytics</h1></div>
      </header>
      <p className="err" role="alert">{error}</p>
    </div>
  );
  if (!summary) return <div className="wrap"><p className="meta">Loading analytics…</p></div>;

  const pageLabels = { home: "Home", login: "Login", trip: "Trip", analytics: "Analytics", other: "Other" };
  return (
    <div className="wrap">
      <header>
        <div><Link to="/" className="meta">← Your trips</Link><h1>Site analytics</h1>
          <div className="meta">Page views from the last {summary.retentionDays} days</div>
        </div>
        <button type="button" className="btn ghost" onClick={load}>Refresh</button>
      </header>
      <p className="analytics-disclosure">Successful sign-ins and logged-in page visits are linked to account details. Visitors who are not signed in are only included in the anonymous count. IP addresses are not stored.</p>
      <div className="grid analytics-stats">
        <div className="card"><span className="meta">Total page views</span><strong>{summary.totalViews}</strong></div>
        <div className="card"><span className="meta">Successful logins</span><strong>{summary.successfulLogins}</strong></div>
        <div className="card"><span className="meta">Signed-in visits</span><strong>{summary.signedInViews}</strong></div>
        <div className="card"><span className="meta">Unique signed-in accounts</span><strong>{summary.uniqueSignedInUsers}</strong></div>
        <div className="card"><span className="meta">Anonymous visits</span><strong>{summary.anonymousViews}</strong></div>
      </div>
      <section className="card analytics-section">
        <h3>Pages visited</h3>
        {summary.pageTotals.length
          ? summary.pageTotals.map(item => (
            <div className="row sp analytics-page-row" key={item.page}>
              <span>{pageLabels[item.page] || item.page}</span><strong>{item.count}</strong>
            </div>
          ))
          : <p className="meta">No page visits recorded in this period yet.</p>}
      </section>
      <section className="card analytics-section">
        <h3>Recent logins</h3>
        {summary.recentLogins.length
          ? summary.recentLogins.map(login => (
            <div className="analytics-visit" key={login.id}>
              <div><strong>{login.user?.name || "Deleted account"}</strong>
                <span>{login.user?.email || "Account unavailable"}</span></div>
              <span>Successful login</span>
              <time dateTime={login.createdAt}>{new Date(login.createdAt).toLocaleString()}</time>
            </div>
          ))
          : <p className="meta">No successful logins recorded in this period yet.</p>}
      </section>
      <section className="card analytics-section">
        <h3>Recent signed-in visits</h3>
        {summary.recentViews.filter(view => view.user).length
          ? summary.recentViews.filter(view => view.user).map(view => (
            <div className="analytics-visit" key={view.id}>
              <div><strong>{view.user.name}</strong><span>{view.user.email}</span></div>
              <span>{pageLabels[view.page] || view.page}</span>
              <time dateTime={view.createdAt}>{new Date(view.createdAt).toLocaleString()}</time>
            </div>
          ))
          : <p className="meta">No signed-in visits recorded in this period yet.</p>}
      </section>
    </div>
  );
}

function Dashboard() {
  const nav = useNavigate();
  const user = currentUser();
  const [trips, setTrips] = useState([]);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [showingCachedTrips, setShowingCachedTrips] = useState(false);
  const [f, setF] = useState({ name: "", destination: "", budget: "", startDate: "", endDate: "" });
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await api("/trips");
      setTrips(result);
      setShowingCachedTrips(false);
      setErr("");
      try {
        const summary = result.map(trip => ({
          _id: trip._id,
          name: trip.name,
          destination: trip.destination,
          startDate: trip.startDate,
          endDate: trip.endDate,
          members: trip.members.map(member => ({ _id: member._id, name: member.name }))
        }));
        localStorage.setItem(`wayfare:trips-cache:${user.id}`, JSON.stringify(summary));
      } catch (error) {
        console.error("Could not save the trip list for offline viewing:", error);
      }
    } catch (error) {
      const cachedTrips = readCachedTrips(user.id);
      if (cachedTrips) {
        setTrips(cachedTrips);
        setShowingCachedTrips(true);
        setErr("");
      } else {
        setErr(error.message);
      }
    }
  }, [user.id]);

  useEffect(() => {
    const cachedTrips = readCachedTrips(user.id);
    if (cachedTrips) {
      setTrips(cachedTrips);
      setShowingCachedTrips(true);
    }
    setIsOnline(navigator.onLine);
    load();

    const handleOnline = () => {
      setIsOnline(true);
      load();
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [load, user.id]);

  async function create(e) {
    e.preventDefault();
    try {
      const t = await api("/trips", {
        method: "POST",
        body: { ...f, startDate: f.startDate || undefined, endDate: f.endDate || undefined }
      });
      nav("/trip/" + t._id);
    }
    catch (x) { setErr(x.message); }
  }
  async function join(e) {
    e.preventDefault();
    try { const t = await api("/trips/join", { method: "POST", body: { code } }); nav("/trip/" + t.id); }
    catch (x) { setErr(x.message); }
  }
  return (
    <div className="wrap">
      <header>
        <div><h1>Your trips</h1><div className="meta">Hi {user?.name}</div></div>
        <ProfileMenu
          user={currentUser()}
          onSignOut={() => { clearSession(); nav("/login"); }}
        />
      </header>
      {(showingCachedTrips || !isOnline) && (
        <div className="offline-banner" role="status">
          Showing saved trips from this browser. Opened trips are available offline; changes will not sync.
        </div>
      )}
      <div className="dashboard-analytics-actions">
        <AnalyticsAccessLink />
        <p className="analytics-disclosure">Page visits and successful sign-ins are recorded for site analytics. Signed-in activity is linked to your account; signed-out visits are counted anonymously. IP addresses are not stored.</p>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="grid g2">
        <form className="card grid" onSubmit={create}>
          <h3>Start a trip</h3>
          <input placeholder="Trip name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required />
          <input placeholder="Destination" value={f.destination} onChange={e => setF({ ...f, destination: e.target.value })} />
          <label className="date-field">Start date
            <input type="date" value={f.startDate} max={f.endDate || undefined} onChange={e => setF({ ...f, startDate: e.target.value })} />
          </label>
          <label className="date-field">End date
            <input type="date" value={f.endDate} min={f.startDate || undefined} onChange={e => setF({ ...f, endDate: e.target.value })} />
          </label>
          <input type="number" placeholder="Group budget ₹" value={f.budget} onChange={e => setF({ ...f, budget: e.target.value })} />
          <button className="btn">Create trip</button>
        </form>
        <form className="card grid" onSubmit={join}>
          <h3>Join with a code</h3>
          <input placeholder="Invite code" value={code} onChange={e => setCode(e.target.value)} required />
          <button className="btn ghost">Join trip</button>
        </form>
      </div>
      <div className="grid g2" style={{ marginTop: 18 }}>
        {trips.map(t => (
          <Link key={t._id} to={"/trip/" + t._id} className="card trip-link">
            <h3>{t.name}</h3><div className="meta">{t.destination || "No destination yet"} · {t.members.length} travellers</div>
            {(t.startDate || t.endDate) && <div className="trip-dates">{formatTripDates(t.startDate, t.endDate)}</div>}
          </Link>
        ))}
        {!trips.length && <p className="meta">No trips yet. Create one or join a friend’s trip with their code.</p>}
      </div>
    </div>
  );
}

function formatTripDates(startDate, endDate) {
  const format = value => value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
  if (startDate && endDate) return `${format(startDate)} – ${format(endDate)}`;
  return startDate ? `From ${format(startDate)}` : `Until ${format(endDate)}`;
}

const Guard = ({ children }) => (getToken() ? children : <Navigate to="/login" />);

export default function App() {
  return (
    <>
      <AnalyticsTracker />
      <Routes>
        <Route path="/login" element={<Auth />} />
        <Route path="/" element={<Guard><Dashboard /></Guard>} />
        <Route path="/analytics" element={<Guard><AnalyticsDashboard /></Guard>} />
        <Route path="/trip/:id" element={<Guard><TripRoom /></Guard>} />
      </Routes>
    </>
  );
}
