import mongoose from "mongoose";
const { Schema } = mongoose;

const schema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", default: null },
  eventType: { type: String, enum: ["page_view", "login"], default: "page_view" },
  page: { type: String, enum: ["home", "login", "trip", "analytics", "other"], required: true },
  createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 }
}, { versionKey: false });

schema.index({ user: 1, createdAt: -1 });

export default mongoose.model("PageView", schema);
