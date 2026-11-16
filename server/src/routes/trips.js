import { Router } from "express";
import crypto from "crypto";
import Trip from "../models/Trip.js";
import Message from "../models/Message.js";
import { auth } from "../middleware/auth.js";
import * as concierge from "../services/concierge.js";

const r = Router();
r.use(auth);

const populate = (q) => q.populate("members", "name email").populate("expenses.paidBy", "name");
const geocodeCache = new Map();
const weatherCache = new Map();
let geocodeQueue = Promise.resolve();
let lastGeocodeRequest = 0;

// Load a trip and make sure the caller belongs to it
async function member(req, res, next) {
  const trip = await populate(Trip.findById(req.params.id));
  if (!trip) return res.status(404).json({ error: "Trip not found." });
  if (!trip.members.some(m => String(m._id) === req.user.id))
    return res.status(403).json({ error: "You are not part of this trip." });
  req.trip = trip; next();
}

// After any change, push the fresh trip to everyone in the room
async function broadcast(req) {
  const fresh = await populate(Trip.findById(req.trip._id));
  req.app.get("io").to(String(fresh._id)).emit("trip:updated", fresh);
  return fresh;
}

r.get("/", async (req, res) =>
  res.json(await Trip.find({ members: req.user.id }).select("name destination startDate endDate budget members").sort("-updatedAt")));

r.post("/", async (req, res) => {
  const { name, destination, startDate, endDate, budget } = req.body;
  if (!name) return res.status(400).json({ error: "Trip name is required." });
  const parsedStart = parseTripDate(startDate);
  const parsedEnd = parseTripDate(endDate);
  if (parsedStart === undefined || parsedEnd === undefined)
    return res.status(400).json({ error: "Enter valid trip dates." });
  if (parsedStart && parsedEnd && parsedEnd < parsedStart)
    return res.status(400).json({ error: "End date must be on or after the start date." });
  const trip = await Trip.create({
    name, destination, startDate: parsedStart, endDate: parsedEnd, budget: Number(budget) || 0,
    owner: req.user.id, members: [req.user.id], inviteCode: crypto.randomBytes(3).toString("hex")
  });
  res.status(201).json(trip);
});

r.post("/join", async (req, res) => {
  const trip = await Trip.findOne({ inviteCode: (req.body.code || "").trim() });
  if (!trip) return res.status(404).json({ error: "That invite code does not match a trip." });
  if (!trip.members.includes(req.user.id)) { trip.members.push(req.user.id); await trip.save(); }
  req.app.get("io").to(String(trip._id)).emit("trip:updated", await populate(Trip.findById(trip._id)));
  res.json({ id: trip._id });
});

r.get("/:id", member, (req, res) => res.json(req.trip));

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

r.get("/:id/weather", member, async (req, res) => {
  const destination = req.trip.destination?.trim();
  if (!destination) return res.status(400).json({ error: "Set a trip destination to see its weather forecast." });

  const today = new Date().toISOString().slice(0, 10);
  const startDate = req.trip.startDate ? req.trip.startDate.toISOString().slice(0, 10) : today;
  const endDate = req.trip.endDate
    ? req.trip.endDate.toISOString().slice(0, 10)
    : req.trip.startDate ? startDate : addDays(today, 6);
  if (endDate < startDate) return res.status(400).json({ error: "Trip end date must be on or after its start date." });

  const cacheKey = `${destination.toLocaleLowerCase()}|${startDate}|${endDate}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);

  try {
    const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geocodeUrl.search = new URLSearchParams({ name: destination, count: "1", language: "en", format: "json" });
    const geocodeResponse = await fetch(geocodeUrl, { signal: AbortSignal.timeout(10000) });
    if (!geocodeResponse.ok) throw new Error(`Weather location lookup returned HTTP ${geocodeResponse.status}.`);
    const geocodeData = await geocodeResponse.json();
    const location = geocodeData.results?.[0];
    if (!location) return res.status(404).json({ error: `Could not find a weather location for "${destination}".` });

    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.search = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
      forecast_days: "16",
      timezone: "auto"
    });
    const forecastResponse = await fetch(forecastUrl, { signal: AbortSignal.timeout(10000) });
    if (!forecastResponse.ok) throw new Error(`Weather forecast returned HTTP ${forecastResponse.status}.`);
    const forecastData = await forecastResponse.json();
    const daily = forecastData.daily;
    if (!daily?.time || !daily.weather_code) throw new Error("Weather provider returned an incomplete forecast.");

    const forecast = daily.time
      .map((date, index) => ({
        date,
        code: daily.weather_code[index],
        high: daily.temperature_2m_max?.[index] ?? null,
        low: daily.temperature_2m_min?.[index] ?? null,
        precipitationChance: daily.precipitation_probability_max?.[index] ?? null,
        windSpeed: daily.wind_speed_10m_max?.[index] ?? null
      }))
      .filter(day => day.date >= startDate && day.date <= endDate);
    const result = {
      destination,
      location: [location.name, location.admin1, location.country].filter(Boolean).join(", "),
      timezone: forecastData.timezone,
      startDate,
      endDate,
      availableFrom: daily.time[0],
      availableTo: daily.time[daily.time.length - 1],
      forecast
    };

    if (weatherCache.size > 100) {
      for (const [key, entry] of weatherCache) {
        if (entry.expiresAt <= Date.now()) weatherCache.delete(key);
      }
    }
    weatherCache.set(cacheKey, { data: result, expiresAt: Date.now() + 15 * 60 * 1000 });
    res.json(result);
  } catch (error) {
    console.error("Weather forecast failed:", error.message);
    res.status(502).json({ error: "Weather forecast is temporarily unavailable. Please try again." });
  }
});

function parseTripDate(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
}

r.put("/:id/dates", member, async (req, res) => {
  const startDate = parseTripDate(req.body.startDate);
  const endDate = parseTripDate(req.body.endDate);
  if (startDate === undefined || endDate === undefined)
    return res.status(400).json({ error: "Enter valid trip dates." });
  if (startDate && endDate && endDate < startDate)
    return res.status(400).json({ error: "End date must be on or after the start date." });
  req.trip.startDate = startDate;
  req.trip.endDate = endDate;
  await req.trip.save();
  res.json(await broadcast(req));
});

// Itinerary
r.post("/:id/items", member, async (req, res) => {
  const { day, time, title, cost, category } = req.body;
  const itineraryDay = Number(day);
  const durationMinutes = Number(req.body.durationMinutes ?? 60);
  const location = typeof req.body.location === "string" ? req.body.location.trim() : "";
  const notes = typeof req.body.notes === "string" ? req.body.notes.trim() : "";
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "Activity title is required." });
  if (!Number.isInteger(itineraryDay) || itineraryDay < 1 || itineraryDay > 365)
    return res.status(400).json({ error: "Choose an itinerary day from 1 to 365." });
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 720)
    return res.status(400).json({ error: "Activity duration must be from 15 minutes to 12 hours." });
  if (location.length > 200) return res.status(400).json({ error: "Location must be 200 characters or fewer." });
  if (typeof req.body.notes !== "undefined" && typeof req.body.notes !== "string")
    return res.status(400).json({ error: "Notes must be text." });
  if (notes.length > 1000) return res.status(400).json({ error: "Notes must be 1,000 characters or fewer." });
  req.trip.items.push({
    day: itineraryDay, time, durationMinutes, title: title.trim(), location, notes,
    cost: Number(cost) || 0, category, addedBy: req.user.id
  });
  await req.trip.save();
  res.status(201).json(await broadcast(req));
});

r.patch("/:id/items/:itemId/notes", member, async (req, res) => {
  if (typeof req.body.notes !== "string" || req.body.notes.trim().length > 1000)
    return res.status(400).json({ error: "Notes must be text with 1,000 characters or fewer." });
  const item = req.trip.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: "Activity not found." });
  item.notes = req.body.notes.trim();
  await req.trip.save();
  res.json(await broadcast(req));
});

r.patch("/:id/items/:itemId/location", member, async (req, res) => {
  if (typeof req.body.location !== "string" || req.body.location.trim().length > 200)
    return res.status(400).json({ error: "Enter a location of 200 characters or fewer." });
  const item = req.trip.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: "Activity not found." });
  item.location = req.body.location.trim();
  await req.trip.save();
  res.json(await broadcast(req));
});

r.delete("/:id/items/:itemId", member, async (req, res) => {
  req.trip.items.pull(req.params.itemId);
  await req.trip.save();
  res.json(await broadcast(req));
});

// Shared trip checklist
r.post("/:id/checklist", member, async (req, res) => {
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  const dueDate = parseTripDate(req.body.dueDate);
  const assignedTo = req.body.assignedTo || null;
  const memberIds = new Set(req.trip.members.map(m => String(m._id)));

  if (!title || title.length > 160)
    return res.status(400).json({ error: "Task title is required and must be 160 characters or fewer." });
  if (typeof req.body.description !== "undefined" && typeof req.body.description !== "string")
    return res.status(400).json({ error: "Task details must be text." });
  if (description.length > 500)
    return res.status(400).json({ error: "Task details must be 500 characters or fewer." });
  if (dueDate === undefined)
    return res.status(400).json({ error: "Enter a valid task due date." });
  if (assignedTo !== null && (typeof assignedTo !== "string" || !memberIds.has(assignedTo)))
    return res.status(400).json({ error: "The assignee must be a member of this trip." });

  req.trip.checklist.push({
    title, description, dueDate, assignedTo, completed: false, createdBy: req.user.id
  });
  await req.trip.save();
  res.status(201).json(await broadcast(req));
});

r.patch("/:id/checklist/:taskId", member, async (req, res) => {
  const task = req.trip.checklist.id(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Checklist task not found." });

  if (Object.prototype.hasOwnProperty.call(req.body, "completed")) {
    if (typeof req.body.completed !== "boolean")
      return res.status(400).json({ error: "Task completion must be true or false." });
    task.completed = req.body.completed;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "assignedTo")) {
    const assignedTo = req.body.assignedTo || null;
    const memberIds = new Set(req.trip.members.map(m => String(m._id)));
    if (assignedTo !== null && (typeof assignedTo !== "string" || !memberIds.has(assignedTo)))
      return res.status(400).json({ error: "The assignee must be a member of this trip." });
    task.assignedTo = assignedTo;
  }
  if (!Object.prototype.hasOwnProperty.call(req.body, "completed") &&
      !Object.prototype.hasOwnProperty.call(req.body, "assignedTo"))
    return res.status(400).json({ error: "No checklist task changes were provided." });

  await req.trip.save();
  res.json(await broadcast(req));
});

r.delete("/:id/checklist/:taskId", member, async (req, res) => {
  const task = req.trip.checklist.id(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Checklist task not found." });
  task.deleteOne();
  await req.trip.save();
  res.json(await broadcast(req));
});

// Shared packing list
r.post("/:id/packing", member, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const quantity = Number(req.body.quantity ?? 1);
  const assignedTo = req.body.assignedTo || null;
  const memberIds = new Set(req.trip.members.map(m => String(m._id)));

  if (!name || name.length > 120)
    return res.status(400).json({ error: "Item name is required and must be 120 characters or fewer." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99)
    return res.status(400).json({ error: "Quantity must be a whole number from 1 to 99." });
  if (assignedTo !== null && (typeof assignedTo !== "string" || !memberIds.has(assignedTo)))
    return res.status(400).json({ error: "The person bringing this item must be a member of this trip." });

  req.trip.packing.push({ name, quantity, assignedTo, packed: false, createdBy: req.user.id });
  await req.trip.save();
  res.status(201).json(await broadcast(req));
});

r.patch("/:id/packing/:itemId", member, async (req, res) => {
  const item = req.trip.packing.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: "Packing item not found." });

  if (Object.prototype.hasOwnProperty.call(req.body, "packed")) {
    if (typeof req.body.packed !== "boolean")
      return res.status(400).json({ error: "Packed status must be true or false." });
    item.packed = req.body.packed;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "assignedTo")) {
    const assignedTo = req.body.assignedTo || null;
    const memberIds = new Set(req.trip.members.map(m => String(m._id)));
    if (assignedTo !== null && (typeof assignedTo !== "string" || !memberIds.has(assignedTo)))
      return res.status(400).json({ error: "The person bringing this item must be a member of this trip." });
    item.assignedTo = assignedTo;
  }
  if (!Object.prototype.hasOwnProperty.call(req.body, "packed") &&
      !Object.prototype.hasOwnProperty.call(req.body, "assignedTo"))
    return res.status(400).json({ error: "No packing item changes were provided." });

  await req.trip.save();
  res.json(await broadcast(req));
});

r.delete("/:id/packing/:itemId", member, async (req, res) => {
  const item = req.trip.packing.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: "Packing item not found." });
  item.deleteOne();
  await req.trip.save();
  res.json(await broadcast(req));
});

// Group polls
r.post("/:id/polls", member, async (req, res) => {
  const question = typeof req.body.question === "string" ? req.body.question.trim() : "";
  const options = req.body.options;
  if (!question || question.length > 200)
    return res.status(400).json({ error: "Poll question is required and must be 200 characters or fewer." });
  if (!Array.isArray(options) || options.length < 2 || options.length > 5)
    return res.status(400).json({ error: "A poll must have between 2 and 5 options." });

  const normalizedOptions = options.map(option => typeof option === "string" ? option.trim() : "");
  if (normalizedOptions.some(option => !option || option.length > 120))
    return res.status(400).json({ error: "Each poll option is required and must be 120 characters or fewer." });
  if (new Set(normalizedOptions.map(option => option.toLocaleLowerCase())).size !== normalizedOptions.length)
    return res.status(400).json({ error: "Poll options must be unique." });

  req.trip.polls.push({
    question,
    closed: false,
    options: normalizedOptions.map(text => ({ text, votes: [] })),
    createdBy: req.user.id
  });
  await req.trip.save();
  res.status(201).json(await broadcast(req));
});

r.post("/:id/polls/:pollId/vote", member, async (req, res) => {
  const poll = req.trip.polls.id(req.params.pollId);
  if (!poll) return res.status(404).json({ error: "Poll not found." });
  if (poll.closed) return res.status(409).json({ error: "This poll is closed." });
  const option = poll.options.id(req.body.optionId);
  if (!option) return res.status(400).json({ error: "Choose an option in this poll." });

  poll.options.forEach(entry => {
    entry.votes = entry.votes.filter(userId => String(userId) !== req.user.id);
  });
  option.votes.push(req.user.id);
  await req.trip.save();
  res.json(await broadcast(req));
});

r.patch("/:id/polls/:pollId/status", member, async (req, res) => {
  if (typeof req.body.closed !== "boolean")
    return res.status(400).json({ error: "Poll status must be open or closed." });
  const poll = req.trip.polls.id(req.params.pollId);
  if (!poll) return res.status(404).json({ error: "Poll not found." });
  if (String(poll.createdBy) !== req.user.id)
    return res.status(403).json({ error: "Only the poll creator can change its status." });

  poll.closed = req.body.closed;
  await req.trip.save();
  res.json(await broadcast(req));
});

r.delete("/:id/polls/:pollId", member, async (req, res) => {
  const poll = req.trip.polls.id(req.params.pollId);
  if (!poll) return res.status(404).json({ error: "Poll not found." });
  if (String(poll.createdBy) !== req.user.id)
    return res.status(403).json({ error: "Only the poll creator can delete it." });

  poll.deleteOne();
  await req.trip.save();
  res.json(await broadcast(req));
});

// Shared booking details
r.post("/:id/bookings", member, async (req, res) => {
  const types = ["Flight", "Train", "Bus", "Hotel", "Car rental", "Other"];
  const type = req.body.type;
  const provider = typeof req.body.provider === "string" ? req.body.provider.trim() : "";
  const confirmationCode = typeof req.body.confirmationCode === "string" ? req.body.confirmationCode.trim() : "";
  const notes = typeof req.body.notes === "string" ? req.body.notes.trim() : "";
  const url = typeof req.body.url === "string" ? req.body.url.trim() : "";
  const date = parseTripDate(req.body.date);

  if (!types.includes(type))
    return res.status(400).json({ error: "Choose a valid booking type." });
  if (!provider || provider.length > 120)
    return res.status(400).json({ error: "Booking provider is required and must be 120 characters or fewer." });
  if (typeof req.body.confirmationCode !== "undefined" &&
      (typeof req.body.confirmationCode !== "string" || confirmationCode.length > 120))
    return res.status(400).json({ error: "Confirmation number must be 120 characters or fewer." });
  if (typeof req.body.notes !== "undefined" &&
      (typeof req.body.notes !== "string" || notes.length > 500))
    return res.status(400).json({ error: "Booking notes must be 500 characters or fewer." });
  if (date === undefined)
    return res.status(400).json({ error: "Enter a valid booking date." });
  if (url.length > 500)
    return res.status(400).json({ error: "Booking link must be 500 characters or fewer." });
  if (url) {
    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol))
        return res.status(400).json({ error: "Booking link must start with http or https." });
    } catch {
      return res.status(400).json({ error: "Enter a valid booking link." });
    }
  }

  req.trip.bookings.push({
    type, provider, confirmationCode, url, date, notes,
    status: "Pending", createdBy: req.user.id
  });
  await req.trip.save();
  res.status(201).json(await broadcast(req));
});

r.patch("/:id/bookings/:bookingId/status", member, async (req, res) => {
  if (!["Pending", "Confirmed", "Cancelled"].includes(req.body.status))
    return res.status(400).json({ error: "Choose Pending, Confirmed or Cancelled." });
  const booking = req.trip.bookings.id(req.params.bookingId);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  booking.status = req.body.status;
  await req.trip.save();
  res.json(await broadcast(req));
});

r.delete("/:id/bookings/:bookingId", member, async (req, res) => {
  const booking = req.trip.bookings.id(req.params.bookingId);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  booking.deleteOne();
  await req.trip.save();
  res.json(await broadcast(req));
});

function geocode(query) {
  const key = query.trim().toLocaleLowerCase();
  if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key));

  const request = geocodeQueue.then(async () => {
    if (geocodeCache.has(key)) return geocodeCache.get(key);
    const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeRequest));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastGeocodeRequest = Date.now();

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.search = new URLSearchParams({ format: "jsonv2", limit: "1", q: query }).toString();
    const response = await fetch(url, {
      headers: {
        "User-Agent": "WayfareTripPlanner/1.0",
        "Accept-Language": "en"
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`OpenStreetMap search returned HTTP ${response.status}.`);
    const results = await response.json();
    const match = results[0];
    const point = match ? { lat: Number(match.lat), lon: Number(match.lon), displayName: match.display_name } : null;
    if (point && (
      !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90 ||
      !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180
    )) return null;
    if (geocodeCache.size >= 500) geocodeCache.clear();
    geocodeCache.set(key, point);
    return point;
  });
  geocodeQueue = request.catch(() => {});
  return request;
}

r.post("/:id/map/route", member, async (req, res) => {
  const day = Number(req.body.day);
  if (!Number.isInteger(day) || day < 1)
    return res.status(400).json({ error: "Choose a valid itinerary day." });

  const items = req.trip.items
    .filter(item => Number(item.day) === day && item.location?.trim())
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  if (!items.length) return res.status(400).json({ error: "Add a location to at least one activity for this day." });
  if (items.length > 20) return res.status(400).json({ error: "A daily route can include up to 20 stops." });

  let stops;
  try {
    stops = [];
    for (const item of items) {
      const query = [item.location, req.trip.destination].filter(Boolean).join(", ");
      const position = await geocode(query);
      stops.push({
        itemId: String(item._id),
        title: item.title,
        time: item.time || "",
        location: item.location,
        ...(position || {})
      });
    }
  } catch (error) {
    console.error("OpenStreetMap geocoding failed:", error.message);
    return res.status(502).json({ error: "Location search is temporarily unavailable. Please try again later." });
  }

  const located = stops.filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
  if (located.length < 2) {
    return res.json({
      stops,
      route: null,
      routeError: located.length === 0
        ? "No locations could be found. Try adding a more specific place or address."
        : "Add a second location for this day to estimate driving time."
    });
  }

  try {
    const coordinates = located.map(stop => `${stop.lon},${stop.lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
    const response = await fetch(url, {
      headers: { "User-Agent": "WayfareTripPlanner/1.0" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}.`);
    const data = await response.json();
    const result = data.routes?.[0];
    if (data.code !== "Ok" || !result || !Array.isArray(result.geometry?.coordinates) || !result.geometry.coordinates.length)
      throw new Error("OSRM did not return a route.");
    if (!Number.isFinite(result.distance) || result.distance < 0 ||
        !Number.isFinite(result.duration) || result.duration < 0)
      throw new Error("OSRM returned invalid route metrics.");
    const coordinatesOnMap = result.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    if (coordinatesOnMap.some(([lat, lon]) =>
      !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180
    )) throw new Error("OSRM returned invalid route coordinates.");
    res.json({
      stops,
      route: {
        coordinates: coordinatesOnMap,
        distanceMeters: result.distance,
        durationSeconds: result.duration,
        legs: (result.legs || []).map((leg, index) => ({
          fromItemId: located[index]?.itemId,
          toItemId: located[index + 1]?.itemId,
          distanceMeters: leg.distance,
          durationSeconds: leg.duration
        })).filter(leg => leg.fromItemId && leg.toItemId &&
          Number.isFinite(leg.distanceMeters) && Number.isFinite(leg.durationSeconds))
      },
      routeError: ""
    });
  } catch (error) {
    console.error("OSRM route lookup failed:", error.message);
    res.json({
      stops,
      route: null,
      routeError: "Driving route is temporarily unavailable. The found stops are still shown on the map."
    });
  }
});

// Stays and group voting
r.post("/:id/stays", member, async (req, res) => {
  req.trip.stays.push(req.body);
  await req.trip.save();
  res.status(201).json(await broadcast(req));
});

r.post("/:id/stays/:stayId/vote", member, async (req, res) => {
  const value = Number(req.body.value);
  if (![1, -1, 0].includes(value)) return res.status(400).json({ error: "Vote must be 1, -1 or 0." });
  const stay = req.trip.stays.id(req.params.stayId);
  if (!stay) return res.status(404).json({ error: "Stay not found." });
  stay.votes = stay.votes.filter(v => String(v.user) !== req.user.id);
  if (value !== 0) stay.votes.push({ user: req.user.id, value });
  await req.trip.save();
  res.json(await broadcast(req));
});

// Budget and shared expenses
r.post("/:id/expenses", member, async (req, res) => {
  const { title, payerId, splitAmong } = req.body;
  const amount = Number(req.body.amount);
  if (typeof title !== "string" || !title.trim() || !Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: "A title and an amount above 0 are required." });

  const memberIds = new Set(req.trip.members.map(m => String(m._id)));
  const paidBy = payerId || req.user.id;
  if (typeof paidBy !== "string" || !memberIds.has(paidBy))
    return res.status(400).json({ error: "The payer must be a member of this trip." });

  let participants = req.trip.members.map(m => String(m._id));
  if (splitAmong !== undefined) {
    if (!Array.isArray(splitAmong) || splitAmong.length === 0 ||
        splitAmong.some(id => typeof id !== "string" || !memberIds.has(id)) ||
        new Set(splitAmong).size !== splitAmong.length)
      return res.status(400).json({ error: "Choose one or more trip members to split this expense." });
    participants = splitAmong;
  }

  req.trip.expenses.push({
    title: title.trim(), amount, paidBy, splitAmong: participants, settledBy: []
  });
  await req.trip.save();
  res.status(201).json(await broadcast(req));
});

r.patch("/:id/expenses/:expenseId/settle", member, async (req, res) => {
  if (typeof req.body.settled !== "boolean")
    return res.status(400).json({ error: "Settlement status must be true or false." });
  const expense = req.trip.expenses.id(req.params.expenseId);
  if (!expense) return res.status(404).json({ error: "Expense not found." });

  const payerId = String(expense.paidBy._id || expense.paidBy);
  const participantIds = expense.splitAmong.map(id => String(id._id || id));
  if (!participantIds.includes(req.user.id) || payerId === req.user.id)
    return res.status(403).json({ error: "You can only settle your own share of an expense." });

  const settledBy = new Set((expense.settledBy || []).map(id => String(id._id || id)));
  if (req.body.settled) settledBy.add(req.user.id);
  else settledBy.delete(req.user.id);
  expense.settledBy = [...settledBy];

  await req.trip.save();
  res.json(await broadcast(req));
});

// Net balance per member: positive = is owed money, negative = owes money
r.get("/:id/balances", member, (req, res) => {
  const net = {};
  req.trip.members.forEach(m => { net[m._id] = { name: m.name, net: 0 }; });
  req.trip.expenses.forEach(e => {
    const share = e.amount / e.splitAmong.length;
    const payer = String(e.paidBy._id || e.paidBy);
    if (net[payer]) net[payer].net += e.amount;
    e.splitAmong.forEach(id => { if (net[id]) net[id].net -= share; });
    (e.settledBy || []).forEach(id => {
      const settledMember = String(id._id || id);
      if (settledMember === payer) return;
      if (net[payer]) net[payer].net -= share;
      if (net[settledMember]) net[settledMember].net += share;
    });
  });
  res.json(Object.values(net).map(n => ({ ...n, net: Math.round(n.net) })));
});

// Chat history (live messages travel over Socket.io)
r.get("/:id/messages", member, async (req, res) =>
  res.json(await Message.find({ trip: req.trip._id }).sort("createdAt").limit(200)));

// AI Travel Concierge
r.post("/:id/concierge", member, async (req, res) =>
  res.json({ reply: await concierge.chat(req.trip, req.body.message || "") }));

r.get("/:id/recommendations", member, async (req, res) =>
  res.json(await concierge.recommend(req.trip)));

export default r;
