import jwt from "jsonwebtoken";

export const sign = (user) =>
  jwt.sign({ id: user._id, name: user.name }, process.env.JWT_SECRET, { expiresIn: "7d" });

export const verify = (token) => jwt.verify(token, process.env.JWT_SECRET);

export function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try { req.user = verify(token); next(); }
  catch { res.status(401).json({ error: "Please sign in again." }); }
}
