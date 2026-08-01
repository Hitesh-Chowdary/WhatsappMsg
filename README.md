# WhatsApp Admission Outreach Portal - Deployment Guide

This portal is a self-hosted, multi-user WhatsApp campaign, live-chat, and AI brochure system designed for college admission counseling teams. It connects directly to the WhatsApp Business Cloud API (Meta) and a PostgreSQL database.

---

## 🚀 Quick Start Setup

1. **Configure Environment Variables:**
   Copy `.env.example` to `.env` and fill in the required credentials:
   ```env
   # PostgreSQL Connection (Use actual database credentials)
   DATABASE_URL=postgresql+asyncpg://username:password@host_ip_or_domain:5432/db_name

   # WhatsApp Configuration
   WHATSAPP_CLIENT_TYPE=meta
   META_ACCESS_TOKEN=your_meta_access_token
   META_PHONE_NUMBER_ID=your_phone_number_id
   META_BUSINESS_ACCOUNT_ID=your_business_account_id
   WHATSAPP_WEBHOOK_VERIFY_TOKEN=your_custom_verify_token

   # Webhook Signature Validation (Required for Webhook security checks)
   META_APP_SECRET=your_meta_app_secret

   # Security settings (Generate a secure 32-character hex key)
   JWT_SECRET=your_secure_random_jwt_secret

   # CORS Allowed Origins
   ALLOWED_ORIGINS=https://whatsapp.rvrnriuniversity.edu.in

   # Public Domain mapping (Used to build media template links)
   PUBLIC_APP_URL=https://whatsapp.rvrnriuniversity.edu.in
   ```

2. **Launch the Application:**
   Double-click the **`start.bat`** script on Windows, or run in your terminal:
   ```bash
   uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
   ```

---

## 🌐 College IT Domain & Port-Forwarding Request (Copy-Paste for IT Team)

To map a college subdomain (e.g. `whatsapp.rvrnriuniversity.edu.in`) to your local college server (e.g. `192.168.1.12:8000`), copy and send this message to your college IT / Network team:

> **Hi IT Team,**
> 
> 1. Please map our college subdomain (e.g. `whatsapp.rvrnriuniversity.edu.in`) with HTTPS (SSL) to our local server IP **`192.168.1.12:8000`**.
> 2. Forward inbound HTTPS port 443 traffic to **`192.168.1.12:8000`** on the firewall router.
> 3. This is required so Meta WhatsApp Cloud API can send live webhooks to `https://whatsapp.rvrnriuniversity.edu.in/api/v1/webhook`.

---

## 👥 Multi-User Staff & Counselor Management

* **Super Admin & Counselor Accounts:**
  The platform supports 1 Main Super Admin + Multiple Admission Counselors operating simultaneously from their own laptops/phones.
* **Email & Username Login:**
  Staff log in with their work email (e.g. `anitha@rvrnri.edu.in`) or username.
* **Default Super Admin Credentials (On Initial Setup):**
  * **Email / Username:** `admin@institution.edu.in` / `admin`
  * **Password:** `admin123`
  * **Role:** `Super Admin`
* **Onboarding Staff Members:**
  Super Admins can add counselors, toggle account active/disabled status, or delete accounts directly from the **`👥 Team & Staff`** dashboard in the sidebar.

---

## 🔒 Production Webhook & Security Configuration (Meta Dashboard)

1. **Meta Webhook Setup:**
   In your **Facebook Developer Console** -> **WhatsApp** -> **Configuration**, set the Callback URL:
   ```text
   https://whatsapp.rvrnriuniversity.edu.in/api/v1/webhook
   ```
2. **Verify Token & Subscriptions:**
   Input the verify token configured in your `.env` file (`WHATSAPP_WEBHOOK_VERIFY_TOKEN`), and subscribe to the `messages` and `message_template_status_update` fields.
3. **Database Security:**
   Ensure your PostgreSQL port (`5432`) is bound locally or restricted behind a firewall so it is not accessible publicly over the internet.
