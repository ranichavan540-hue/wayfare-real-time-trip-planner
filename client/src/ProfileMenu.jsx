import React, { useEffect, useRef, useState } from "react";

export default function ProfileMenu({ user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const name = user?.name || "Traveler";
  const initial = name.trim().charAt(0).toUpperCase() || "T";

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = event => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = event => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={menuRef}>
      <button
        className="profile-trigger"
        type="button"
        aria-label="Open profile"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(value => !value)}
      >
        {initial}
      </button>
      {open && (
        <section className="profile-popover" role="dialog" aria-label="Profile information">
          <div className="profile-heading">
            <div className="profile-avatar" aria-hidden="true">{initial}</div>
            <div className="profile-identity">
              <h3>{name}</h3>
              <span>Wayfare traveler</span>
            </div>
            <button className="x" type="button" onClick={() => setOpen(false)} aria-label="Close profile">×</button>
          </div>
          <div className="profile-details">
            <span className="profile-label">Name</span>
            <strong>{name}</strong>
            <span className="profile-label">Email</span>
            <strong className="profile-email">{user?.email || "No email available"}</strong>
          </div>
          {onSignOut && (
            <button className="btn ghost profile-signout" type="button" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </section>
      )}
    </div>
  );
}
