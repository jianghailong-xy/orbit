import { NavLink } from 'react-router-dom';

/**
 * The admin area's sections, side by side at the top of each (docs/google-sign-in-design.md §8.1):
 * user management, and the Sign-in settings. The area is an administrator's alone — the account
 * menu offers Admin to administrators only, and every request behind it is refused anyone else.
 */
export function AdminNav() {
  return (
    <nav className="admin-nav" aria-label="Admin">
      <NavLink to="/admin" end className="admin-nav-link">
        Users
      </NavLink>
      <NavLink to="/admin/sign-in" className="admin-nav-link">
        Sign-in
      </NavLink>
    </nav>
  );
}
