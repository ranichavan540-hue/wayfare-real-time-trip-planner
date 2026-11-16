const MODEL = "claude-sonnet-4-6";

function summarize(trip) {
  const spent = trip.items.reduce((s, i) => s + (i.cost || 0), 0);
  return JSON.stringify({
    name: trip.name, destination: trip.destination, budget: trip.budget, plannedSpend: spent,
    travellers: trip.members.length,
    itinerary: trip.items.map(i => ({ day: i.day, time: i.time, title: i.title, cost: i.cost, category: i.category })),
    stays: trip.stays.map(s => ({ name: s.name, price: s.price, score: s.votes.reduce((a, v) => a + v.value, 0) }))
  });
}

async function callClaude(system, user, maxTokens = 600) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
  });
  if (!res.ok) throw new Error("AI request failed: " + res.status);
  const data = await res.json();
  return data.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

const SYSTEM = "You are Wayfare's Travel Concierge for a group trip. Use the trip JSON for facts. " +
  "Be concise (under 120 words), practical, mention costs in INR, and never invent bookings.";

export async function chat(trip, message) {
  if (!process.env.ANTHROPIC_API_KEY) return fallback(trip, message);
  try { return await callClaude(SYSTEM, `Trip: ${summarize(trip)}\n\nQuestion: ${message}`); }
  catch { return fallback(trip, message); }
}

export async function recommend(trip) {
  const prompt = `Trip: ${summarize(trip)}\nSuggest 4 activities or restaurants that fit the remaining budget. ` +
    `Reply with ONLY a JSON array of {"title","category","cost","why"} where category is Food, Activity or Transport.`;
  if (!process.env.ANTHROPIC_API_KEY) return defaults();
  try {
    const text = await callClaude(SYSTEM, prompt, 700);
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return defaults(); }
}

const defaults = () => [
  { title: "Sunrise at the local fort", category: "Activity", cost: 0, why: "Free and good for a quiet start." },
  { title: "Group kayak session", category: "Activity", cost: 2800, why: "Groups usually get a combo rate." },
  { title: "Seafood dinner for the group", category: "Food", cost: 5000, why: "Easy to book for large tables." },
  { title: "Evening market walk", category: "Activity", cost: 1200, why: "Low cost, fits an evening slot." }
];

function fallback(trip, q) {
  const l = q.toLowerCase();
  const spent = trip.items.reduce((s, i) => s + (i.cost || 0), 0);
  if (/budget|spend|left/.test(l)) {
    const left = trip.budget - spent;
    return `Planned spend is ₹${spent} of ₹${trip.budget}. ` + (left >= 0 ? `₹${left} remains.` : `You are ₹${-left} over.`);
  }
  if (/split|owe|each/.test(l)) return `Equal split is about ₹${Math.round(spent / Math.max(trip.members.length, 1))} per person.`;
  return "I can check the budget, split costs, or suggest places. Add ANTHROPIC_API_KEY on the server for full AI answers.";
}
