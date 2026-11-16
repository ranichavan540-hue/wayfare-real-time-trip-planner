import { Router } from "express";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import PageView from "../models/PageView.js";
import { sign, auth } from "../middleware/auth.js";

const r = Router();

r.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: "Name, email and a 6+ character password are required." });
  if (await User.findOne({ email })) return res.status(409).json({ error: "This email is already registered." });
  const user = await User.create({ name, email, password: await bcrypt.hash(password, 10) });
  res.status(201).json({ token: sign(user), user: { id: user._id, name, email } });
});

r.post("/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email }).select("+password");
  if (!user || !(await bcrypt.compare(req.body.password || "", user.password)))
    return res.status(401).json({ error: "Email or password is incorrect." });
  if (process.env.ANALYTICS_ADMIN_EMAIL?.trim()) {
    await PageView.create({ user: user._id, eventType: "login", page: "login" });
  }
  res.json({ token: sign(user), user: { id: user._id, name: user.name, email: user.email } });
});

r.get("/me", auth, async (req, res) => res.json(await User.findById(req.user.id)));
export default r;
