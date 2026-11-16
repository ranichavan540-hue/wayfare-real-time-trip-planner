import { Router } from "express";
import PageView from "../models/PageView.js";
import User from "../models/User.js";
import { auth, verify } from "../middleware/auth.js";

const r = Router();
const pages = new Set(["home", "login", "trip", "analytics", "other"]);
const retentionDays = 30;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function adminEmail() {
  return process.env.ANALYTICS_ADMIN_EMAIL?.trim().toLowerCase() || "";
}

const requireAnalyticsAdmin = asyncRoute(async (req, res, next) => {
  if (!adminEmail())
    return res.status(503).json({ error: "Analytics are not configured on this deployment." });

  const user = await User.findById(req.user.id).select("name email").lean();
  if (!user || user.email.toLowerCase() !== adminEmail())
    return res.status(403).json({ error: "You are not allowed to view analytics." });

  req.analyticsAdmin = user;
  next();
});

r.post("/page-view", asyncRoute(async (req, res) => {
  const { page } = req.body;
  if (typeof page !== "string" || !pages.has(page))
    return res.status(400).json({ error: "Choose a valid page category." });
  if (!adminEmail())
    return res.status(202).json({ recorded: false });

  let userId = null;
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token) {
    try {
      userId = verify(token).id;
    } catch {
      return res.status(401).json({ error: "Please sign in again." });
    }
  }

  await PageView.create({ user: userId, page });
  res.status(202).json({ recorded: true });
}));

r.get("/access", auth, asyncRoute(async (req, res) => {
  const configuredEmail = adminEmail();
  if (!configuredEmail) return res.json({ isAdmin: false });
  const user = await User.findById(req.user.id).select("email").lean();
  res.json({ isAdmin: Boolean(user && user.email.toLowerCase() === configuredEmail) });
}));

r.get("/summary", auth, requireAnalyticsAdmin, asyncRoute(async (req, res) => {
  const since = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const filter = { createdAt: { $gte: since } };
  const viewFilter = { ...filter, eventType: "page_view" };
  const loginFilter = { ...filter, eventType: "login" };
  const [totalViews, anonymousViews, signedInViews, uniqueUsers, successfulLogins, pageTotals, recentViews, recentLogins] = await Promise.all([
    PageView.countDocuments(viewFilter),
    PageView.countDocuments({ ...viewFilter, user: null }),
    PageView.countDocuments({ ...viewFilter, user: { $ne: null } }),
    PageView.distinct("user", { ...viewFilter, user: { $ne: null } }),
    PageView.countDocuments(loginFilter),
    PageView.aggregate([
      { $match: viewFilter },
      { $group: { _id: "$page", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    PageView.find(viewFilter)
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    PageView.find(loginFilter)
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
  ]);

  res.json({
    since,
    retentionDays,
    totalViews,
    anonymousViews,
    signedInViews,
    uniqueSignedInUsers: uniqueUsers.length,
    successfulLogins,
    pageTotals: pageTotals.map(entry => ({ page: entry._id, count: entry.count })),
    recentViews: recentViews.map(view => ({
      id: String(view._id),
      page: view.page,
      createdAt: view.createdAt,
      user: view.user ? { name: view.user.name, email: view.user.email } : null
    })),
    recentLogins: recentLogins.map(login => ({
      id: String(login._id),
      createdAt: login.createdAt,
      user: login.user ? { name: login.user.name, email: login.user.email } : null
    }))
  });
}));

export default r;
