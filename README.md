# Wayfare – Real-Time AI Trip Planning & Collaboration Platform

## About the Project
Wayfare is an AI-powered travel planning platform that helps users plan and manage trips easily. It allows users to create trips, manage travel budgets, share itineraries, and collaborate with friends in real time.

## Features
- User Registration and Login
- Create and Manage Trips
- Shared Travel Itineraries
- Budget Tracking
- Group Voting
- Real-Time Group Chat
- Travel Recommendations
- AI Travel Concierge
- Real-Time Collaboration

## Technologies Used

**Frontend:**
- React.js
- Vite
- HTML
- CSS
- JavaScript

**Backend:**
- Node.js
- Express.js
- MongoDB
- Mongoose
- Socket.io
- JWT Authentication

## Project Structure

```text
wayfare/
│
├── client/          # Frontend
├── server/          # Backend
├── .gitignore
└── README.md
```

## Installation and Setup

### 1. Clone the Repository

```bash
git clone https://github.com/ranichavan540-hue/wayfare-real-time-trip-planner.git
```

### 2. Open the Project

```bash
cd wayfare-real-time-trip-planner
```

### 3. Setup Backend

```bash
cd server
npm install
```

Create a `.env` file inside the server folder:

```env
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secret_key
CLIENT_URL=http://localhost:5173
```

Start the backend:

```bash
npm start
```

### 4. Setup Frontend

Open another terminal:

```bash
cd client
npm install
```

Create a `.env` file inside the client folder:

```env
VITE_API_URL=http://localhost:YOUR_BACKEND_PORT
```

Start the frontend:

```bash
npm run dev
```

## Live Demo Link

https://wayfare-real-time-trip-planner.onrender.com?utm_source=chatgpt.com

## Repository

GitHub: https://github.com/ranichavan540-hue/wayfare-real-time-trip-planner

## Conclusion

Wayfare makes trip planning easier through AI-powered recommendations and real-time collaboration. It provides a simple platform for users to plan, organize, and enjoy trips together.

---

**Developed as a Full Stack Web Development Project.**, This Project Developed By Rani Chavan.
