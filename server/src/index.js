import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { Server } from "socket.io";
import authRoutes from "./routes/auth.js";
import analyticsRoutes from "./routes/analytics.js";
import tripRoutes from "./routes/trips.js";
import Trip from "./models/Trip.js";
import Message from "./models/Message.js";
import { verify } from "./middleware/auth.js";

const app = express();
const server = http.createServer(app);
const origin = process.env.CLIENT_URL || "http://localhost:5173";
const io = new Server(server, { cors: { origin } });
app.set("io", io);

app.use(cors({ origin }));
app.use(express.json());
app.get("/api/health", (_, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/trips", tripRoutes);
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Something went wrong. Try again." }); });

// Real-time layer: presence, typing and chat per trip room
io.use((socket, next) => {
  try { socket.user = verify(socket.handshake.auth.token); next(); }
  catch { next(new Error("unauthorized")); }
});

const online = new Map(); // tripId -> Map(userId -> name)

io.on("connection", (socket) => {
  socket.on("trip:join", async (tripId, acknowledge = () => {}) => {
    try {
      if (typeof tripId !== "string" || !mongoose.isValidObjectId(tripId)) {
        acknowledge({ ok: false, error: "Invalid trip." });
        return;
      }
      const trip = await Trip.findOne({ _id: tripId, members: socket.user.id }).select("_id");
      if (!trip) {
        acknowledge({ ok: false, error: "You are not a member of this trip." });
        return;
      }
      socket.join(tripId);
      socket.tripId = tripId;
      if (!online.has(tripId)) online.set(tripId, new Map());
      online.get(tripId).set(socket.user.id, socket.user.name);
      io.to(tripId).emit("presence", [...online.get(tripId)].map(([id, name]) => ({ id, name })));
      acknowledge({ ok: true });
    } catch (error) {
      console.error("Could not join trip chat:", error);
      acknowledge({ ok: false, error: "Could not join trip chat. Please try again." });
    }
  });

  socket.on("chat:send", async (text, acknowledge = () => {}) => {
    const message = typeof text === "string" ? text.trim() : "";
    if (!socket.tripId) {
      acknowledge({ ok: false, error: "Join a trip before sending a message." });
      return;
    }
    if (!message || message.length > 2000) {
      acknowledge({ ok: false, error: "Messages must be between 1 and 2000 characters." });
      return;
    }
    try {
      const saved = await Message.create({
        trip: socket.tripId,
        user: socket.user.id,
        userName: socket.user.name,
        text: message
      });
      io.to(socket.tripId).emit("chat:message", saved);
      acknowledge({ ok: true });
    } catch (error) {
      console.error("Could not save chat message:", error);
      acknowledge({ ok: false, error: "Message could not be saved. Please try again." });
    }
  });

  socket.on("chat:typing", () => {
    if (socket.tripId) socket.to(socket.tripId).emit("chat:typing", socket.user.name);
  });

  socket.on("disconnect", () => {
    const room = online.get(socket.tripId);
    if (!room) return;
    room.delete(socket.user.id);
    io.to(socket.tripId).emit("presence", [...room].map(([id, name]) => ({ id, name })));
  });
});

mongoose.connect(process.env.MONGO_URI).then(() => {
  const port = process.env.PORT || 5000;
  server.listen(port, () => console.log(`Wayfare API on :${port}`));
}).catch((e) => { console.error("MongoDB connection failed:", e.message); process.exit(1); });
