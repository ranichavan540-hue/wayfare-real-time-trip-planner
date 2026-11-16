import { io } from "socket.io-client";

export const getToken = () => localStorage.getItem("token");
export const setSession = (token, user) => { localStorage.setItem("token", token); localStorage.setItem("user", JSON.stringify(user)); };
export const clearSession = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  Object.keys(localStorage)
    .filter(key => key.startsWith("wayfare:trip-cache:") ||
      key.startsWith("wayfare:trips-cache:") ||
      key.startsWith("wayfare:notifications:") ||
      key.startsWith("wayfare:notification:"))
    .forEach(key => localStorage.removeItem(key));
};
export const currentUser = () => JSON.parse(localStorage.getItem("user") || "null");

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(getToken() && { Authorization: "Bearer " + getToken() }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export const connectSocket = () => io(window.location.origin, { auth: { token: getToken() } });
