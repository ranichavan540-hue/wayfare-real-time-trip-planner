# Wayfare – Real-Time AI Trip Planning & Collaboration Platform (MERN)

Shared itineraries with editable activity notes and trip weather forecasts, Airbnb stay voting, budget and expense splitting, live group chat with presence,
recommendations and an AI Travel Concierge (Claude API).

Itinerary stops can include a place or address. The **Map & travel** tab uses OpenStreetMap
Nominatim to find those places and the public OSRM demo service for approximate driving routes.
These public services require an internet connection and may be rate-limited; travel times are
not live traffic estimates.
Add optional notes to each itinerary activity; notes can be edited later and are included in calendar exports.
The **Weather** tab shows daily forecasts for the trip destination and dates using Open-Meteo. Forecast data is limited to 16 days ahead and requires an internet connection.

## Stack
- **Client:** React 18, Vite, React Router, Socket.io client
- **Server:** Node 18+, Express, MongoDB (Mongoose), Socket.io, JWT auth
- **AI:** Anthropic Messages API (optional; rule-based fallback if no key)

## Run locally
1. Start MongoDB (local or Atlas).
2. Server:
   ```
   cd server && cp .env.example .env   # set JWT_SECRET, MONGO_URI, optional ANTHROPIC_API_KEY
   npm install && npm run dev
   ```
3. Client (new terminal):
   ```
   cd client && npm install && npm run dev
   ```
4. Open http://localhost:5173, register two users in two browsers, create a trip,
   share the invite code and watch itinerary, votes and chat sync live.

## Map and travel time
Add a place or address when creating an itinerary activity, or add it later in the **Map & travel**
tab. Save at least two stops for a day and choose **Show map & travel time** to see the locations
and estimated driving route. Location lookups are limited to one request per second and only include
the stop location and trip destination. The public Nominatim and OSRM demo services can be
rate-limited or unavailable; estimated driving times do not account for live traffic.

## API
| Method | Route | Purpose |
|---|---|---|
| POST | /api/auth/register, /login | Sign up, sign in (JWT) |
| GET/POST | /api/trips | List / create trips |
| POST | /api/trips/join | Join by invite code |
| GET | /api/trips/:id | Trip details |
| GET | /api/trips/:id/weather | Destination weather forecast for the trip dates |
| POST/DELETE | /api/trips/:id/items(/:itemId) | Itinerary items |
| PATCH | /api/trips/:id/items/:itemId/notes | Update activity notes (up to 1,000 characters) |
| PATCH | /api/trips/:id/items/:itemId/location | Set an itinerary stop location |
| POST | /api/trips/:id/map/route | Geocode and calculate a day's driving route |
| POST | /api/trips/:id/stays, /stays/:stayId/vote | Stay options and votes |
| POST | /api/trips/:id/expenses | Shared expenses |
| GET | /api/trips/:id/balances | Who owes what |
| GET | /api/trips/:id/messages | Chat history |
| POST | /api/trips/:id/concierge | AI concierge answer |
| GET | /api/trips/:id/recommendations | AI recommendations |

## Socket events
`trip:join`, `trip:updated`, `presence`, `chat:send`, `chat:message`, `chat:typing`

## Ideas to extend
Calendar export, image uploads for stays, push notifications, Docker Compose, deploy (Render + Vercel + Atlas).
