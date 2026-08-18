# User Impersonation ("Switch User") in TalentCIO

This document outlines the architecture, security policies, APIs, and verification instructions for the two-tier user impersonation feature in TalentCIO.

---

## 1. Overview

Impersonation allows authorized administrators to temporarily assume the identity of another user in order to troubleshoot permissions, assist with operational workflows, and verify employee self-service experiences.

TalentCIO implements two distinct impersonation tiers:

1. **Tier A (Company Admin → Employee / Peer Admin)**:
   - **Scope**: Same-tenant only (`req.user.companyId === target.companyId`).
   - **Permission required**: `user.impersonate` (or wildcard `*` / Admin role).
   - **Constraint**: Admin actors (`Admin`, `Super Admin`, `System Admin`, `*`) can impersonate all active employees and peer Admins within the workspace. Non-admin actors holding delegated `user.impersonate` permissions cannot impersonate privileged/Admin accounts (preventing privilege escalation). Cannot impersonate self, protected primary admins, or inactive/deleted accounts.
   - **Lifecycle**: 30-minute maximum session duration with 1-click return to admin identity.

2. **Tier B (Platform Super Admin → Tenant User)**:
   - **Scope**: Any tenant user globally across the entire platform (including tenant Admins for customer support).
   - **Permission required**: `impersonateUsers` permission on `SuperAdminUser` (or `Super Admin` role).
   - **Constraint**: Mandatory reason/ticket reference required before starting; cannot impersonate inactive or deleted accounts.
   - **Lifecycle**: 30-minute maximum session duration, sets tenant session cookie (`talentcio_session`) while keeping superadmin session (`talentcio_superadmin_session`) active.

---

## 2. Security & Architecture Constraints

- **Hard 30-Minute Expiry**: Tokens are issued with a 30-minute expiration (`30m`), and their state is tracked in the `ImpersonationSession` collection. When expired mid-request, backend returns `401 { code: 'IMPERSONATION_EXPIRED' }`.
- **Database Killswitch & Token JTI**: Every impersonated token embeds a unique UUID (`imp.jti`). On every authenticated request, `authMiddleware.js` verifies that the `ImpersonationSession` matching `imp.jti` is active, not revoked, and not expired.
- **Anti-Chaining**: Impersonated sessions cannot initiate further impersonation requests (`403 Impersonation chaining is not permitted`).
- **Cache Isolation**: Impersonated requests completely bypass the in-memory `authUserCache` in `authMiddleware.js` to ensure direct logins and impersonated sessions never cross-contaminate.
- **Action Blocking**: Sensitive routes are guarded with `blockDuringImpersonation` middleware (`403 Forbidden` / `BLOCKED_DURING_IMPERSONATION`):
  - Password mutation: `PUT /api/auth/change-password`
  - User mutations: `POST /api/admin/users`, `PUT /api/admin/users/:id`, `PUT /api/admin/users/:id/role`, `PATCH /api/admin/users/:id/status`, `DELETE /api/admin/users/:id`
  - Role mutations: `POST /api/admin/roles`, `PUT /api/admin/roles/:id`
  - System migrations: `POST /api/admin/migrate-timesheets`
- **Audit Logging**: Every impersonation start and end event is recorded in the `AuditLog` collection with actor ID/email, target ID/email, reason, tier, timestamp, and IP address.

---

## 3. Backend Endpoints

### Tenant Impersonation Routes (`/api/users`)
- `POST /api/users/:id/impersonate`:
  - **Auth**: `protect`, `authorizeAny(['user.impersonate'])`, `blockDuringImpersonation`
  - **Body**: `{ reason?: string }`
  - **Returns**: Target user payload + JWT token with `imp` claim.
- `POST /api/users/impersonate/end`:
  - **Auth**: `protect`
  - **Returns**: Restores admin token cookie and admin user profile payload (or clears tenant session for Super Admin).
- `GET /api/users/impersonate/status`:
  - **Auth**: `protect`
  - **Returns**: `{ active: boolean, tier?: string, expiresAt?: string, actorName?: string, actorEmail?: string }`.

### Platform Super Admin Routes (`/api/superadmin/users`)
- `POST /api/superadmin/users/:id/impersonate`:
  - **Auth**: `protectSuperAdmin`, `requirePermission('impersonateUsers')`
  - **Body**: `{ reason: string }` (Required)
  - **Returns**: Target user payload + JWT token with `imp` claim.

---

## 4. Frontend Experience

### TalentCIO_Frontend
- **ImpersonationBanner**: Fixed warning banner displayed at top of app showing active target user, actor, and live countdown timer. Includes a "Return to Admin" button.
- **UsersTable & EmployeeProfile**: Includes "Switch" / "Switch User" buttons for eligible accounts.
- **ImpersonateConfirmModal**: Displays target user details, explanation of the 30-minute session, and an optional reason input before switching.
- **Scoped Cache Purge**: Automatically cleans user-scoped session caches upon session switch and restore.

### TalentCIO_SuperAdmin
- **Users Table**: Displays "Impersonate" action button for active tenant users.
- **ImpersonateModal**: Prompts for support ticket / reason reference and redirects to the tenant application.

---

## 5. Database Migration / Backfill

To seed the `user.impersonate` permission and assign it to existing Admin roles and Super Admin accounts, run:

```bash
cd TalentCIO_backend
node scripts/backfill-impersonation-permission.js
```
