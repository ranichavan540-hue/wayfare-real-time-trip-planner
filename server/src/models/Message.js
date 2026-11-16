import mongoose from "mongoose";
const { Schema } = mongoose;
export default mongoose.model("Message", new Schema({
  trip: { type: Schema.Types.ObjectId, ref: "Trip", index: true },
  user: { type: Schema.Types.ObjectId, ref: "User" },
  userName: String,
  text: { type: String, required: true, maxlength: 2000 }
}, { timestamps: true }));
