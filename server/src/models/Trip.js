import mongoose from "mongoose";
const { Schema } = mongoose;
const ref = { type: Schema.Types.ObjectId, ref: "User" };

const schema = new Schema({
  name: { type: String, required: true },
  destination: String,
  startDate: Date,
  endDate: Date,
  budget: { type: Number, default: 0 },
  owner: ref,
  members: [ref],
  inviteCode: { type: String, unique: true },
  items: [{
    day: Number, time: String, durationMinutes: { type: Number, default: 60 },
    title: String, location: { type: String, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 1000, default: "" }, cost: { type: Number, default: 0 },
    category: { type: String, enum: ["Stay", "Food", "Activity", "Transport"], default: "Activity" },
    addedBy: ref
  }],
  checklist: [{
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    assignedTo: ref,
    dueDate: Date,
    completed: { type: Boolean, default: false },
    createdBy: ref,
    createdAt: { type: Date, default: Date.now }
  }],
  packing: [{
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: Number, default: 1, min: 1, max: 99 },
    assignedTo: ref,
    packed: { type: Boolean, default: false },
    createdBy: ref,
    createdAt: { type: Date, default: Date.now }
  }],
  polls: [{
    question: { type: String, required: true, trim: true, maxlength: 200 },
    closed: { type: Boolean, default: false },
    options: [{
      text: { type: String, required: true, trim: true, maxlength: 120 },
      votes: [ref]
    }],
    createdBy: ref,
    createdAt: { type: Date, default: Date.now }
  }],
  bookings: [{
    type: { type: String, enum: ["Flight", "Train", "Bus", "Hotel", "Car rental", "Other"], required: true },
    provider: { type: String, required: true, trim: true, maxlength: 120 },
    confirmationCode: { type: String, trim: true, maxlength: 120, default: "" },
    url: { type: String, trim: true, maxlength: 500, default: "" },
    date: Date,
    status: { type: String, enum: ["Pending", "Confirmed", "Cancelled"], default: "Pending" },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    createdBy: ref,
    createdAt: { type: Date, default: Date.now }
  }],
  stays: [{
    name: String, description: String, price: Number, url: String,
    votes: [{ user: ref, value: { type: Number, enum: [1, -1] } }]
  }],
  expenses: [{
    title: String, amount: Number, paidBy: ref, splitAmong: [ref], settledBy: [ref],
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

export default mongoose.model("Trip", schema);
