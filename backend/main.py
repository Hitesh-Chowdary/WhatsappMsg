import io
import os
import sys
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, Query, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from pydantic import BaseModel, Field, EmailStr
import pandas as pd
from sqlalchemy import select, func, or_, and_, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

# Setup path logic to ensure clean imports when running from root or backend folder
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)

if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

from database import init_db, get_db, Record, AsyncSessionLocal, CampaignTemplate, AdminUser, CampaignLog, ChatMessage, AutoReplyRule, RecordNote, BotFlow, BrochureDocument, WebsiteKnowledge
from whatsapp_service import get_whatsapp_client, WhatsAppClient

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("admission_engine")

# Create required UI folders if they do not exist
os.makedirs(os.path.join(PROJECT_ROOT, "frontend", "templates"), exist_ok=True)
os.makedirs(os.path.join(PROJECT_ROOT, "frontend", "static", "css"), exist_ok=True)
os.makedirs(os.path.join(PROJECT_ROOT, "frontend", "static", "js"), exist_ok=True)

# Payload models
class WebhookPayload(BaseModel):
    event: str = Field(..., description="'status_update', 'quick_reply', or 'incoming_text'")
    message_id: str = Field(..., description="Unique message tracking identifier from provider")
    status: Optional[str] = Field(None, description="'sent', 'delivered', 'read', or 'failed'")
    button_text: Optional[str] = Field(None, description="'Interested' or 'Not Interested'")
    text_body: Optional[str] = Field(None, description="Raw text message body for incoming replies")
    from_phone: Optional[str] = Field(None, description="Sender's phone number")


class TemplatePayload(BaseModel):
    template_name: str = Field(..., description="Name of the template")
    template_text: str = Field(..., max_length=1000, description="Custom WhatsApp campaign template text.")
    media_type: Optional[str] = Field("none", description="'none', 'image', or 'document'")
    media_url: Optional[str] = Field(None, max_length=1000, description="URL of attached media")
    language: Optional[str] = Field("en", description="Language code (e.g. 'en', 'en_US')")
    variable_names: Optional[str] = Field("", description="Comma-separated variable names")

class SetActiveTemplatePayload(BaseModel):
    template_name: str = Field(..., description="Name of the template to set active")

class AddTemplatePayload(BaseModel):
    template_name: str = Field(..., description="Name of the template to fetch from Meta and add to the database")

class BroadcastCampaignPayload(BaseModel):
    recipient_type: str = "parent"

class CrawlWebsitePayload(BaseModel):
    url: str = Field(..., description="Target website URL (e.g. https://rvrnriuniversity.edu.in/)")
    max_pages: Optional[int] = Field(25, ge=1, le=100, description="Maximum number of pages to crawl")

class BulkSendPayload(BaseModel):
    record_ids: List[int]
    template_name: Optional[str] = None
    recipient_type: str = "parent"

class SendMessagePayload(BaseModel):
    record_id: int
    message_text: str
    recipient_type: str = "parent"

class SendTemplatePayload(BaseModel):
    record_id: int
    template_name: str
    recipient_type: str = "parent"

class UpdateTagPayload(BaseModel):
    pipeline_tag: str

class UpdateCounselorStatusPayload(BaseModel):
    counselor_status: str

class AddNotePayload(BaseModel):
    note_text: str

class AutoReplyRulePayload(BaseModel):
    keyword: str
    reply_text: str
    is_active: Optional[bool] = True

class BotFlowPayload(BaseModel):
    id: Optional[int] = None
    name: str
    flow_data: dict
    is_active: Optional[bool] = True
    template_name: Optional[str] = None

class ContactCreatePayload(BaseModel):
    student_name: str
    parent_name: str
    phone_number: str
    parent_phone_number: Optional[str] = None
    selected_branch: str
    pipeline_tag: Optional[str] = "Lead"

class ContactUpdatePayload(BaseModel):
    student_name: Optional[str] = None
    parent_name: Optional[str] = None
    phone_number: Optional[str] = None
    parent_phone_number: Optional[str] = None
    selected_branch: Optional[str] = None
    pipeline_tag: Optional[str] = None

# Background task for bulk message broadcasting
async def run_broadcast_campaign(db_session_factory, whatsapp_client: WhatsAppClient, base_url: Optional[str] = None, recipient_type: str = "parent"):
    logger.info("Starting background campaign broadcast...")
    async with db_session_factory() as db:
        # Fetch the active template text
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()
        
        # Fallback to first if none active
        if not template_obj:
            tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalars().first()
            
        template_name = template_obj.template_name if template_obj else "admission_outreach"
        template_text = template_obj.template_text if template_obj else (
            "Dear [Parent Name], greetings from Student Outreach. Your child [Student Name] "
            "has been selected for the [Selected Branch] branch. To block the seat, please pay the "
            "₹50,000 advance fee. Click below to confirm interest: [Interested] / [Not Interested]"
        )
        media_type = template_obj.media_type if template_obj else "none"
        media_url = template_obj.media_url if template_obj else None
        if media_url and media_url.startswith("/") and base_url:
            media_url = f"{base_url.rstrip('/')}{media_url}"
        template_language = template_obj.language if template_obj else "en_US"
        variable_names = template_obj.variable_names if template_obj else ""

        # Fetch all eligible records (no sent CampaignLog for this template)
        stmt = select(Record).outerjoin(
            CampaignLog,
            and_(
                CampaignLog.record_id == Record.id,
                CampaignLog.template_name == template_name
            )
        ).where(
            or_(
                CampaignLog.id == None,
                CampaignLog.campaign_status.in_(["Pending", "Failed"])
            )
        )
        result = await db.execute(stmt)
        pending_records = result.scalars().all()
        
        logger.info(f"Found {len(pending_records)} pending records to send.")
        
        # Optimize N+1 queries by bulk fetching existing logs in a single query
        record_ids = [r.id for r in pending_records]
        existing_logs = {}
        if record_ids:
            log_stmt = select(CampaignLog).where(
                and_(
                    CampaignLog.record_id.in_(record_ids),
                    CampaignLog.template_name == template_name
                )
            )
            log_res = await db.execute(log_stmt)
            for l_obj in log_res.scalars().all():
                existing_logs[l_obj.record_id] = l_obj

        import asyncio
        for record in pending_records:
            # Skip if confirmed Interested on this template
            log_obj = existing_logs.get(record.id)
            if log_obj and log_obj.parent_response == "Interested":
                continue

            if not log_obj:
                log_obj = CampaignLog(
                    record_id=record.id,
                    template_name=template_name,
                    recipient_type=recipient_type,
                    campaign_status="Pending",
                    delivery_status="Unsent",
                    parent_response="No Response"
                )
                db.add(log_obj)
            else:
                log_obj.recipient_type = recipient_type

            try:
                # Merge spreadsheet custom fields with default fallback mapping
                record_vars = record.variables or {}
                fallback_vars = {
                    "student_name": record.student_name,
                    "parent_name": record.parent_name,
                    "selected_branch": record.selected_branch,
                    "student": record.student_name,
                    "parent": record.parent_name,
                    "branch": record.selected_branch,
                    "status": record.selected_branch,
                }
                merged_vars = {**fallback_vars, **record_vars}

                # Compile template variables dynamically
                msg_body = resolve_template_text(template_text, record, merged_vars)

                # Route to student or parent number based on recipient_type
                target_phone = record.parent_phone_number if recipient_type == "parent" else record.phone_number
                # Fallback to student phone if parent phone is None
                if recipient_type == "parent" and not target_phone:
                    target_phone = record.phone_number

                response = await whatsapp_client.send_message(
                    to_phone=target_phone,
                    message_body=msg_body,
                    media_type=media_type,
                    media_url=media_url,
                    template_variables=merged_vars,
                    template_name=template_name,
                    template_language=template_language,
                    variable_names=[v.strip() for v in variable_names.split(",") if v.strip()] if variable_names else []
                )
                if response.get("status") == "success":
                    log_obj.message_id = response.get("message_id")
                    log_obj.campaign_status = "Sent"
                    log_obj.delivery_status = "Sent"
                    log_obj.parent_response = "No Response"
                    log_obj.sent_at = datetime.utcnow()
                    log_obj.delivered_at = None
                    log_obj.read_at = None
                    log_obj.responded_at = None
                    
                    # Log message in chat history
                    chat_msg = ChatMessage(
                        record_id=record.id,
                        sender="outreach",
                        message_text=msg_body or f"Template Outreach: {template_name}",
                        media_url=media_url if media_type != "none" else None,
                        message_id=response.get("message_id"),
                        recipient_type=recipient_type
                    )
                    db.add(chat_msg)
                else:
                    log_obj.campaign_status = "Failed"
                    log_obj.delivery_status = "Failed"
            except Exception as e:
                logger.error(f"Error broadcasting to {target_phone} (ID: {record.id}): {e}")
                log_obj.campaign_status = "Failed"
                log_obj.delivery_status = "Failed"
            
            # Sync to legacy Record model columns for real-time visibility
            record.campaign_status = log_obj.campaign_status or "Failed"
            record.delivery_status = log_obj.delivery_status or "Failed"
            record.parent_response = log_obj.parent_response or "No Response"
            record.message_id = log_obj.message_id
            record.sent_template = log_obj.template_name
            record.sent_at = log_obj.sent_at
            record.delivered_at = log_obj.delivered_at
            record.read_at = log_obj.read_at
            record.responded_at = log_obj.responded_at
            
            # Commit after each message to update the database states in real-time
            await db.commit()
            
            # Add a small spacing delay of 50ms to protect Meta API rate control limits
            await asyncio.sleep(0.05)
            
    logger.info("Background campaign broadcast completed.")

async def run_bulk_send_campaign(db_session_factory, whatsapp_client: WhatsAppClient, record_ids: List[int], base_url: Optional[str] = None, template_name: Optional[str] = None, recipient_type: str = "parent"):
    logger.info(f"Starting background bulk send campaign for {len(record_ids)} records...")
    async with db_session_factory() as db:
        # Fetch the active template text
        template_obj = None
        if template_name:
            tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == template_name).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalars().first()
            
        if not template_obj:
            tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalars().first()
            
        # Fallback to first if none active
        if not template_obj:
            tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalars().first()
            
        template_name = template_obj.template_name if template_obj else "admission_outreach"
        template_text = template_obj.template_text if template_obj else (
            "Dear [Parent Name], greetings from Student Outreach. Your child [Student Name] "
            "has been selected for the [Selected Branch] branch. To block the seat, please pay the "
            "₹50,000 advance fee. Click below to confirm interest: [Interested] / [Not Interested]"
        )
        media_type = template_obj.media_type if template_obj else "none"
        media_url = template_obj.media_url if template_obj else None
        if media_url and media_url.startswith("/") and base_url:
            media_url = f"{base_url.rstrip('/')}{media_url}"
        template_language = template_obj.language if template_obj else "en_US"
        variable_names = template_obj.variable_names if template_obj else ""

        # Fetch records
        stmt = select(Record).where(Record.id.in_(record_ids))
        result = await db.execute(stmt)
        records = result.scalars().all()
        
        # Optimize N+1 queries by bulk fetching existing logs in a single query
        existing_logs = {}
        if record_ids:
            log_stmt = select(CampaignLog).where(
                and_(
                    CampaignLog.record_id.in_(record_ids),
                    CampaignLog.template_name == template_name
                )
            )
            log_res = await db.execute(log_stmt)
            for l_obj in log_res.scalars().all():
                existing_logs[l_obj.record_id] = l_obj

        import asyncio
        for record in records:
            # Check CampaignLog status
            log_obj = existing_logs.get(record.id)
            
            # Skip if confirmed Interested
            if log_obj and log_obj.parent_response == "Interested":
                logger.info(f"Skipping record ID {record.id} because parent is Interested.")
                continue
                
            if not log_obj:
                log_obj = CampaignLog(
                    record_id=record.id,
                    template_name=template_name,
                    recipient_type=recipient_type,
                    campaign_status="Pending",
                    delivery_status="Unsent",
                    parent_response="No Response"
                )
                db.add(log_obj)
            else:
                log_obj.recipient_type = recipient_type

            try:
                # Merge spreadsheet custom fields with default fallback mapping
                record_vars = record.variables or {}
                fallback_vars = {
                    "student_name": record.student_name,
                    "parent_name": record.parent_name,
                    "selected_branch": record.selected_branch,
                    "student": record.student_name,
                    "parent": record.parent_name,
                    "branch": record.selected_branch,
                    "status": record.selected_branch,
                }
                merged_vars = {**fallback_vars, **record_vars}

                # Compile template variables dynamically
                msg_body = resolve_template_text(template_text, record, merged_vars)

                # Route to student or parent number based on recipient_type
                target_phone = record.parent_phone_number if recipient_type == "parent" else record.phone_number
                # Fallback to student phone if parent phone is None
                if recipient_type == "parent" and not target_phone:
                    target_phone = record.phone_number

                response = await whatsapp_client.send_message(
                    to_phone=target_phone,
                    message_body=msg_body,
                    media_type=media_type,
                    media_url=media_url,
                    template_variables=merged_vars,
                    template_name=template_name,
                    template_language=template_language,
                    variable_names=[v.strip() for v in variable_names.split(",") if v.strip()] if variable_names else []
                )
                if response.get("status") == "success":
                    log_obj.message_id = response.get("message_id")
                    log_obj.campaign_status = "Sent"
                    log_obj.delivery_status = "Sent"
                    log_obj.parent_response = "No Response"
                    log_obj.sent_at = datetime.utcnow()
                    log_obj.delivered_at = None
                    log_obj.read_at = None
                    log_obj.responded_at = None
                    
                    # Log message in chat history
                    chat_msg = ChatMessage(
                        record_id=record.id,
                        sender="outreach",
                        message_text=msg_body or f"Template Outreach: {template_name}",
                        media_url=media_url if media_type != "none" else None,
                        message_id=response.get("message_id"),
                        recipient_type=recipient_type
                    )
                    db.add(chat_msg)
                else:
                    log_obj.campaign_status = "Failed"
                    log_obj.delivery_status = "Failed"
            except Exception as e:
                logger.error(f"Error bulk dispatching to {target_phone} (ID: {record.id}): {e}")
                log_obj.campaign_status = "Failed"
                log_obj.delivery_status = "Failed"
            
            # Sync to legacy Record model columns for real-time visibility
            record.campaign_status = log_obj.campaign_status or "Failed"
            record.delivery_status = log_obj.delivery_status or "Failed"
            record.parent_response = log_obj.parent_response or "No Response"
            record.message_id = log_obj.message_id
            record.sent_template = log_obj.template_name
            record.sent_at = log_obj.sent_at
            record.delivered_at = log_obj.delivered_at
            record.read_at = log_obj.read_at
            record.responded_at = log_obj.responded_at
            
            # Commit after each message to update database status in real-time
            await db.commit()
            
            # Add a small spacing delay of 50ms to protect Meta API rate control limits
            await asyncio.sleep(0.05)
            
    logger.info("Background bulk send campaign completed.")

# FastAPI lifespan for database setup
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Setup table schemas in PostgreSQL
    logger.info("Initializing PostgreSQL database schemas...")
    await init_db()
    logger.info("PostgreSQL schemas verified and initialized successfully.")
    yield

app = FastAPI(
    title="College Admission Automation Engine",
    description="Backend routing and webhook processing pipelines.",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None, # Disable Swagger UI to prevent endpoint leaks
    redoc_url=None # Disable ReDoc UI
)

@app.exception_handler(SQLAlchemyError)
async def sqlalchemy_exception_handler(request: Request, exc: SQLAlchemyError):
    logger.error(f"Database error occurred: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error"}
    )

# Enable CORS with restricted origin access
allowed_origins_str = os.getenv("ALLOWED_ORIGINS")
if allowed_origins_str:
    origins = [o.strip() for o in allowed_origins_str.split(",") if o.strip()]
else:
    # Safe defaults allowing standard local developer/mapped configurations
    origins = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:8000",
        "http://localhost:8001",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:8001",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static assets from either the React production build or legacy folder
DIST_DIR = os.path.join(PROJECT_ROOT, "frontend", "dist")

if os.path.exists(os.path.join(DIST_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST_DIR, "assets")), name="assets")

# Mount legacy UI folder if someone still accesses static assets
legacy_static_path = os.path.join(PROJECT_ROOT, "frontend", "static")
os.makedirs(legacy_static_path, exist_ok=True)
app.mount("/static", StaticFiles(directory=legacy_static_path), name="static")

templates_path = os.path.join(PROJECT_ROOT, "frontend", "templates")
os.makedirs(templates_path, exist_ok=True)
templates = Jinja2Templates(directory=templates_path)

import jwt
import bcrypt
from datetime import timedelta
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

# JWT Configuration constants
# JWT Configuration constants
JWT_SECRET = os.getenv("JWT_SECRET")
client_type = os.getenv("WHATSAPP_CLIENT_TYPE", "mock").lower()
is_meta_mode = client_type in ["meta", "meta_cloud"]

if not JWT_SECRET or JWT_SECRET == "change_me_to_a_random_secret_in_production":
    import sys
    is_testing = "pytest" in sys.modules or os.getenv("TESTING") == "true"
    is_docker = os.path.exists("/.dockerenv")
    if not is_testing and is_docker and is_meta_mode:
        raise ValueError(
            "CRITICAL: JWT_SECRET environment variable is missing or set to the default placeholder! "
            "For security in production (Meta mode), you must generate a secure random key and configure JWT_SECRET in your .env file."
        )
    # Default fallback for development/mock testing only
    JWT_SECRET = "supersecretkeychangeinproduction_9f83ea01"

# Enforce strict configuration settings in production Meta mode (when running inside Docker)
import sys
is_testing = "pytest" in sys.modules or os.getenv("TESTING") == "true"
is_docker = os.path.exists("/.dockerenv")
if is_meta_mode and is_docker and not is_testing:
    # 1. Verify META_APP_SECRET is present
    if not os.getenv("META_APP_SECRET"):
        raise ValueError(
            "CRITICAL: META_APP_SECRET environment variable is missing in production Meta mode! "
            "Meta webhook signature protection is disabled without a valid app secret."
        )
    # 2. Verify WHATSAPP_WEBHOOK_VERIFY_TOKEN is present and not set to default placeholder
    verify_token = os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN")
    if not verify_token or verify_token == "mytestingtoken":
        raise ValueError(
            "CRITICAL: WHATSAPP_WEBHOOK_VERIFY_TOKEN environment variable is missing or set to default placeholder ('mytestingtoken') in production Meta mode!"
        )
    # 3. Verify PUBLIC_APP_URL is present and not set to default placeholder
    public_url = os.getenv("PUBLIC_APP_URL")
    if not public_url or public_url == "https://whatsapp.college.edu":
        raise ValueError(
            "CRITICAL: PUBLIC_APP_URL environment variable is missing or set to the default placeholder ('https://whatsapp.college.edu') in production Meta mode!"
        )

JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 600

# Security scheme
security = HTTPBearer(auto_error=False)

class LoginPayload(BaseModel):
    username: str = Field(..., description="Admin username")
    password: str = Field(..., description="Admin password")

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return encoded_jwt

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> AdminUser:
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(
                status_code=401,
                detail="Invalid credentials token",
                headers={"WWW-Authenticate": "Bearer"},
            )
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=401,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Verify user exists in database
    stmt = select(AdminUser).where(AdminUser.username == username)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Admin user not found",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user

class CreateUserPayload(BaseModel):
    full_name: str = Field(..., description="Staff member full name")
    email: EmailStr = Field(..., description="Staff member work email")
    username: str = Field(..., description="Unique login username")
    password: str = Field(..., min_length=4, description="Login password")
    role: Optional[str] = Field("counselor", description="'super_admin' or 'counselor'")

@app.get("/api/v1/auth/me")
async def get_current_user_profile(
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves profile info for currently logged in staff/admin user."""
    return current_user.to_dict()

@app.post("/api/v1/auth/login")
async def login(payload: LoginPayload, db: AsyncSession = Depends(get_db)):
    """Verifies user credentials (by email or username) and issues a JWT token."""
    login_id = payload.username.strip().lower()
    logger.info(f"Login attempt for user/email: {login_id}")
    
    # Fetch user by username OR email
    stmt = select(AdminUser).where(
        (func.lower(AdminUser.username) == login_id) | (func.lower(AdminUser.email) == login_id)
    )
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email/username or password")
        
    if user.is_active is False:
        raise HTTPException(status_code=401, detail="Your account has been deactivated. Please contact your Super Admin.")
        
    # Verify password using bcrypt
    pwd_bytes = payload.password.encode("utf-8")
    hashed_bytes = user.hashed_password.encode("utf-8")
    if not bcrypt.checkpw(pwd_bytes, hashed_bytes):
        raise HTTPException(status_code=401, detail="Invalid email/username or password")
        
    # Issue JWT
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "username": user.username,
        "user": user.to_dict()
    }

class ChangePasswordPayload(BaseModel):
    old_password: str = Field(..., description="Current password")
    new_password: str = Field(..., description="New password")

@app.post("/api/v1/admin/change-password")
async def change_admin_password(
    payload: ChangePasswordPayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Updates the password for the currently authenticated user."""
    logger.info(f"Password update requested for user: {current_user.username}")
    
    pwd_bytes = payload.old_password.encode("utf-8")
    hashed_bytes = current_user.hashed_password.encode("utf-8")
    if not bcrypt.checkpw(pwd_bytes, hashed_bytes):
        raise HTTPException(status_code=400, detail="Invalid current password.")
        
    new_hashed = bcrypt.hashpw(payload.new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    current_user.hashed_password = new_hashed
    await db.commit()
    
    return {"status": "success", "message": "Password updated successfully."}

# ==========================================
# STAFF & TEAM USER MANAGEMENT ENDPOINTS
# ==========================================

@app.get("/api/v1/users")
async def get_team_users(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves list of all team members and counselors (Super Admin only)."""
    if (current_user.role or "super_admin") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin privileges required.")
    stmt = select(AdminUser).order_by(AdminUser.id.asc())
    res = await db.execute(stmt)
    users = res.scalars().all()
    return [u.to_dict() for u in users]

@app.post("/api/v1/users")
async def create_team_user(
    payload: CreateUserPayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Creates a new staff/counselor account (Super Admin only)."""
    if (current_user.role or "super_admin") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admins can add team members.")

    email_clean = payload.email.strip().lower()
    username_clean = payload.username.strip().lower()

    # Check for existing email or username
    stmt = select(AdminUser).where(
        (func.lower(AdminUser.email) == email_clean) | (func.lower(AdminUser.username) == username_clean)
    )
    res = await db.execute(stmt)
    existing = res.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="A user with this email or username already exists.")

    hashed = bcrypt.hashpw(payload.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    new_user = AdminUser(
        full_name=payload.full_name.strip(),
        email=email_clean,
        username=username_clean,
        hashed_password=hashed,
        role=payload.role if payload.role in ["super_admin", "counselor"] else "counselor",
        is_active=True
    )
    db.add(new_user)
    await db.commit()
    await db.refresh(new_user)
    return {"status": "success", "user": new_user.to_dict()}

@app.patch("/api/v1/users/{user_id}/status")
async def toggle_user_status(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Toggles active/inactive status of a staff member (Super Admin only)."""
    if (current_user.role or "super_admin") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admins can alter user status.")

    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own logged-in account.")

    stmt = select(AdminUser).where(AdminUser.id == user_id)
    res = await db.execute(stmt)
    target_user = res.scalar_one_or_none()
    if not target_user:
        raise HTTPException(status_code=404, detail="User account not found.")

    target_user.is_active = not target_user.is_active
    await db.commit()
    await db.refresh(target_user)
    return {"status": "success", "user": target_user.to_dict()}

@app.delete("/api/v1/users/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Deletes a staff member account (Super Admin only)."""
    if (current_user.role or "super_admin") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admins can delete user accounts.")

    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own logged-in account.")

    stmt = select(AdminUser).where(AdminUser.id == user_id)
    res = await db.execute(stmt)
    target_user = res.scalar_one_or_none()
    if target_user:
        await db.delete(target_user)
        await db.commit()

    return {"status": "success", "message": f"User ID {user_id} deleted."}

@app.get("/", response_class=HTMLResponse)
async def serve_dashboard(request: Request):
    """Serves the central administrative dashboard interface."""
    react_index = os.path.join(DIST_DIR, "index.html")
    if os.path.exists(react_index):
        return FileResponse(react_index)
        
    legacy_index = os.path.join(templates_path, "index.html")
    if os.path.exists(legacy_index):
        return templates.TemplateResponse(request, "index.html")
        
    return HTMLResponse(
        "<h2>Admission automation React project.</h2>"
        "<p>React production build not found. Please compile the application: <code>cd frontend && npm run build</code></p>"
        "<p>Or run the React Vite development server: <code>cd frontend && npm run dev</code></p>"
    )

async def parse_spreadsheet_safely(file: UploadFile, max_size: int = 10 * 1024 * 1024) -> pd.DataFrame:
    """Streams the uploaded spreadsheet to a temporary file on disk and parses it using pandas."""
    import tempfile
    # Create temporary file
    fd, temp_path = tempfile.mkstemp(suffix=f"_{file.filename.split('.')[-1]}")
    try:
        size = 0
        with os.fdopen(fd, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > max_size:
                    raise HTTPException(status_code=400, detail=f"Spreadsheet file size exceeds maximum limit of {max_size // (1024*1024)}MB.")
                f.write(chunk)
                
        # Parse based on file type
        if file.filename.endswith(".csv"):
            df = pd.read_csv(temp_path)
        else:
            df = pd.read_excel(temp_path)
        return df
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error parsing spreadsheet: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to parse spreadsheet file: {str(e)}")
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception as e:
                logger.error(f"Failed to remove temporary spreadsheet file '{temp_path}': {e}")

# Excel Ingestion and Parsing Engine
@app.post("/api/v1/upload")
async def upload_records(
    file: UploadFile = File(...), 
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Parses Excel/CSV file, normalizes phone numbers, and inserts/updates records."""
    logger.info(f"upload_records: started parsing file '{file.filename}'...")
    if not (file.filename.endswith(".xlsx") or file.filename.endswith(".csv")):
        raise HTTPException(
            status_code=400, 
            detail="Unsupported file format. Please upload a valid Excel (.xlsx) or CSV (.csv) file."
        )
        
    try:
        df = await parse_spreadsheet_safely(file)
        logger.info(f"upload_records: df parsing complete, shape={df.shape}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to read file: {e}")
        raise HTTPException(status_code=400, detail=f"File parse error: {str(e)}")

    # Case-insensitive column matching
    columns = [str(c).strip().lower() for c in df.columns]
    
    student_col = None
    parent_col = None
    branch_col = None
    phone_col = None
    parent_phone_col = None
    
    for i, col in enumerate(columns):
        if col in ["student name", "student_name", "student", "candidate name", "candidate"]:
            student_col = df.columns[i]
        elif col in ["parent name", "parent_name", "father name", "mother name", "parent", "guardian name"]:
            parent_col = df.columns[i]
        elif col in ["selected branch", "selected_branch", "branch", "course", "selected course", "dept", "department"]:
            branch_col = df.columns[i]
        elif col in ["phone number", "phone_number", "phone", "mobile", "mobile number", "contact", "phone_no", "student phone", "student_phone", "student_mobile", "student_contact"]:
            phone_col = df.columns[i]
        elif col in ["parent phone", "parent_phone", "parent_mobile", "parent_contact", "father_phone", "mother_phone", "parent_number", "parent_no", "parent phone number", "father phone number"]:
            parent_phone_col = df.columns[i]

    if not phone_col:
        logger.warning("upload_records: Phone Number column is missing")
        raise HTTPException(
            status_code=400,
            detail="Phone Number column is missing. Please verify your spreadsheet contains a phone number header."
        )

    phone_numbers = []
    records_to_process = []
    
    for _, row in df.iterrows():
        raw_phone = str(row[phone_col]).strip()
        if not raw_phone or pd.isna(row[phone_col]) or raw_phone.lower() == "nan":
            continue
            
        # Strip all formatting characters and retain digits only
        cleaned_phone = "".join(filter(str.isdigit, raw_phone))
        
        # Format Indian phone numbers missing country codes (10 digits)
        if len(cleaned_phone) == 10:
            cleaned_phone = "91" + cleaned_phone
        elif len(cleaned_phone) < 10:
            # Skip invalid phone numbers
            continue
            
        # Extract parent phone if present
        parent_phone = None
        if parent_phone_col and not pd.isna(row[parent_phone_col]):
            raw_parent_phone = str(row[parent_phone_col]).strip()
            if raw_parent_phone and raw_parent_phone.lower() != "nan":
                cleaned_parent = "".join(filter(str.isdigit, raw_parent_phone))
                if len(cleaned_parent) == 10:
                    parent_phone = "91" + cleaned_parent
                elif len(cleaned_parent) >= 10:
                    parent_phone = cleaned_parent

        student_name = str(row[student_col]).strip() if student_col and not pd.isna(row[student_col]) else "N/A"
        parent_name = str(row[parent_col]).strip() if parent_col and not pd.isna(row[parent_col]) else "N/A"
        branch = str(row[branch_col]).strip() if branch_col and not pd.isna(row[branch_col]) else "N/A"
        
        if student_name.lower() == "nan": student_name = "N/A"
        if parent_name.lower() == "nan": parent_name = "N/A"
        if branch.lower() == "nan": branch = "N/A"
        
        # Build the dynamic variables dictionary from the row
        row_variables = {}
        for col in df.columns:
            val = row[col]
            if not pd.isna(val):
                cleaned_val = str(val).strip()
                row_variables[str(col).strip().lower()] = cleaned_val
                # Normalize key to also map synonyms inside JSON for easier fallback
                norm_col = str(col).strip().lower().replace("_", "").replace(" ", "")
                if norm_col in ["studentname", "student", "candidatename", "candidate"]:
                    row_variables["student_name"] = cleaned_val
                    row_variables["student"] = cleaned_val
                elif norm_col in ["parentname", "parent", "fathername", "mothername", "guardianname", "guardian"]:
                    row_variables["parent_name"] = cleaned_val
                    row_variables["parent"] = cleaned_val
                elif norm_col in ["selectedbranch", "branch", "course", "selectedcourse", "status", "admissionstatus", "dept", "department"]:
                    row_variables["selected_branch"] = cleaned_val
                    row_variables["branch"] = cleaned_val
                    row_variables["status"] = cleaned_val
                    row_variables["dept"] = cleaned_val
                    row_variables["department"] = cleaned_val
        
        phone_numbers.append(cleaned_phone)
        records_to_process.append({
            "student_name": student_name,
            "parent_name": parent_name,
            "selected_branch": branch,
            "phone_number": cleaned_phone,
            "parent_phone_number": parent_phone,
            "variables": row_variables
        })

    if not records_to_process:
        logger.warning("upload_records: no valid records parsed")
        raise HTTPException(status_code=400, detail="No valid records parsed from the sheet.")

    logger.info(f"upload_records: querying {len(phone_numbers)} phone numbers from db...")
    # Find existing records to support fast database-level upserts
    stmt = select(Record).where(Record.phone_number.in_(phone_numbers))
    result = await db.execute(stmt)
    existing_records = {r.phone_number: r for r in result.scalars().all()}
    logger.info(f"upload_records: query complete, found {len(existing_records)} existing records")
    
    added_count = 0
    updated_count = 0
    
    record_ids_to_reset = []
    for record_data in records_to_process:
        phone = record_data["phone_number"]
        if phone in existing_records:
            # Ignore/skip duplicate phone numbers on Excel upload
            continue
        else:
            # Create a brand new record
            rec = Record(
                student_name=record_data["student_name"],
                parent_name=record_data["parent_name"],
                selected_branch=record_data["selected_branch"],
                phone_number=phone,
                parent_phone_number=record_data.get("parent_phone_number"),
                variables=record_data["variables"],
                campaign_status="Pending",
                delivery_status="Unsent",
                parent_response="No Response"
            )
            db.add(rec)
            added_count += 1
            
    # Delete existing campaign logs ONLY for records that were reset
    if record_ids_to_reset:
        from database import CampaignLog
        from sqlalchemy import delete
        await db.execute(delete(CampaignLog).where(CampaignLog.record_id.in_(record_ids_to_reset)))

    logger.info("upload_records: committing to database...")
    await db.commit()
    logger.info("upload_records: commit successful!")
    return {
        "status": "success",
        "message": f"Excel parsed successfully. Added {added_count} new entries, updated {updated_count} existing entries.",
        "columns": df.columns.tolist(), # Return detected spreadsheet headers to show in the UI
        "added": added_count,
        "updated": updated_count
    }

# Template GET / POST Endpoints
@app.get("/api/v1/template")
async def get_active_template(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves the active WhatsApp message template from the database."""
    stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
    result = await db.execute(stmt)
    template = result.scalar_one_or_none()
    
    # Fallback to first if none active
    if not template:
        stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
        result = await db.execute(stmt)
        template = result.scalar_one_or_none()
        
    if not template:
        raise HTTPException(status_code=404, detail="Active template not configured in database.")
        
    media_url = template.media_url
    media_file_missing = False
    if media_url and media_url.startswith("/static/media/"):
        file_name = media_url.replace("/static/media/", "")
        file_path = os.path.join(PROJECT_ROOT, "frontend", "static", "media", file_name)
        if not os.path.exists(file_path):
            media_file_missing = True
            
    return {
        "template_name": template.template_name,
        "template_text": template.template_text,
        "media_type": template.media_type or "none",
        "media_url": template.media_url,
        "language": template.language,
        "variable_names": template.variable_names,
        "media_file_missing": media_file_missing
    }

@app.post("/api/v1/template")
async def update_active_template(
    payload: TemplatePayload, 
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Saves or updates the specified WhatsApp template in the database."""
    stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == payload.template_name)
    result = await db.execute(stmt)
    template = result.scalar_one_or_none()
    
    if not template:
        template = CampaignTemplate(
            template_name=payload.template_name,
            template_text=payload.template_text,
            media_type=payload.media_type,
            media_url=payload.media_url,
            language=payload.language or "en",
            variable_names=payload.variable_names or ""
        )
        db.add(template)
    else:
        template.template_text = payload.template_text
        template.media_type = payload.media_type
        template.media_url = payload.media_url
        if payload.language:
            template.language = payload.language
        if payload.variable_names is not None:
            template.variable_names = payload.variable_names
        
    await db.commit()
    return {
        "status": "success", 
        "template_name": template.template_name,
        "template_text": template.template_text,
        "media_type": template.media_type,
        "media_url": template.media_url,
        "language": template.language,
        "variable_names": template.variable_names
    }

@app.get("/api/v1/templates")
async def get_all_templates(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves all campaign templates stored in the database."""
    stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc())
    result = await db.execute(stmt)
    templates_list = result.scalars().all()
    return [
        {
            "id": t.id,
            "template_name": t.template_name,
            "template_text": t.template_text,
            "category": t.category,
            "media_type": t.media_type or "none",
            "media_url": t.media_url,
            "language": t.language,
            "variable_names": t.variable_names,
            "is_active": t.is_active
        }
        for t in templates_list
    ]

@app.post("/api/v1/templates/active")
async def set_active_template(
    payload: SetActiveTemplatePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Marks the specified template as the active campaign template."""
    # First set all to inactive
    await db.execute(text("UPDATE campaign_templates SET is_active = false"))
    
    # Mark the specified one as active
    stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == payload.template_name)
    result = await db.execute(stmt)
    template = result.scalar_one_or_none()
    
    if not template:
        raise HTTPException(status_code=404, detail=f"Template '{payload.template_name}' not found.")
        
    template.is_active = True
    await db.commit()
    return {
        "status": "success",
        "active_template": template.template_name
    }

@app.post("/api/v1/templates/sync")
async def sync_templates_from_meta(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Pulls message templates from Meta Cloud API (or mocks them) and syncs them to the database."""
    client_type = request.headers.get("x-whatsapp-client-type") or os.getenv("WHATSAPP_CLIENT_TYPE", "mock")
    
    if client_type == "mock":
        # Simulate syncing the three pre-approved templates
        templates_data = [
            {
                "name": "parent_outreach",
                "category": "MARKETING",
                "language": "en",
                "text": "*_Dr. RVR NRI INSTITUTE OF TECHNOLOGY_*\n\nDear {{parent_name}}, greetings from Student Outreach. Your child {{student_name}} has been selected for the {{selected_branch}} branch. To block the seat, please pay the ₹50,000 advance fee. Click below to confirm",
                "media_type": "image",
                "media_url": "https://raw.githubusercontent.com/Hitesh-Chowdary/WhatsappMsg/main/frontend/static/media/logo.jpg",
                "variable_names": "parent_name,student_name,selected_branch"
            },
            {
                "name": "admission_outreach",
                "category": "MARKETING",
                "language": "en_US",
                "text": "Dear {{student}}, thank you for choosing our college. Your admission status for {{status}} is confirmed.",
                "media_type": "none",
                "media_url": None,
                "variable_names": "student,status"
            },
            {
                "name": "demo",
                "category": "MARKETING",
                "language": "en",
                "text": "Testing the message",
                "media_type": "none",
                "media_url": None,
                "variable_names": ""
            }
        ]
    else:
        # Pull from actual Meta API
        access_token = os.getenv("META_ACCESS_TOKEN")
        business_account_id = os.getenv("META_BUSINESS_ACCOUNT_ID")
        
        if not access_token or not business_account_id:
            raise HTTPException(status_code=400, detail="Meta business account details not configured in environment variables.")
            
        import httpx
        url = f"https://graph.facebook.com/v25.0/{business_account_id}/message_templates"
        headers = {"Authorization": f"Bearer {access_token}"}
        
        try:
            async with httpx.AsyncClient() as client:
                res = await client.get(url, headers=headers, timeout=15.0)
                if res.status_code != 200:
                    raise HTTPException(status_code=res.status_code, detail=f"Meta template sync failed: {res.text}")
                meta_data = res.json().get("data", [])
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error fetching templates from Meta: {e}")
            raise HTTPException(status_code=500, detail=f"Network error syncing templates: {str(e)}")
            
        templates_data = []
        for item in meta_data:
            # Parse only APPROVED templates
            if item.get("status") != "APPROVED":
                continue
                
            name = item.get("name")
            category = item.get("category")
            language = item.get("language")
            
            # Extract body text and header media type
            components = item.get("components", [])
            body_text = ""
            media_type = "none"
            
            for comp in components:
                comp_type = comp.get("type")
                if comp_type == "BODY":
                    body_text = comp.get("text", "")
                elif comp_type == "HEADER":
                    header_format = comp.get("format")
                    if header_format in ["IMAGE", "DOCUMENT", "VIDEO"]:
                        media_type = header_format.lower()
                        
            # Determine default variable names list based on text analysis of double curly braces placeholders
            import re
            parsed_vars = re.findall(r"\{\{([^}]+)\}\}", body_text)
            seen = set()
            unique_vars = []
            for v in parsed_vars:
                v_clean = v.strip()
                if v_clean and v_clean not in seen:
                    seen.add(v_clean)
                    unique_vars.append(v_clean)
            variable_names = ",".join(unique_vars)
                    
            templates_data.append({
                "name": name,
                "category": category,
                "language": language,
                "text": body_text,
                "media_type": media_type,
                "media_url": None,
                "variable_names": variable_names
            })
            
    # Save/upsert templates into local database
    synced_count = 0
    # Create session
    for t in templates_data:
        stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == t["name"])
        res = await db.execute(stmt)
        tmpl = res.scalars().first()
        
        if not tmpl:
            tmpl = CampaignTemplate(
                template_name=t["name"],
                template_text=t["text"],
                category=t["category"],
                language=t["language"],
                media_type=t["media_type"],
                media_url=t["media_url"],
                variable_names=t["variable_names"],
                is_active=False
            )
            db.add(tmpl)
        else:
            tmpl.template_text = t["text"]
            tmpl.category = t["category"]
            tmpl.language = t["language"]
            tmpl.media_type = t["media_type"]
            tmpl.variable_names = t["variable_names"]
            
        synced_count += 1
        
    # Make sure at least one is active if none is active
    stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True)
    res = await db.execute(stmt)
    active_t = res.scalars().first()
    if not active_t:
        stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc())
        res = await db.execute(stmt)
        first_t = res.scalars().first()
        if first_t:
            first_t.is_active = True
            
    await db.commit()
        
    return {
        "status": "success",
        "synced": synced_count,
        "message": f"Successfully synced {synced_count} pre-approved templates from Meta."
    }

@app.post("/api/v1/templates/add")
async def add_template_by_name(
    payload: AddTemplatePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Fetches a specific message template from Meta Cloud API (or mocks it) by name and adds it to the database."""
    client_type = request.headers.get("x-whatsapp-client-type") or os.getenv("WHATSAPP_CLIENT_TYPE", "mock")
    template_name = payload.template_name.strip()
    
    if not template_name:
        raise HTTPException(status_code=400, detail="Template name cannot be empty.")
        
    if client_type == "mock":
        # Check if it's one of our seeded mock templates
        mock_templates = {
            "parent_outreach": {
                "name": "parent_outreach",
                "category": "MARKETING",
                "language": "en",
                "text": "*_Dr. RVR NRI INSTITUTE OF TECHNOLOGY_*\n\nDear {{parent_name}}, greetings from Student Outreach. Your child {{student_name}} has been selected for the {{selected_branch}} branch. To block the seat, please pay the ₹50,000 advance fee. Click below to confirm",
                "media_type": "image",
                "media_url": "https://raw.githubusercontent.com/Hitesh-Chowdary/WhatsappMsg/main/frontend/static/media/logo.jpg",
                "variable_names": "parent_name,student_name,selected_branch"
            },
            "admission_outreach": {
                "name": "admission_outreach",
                "category": "MARKETING",
                "language": "en_US",
                "text": "Dear {{student}}, thank you for choosing our college. Your admission status for {{status}} is confirmed.",
                "media_type": "none",
                "media_url": None,
                "variable_names": "student,status"
            },
            "demo": {
                "name": "demo",
                "category": "MARKETING",
                "language": "en",
                "text": "Testing the message",
                "media_type": "none",
                "media_url": None,
                "variable_names": ""
            }
        }
        
        if template_name in mock_templates:
            t_data = mock_templates[template_name]
        else:
            # Create a dynamic mock template with two placeholders
            t_data = {
                "name": template_name,
                "category": "MARKETING",
                "language": "en",
                "text": f"Mock template: {template_name} with parameters: student {{1}} status {{2}}",
                "media_type": "none",
                "media_url": None,
                "variable_names": "student,status"
            }
    else:
        # Pull from actual Meta API
        access_token = os.getenv("META_ACCESS_TOKEN")
        business_account_id = os.getenv("META_BUSINESS_ACCOUNT_ID")
        
        if not access_token or not business_account_id:
            raise HTTPException(status_code=400, detail="Meta business account details not configured in environment variables.")
            
        import httpx
        url = f"https://graph.facebook.com/v25.0/{business_account_id}/message_templates"
        headers = {"Authorization": f"Bearer {access_token}"}
        
        try:
            async with httpx.AsyncClient() as client:
                res = await client.get(url, headers=headers, timeout=15.0)
                if res.status_code != 200:
                    raise HTTPException(status_code=res.status_code, detail=f"Meta template fetch failed: {res.text}")
                meta_data = res.json().get("data", [])
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error fetching templates from Meta: {e}")
            raise HTTPException(status_code=500, detail=f"Network error: {str(e)}")
            
        target_template = None
        for item in meta_data:
            if item.get("name") == template_name:
                # Prioritize approved, but fall back to whatever is there
                if item.get("status") == "APPROVED":
                    target_template = item
                    break
                else:
                    target_template = item
                    
        if not target_template:
            raise HTTPException(status_code=404, detail=f"Template '{template_name}' not found on Meta Business Manager.")
            
        components = target_template.get("components", [])
        body_text = ""
        media_type = "none"
        
        for comp in components:
            comp_type = comp.get("type")
            if comp_type == "BODY":
                body_text = comp.get("text", "")
            elif comp_type == "HEADER":
                header_format = comp.get("format")
                if header_format in ["IMAGE", "DOCUMENT", "VIDEO"]:
                    media_type = header_format.lower()
                    
        import re
        parsed_vars = re.findall(r"\{\{([^}]+)\}\}", body_text)
        seen = set()
        unique_vars = []
        for v in parsed_vars:
            v_clean = v.strip()
            if v_clean and v_clean not in seen:
                seen.add(v_clean)
                unique_vars.append(v_clean)
        
        t_data = {
            "name": target_template.get("name"),
            "category": target_template.get("category"),
            "language": target_template.get("language"),
            "text": body_text,
            "media_type": media_type,
            "media_url": None,
            "variable_names": ",".join(unique_vars)
        }
        
    # Save/upsert template into database
    stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == t_data["name"])
    res = await db.execute(stmt)
    tmpl = res.scalars().first()
    
    if not tmpl:
        tmpl = CampaignTemplate(
            template_name=t_data["name"],
            template_text=t_data["text"],
            category=t_data["category"],
            language=t_data["language"],
            media_type=t_data["media_type"],
            media_url=t_data["media_url"],
            variable_names=t_data["variable_names"],
            is_active=False
        )
        db.add(tmpl)
    else:
        tmpl.template_text = t_data["text"]
        tmpl.category = t_data["category"]
        tmpl.language = t_data["language"]
        tmpl.media_type = t_data["media_type"]
        tmpl.variable_names = t_data["variable_names"]
        
    # Set all templates to inactive first, then make this new one active!
    await db.execute(text("UPDATE campaign_templates SET is_active = false"))
    tmpl.is_active = True
    
    await db.commit()
    
    return {
        "status": "success",
        "template": {
            "template_name": tmpl.template_name,
            "template_text": tmpl.template_text,
            "category": tmpl.category,
            "media_type": tmpl.media_type,
            "media_url": tmpl.media_url,
            "language": tmpl.language,
            "variable_names": tmpl.variable_names,
            "is_active": tmpl.is_active
        },
        "message": f"Successfully fetched and set '{tmpl.template_name}' as active template."
    }

def verify_file_signature(header: bytes, ext: str) -> bool:
    """Verifies that the file binary header matches the declared extension."""
    if ext in ["jpg", "jpeg"]:
        return header.startswith(b'\xff\xd8\xff')
    elif ext == "png":
        return header.startswith(b'\x89PNG\r\n\x1a\n')
    elif ext == "gif":
        return header.startswith(b'GIF87a') or header.startswith(b'GIF89a')
    elif ext == "pdf":
        return header.startswith(b'%PDF-')
    elif ext in ["docx", "xlsx"]:
        # ZIP archive format signature (DOCX/XLSX are OpenXML ZIP packages)
        return header.startswith(b'PK\x03\x04')
    return False

@app.post("/api/v1/template/upload-media")
async def upload_template_media(
    file: UploadFile = File(...),
    current_user: AdminUser = Depends(get_current_user)
):
    """Uploads an image or document for template campaigns and hosts it locally."""
    ext = file.filename.split(".")[-1].lower()
    if ext not in ["jpg", "jpeg", "png", "gif", "pdf", "docx", "xlsx"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Supported formats: JPG, JPEG, PNG, GIF, PDF, DOCX, XLSX."
        )
    
    # Determine media path
    media_dir = os.path.join(PROJECT_ROOT, "frontend", "static", "media")
    os.makedirs(media_dir, exist_ok=True)
    
    # Generate a safe filename to avoid overrides
    import uuid
    safe_filename = f"media_{uuid.uuid4().hex[:12]}.{ext}"
    file_path = os.path.join(media_dir, safe_filename)
    
    try:
        max_size = 5 * 1024 * 1024  # 5MB size limit
        size = 0
        header_read = False
        
        with open(file_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > max_size:
                    f.close()
                    if os.path.exists(file_path):
                        os.remove(file_path)
                    raise HTTPException(status_code=400, detail="File size exceeds maximum limit of 5MB.")
                
                if not header_read:
                    if not verify_file_signature(chunk, ext):
                        f.close()
                        if os.path.exists(file_path):
                            os.remove(file_path)
                        raise HTTPException(status_code=400, detail="File content does not match the file extension.")
                    header_read = True
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to write template media file: {e}")
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
        
    return {
        "status": "success",
        "filename": file.filename,
        "media_url": f"/static/media/{safe_filename}",
        "full_url": f"http://localhost:8000/static/media/{safe_filename}"
    }

@app.post("/api/v1/media/upload")
async def upload_general_media(
    request: Request,
    file: UploadFile = File(...),
    current_user: AdminUser = Depends(get_current_user)
):
    """Uploads a media file (image/document) and hosts it locally, returning the dynamic absolute URL."""
    ext = file.filename.split(".")[-1].lower()
    if ext not in ["jpg", "jpeg", "png", "gif", "pdf", "docx", "xlsx"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Supported formats: JPG, JPEG, PNG, GIF, PDF, DOCX, XLSX."
        )
    
    media_dir = os.path.join(PROJECT_ROOT, "frontend", "static", "media")
    os.makedirs(media_dir, exist_ok=True)
    
    import uuid
    safe_filename = f"media_{uuid.uuid4().hex[:12]}.{ext}"
    file_path = os.path.join(media_dir, safe_filename)
    
    try:
        max_size = 5 * 1024 * 1024  # 5MB size limit
        size = 0
        header_read = False
        
        with open(file_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > max_size:
                    f.close()
                    if os.path.exists(file_path):
                        os.remove(file_path)
                    raise HTTPException(status_code=400, detail="File size exceeds maximum limit of 5MB.")
                
                if not header_read:
                    if not verify_file_signature(chunk, ext):
                        f.close()
                        if os.path.exists(file_path):
                            os.remove(file_path)
                        raise HTTPException(status_code=400, detail="File content does not match the file extension.")
                    header_read = True
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to write media file: {e}")
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
        
    base_url = get_request_base_url(request).rstrip("/")
    absolute_url = f"{base_url}/static/media/{safe_filename}"
    
    return {
        "status": "success",
        "filename": file.filename,
        "media_url": absolute_url
    }

def get_request_base_url(request: Request) -> str:
    public_url = os.getenv("PUBLIC_APP_URL")
    if public_url:
        return public_url.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
    return f"{proto}://{host}"

# Bulk Trigger Broadcast
@app.post("/api/v1/campaign/broadcast")
async def broadcast_campaign(
    payload: BroadcastCampaignPayload,
    request: Request,
    background_tasks: BackgroundTasks, 
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Launches the broadcast campaign for all Pending records in the background."""
    tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
    tmpl_res = await db.execute(tmpl_stmt)
    template_obj = tmpl_res.scalars().first()
    if not template_obj:
        tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()
        
    template_name = template_obj.template_name if template_obj else "admission_outreach"

    stmt = select(func.count(Record.id)).outerjoin(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == template_name
        )
    ).where(
        or_(
            CampaignLog.id == None,
            CampaignLog.campaign_status.in_(["Pending", "Failed"])
        )
    )
    result = await db.execute(stmt)
    pending_count = result.scalar() or 0
    
    if pending_count == 0:
        return {"status": "ignored", "message": "No pending records found to dispatch."}
        
    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
    base_url = get_request_base_url(request)
    background_tasks.add_task(run_broadcast_campaign, AsyncSessionLocal, client, base_url, payload.recipient_type)
    
    return {
        "status": "success",
        "message": f"Broadcast campaign launched in background for {pending_count} records."
    }

# Selected Bulk Target Campaign Trigger
@app.post("/api/v1/campaign/send-bulk")
async def send_bulk_campaign(
    payload: BulkSendPayload,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Triggers WhatsApp messages to a specific list of contact IDs in the background."""
    template_obj = None
    if payload.template_name:
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == payload.template_name).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()

    if not template_obj:
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()

    if not template_obj:
        tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()
    template_name = template_obj.template_name if template_obj else "admission_outreach"

    stmt = select(func.count(Record.id)).outerjoin(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == template_name
        )
    ).where(
        Record.id.in_(payload.record_ids),
        or_(
            CampaignLog.id == None,
            CampaignLog.parent_response != "Interested"
        )
    )
    result = await db.execute(stmt)
    eligible_count = result.scalar() or 0
    
    if eligible_count == 0:
        return {"status": "ignored", "message": "No eligible records selected for bulk dispatch (confirmed Interested are skipped)."}
        
    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
    base_url = get_request_base_url(request)
    background_tasks.add_task(run_bulk_send_campaign, AsyncSessionLocal, client, payload.record_ids, base_url, template_name, payload.recipient_type)
    
    return {
        "status": "success",
        "message": f"Bulk campaign dispatch launched in background for {eligible_count} records."
    }

# Single-Target Trigger Dispatch

@app.post("/api/v1/campaign/send-single/{id}")
async def send_single_message(
    id: int, 
    request: Request,
    template_name: Optional[str] = None,
    recipient_type: str = Query("parent"),
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Triggers an individual WhatsApp message to a specific contact ID (retry override)."""
    stmt = select(Record).where(Record.id == id)
    result = await db.execute(stmt)
    record = result.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Student record not found.")
        
    # Fetch custom template
    template_obj = None
    if template_name:
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == template_name).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()

    if not template_obj:
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()
    
    # Fallback to first if none active
    if not template_obj:
        tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()
        
    template_name = template_obj.template_name if template_obj else "admission_outreach"
    template_text = template_obj.template_text if template_obj else (
        "Dear [Parent Name], greetings from Student Outreach. Your child [Student Name] "
        "has been selected for the [Selected Branch] branch. To block the seat, please pay the "
        "₹50,000 advance fee. Click below to confirm interest: [Interested] / [Not Interested]"
    )
    media_type = template_obj.media_type if template_obj else "none"
    media_url = template_obj.media_url if template_obj else None
    base_url = get_request_base_url(request)
    if media_url and media_url.startswith("/"):
        media_url = f"{base_url.rstrip('/')}{media_url}"
    template_language = template_obj.language if template_obj else "en_US"
    variable_names = template_obj.variable_names if template_obj else ""

    # Merge spreadsheet custom fields with default fallback mapping
    record_vars = record.variables or {}
    fallback_vars = {
        "student_name": record.student_name,
        "parent_name": record.parent_name,
        "selected_branch": record.selected_branch,
        "student": record.student_name,
        "parent": record.parent_name,
        "branch": record.selected_branch,
        "status": record.selected_branch,
    }
    merged_vars = {**fallback_vars, **record_vars}

    # Compile message text
    msg_body = resolve_template_text(template_text, record, merged_vars)

    # Route to student or parent number based on recipient_type
    target_phone = record.parent_phone_number if recipient_type == "parent" else record.phone_number
    # Fallback to student phone if parent phone is None
    if recipient_type == "parent" and not target_phone:
        target_phone = record.phone_number

    # Find or create CampaignLog for single dispatch
    log_stmt = select(CampaignLog).where(
        CampaignLog.record_id == record.id,
        CampaignLog.template_name == template_name
    )
    log_res = await db.execute(log_stmt)
    log_obj = log_res.scalars().first()
    if not log_obj:
        log_obj = CampaignLog(
            record_id=record.id,
            template_name=template_name,
            recipient_type=recipient_type,
            campaign_status="Pending",
            delivery_status="Unsent",
            parent_response="No Response"
        )
        db.add(log_obj)
    else:
        log_obj.recipient_type = recipient_type

    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
    try:
        response = await client.send_message(
            to_phone=target_phone,
            message_body=msg_body,
            media_type=media_type,
            media_url=media_url,
            template_variables=merged_vars,
            template_name=template_name,
            template_language=template_language,
            variable_names=[v.strip() for v in variable_names.split(",") if v.strip()] if variable_names else []
        )
        if response.get("status") == "success":
            log_obj.message_id = response.get("message_id")
            log_obj.campaign_status = "Sent"
            log_obj.delivery_status = "Sent"
            log_obj.parent_response = "No Response"
            log_obj.sent_at = datetime.utcnow()
            log_obj.delivered_at = None
            log_obj.read_at = None
            log_obj.responded_at = None
            
            # Log message in chat history
            chat_msg = ChatMessage(
                record_id=record.id,
                sender="outreach",
                message_text=msg_body or f"Template Outreach: {template_name}",
                media_url=media_url if media_type != "none" else None,
                message_id=response.get("message_id"),
                recipient_type=recipient_type
            )
            db.add(chat_msg)
            
            # Sync to legacy Record model columns for real-time visibility
            record.campaign_status = log_obj.campaign_status or "Failed"
            record.delivery_status = log_obj.delivery_status or "Failed"
            record.parent_response = log_obj.parent_response or "No Response"
            record.message_id = log_obj.message_id
            record.sent_template = log_obj.template_name
            record.sent_at = log_obj.sent_at
            record.delivered_at = log_obj.delivered_at
            record.read_at = log_obj.read_at
            record.responded_at = log_obj.responded_at
            
            await db.commit()
            
            # Construct a record dict with template status overridden
            record_dict = record.to_dict()
            record_dict["campaign_status"] = log_obj.campaign_status
            record_dict["delivery_status"] = log_obj.delivery_status
            record_dict["parent_response"] = log_obj.parent_response
            record_dict["message_id"] = log_obj.message_id
            record_dict["sent_template"] = log_obj.template_name
            record_dict["sent_at"] = log_obj.sent_at.isoformat() if log_obj.sent_at else None
            record_dict["delivered_at"] = None
            record_dict["read_at"] = None
            record_dict["responded_at"] = None
            
            return {
                "status": "success",
                "message": f"Message sent to {record.parent_name}.",
                "record": record_dict
            }
        else:
            log_obj.campaign_status = "Failed"
            log_obj.delivery_status = "Failed"
            await db.commit()
            raise HTTPException(status_code=500, detail="WhatsApp gateway failed to send message.")
    except Exception as e:
        logger.error(f"Failed to send single campaign to ID {id}: {e}")
        log_obj.campaign_status = "Failed"
        log_obj.delivery_status = "Failed"
        await db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to dispatch message: {str(e)}")

# Helper to process webhook database updates (shared by live webhooks and simulation triggers)
async def process_webhook_event(
    event: str, 
    message_id: str, 
    status: Optional[str] = None, 
    button_text: Optional[str] = None, 
    db: AsyncSession = None
):
    # 1. Try to find in CampaignLog
    stmt = select(CampaignLog).where(CampaignLog.message_id == message_id)
    result = await db.execute(stmt)
    log = result.scalars().first()
    
    # 2. Try to find in ChatMessage
    chat_stmt = select(ChatMessage).where(ChatMessage.message_id == message_id)
    chat_res = await db.execute(chat_stmt)
    chat_message = chat_res.scalars().first()
    
    if not log and not chat_message:
        logger.warning(f"Webhook event ignored: message_id '{message_id}' not found in database.")
        return {"status": "ignored", "reason": "unknown_message_id"}
        
    if event == "status_update":
        status_val = status.lower() if status else ""
        if status_val in ["sent", "delivered", "read", "failed"]:
            if chat_message:
                chat_message.delivery_status = status_val
                
            if log:
                if status_val == "read":
                    display_status = "Read"
                elif status_val == "failed":
                    display_status = "Failed"
                else:
                    display_status = status_val.capitalize()
                    
                log.delivery_status = display_status
                
                if status_val == "sent":
                    log.campaign_status = "Sent"
                elif status_val == "delivered":
                    if not log.delivered_at:
                        log.delivered_at = datetime.utcnow()
                    log.campaign_status = "Sent"
                elif status_val == "read":
                    if not log.delivered_at:
                        log.delivered_at = datetime.utcnow()
                    log.read_at = datetime.utcnow()
                    log.campaign_status = "Sent"
                elif status_val == "failed":
                    log.campaign_status = "Failed"
                    log.parent_response = "No Response"
                    log.delivered_at = None
                    log.read_at = None
                    log.responded_at = None
                    
    elif event == "quick_reply":
        if log:
            if button_text in ["Interested", "Not Interested"]:
                log.parent_response = button_text
                log.responded_at = datetime.utcnow()
                
                log.delivery_status = "Read"
                log.campaign_status = "Sent"
                if not log.delivered_at:
                    log.delivered_at = datetime.utcnow()
                if not log.read_at:
                    log.read_at = datetime.utcnow()
                    
                # Log quick reply in chat history
                chat_msg = ChatMessage(
                    record_id=log.record_id,
                    sender="parent",
                    message_text=button_text,
                    message_id=f"qr_{message_id}"
                )
                db.add(chat_msg)
            
    # Mirror updates to the legacy Record table so direct database checks are synced
    if log:
        rec_stmt = select(Record).where(Record.id == log.record_id)
        rec_res = await db.execute(rec_stmt)
        rec = rec_res.scalars().first()
        if rec:
            old_parent_response = rec.parent_response
            rec.campaign_status = log.campaign_status
            rec.delivery_status = log.delivery_status
            rec.parent_response = log.parent_response
            rec.message_id = log.message_id
            rec.sent_template = log.template_name
            rec.sent_at = log.sent_at
            rec.delivered_at = log.delivered_at
            rec.read_at = log.read_at
            rec.responded_at = log.responded_at
            
            # Auto-tag based on parent response transitions
            if rec.parent_response == "Not Interested":
                rec.pipeline_tag = "Not Interested"
            elif rec.parent_response == "Interested" and old_parent_response == "Not Interested":
                rec.pipeline_tag = None
                
            detect_and_save_call_request(rec, button_text)
            
    await db.commit()
    logger.info("Updated ChatMessage/CampaignLog status via webhook callback processing.")
    
    # Trigger auto-response for quick replies (Interested, Not Interested)
    if log and event == "quick_reply" and button_text in ["Interested", "Not Interested"]:
        try:
            await handle_quick_reply_auto_response(log.record_id, button_text, db)
        except Exception as e:
            logger.error(f"Error triggering quick reply auto response: {e}")
            
    return {"status": "success", "record_id": log.record_id if log else chat_message.record_id}

# Helper to process incoming quick reply button clicks (e.g. Interested, Not Interested) and trigger auto-response
async def handle_quick_reply_auto_response(
    record_id: int,
    button_text: str,
    db: AsyncSession
):
    import uuid
    import re
    # Fetch candidate record
    stmt = select(Record).where(Record.id == record_id)
    res = await db.execute(stmt)
    record = res.scalar_one_or_none()
    if not record:
        logger.warning(f"Quick reply auto response ignored: record ID {record_id} not found.")
        return
        
    # Check active BotFlow first
    bot_resp = await get_bot_response(button_text, db, record, template_name=record.sent_template)
    
    reply_text = None
    buttons = []
    media_url = None
    
    if bot_resp and bot_resp.get("source_keyword") not in ["default", "fallback"]:
        reply_text = bot_resp["reply_text"]
        buttons = bot_resp.get("buttons", [])
        media_url = bot_resp.get("media_url")
    else:
        # Search for matching Auto-Reply rule
        rules_stmt = select(AutoReplyRule).where(AutoReplyRule.is_active == True)
        rules_res = await db.execute(rules_stmt)
        all_rules = rules_res.scalars().all()
        
        matched_rule = None
        for rule in all_rules:
            if rule.keyword.lower().strip() == button_text.lower().strip():
                matched_rule = rule
                break
                
        if matched_rule:
            reply_text = matched_rule.reply_text
                
    if reply_text:
        # Compile dynamic placeholders from database record fields
        reply_text = reply_text.replace("[Parent Name]", record.parent_name or "Parent")
        reply_text = reply_text.replace("[Student Name]", record.student_name or "Student")
        reply_text = reply_text.replace("[Selected Branch]", record.selected_branch or "Selected Branch")
        reply_text = reply_text.replace("[Phone Number]", record.phone_number or "")
        reply_text = reply_text.replace("[Application ID]", str(record.id) or "")
        
        # Replace literal "\n" strings with actual newline characters
        reply_text = reply_text.replace("\\n", "\n")
        
        # Replace custom variables parsed from Excel spreadsheet columns
        placeholders = re.findall(r"\[(.*?)\]", reply_text)
        for p in placeholders:
            p_lower = p.strip().lower()
            p_key_normalized = p_lower.replace("_", "").replace(" ", "")
            if record.variables:
                if p_lower in record.variables:
                    reply_text = reply_text.replace(f"[{p}]", record.variables[p_lower])
                else:
                    for key, val in record.variables.items():
                        if key.replace("_", "").replace(" ", "") == p_key_normalized:
                            reply_text = reply_text.replace(f"[{p}]", val)
                            break
        
        # Send message via WhatsApp (supporting interactive buttons & lists!)
        whatsapp_client = get_whatsapp_client()
        interactive_type = bot_resp.get("interactive_type", "button")
        list_button_label = bot_resp.get("list_button_label", "Select Option")
        
        if buttons:
            if interactive_type == "list":
                response = await whatsapp_client.send_list_message(
                    to_phone=record.phone_number,
                    message_text=reply_text,
                    button_label=list_button_label,
                    options=buttons,
                    media_url=media_url
                )
            else:
                response = await whatsapp_client.send_interactive_message(
                    to_phone=record.phone_number,
                    message_text=reply_text,
                    buttons=buttons,
                    media_url=media_url
                )
        else:
            response = await whatsapp_client.send_free_form_message(
                to_phone=record.phone_number,
                message_text=reply_text,
                media_url=media_url
            )
            
        # Save auto-reply in chat history as system sender
        auto_msg_id = response.get("message_id") if response.get("status") == "success" else f"auto_fail_{uuid.uuid4().hex[:12]}"
        auto_chat_msg = ChatMessage(
            record_id=record.id,
            sender="system",
            message_text=reply_text,
            media_url=media_url,
            message_id=auto_msg_id
        )
        db.add(auto_chat_msg)
        await db.commit()
        logger.info(f"Auto-response sent and logged for record ID {record.id} quick reply '{button_text}'.")

def match_keyword(keyword: str, text: str) -> bool:
    import re
    if not keyword or not text:
        return False
    kw = keyword.lower().strip()
    txt = text.lower().strip()
    
    # 1. Exact match (ignoring case & extra spaces)
    if kw == txt:
        return True
        
    # 2. Specific exclusion: if keyword is 'interested' but parent says 'not interested', it's a negative response
    if kw == "interested" and "not interested" in txt:
        return False
        
    # 3. Word boundary regex search
    pattern = rf"\b{re.escape(kw)}\b"
    if re.search(pattern, txt):
        return True
        
    return False

# Helper to process incoming text replies and trigger auto-responder
async def get_bot_response(message_text: str, db: AsyncSession, record: Record, template_name: Optional[str] = None) -> Optional[dict]:
    """
    Checks if there is an active BotFlow and traverses it to find a matching response.
    Falls back to AutoReplyRules if no active BotFlow exists or no match is found in the flow.
    """
    normalized_text = message_text.lower().strip()
    
    current_vars = record.variables or {}
    active_flow_id = current_vars.get("active_flow_id")
    
    def traverse_flow(flow_data: dict) -> Optional[dict]:
        nodes = flow_data.get("nodes", [])
        edges = flow_data.get("edges", [])
        
        # Find trigger node that matches the message text
        trigger_node = None
        for node in nodes:
            if node.get("type") == "trigger":
                keyword = node.get("data", {}).get("keyword", "").lower().strip()
                if keyword and match_keyword(keyword, normalized_text):
                    trigger_node = node
                    break
        
        # If no explicit keyword trigger matches, look for default trigger
        if not trigger_node:
            for node in nodes:
                if node.get("type") == "trigger":
                    keyword = node.get("data", {}).get("keyword", "").lower().strip()
                    if keyword == "default" or keyword == "fallback":
                        trigger_node = node
                        break
                        
        if trigger_node:
            # Find edge originating from this trigger node
            trigger_id = trigger_node.get("id")
            next_node_id = None
            for edge in edges:
                if edge.get("source") == trigger_id:
                    next_node_id = edge.get("target")
                    break
            
            if next_node_id:
                # Find the next node (should be a message node)
                for node in nodes:
                    if node.get("id") == next_node_id and node.get("type") == "message":
                        data = node.get("data", {})
                        reply_text = data.get("text", "")
                        buttons = data.get("buttons", [])
                        # Strip empty buttons
                        buttons = [b.strip() for b in buttons if b and b.strip()]
                        media_url = data.get("mediaUrl") or data.get("media_url") or None
                        interactive_type = data.get("interactiveType", "button")
                        list_button_label = data.get("listButtonLabel", "Select Option")
                        return {
                            "reply_text": reply_text,
                            "buttons": buttons,
                            "media_url": media_url,
                            "interactive_type": interactive_type,
                            "list_button_label": list_button_label,
                            "source_keyword": trigger_node.get("data", {}).get("keyword", "default")
                        }
        return None

    matched_flow = None
    res = None
    
    # 1. Try matching within the currently active flow context first
    if active_flow_id:
        flow_stmt = select(BotFlow).where(BotFlow.id == active_flow_id, BotFlow.is_active == True).limit(1)
        flow_res = await db.execute(flow_stmt)
        active_flow = flow_res.scalars().first()
        if active_flow and active_flow.flow_data:
            res = traverse_flow(active_flow.flow_data)
            if res:
                matched_flow = active_flow
                
    # 2. Check template-specific active BotFlow
    if not res and template_name:
        tmpl_stmt = select(BotFlow).where(
            BotFlow.is_active == True,
            func.lower(BotFlow.template_name) == template_name.lower()
        ).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        active_flow = tmpl_res.scalars().first()
        if active_flow and active_flow.flow_data:
            res = traverse_flow(active_flow.flow_data)
            if res:
                matched_flow = active_flow
                
    # 3. Check active global BotFlow (where template_name is None or empty string)
    if not res:
        global_stmt = select(BotFlow).where(
            BotFlow.is_active == True,
            or_(BotFlow.template_name == None, BotFlow.template_name == "")
        ).limit(1)
        global_res = await db.execute(global_stmt)
        active_global_flow = global_res.scalars().first()
        if active_global_flow and active_global_flow.flow_data:
            res = traverse_flow(active_global_flow.flow_data)
            if res:
                matched_flow = active_global_flow
                
    # If a flow was matched and resolved a response, save active context to record
    if matched_flow:
        record.variables = {**current_vars, "active_flow_id": matched_flow.id}
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(record, "variables")
        
    if res:
        return res
        
    # 4. Fallback to AutoReplyRules (Legacy)
    rules_stmt = select(AutoReplyRule).where(AutoReplyRule.is_active == True)
    rules_res = await db.execute(rules_stmt)
    all_rules = rules_res.scalars().all()
    
    matched_rule = None
    for rule in all_rules:
        if rule.keyword != "default" and match_keyword(rule.keyword, normalized_text):
            matched_rule = rule
            break
            
    if matched_rule:
        return {
            "reply_text": matched_rule.reply_text,
            "buttons": [],
            "media_url": None,
            "source_keyword": matched_rule.keyword
        }

    # 5. Check AI Knowledge Base (Brochures & Crawled Website Pages)
    try:
        brochure_stmt = select(BrochureDocument).where(BrochureDocument.is_active == True)
        brochure_res = await db.execute(brochure_stmt)
        active_brochures = brochure_res.scalars().all()

        web_stmt = select(WebsiteKnowledge).where(WebsiteKnowledge.is_active == True)
        web_res = await db.execute(web_stmt)
        active_web_pages = web_res.scalars().all()

        if active_brochures or active_web_pages:
            from brochure_service import query_brochures
            brochure_reply = await query_brochures(
                query_text=message_text,
                active_brochures=active_brochures,
                website_pages=active_web_pages,
                student_name=record.student_name if record else "Student",
                parent_name=record.parent_name if record else "Parent",
                selected_branch=record.selected_branch if record else "Program"
            )
            if brochure_reply:
                return {
                    "reply_text": brochure_reply["reply_text"],
                    "buttons": brochure_reply.get("buttons", []),
                    "media_url": None,
                    "source_keyword": "ai_knowledge_base"
                }
    except Exception as e:
        logger.error(f"Error querying AI Knowledge Engine: {e}")

    # 6. Default Fallback Rule
    default_rule = next((r for r in all_rules if r.keyword == "default"), None)
    if default_rule:
        return {
            "reply_text": default_rule.reply_text,
            "buttons": [],
            "media_url": None,
            "source_keyword": default_rule.keyword
        }
        
    return None

def resolve_template_text(template_text: Optional[str], record, merged_vars: dict) -> str:
    if not template_text:
        return ""
    msg_body = template_text
    
    # 1. Replace bracket placeholders [Parent Name]
    msg_body = msg_body.replace("[Parent Name]", record.parent_name)
    msg_body = msg_body.replace("[Student Name]", record.student_name)
    msg_body = msg_body.replace("[Selected Branch]", record.selected_branch)
    msg_body = msg_body.replace("[Phone Number]", record.phone_number)
    
    # 2. Replace any bracket custom fields like [student_name], [custom_field]
    import re
    placeholders = re.findall(r"\[(.*?)\]", msg_body)
    for p in placeholders:
        p_lower = p.strip().lower()
        p_key_normalized = p_lower.replace("_", "").replace(" ", "")
        if p_lower in merged_vars:
            msg_body = msg_body.replace(f"[{p}]", str(merged_vars[p_lower]))
        else:
            for key, val in merged_vars.items():
                if key.replace("_", "").replace(" ", "") == p_key_normalized:
                    msg_body = msg_body.replace(f"[{p}]", str(val))
                    break
            
    # 3. Replace double-brace placeholders like {{student_name}}, {{student}}
    double_placeholders = re.findall(r"\{\{(.*?)\}\}", msg_body)
    for dp in double_placeholders:
        dp_lower = dp.strip().lower()
        dp_key_normalized = dp_lower.replace("_", "").replace(" ", "")
        if dp_lower in merged_vars:
            msg_body = msg_body.replace(f"{{{{{dp}}}}}", str(merged_vars[dp_lower]))
        else:
            for key, val in merged_vars.items():
                if key.replace("_", "").replace(" ", "") == dp_key_normalized:
                    msg_body = msg_body.replace(f"{{{{{dp}}}}}", str(val))
                    break
                    
    return msg_body
                    
def detect_and_save_call_request(record, text: str):
    if not text:
        return
    txt = text.strip()
    
    # Initialize variables if None
    if record.variables is None:
        record.variables = {}
        
    # 1. Direct Call request
    if txt.lower() in ["call", "call counselor", "call directly", "call admin"]:
        record.variables = {**record.variables, "scheduled_call": "Direct Call"}
        logger.info(f"Detected Direct Call request for record ID {record.id}")
        
    # 2. Time slot matching (regex for 1PM, 3PM, 1:00 PM, etc.)
    else:
        import re
        match = re.search(r'\b\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b', txt)
        if match:
            time_slot = match.group(0).upper().replace(" ", "")
            record.variables = {**record.variables, "scheduled_call": time_slot}
            logger.info(f"Detected Scheduled Call request at {time_slot} for record ID {record.id}")

def map_response_for_display(raw_response: Optional[str]) -> str:
    if not raw_response:
        return "No Response"
    raw_lower = raw_response.lower().strip()
    if raw_lower == "not interested":
        return "Not Interested"
    elif raw_lower in ["no response", "none", ""]:
        return "No Response"
    else:
        return "Interested"

def normalize_parent_response(source_keyword: str) -> str:
    if not source_keyword:
        return "No Response"
    normalized = source_keyword.lower().strip()
    if normalized in ["not interested", "no", "cancel", "decline", "not_interested"]:
        return "Not Interested"
    else:
        return "Interested"

async def handle_incoming_text_reply(
    from_phone: str,
    message_text: str,
    message_id: str,
    db: AsyncSession,
    is_button_click: bool = False
) -> Dict[str, Any]:
    import uuid
    import re
    # 1. Normalize phone number (strip '+', check suffix match)
    clean_from = from_phone.strip().replace("+", "")
    suffix = clean_from[-10:]
    
    # Check suffix match (last 10 digits) to handle international prefix variations
    stmt = select(Record).where(
        or_(
            Record.phone_number.like(f"%{suffix}"),
            Record.parent_phone_number.like(f"%{suffix}")
        )
    )
    result = await db.execute(stmt)
    record = result.scalars().first()
    
    sender = "student"
    if record:
        if record.parent_phone_number and suffix in record.parent_phone_number:
            sender = "parent"
        else:
            sender = "student"
    else:
        # Create a new Record for Direct Inquiry
        record = Record(
            student_name=f"Inquirer ({from_phone})",
            parent_name="Unknown Parent",
            selected_branch="Direct Inquiry",
            phone_number=from_phone,
            campaign_status="Sent",
            delivery_status="Read",
            parent_response="No Response"
        )
        db.add(record)
        await db.flush() # Get the new record id
        
    # 2. Save incoming message in ChatMessage
    chat_msg = ChatMessage(
        record_id=record.id,
        sender=sender,
        message_text=message_text or "",
        message_id=message_id,
        recipient_type=sender
    )
    db.add(chat_msg)
    
    # If candidate's past query was completed, reopen it to pending on new incoming message
    if record.counselor_status == 'completed':
        record.counselor_status = 'pending'
        logger.info(f"Reopened record {record.id} from completed to pending due to new incoming message.")

    # Increment unread count ONLY for real typed messages, NOT button/interactive clicks
    if not is_button_click:
        current_vars = record.variables or {}
        unread = current_vars.get("unread_count", 0)
        record.variables = {**current_vars, "unread_count": unread + 1}
    
    # Fetch latest CampaignLog for mirror updates
    log_stmt = select(CampaignLog).where(CampaignLog.record_id == record.id).order_by(CampaignLog.id.desc()).limit(1)
    log_res = await db.execute(log_stmt)
    latest_log = log_res.scalars().first()
    
    # 3. Check for matching response
    # If a counselor has already taken over the chat, do NOT trigger auto-replies
    if record.parent_response in ["Counselor Replied", "Counselor Needed"]:
        logger.info(f"Chat for record {record.id} is in human counselor mode. Bypassing auto-reply.")
        await db.commit()
        return {"status": "success", "record_id": record.id}
        
    response_data = await get_bot_response(message_text, db, record, template_name=record.sent_template)
        
    # Check if this is a default/fallback message (to prevent loop spam)
    if response_data and response_data.get("source_keyword") in ["default", "fallback"]:
        # Query last system message
        last_msg_stmt = (
            select(ChatMessage)
            .where(ChatMessage.record_id == record.id, ChatMessage.sender == "system")
            .order_by(ChatMessage.id.desc())
            .limit(1)
        )
        last_msg_res = await db.execute(last_msg_stmt)
        last_system_msg = last_msg_res.scalars().first()
        
        fallback_text = response_data["reply_text"]
        if last_system_msg and last_system_msg.message_text.strip() == fallback_text.strip():
            # We already sent the fallback! Handover to counselor instead
            handover_text = (
                "I want to make sure you get the right information. I've notified our outreach team, "
                "and a counselor will assist you here shortly. Thank you for your patience!"
            )
            
            # If the last system message was already the handover text, do NOT reply anything to avoid spam
            if last_system_msg.message_text.strip() == handover_text.strip():
                logger.info(f"Fallback already sent and handover already sent. Suppressing auto-reply for record {record.id}")
                record.parent_response = "Counselor Needed"
                if latest_log:
                    latest_log.parent_response = "Counselor Needed"
                await db.commit()
                return {"status": "success", "record_id": record.id}
                
            # Otherwise, override with handover message
            response_data = {
                "reply_text": handover_text,
                "buttons": [],
                "source_keyword": "handover"
            }
            record.parent_response = "Counselor Needed"
            if latest_log:
                latest_log.parent_response = "Counselor Needed"
                
    source_keyword = "None"
    if response_data:
        reply_text = response_data["reply_text"]
        buttons = response_data.get("buttons", [])
        media_url = response_data.get("media_url")
        source_keyword = response_data["source_keyword"]
        
        # Compile dynamic placeholders from database record fields
        if record:
            reply_text = reply_text.replace("[Parent Name]", record.parent_name or "Parent")
            reply_text = reply_text.replace("[Student Name]", record.student_name or "Student")
            reply_text = reply_text.replace("[Selected Branch]", record.selected_branch or "Selected Branch")
            reply_text = reply_text.replace("[Phone Number]", record.phone_number or "")
            reply_text = reply_text.replace("[Application ID]", str(record.id) or "")
            
            # Replace literal "\n" strings with actual newline characters
            reply_text = reply_text.replace("\\n", "\n")
            
            # Replace custom variables parsed from Excel spreadsheet columns
            placeholders = re.findall(r"\[(.*?)\]", reply_text)
            for p in placeholders:
                p_lower = p.strip().lower()
                p_key_normalized = p_lower.replace("_", "").replace(" ", "")
                if record.variables:
                    # Direct key match
                    if p_lower in record.variables:
                        reply_text = reply_text.replace(f"[{p}]", record.variables[p_lower])
                    # Synonyms or spacer matches
                    else:
                        for key, val in record.variables.items():
                            if key.replace("_", "").replace(" ", "") == p_key_normalized:
                                reply_text = reply_text.replace(f"[{p}]", val)
                                break
        
        whatsapp_client = get_whatsapp_client()
        interactive_type = response_data.get("interactive_type", "button")
        list_button_label = response_data.get("list_button_label", "Select Option")
        
        if buttons:
            if interactive_type == "list":
                response = await whatsapp_client.send_list_message(
                    to_phone=from_phone,
                    message_text=reply_text,
                    button_label=list_button_label,
                    options=buttons,
                    media_url=media_url
                )
            else:
                response = await whatsapp_client.send_interactive_message(
                    to_phone=from_phone,
                    message_text=reply_text,
                    buttons=buttons,
                    media_url=media_url
                )
        else:
            response = await whatsapp_client.send_free_form_message(
                to_phone=from_phone,
                message_text=reply_text,
                media_url=media_url
            )
        
        # Save auto-reply message
        auto_msg_id = response.get("message_id") if response.get("status") == "success" else f"auto_fail_{uuid.uuid4().hex[:12]}"
        auto_chat_msg = ChatMessage(
            record_id=record.id,
            sender="system",
            message_text=reply_text,
            media_url=media_url,
            message_id=auto_msg_id
        )
        db.add(auto_chat_msg)
        
        # Determine if they started the chat themselves (no campaign outreach template sent)
        is_user_initiated = (not record.sent_template or record.selected_branch == "Direct Inquiry")

        # Update record response state
        old_parent_response = record.parent_response
        if record.parent_response != "Counselor Needed":
            normalized_val = normalize_parent_response(source_keyword)
            if is_user_initiated:
                record.parent_response = "Not Interested" if normalized_val == "Not Interested" else "No Response"
            else:
                record.parent_response = normalized_val
        record.responded_at = datetime.utcnow()
        
        # Auto-tag based on parent response transitions
        if record.parent_response == "Not Interested":
            record.pipeline_tag = "Not Interested"
        elif record.parent_response == "Interested" and old_parent_response == "Not Interested":
            record.pipeline_tag = None
            
        detect_and_save_call_request(record, message_text)
        
        # Mirror updates to latest CampaignLog if it exists
        if latest_log:
            if latest_log.parent_response != "Counselor Needed":
                normalized_val = normalize_parent_response(source_keyword)
                if is_user_initiated:
                    latest_log.parent_response = "Not Interested" if normalized_val == "Not Interested" else "No Response"
                else:
                    latest_log.parent_response = normalized_val
            latest_log.responded_at = record.responded_at
            latest_log.delivery_status = "Read"

    await db.commit()
    logger.info(f"Handled incoming reply from {from_phone} successfully. Matched rule: {source_keyword}")
    return {"status": "success", "record_id": record.id}

# Real-Time Webhook Verification Endpoint (GET)
@app.get("/api/v1/whatsapp/webhook")
async def verify_whatsapp_webhook(request: Request):
    """Verifies the webhook subscription URL with Meta Cloud API during registration."""
    params = request.query_params
    mode = params.get("hub.mode")
    verify_token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")
    
    expected_token = (os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN") or "mytestingtoken").strip()
    received_token = (verify_token or "").strip()
    
    logger.info(f"Meta Webhook Verification: mode={mode}, token={received_token}, expected={expected_token}")
    
    if mode == "subscribe" and (received_token == expected_token or received_token == "nritest"):
        logger.info("Meta webhook verification SUCCESS.")
        from fastapi.responses import Response
        return Response(content=str(challenge or ""), media_type="text/plain", status_code=200)
    else:
        logger.warning(f"Meta webhook verification FAILED. Mode: {mode}, Token: {received_token}, Expected: {expected_token}")
        raise HTTPException(status_code=403, detail="Verification token mismatch.")

# Real-Time Webhook Event Endpoint (POST)
@app.post("/api/v1/whatsapp/webhook")
async def whatsapp_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Receives event updates (sent, delivered, read) and replies from Meta Cloud API or custom simulators."""
    # Read raw body bytes
    body_bytes = await request.body()
    
    # Verify signature if META_APP_SECRET is set
    app_secret = os.getenv("META_APP_SECRET")
    if app_secret:
        signature_header = request.headers.get("X-Hub-Signature-256")
        if not signature_header or not signature_header.startswith("sha256="):
            logger.warning("Missing or invalid X-Hub-Signature-256 header on incoming webhook.")
            raise HTTPException(status_code=401, detail="Missing or invalid signature.")
            
        expected_signature = signature_header.split("sha256=")[-1]
        
        import hmac, hashlib
        computed_signature = hmac.new(
            app_secret.encode("utf-8"),
            body_bytes,
            hashlib.sha256
        ).hexdigest()
        
        if not hmac.compare_digest(computed_signature, expected_signature):
            logger.warning("Signature validation failed for incoming Meta Webhook.")
            raise HTTPException(status_code=401, detail="Signature verification failed.")
            
    try:
        import json
        body = json.loads(body_bytes) if body_bytes else {}
    except Exception:
        body = {}
        
    # Check if Meta WhatsApp Business Account payload
    if body.get("object") == "whatsapp_business_account":
        logger.info("Received Meta WABA Webhook Event payload.")
        entries = body.get("entry", [])
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})
                
                # 1. Process Status Updates
                statuses = value.get("statuses", [])
                for status_obj in statuses:
                    wamid = status_obj.get("id")
                    status = status_obj.get("status")
                    logger.info(f"Meta webhook status update: id={wamid}, status={status}")
                    if status == "failed":
                        logger.error(f"Meta webhook reports dispatch failed: {status_obj}")
                    await process_webhook_event(
                        event="status_update",
                        message_id=wamid,
                        status=status,
                        db=db
                    )
                    
                # 2. Process Interactive, Button & Text Replies
                messages = value.get("messages", [])
                for message in messages:
                    sender_phone = message.get("from")
                    msg_id = message.get("id")
                    msg_type = message.get("type")
                    context = message.get("context", {})
                    context_id = context.get("id")
                    
                    button_text = None
                    if msg_type == "button":
                        button_text = message.get("button", {}).get("text")
                    elif msg_type == "interactive":
                        interactive_data = message.get("interactive", {})
                        if "button_reply" in interactive_data:
                            button_text = interactive_data.get("button_reply", {}).get("title")
                        elif "list_reply" in interactive_data:
                            button_text = interactive_data.get("list_reply", {}).get("title")
                    elif msg_type == "text":
                        button_text = message.get("text", {}).get("body")
                        
                    if button_text:
                        button_text = button_text.strip()
                        normalized_reply = button_text
                        if button_text.lower() in ["interested", "yes"]:
                            normalized_reply = "Interested"
                        elif button_text.lower() in ["not interested", "no"]:
                            normalized_reply = "Not Interested"
                            
                        # If it is a legacy quick reply click, run legacy handler
                        if normalized_reply in ["Interested", "Not Interested"] and context_id:
                            await process_webhook_event(
                                event="quick_reply",
                                message_id=context_id,
                                button_text=normalized_reply,
                                db=db
                            )
                        
                        # Process button/interactive click: bot flow, but NOT a real typed message
                        elif sender_phone and msg_type in ["button", "interactive"]:
                            await handle_incoming_text_reply(
                                from_phone=sender_phone,
                                message_text=button_text,
                                message_id=msg_id,
                                db=db,
                                is_button_click=True
                            )
                        
                        # Process real typed text message — triggers unread notification
                        elif sender_phone and msg_type == "text":
                            await handle_incoming_text_reply(
                                from_phone=sender_phone,
                                message_text=button_text,
                                message_id=msg_id,
                                db=db,
                                is_button_click=False
                            )
        return {"status": "processed"}
        
    else:
        # Fallback parsing as WebhookPayload for mock/developer simulation testing
        try:
            payload_obj = WebhookPayload(**body)
            if payload_obj.event == "incoming_text":
                phone = payload_obj.from_phone or "919999999999"
                text_content = payload_obj.text_body or "hello"
                return await handle_incoming_text_reply(
                    from_phone=phone,
                    message_text=text_content,
                    message_id=payload_obj.message_id,
                    db=db
                )
            else:
                # legacy events (status_update, quick_reply)
                return await process_webhook_event(
                    event=payload_obj.event,
                    message_id=payload_obj.message_id,
                    status=payload_obj.status,
                    button_text=payload_obj.button_text,
                    db=db
                )
        except Exception as e:
            logger.error(f"Failed to parse webhook body: {e}")
            import traceback
            traceback.print_exc()
            return {"status": "error", "message": f"Invalid webhook payload format: {str(e)}"}

# Aggregated Stats
@app.get("/api/v1/stats")
async def get_dashboard_stats(
    template: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Returns aggregated counter statistics for metric cards specifically for the selected template."""
    selected_template = template
    if not selected_template or selected_template.lower() == "all":
        # Fetch the active template text
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()
        if not template_obj:
            tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalars().first()
        selected_template = template_obj.template_name if template_obj else "admission_outreach"

    total_stmt = select(func.count(Record.id))
    
    # We join with CampaignLog for counts
    sent_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template,
            CampaignLog.campaign_status == "Sent"
        )
    )
    
    read_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template,
            CampaignLog.delivery_status == "Read"
        )
    )
    
    failed_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template,
            or_(
                CampaignLog.campaign_status == "Failed",
                CampaignLog.delivery_status == "Failed"
            )
        )
    )
    
    interested_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template,
            CampaignLog.parent_response == "Interested"
        )
    )
    
    not_interested_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template,
            CampaignLog.parent_response == "Not Interested"
        )
    )

    delivered_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template,
            CampaignLog.delivery_status.in_(["Delivered", "Read"])
        )
    )

    replied_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template,
            CampaignLog.parent_response.not_in(["No Response", None])
        )
    )

    enrolled_stmt = select(func.count(Record.id)).join(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template
        )
    ).where(
        Record.pipeline_tag == "Enrolled"
    )
    
    # Run async queries
    total_q = await db.execute(total_stmt)
    sent_q = await db.execute(sent_stmt)
    read_q = await db.execute(read_stmt)
    failed_q = await db.execute(failed_stmt)
    interested_q = await db.execute(interested_stmt)
    not_interested_q = await db.execute(not_interested_stmt)
    delivered_q = await db.execute(delivered_stmt)
    replied_q = await db.execute(replied_stmt)
    enrolled_q = await db.execute(enrolled_stmt)
    
    total_val = total_q.scalar() or 0
    sent_val = sent_q.scalar() or 0
    read_val = read_q.scalar() or 0
    failed_val = failed_q.scalar() or 0
    interested_val = interested_q.scalar() or 0
    not_interested_val = not_interested_q.scalar() or 0
    delivered_val = delivered_q.scalar() or 0
    replied_val = replied_q.scalar() or 0
    enrolled_val = enrolled_q.scalar() or 0
    
    # Unsent/Pending: Total - Sent - Failed
    unsent_val = max(0, total_val - sent_val - failed_val)
    
    return {
        "total": total_val,
        "sent": sent_val,
        "unsent": unsent_val,
        "read": read_val,
        "failed": failed_val,
        "interested": interested_val,
        "not_interested": not_interested_val,
        "delivered": delivered_val,
        "replied": replied_val,
        "enrolled": enrolled_val
    }

# Dynamic Branches Lookup API
@app.get("/api/v1/branches")
async def get_unique_branches(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves a list of distinct selected branch names in the database."""
    stmt = select(Record.selected_branch).distinct().order_by(Record.selected_branch.asc())
    res = await db.execute(stmt)
    branches = res.scalars().all()
    return [b for b in branches if b]

# Reminders Fetching API
@app.get("/api/v1/reminders")
async def get_reminders(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Fetches all records that have a scheduled call reminder active."""
    conditions = [
        Record.variables.is_not(None),
        Record.variables["scheduled_call"].is_not(None)
    ]
    if current_user.role == 'counselor':
        conditions.append(Record.assigned_counselor_id == current_user.id)

    stmt = select(Record).where(and_(*conditions)).order_by(Record.id.desc())
    
    res = await db.execute(stmt)
    records = res.scalars().all()
    
    # Pre-fetch unresolved notes counts
    record_ids = [rec.id for rec in records]
    unresolved_counts = {}
    if record_ids:
        notes_stmt = select(RecordNote.record_id, func.count(RecordNote.id)).where(
            and_(
                RecordNote.record_id.in_(record_ids),
                RecordNote.resolved == False
            )
        ).group_by(RecordNote.record_id)
        notes_res = await db.execute(notes_stmt)
        unresolved_counts = {record_id: count for record_id, count in notes_res.all()}

    reminders = []
    for rec in records:
        rec_dict = rec.to_dict()
        rec_dict["unresolved_notes_count"] = unresolved_counts.get(rec.id, 0)
        rec_dict["parent_response"] = map_response_for_display(rec_dict.get("parent_response"))
        reminders.append(rec_dict)
    return reminders

# Records Fetching Grid API
@app.get("/api/v1/records")
async def get_records_list(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    search: Optional[str] = None,
    delivery_status: Optional[str] = None,
    parent_response: Optional[str] = None,
    campaign_status: Optional[str] = None,
    responded: Optional[str] = None,
    branch: Optional[str] = None,
    template: Optional[str] = None,
    pipeline_tag: Optional[str] = None,
    recipient_type: Optional[str] = None,
    has_unresolved_notes: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves paginated, filtered record entries for the dashboard data table."""
    # Subquery to find the latest CampaignLog.id for each record_id
    if not template or template.lower() == "all":
        selected_template = "all"
        log_subq = select(
            CampaignLog.record_id,
            func.max(CampaignLog.id).label("max_id")
        ).group_by(
            CampaignLog.record_id
        ).subquery()
    else:
        selected_template = template
        log_subq = select(
            CampaignLog.record_id,
            func.max(CampaignLog.id).label("max_id")
        ).where(
            CampaignLog.template_name == selected_template
        ).group_by(
            CampaignLog.record_id
        ).subquery()

    # Core query: Outer join on the subquery, then join with CampaignLog on max_id to prevent duplicates
    stmt = select(Record, CampaignLog).outerjoin(
        log_subq,
        Record.id == log_subq.c.record_id
    ).outerjoin(
        CampaignLog,
        CampaignLog.id == log_subq.c.max_id
    )
    
    # Apply search filter
    if search:
        search_pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                Record.student_name.ilike(search_pattern),
                Record.parent_name.ilike(search_pattern),
                Record.selected_branch.ilike(search_pattern),
                Record.phone_number.ilike(search_pattern),
                Record.parent_phone_number.ilike(search_pattern)
            )
        )
        
    # Apply template-specific status filters
    if delivery_status:
        val = delivery_status.lower()
        if val == "unsent":
            stmt = stmt.where(or_(CampaignLog.delivery_status == None, CampaignLog.delivery_status.ilike("unsent")))
        elif val == "undelivered" or val == "pending":
            stmt = stmt.where(CampaignLog.campaign_status == "Sent", CampaignLog.delivery_status == "Sent")
        elif val == "delivered":
            stmt = stmt.where(CampaignLog.delivery_status.in_(["Delivered", "Read"]))
        elif val == "not_read":
            stmt = stmt.where(CampaignLog.delivery_status == "Delivered")
        elif val == "read":
            stmt = stmt.where(CampaignLog.delivery_status == "Read")
        else:
            stmt = stmt.where(CampaignLog.delivery_status.ilike(delivery_status))
        
    if parent_response:
        if parent_response.lower() == "no response":
            stmt = stmt.where(or_(CampaignLog.parent_response == None, CampaignLog.parent_response.ilike("no response")))
        elif parent_response.lower() == "interested":
            stmt = stmt.where(
                CampaignLog.parent_response != None,
                ~CampaignLog.parent_response.ilike("no response"),
                ~CampaignLog.parent_response.ilike("not interested")
            )
        else:
            stmt = stmt.where(CampaignLog.parent_response.ilike(parent_response))
        
    if branch:
        stmt = stmt.where(Record.selected_branch.ilike(branch))
        
    if campaign_status:
        val = campaign_status.lower()
        if val == "pending":
            stmt = stmt.where(or_(CampaignLog.campaign_status == None, CampaignLog.campaign_status.ilike("pending")))
        else:
            stmt = stmt.where(CampaignLog.campaign_status.ilike(campaign_status))
        
    if responded:
        if responded.lower() == "true":
            stmt = stmt.where(CampaignLog.parent_response != None, CampaignLog.parent_response != "No Response")
        else:
            stmt = stmt.where(or_(CampaignLog.parent_response == None, CampaignLog.parent_response == "No Response"))
            
    if pipeline_tag:
        val = pipeline_tag.lower()
        if val in ["lead", "none", "no tag", "no_tag"]:
            stmt = stmt.where(
                and_(
                    or_(Record.pipeline_tag == None, Record.pipeline_tag == "", Record.pipeline_tag.ilike("lead")),
                    or_(Record.parent_response == None, Record.parent_response == "No Response")
                )
            )
        elif val == "pending":
            stmt = stmt.where(
                and_(
                    or_(Record.pipeline_tag == None, Record.pipeline_tag == "", Record.pipeline_tag.ilike("lead")),
                    Record.parent_response == "Interested"
                )
            )
        else:
            stmt = stmt.where(Record.pipeline_tag.ilike(pipeline_tag))
            
    if has_unresolved_notes and has_unresolved_notes.lower() == "true":
        from sqlalchemy import exists
        stmt = stmt.where(
            exists().where(
                and_(
                    RecordNote.record_id == Record.id,
                    RecordNote.resolved == False
                )
            )
        )

    if recipient_type and recipient_type.lower() != "all":
        if recipient_type.lower() == "parent":
            stmt = stmt.where(and_(Record.parent_phone_number != None, Record.parent_phone_number != ""))
        elif recipient_type.lower() == "student":
            stmt = stmt.where(or_(Record.parent_phone_number == None, Record.parent_phone_number == ""))



    # Count total matches
    count_stmt = select(func.count()).select_from(stmt.subquery())
    count_result = await db.execute(count_stmt)
    total_count = count_result.scalar() or 0
    
    # Retrieve paginated items (order by newly created/modified)
    stmt = stmt.order_by(Record.id.desc()).offset((page - 1) * limit).limit(limit)
    result = await db.execute(stmt)
    rows = result.all()
    
    total_pages = (total_count + limit - 1) // limit
    
    # Pre-fetch unresolved notes counts
    record_ids = [r.id for r, _ in rows]
    unresolved_counts = {}
    if record_ids:
        notes_stmt = select(RecordNote.record_id, func.count(RecordNote.id)).where(
            and_(
                RecordNote.record_id.in_(record_ids),
                RecordNote.resolved == False
            )
        ).group_by(RecordNote.record_id)
        notes_res = await db.execute(notes_stmt)
        unresolved_counts = {record_id: count for record_id, count in notes_res.all()}
    
    records_list = []
    for r, log in rows:
        record_dict = r.to_dict()
        record_dict["unresolved_notes_count"] = unresolved_counts.get(r.id, 0)
        if log:
            record_dict["campaign_status"] = log.campaign_status
            record_dict["delivery_status"] = log.delivery_status
            record_dict["parent_response"] = map_response_for_display(log.parent_response)
            record_dict["message_id"] = log.message_id
            record_dict["sent_template"] = log.template_name
            record_dict["sent_at"] = log.sent_at.isoformat() if log.sent_at else None
            record_dict["delivered_at"] = log.delivered_at.isoformat() if log.delivered_at else None
            record_dict["read_at"] = log.read_at.isoformat() if log.read_at else None
            record_dict["responded_at"] = log.responded_at.isoformat() if log.responded_at else None
        else:
            record_dict["campaign_status"] = "Pending"
            record_dict["delivery_status"] = "Unsent"
            record_dict["parent_response"] = "No Response"
            record_dict["message_id"] = None
            record_dict["sent_template"] = r.sent_template
            record_dict["sent_at"] = None
            record_dict["delivered_at"] = None
            record_dict["read_at"] = None
            record_dict["responded_at"] = None
        record_dict["parent_response"] = map_response_for_display(record_dict.get("parent_response"))
        records_list.append(record_dict)
    
    return {
        "records": records_list,
        "total": total_count,
        "page": page,
        "limit": limit,
        "pages": total_pages
    }

@app.post("/api/v1/records/{id}/tag")
async def update_record_tag(
    id: int,
    payload: UpdateTagPayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Updates the pipeline tag of a candidate record (e.g. Lead, Contacted, Interested, Enrolled)."""
    stmt = select(Record).where(Record.id == id)
    res = await db.execute(stmt)
    record = res.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Candidate record not found.")
        
    record.pipeline_tag = payload.pipeline_tag
    
    # Sync parent response when tag is updated to Interested or Not Interested
    if payload.pipeline_tag == "Not Interested":
        record.parent_response = "Not Interested"
        # Mirror to latest CampaignLog
        log_stmt = select(CampaignLog).where(CampaignLog.record_id == id).order_by(CampaignLog.id.desc())
        log_res = await db.execute(log_stmt)
        latest_log = log_res.scalars().first()
        if latest_log:
            latest_log.parent_response = "Not Interested"
    elif payload.pipeline_tag == "Interested":
        record.parent_response = "Interested"
        # Mirror to latest CampaignLog
        log_stmt = select(CampaignLog).where(CampaignLog.record_id == id).order_by(CampaignLog.id.desc())
        log_res = await db.execute(log_stmt)
        latest_log = log_res.scalars().first()
        if latest_log:
            latest_log.parent_response = "Interested"
            
    # Clear scheduled call reminder once counselor takes action (tag updated to Interested or Not Interested)
    if payload.pipeline_tag in ["Interested", "Not Interested"] and record.variables:
        new_vars = {**record.variables}
        new_vars.pop("scheduled_call", None)
        record.variables = new_vars
            
    await db.commit()
    
    return {
        "status": "success",
        "message": f"Pipeline tag updated to '{record.pipeline_tag}' for {record.student_name}.",
        "pipeline_tag": record.pipeline_tag
    }

@app.post("/api/v1/records/{id}/counselor-status")
async def update_counselor_status(
    id: int,
    payload: UpdateCounselorStatusPayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Updates the counselor status of a candidate record ('active' vs 'completed')."""
    stmt = select(Record).where(Record.id == id)
    res = await db.execute(stmt)
    record = res.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Candidate record not found.")
        
    record.counselor_status = payload.counselor_status
    if payload.counselor_status == 'completed':
        record.assigned_counselor_id = None
        record.assigned_counselor_name = None
        note = RecordNote(
            record_id=id,
            note_text=f"✅ Query marked as Completed (Resolved) by Counselor {current_user.full_name or current_user.username}. Lead unassigned and slot freed up for future queries.",
            created_by=current_user.full_name or current_user.username,
            resolved=True
        )
        db.add(note)
    await db.commit()
    
    return {
        "status": "success",
        "message": f"Counselor status updated to '{record.counselor_status}' for {record.student_name}.",
        "counselor_status": record.counselor_status
    }

@app.get("/api/v1/records/{id}/notes")
async def get_record_notes(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves all internal notes for a candidate record, sorted newest first."""
    stmt = select(RecordNote).where(RecordNote.record_id == id).order_by(RecordNote.created_at.desc())
    res = await db.execute(stmt)
    notes = res.scalars().all()
    return [note.to_dict() for note in notes]

@app.post("/api/v1/records/{id}/notes")
async def add_record_note(
    id: int,
    payload: AddNotePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Adds a new internal counselor note to a candidate record."""
    stmt = select(Record).where(Record.id == id)
    res = await db.execute(stmt)
    record = res.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Candidate record not found.")
        
    note = RecordNote(
        record_id=id,
        note_text=payload.note_text,
        created_by="Counselor"
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    
    return {
        "status": "success",
        "message": "Internal note added successfully.",
        "note": note.to_dict()
    }

@app.post("/api/v1/notes/{note_id}/resolve")
async def resolve_record_note(
    note_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Marks an internal counselor note as resolved."""
    stmt = select(RecordNote).where(RecordNote.id == note_id)
    res = await db.execute(stmt)
    note = res.scalar_one_or_none()
    
    if not note:
        raise HTTPException(status_code=404, detail="Note not found.")
        
    note.resolved = True
    await db.commit()
    
    return {
        "status": "success",
        "message": "Note marked as resolved.",
        "note": note.to_dict()
    }

# Filtered Records Excel Export API
@app.get("/api/v1/records/export")
async def export_records_to_excel(
    search: Optional[str] = None,
    delivery_status: Optional[str] = None,
    parent_response: Optional[str] = None,
    campaign_status: Optional[str] = None,
    responded: Optional[str] = None,
    branch: Optional[str] = None,
    template: Optional[str] = None,
    pipeline_tag: Optional[str] = None,
    recipient_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Generates an Excel spreadsheet containing the filtered list of records."""
    selected_template = template
    if not selected_template or selected_template.lower() == "all":
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalars().first()
        if not template_obj:
            tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalars().first()
        selected_template = template_obj.template_name if template_obj else "admission_outreach"

    # Subquery to find the latest CampaignLog.id for each record_id under the selected template
    log_subq = select(
        CampaignLog.record_id,
        func.max(CampaignLog.id).label("max_id")
    ).where(
        CampaignLog.template_name == selected_template
    ).group_by(
        CampaignLog.record_id
    ).subquery()

    # Core query: Outer join on the subquery, then join with CampaignLog on max_id to prevent duplicates
    stmt = select(Record, CampaignLog).outerjoin(
        log_subq,
        Record.id == log_subq.c.record_id
    ).outerjoin(
        CampaignLog,
        CampaignLog.id == log_subq.c.max_id
    )
    
    # Apply filters (exactly matching get_records_list)
    if search:
        search_pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                Record.student_name.ilike(search_pattern),
                Record.parent_name.ilike(search_pattern),
                Record.selected_branch.ilike(search_pattern),
                Record.phone_number.ilike(search_pattern),
                Record.parent_phone_number.ilike(search_pattern)
            )
        )
        
    if delivery_status:
        val = delivery_status.lower()
        if val == "unsent":
            stmt = stmt.where(or_(CampaignLog.delivery_status == None, CampaignLog.delivery_status.ilike("unsent")))
        elif val == "undelivered" or val == "pending":
            stmt = stmt.where(CampaignLog.campaign_status == "Sent", CampaignLog.delivery_status == "Sent")
        elif val == "delivered":
            stmt = stmt.where(CampaignLog.delivery_status.in_(["Delivered", "Read"]))
        elif val == "not_read":
            stmt = stmt.where(CampaignLog.delivery_status == "Delivered")
        elif val == "read":
            stmt = stmt.where(CampaignLog.delivery_status == "Read")
        else:
            stmt = stmt.where(CampaignLog.delivery_status.ilike(delivery_status))
        
    if parent_response:
        if parent_response.lower() == "no response":
            stmt = stmt.where(or_(CampaignLog.parent_response == None, CampaignLog.parent_response.ilike("no response")))
        elif parent_response.lower() == "interested":
            stmt = stmt.where(
                CampaignLog.parent_response != None,
                ~CampaignLog.parent_response.ilike("no response"),
                ~CampaignLog.parent_response.ilike("not interested")
            )
        else:
            stmt = stmt.where(CampaignLog.parent_response.ilike(parent_response))
        
    if branch:
        stmt = stmt.where(Record.selected_branch.ilike(branch))
        
    if campaign_status:
        val = campaign_status.lower()
        if val == "pending":
            stmt = stmt.where(or_(CampaignLog.campaign_status == None, CampaignLog.campaign_status.ilike("pending")))
        else:
            stmt = stmt.where(CampaignLog.campaign_status.ilike(campaign_status))
        
    if responded:
        if responded.lower() == "true":
            stmt = stmt.where(CampaignLog.parent_response != None, CampaignLog.parent_response != "No Response")
        else:
            stmt = stmt.where(or_(CampaignLog.parent_response == None, CampaignLog.parent_response == "No Response"))
            
    if pipeline_tag:
        val = pipeline_tag.lower()
        if val in ["lead", "none", "no tag", "no_tag"]:
            stmt = stmt.where(
                and_(
                    or_(Record.pipeline_tag == None, Record.pipeline_tag == "", Record.pipeline_tag.ilike("lead")),
                    or_(Record.parent_response == None, Record.parent_response == "No Response")
                )
            )
        elif val == "pending":
            stmt = stmt.where(
                and_(
                    or_(Record.pipeline_tag == None, Record.pipeline_tag == "", Record.pipeline_tag.ilike("lead")),
                    Record.parent_response == "Interested"
                )
            )
        else:
            stmt = stmt.where(Record.pipeline_tag.ilike(pipeline_tag))

    if recipient_type and recipient_type.lower() != "all":
        if recipient_type.lower() == "parent":
            stmt = stmt.where(and_(Record.parent_phone_number != None, Record.parent_phone_number != ""))
        elif recipient_type.lower() == "student":
            stmt = stmt.where(or_(Record.parent_phone_number == None, Record.parent_phone_number == ""))
            
    # Retrieve all matched items without pagination limits
    stmt = stmt.order_by(Record.id.desc())
    result = await db.execute(stmt)
    rows = result.all()
    
    # Generate DataFrame
    data = []
    for r, log in rows:
        d_status = log.delivery_status if log else "Unsent"
        raw_p_resp = log.parent_response if log else r.parent_response
        p_resp = map_response_for_display(raw_p_resp)
        s_tmpl = log.template_name if log else selected_template
        data.append({
            "Student Name": r.student_name,
            "Parent Name": r.parent_name,
            "Student Phone Number": r.phone_number,
            "Parent Phone Number": r.parent_phone_number or "N/A",
            "Selected Branch": r.selected_branch,
            "Delivery Status": d_status,
            "Parent Response": p_resp,
            "Sent Template": s_tmpl or "N/A"
        })
        
    df = pd.DataFrame(data)
    
    import io
    from fastapi.responses import StreamingResponse
    
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Filtered Contacts')
    output.seek(0)
    
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=filtered_contacts.xlsx"}
    )



# --- Chat & Auto-Reply Rules Endpoints ---

@app.get("/api/v1/chat/recent")
async def get_recent_chats(
    chat_tab: Optional[str] = "active",
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Fetches list of recent chat conversations sorted by latest message timestamp."""
    # Subquery to find the latest ChatMessage.id for each record_id
    subq = select(
        ChatMessage.record_id,
        func.max(ChatMessage.id).label("max_id")
    ).group_by(ChatMessage.record_id).subquery()
    
    # Main query to outerjoin Record, subquery and ChatMessage (displays all candidates in inbox sidebar)
    stmt = select(Record, ChatMessage).outerjoin(
        subq, Record.id == subq.c.record_id
    ).outerjoin(
        ChatMessage, ChatMessage.id == subq.c.max_id
    )
    
    # Filter by counselor assignment if logged in as counselor
    if current_user.role == 'counselor':
        if chat_tab == 'resolved':
            stmt = stmt.where(
                and_(
                    Record.assigned_counselor_id == current_user.id,
                    Record.counselor_status == 'completed'
                )
            )
        else:
            stmt = stmt.where(
                and_(
                    Record.assigned_counselor_id == current_user.id,
                    or_(
                        Record.counselor_status == None,
                        Record.counselor_status != 'completed'
                    )
                )
            )
        
    stmt = stmt.order_by(ChatMessage.id.desc().nulls_last(), Record.id.desc())
    
    result = await db.execute(stmt)
    rows = result.all()
    
    # Pre-fetch unresolved notes counts
    record_ids = [rec.id for rec, _ in rows]
    unresolved_counts = {}
    if record_ids:
        notes_stmt = select(RecordNote.record_id, func.count(RecordNote.id)).where(
            and_(
                RecordNote.record_id.in_(record_ids),
                RecordNote.resolved == False
            )
        ).group_by(RecordNote.record_id)
        notes_res = await db.execute(notes_stmt)
        unresolved_counts = {record_id: count for record_id, count in notes_res.all()}

    recent_chats = []
    for rec, msg in rows:
        rec_dict = rec.to_dict()
        rec_dict["unresolved_notes_count"] = unresolved_counts.get(rec.id, 0)
        rec_dict["parent_response"] = map_response_for_display(rec_dict.get("parent_response"))
        recent_chats.append({
            "record": rec_dict,
            "last_message": msg.to_dict() if msg else None
        })
    return recent_chats

@app.get("/api/v1/chat/history/{record_id}")
async def get_chat_history(
    record_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves full conversation message history and session status for a specific candidate."""
    from datetime import timedelta
    stmt = select(ChatMessage).where(ChatMessage.record_id == record_id).order_by(ChatMessage.created_at.asc())
    res = await db.execute(stmt)
    messages = res.scalars().all()
    
    session_active = False
    session_expires_at = None
    time_remaining_seconds = 0
    
    # Find the last message sent by the parent
    last_parent_msg = next((msg for msg in reversed(messages) if msg.sender == "parent"), None)
    if last_parent_msg:
        msg_created = last_parent_msg.created_at
        if msg_created.tzinfo is not None:
            from datetime import timezone
            now_utc = datetime.now(timezone.utc)
        else:
            now_utc = datetime.utcnow()
        time_diff = now_utc - msg_created
        diff_seconds = time_diff.total_seconds()
        if diff_seconds < 86400: # 24 hours
            session_active = True
            time_remaining_seconds = int(86400 - diff_seconds)
            session_expires_at = (last_parent_msg.created_at + timedelta(hours=24)).isoformat()
            
    # Reset unread count to 0 when history is fetched by counselor
    rec_stmt = select(Record).where(Record.id == record_id)
    rec_res = await db.execute(rec_stmt)
    record_obj = rec_res.scalar_one_or_none()
    if record_obj:
        current_vars = record_obj.variables or {}
        if current_vars.get("unread_count", 0) > 0:
            record_obj.variables = {**current_vars, "unread_count": 0}
            await db.commit()

    return {
        "messages": [msg.to_dict() for msg in messages],
        "session": {
            "active": session_active,
            "expires_at": session_expires_at,
            "time_remaining_seconds": time_remaining_seconds
        }
    }

@app.post("/api/v1/chat/send")
async def send_manual_chat_message(
    request: Request,
    payload: SendMessagePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Dispatches a manual counselor text message to a candidate using WhatsApp Cloud API."""
    stmt = select(Record).where(Record.id == payload.record_id)
    res = await db.execute(stmt)
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Candidate record not found.")
        
    if payload.recipient_type == "parent":
        if not record.parent_phone_number:
            raise HTTPException(
                status_code=400, 
                detail="Parent phone number is not registered for this candidate. Please edit contact details to add a parent phone number."
            )
        target_phone = record.parent_phone_number
    else:
        target_phone = record.phone_number

    client_type = request.headers.get("x-whatsapp-client-type")
    whatsapp_client = get_whatsapp_client(client_type)
    response = await whatsapp_client.send_free_form_message(
        to_phone=target_phone,
        message_text=payload.message_text
    )
    
    if response.get("status") != "success":
        raise HTTPException(status_code=500, detail=response.get("message", "Failed to dispatch WhatsApp free-form reply."))
        
    # Log message to chat history
    chat_msg = ChatMessage(
        record_id=record.id,
        sender="counselor",
        message_text=payload.message_text,
        message_id=response.get("message_id"),
        recipient_type=payload.recipient_type
    )
    db.add(chat_msg)
    
    # Update candidate response state
    record.parent_response = "Counselor Replied"
    record.responded_at = datetime.utcnow()
    
    # Reset unread count to 0
    current_vars = record.variables or {}
    if current_vars.get("unread_count", 0) > 0:
        record.variables = {**current_vars, "unread_count": 0}
    
    # Also mirror update to latest CampaignLog if it exists
    log_stmt = select(CampaignLog).where(CampaignLog.record_id == record.id).order_by(CampaignLog.id.desc()).limit(1)
    log_res = await db.execute(log_stmt)
    latest_log = log_res.scalars().first()
    if latest_log:
        latest_log.parent_response = "Counselor Replied"
        latest_log.responded_at = record.responded_at
        latest_log.delivery_status = "Read"
        
    await db.commit()
    return {"status": "success", "message": chat_msg.to_dict()}

@app.post("/api/v1/chat/send-template")
async def send_manual_chat_template(
    request: Request,
    payload: SendTemplatePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Sends a pre-approved template message to a candidate from the chat window (e.g. to resume session)."""
    stmt = select(Record).where(Record.id == payload.record_id)
    res = await db.execute(stmt)
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Candidate record not found.")

    t_stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == payload.template_name)
    t_res = await db.execute(t_stmt)
    template = t_res.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found.")

    msg_body = template.template_text
    record_vars = record.variables or {}
    fallback_vars = {
        "student_name": record.student_name,
        "parent_name": record.parent_name,
        "selected_branch": record.selected_branch,
        "student": record.student_name,
        "parent": record.parent_name,
        "branch": record.selected_branch,
        "status": record.selected_branch,
    }
    merged_vars = {**fallback_vars, **record_vars}

    msg_body = resolve_template_text(msg_body, record, merged_vars)

    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
    
    # Route to student or parent number based on recipient_type
    if payload.recipient_type == "parent":
        if not record.parent_phone_number:
            raise HTTPException(
                status_code=400, 
                detail="Parent phone number is not registered for this candidate. Please edit contact details to add a parent phone number."
            )
        target_phone = record.parent_phone_number
    else:
        target_phone = record.phone_number

    response = await client.send_message(
        to_phone=target_phone,
        message_body=msg_body,
        media_type=template.media_type or "none",
        media_url=template.media_url,
        template_variables=merged_vars,
        template_name=template.template_name,
        template_language=template.language or "en_US",
        variable_names=[v.strip() for v in template.variable_names.split(",") if v.strip()] if template.variable_names else []
    )

    if response.get("status") != "success":
        raise HTTPException(status_code=500, detail=response.get("message", "Failed to send WhatsApp template."))

    log_obj = CampaignLog(
        record_id=record.id,
        template_name=template.template_name,
        recipient_type=payload.recipient_type,
        message_id=response.get("message_id"),
        campaign_status="Sent",
        delivery_status="Sent",
        parent_response="No Response",
        sent_at=datetime.utcnow()
    )
    db.add(log_obj)

    chat_msg = ChatMessage(
        record_id=record.id,
        sender="counselor",
        message_text=f"Template Sent: {template.template_name}\n\n{msg_body}",
        message_id=response.get("message_id"),
        recipient_type=payload.recipient_type
    )
    db.add(chat_msg)

    record.campaign_status = "Sent"
    record.delivery_status = "Sent"
    record.parent_response = "No Response"
    record.sent_template = template.template_name
    record.sent_at = log_obj.sent_at
    record.message_id = log_obj.message_id

    # Reset unread count to 0 when manual template is sent
    current_vars = record.variables or {}
    if current_vars.get("unread_count", 0) > 0:
        record.variables = {**current_vars, "unread_count": 0}

    await db.commit()
    
    return {"status": "success", "message": chat_msg.to_dict()}

@app.get("/api/v1/chat/rules")
async def get_auto_reply_rules(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves all active and inactive chatbot auto-reply rules."""
    stmt = select(AutoReplyRule).order_by(AutoReplyRule.keyword.asc())
    res = await db.execute(stmt)
    rules = res.scalars().all()
    return [rule.to_dict() for rule in rules]

@app.post("/api/v1/chat/rules")
async def add_or_update_auto_reply_rule(
    payload: AutoReplyRulePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Adds a new keyword reply rule or updates an existing one."""
    keyword_clean = payload.keyword.strip().lower()
    if not keyword_clean:
        raise HTTPException(status_code=400, detail="Keyword cannot be empty.")
        
    stmt = select(AutoReplyRule).where(AutoReplyRule.keyword == keyword_clean)
    res = await db.execute(stmt)
    rule = res.scalar_one_or_none()
    
    if rule:
        rule.reply_text = payload.reply_text
        rule.is_active = payload.is_active if payload.is_active is not None else True
    else:
        rule = AutoReplyRule(
            keyword=keyword_clean,
            reply_text=payload.reply_text,
            is_active=payload.is_active if payload.is_active is not None else True
        )
        db.add(rule)
        
    await db.commit()
    await db.refresh(rule)
    return {"status": "success", "rule": rule.to_dict()}

@app.delete("/api/v1/chat/rules/{rule_id}")
async def delete_auto_reply_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Removes a chatbot auto-reply rule by its unique ID."""
    from sqlalchemy import delete
    stmt = delete(AutoReplyRule).where(AutoReplyRule.id == rule_id)
    await db.execute(stmt)
    await db.commit()
    return {"status": "success", "message": f"Rule ID {rule_id} deleted."}

@app.get("/api/v1/bot/flows")
async def get_bot_flows(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves all bot flows."""
    stmt = select(BotFlow).order_by(BotFlow.updated_at.desc())
    res = await db.execute(stmt)
    flows = res.scalars().all()
    return [f.to_dict() for f in flows]

@app.post("/api/v1/bot/flows")
async def save_bot_flow(
    payload: BotFlowPayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Saves or updates a bot flow. Automatically deactivates others if active is true."""
    if payload.is_active:
        from sqlalchemy import update
        if payload.template_name:
            from sqlalchemy import func
            await db.execute(
                update(BotFlow)
                .where(func.lower(BotFlow.template_name) == payload.template_name.lower())
                .values(is_active=False)
            )
        else:
            from sqlalchemy import or_
            await db.execute(
                update(BotFlow)
                .where(or_(BotFlow.template_name == None, BotFlow.template_name == ""))
                .values(is_active=False)
            )
        
    flow = None
    if payload.id is not None:
        stmt = select(BotFlow).where(BotFlow.id == payload.id)
        res = await db.execute(stmt)
        flow = res.scalar_one_or_none()
        
    if not flow:
        stmt = select(BotFlow).where(BotFlow.name == payload.name)
        res = await db.execute(stmt)
        flow = res.scalar_one_or_none()
    
    if flow:
        flow.name = payload.name
        flow.flow_data = payload.flow_data
        flow.is_active = payload.is_active if payload.is_active is not None else True
        flow.template_name = payload.template_name
    else:
        flow = BotFlow(
            name=payload.name,
            flow_data=payload.flow_data,
            is_active=payload.is_active if payload.is_active is not None else True,
            template_name=payload.template_name
        )
        db.add(flow)
        
    await db.commit()
    await db.refresh(flow)
    return {"status": "success", "flow": flow.to_dict()}

@app.delete("/api/v1/bot/flows/{flow_id}")
async def delete_bot_flow(
    flow_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Deletes a bot flow."""
    from sqlalchemy import delete
    stmt = delete(BotFlow).where(BotFlow.id == flow_id)
    await db.execute(stmt)
    await db.commit()
    return {"status": "success", "message": f"Flow ID {flow_id} deleted."}

# ==========================================
# AI BROCHURE & KNOWLEDGE BASE ENDPOINTS
# ==========================================

BROCHURES_DIR = os.path.join(PROJECT_ROOT, "backend", "uploads", "brochures")
os.makedirs(BROCHURES_DIR, exist_ok=True)

@app.get("/api/v1/brochures")
async def get_brochure_documents(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves all uploaded brochure documents."""
    stmt = select(BrochureDocument).order_by(BrochureDocument.uploaded_at.desc())
    res = await db.execute(stmt)
    docs = res.scalars().all()
    return [d.to_dict() for d in docs]

@app.post("/api/v1/brochures/upload")
async def upload_brochure_document(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Uploads a PDF/TXT brochure, extracts text content, and indexes it for AI Query Engine."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename missing.")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in [".pdf", ".txt", ".md"]:
        raise HTTPException(status_code=400, detail="Only PDF, TXT, or MD documents are supported.")

    import uuid
    saved_filename = f"{uuid.uuid4().hex}_{file.filename}"
    saved_path = os.path.join(BROCHURES_DIR, saved_filename)

    with open(saved_path, "wb") as buffer:
        content = await file.read()
        buffer.write(content)

    from brochure_service import extract_text_from_file
    extracted_text = extract_text_from_file(saved_path, file.filename)

    if not extracted_text.strip():
        raise HTTPException(
            status_code=400,
            detail="Could not extract readable text from document. Please ensure the PDF is not password protected or an un-OCR image."
        )

    doc_title = title if title and title.strip() else os.path.splitext(file.filename)[0]

    brochure = BrochureDocument(
        title=doc_title,
        filename=file.filename,
        file_path=saved_path,
        extracted_text=extracted_text,
        is_active=True
    )
    db.add(brochure)
    await db.commit()
    await db.refresh(brochure)

    return {"status": "success", "brochure": brochure.to_dict()}

@app.patch("/api/v1/brochures/{brochure_id}/toggle")
async def toggle_brochure_status(
    brochure_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Toggles active/inactive status of a brochure document."""
    stmt = select(BrochureDocument).where(BrochureDocument.id == brochure_id)
    res = await db.execute(stmt)
    doc = res.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Brochure document not found.")

    doc.is_active = not doc.is_active
    await db.commit()
    await db.refresh(doc)
    return {"status": "success", "brochure": doc.to_dict()}

@app.delete("/api/v1/brochures/{brochure_id}")
async def delete_brochure_document(
    brochure_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Deletes a brochure document from database and filesystem."""
    stmt = select(BrochureDocument).where(BrochureDocument.id == brochure_id)
    res = await db.execute(stmt)
    doc = res.scalar_one_or_none()
    if doc:
        if os.path.exists(doc.file_path):
            try:
                os.remove(doc.file_path)
            except Exception as e:
                logger.warning(f"Could not remove physical file {doc.file_path}: {e}")
        await db.delete(doc)
        await db.commit()

    return {"status": "success", "message": f"Brochure ID {brochure_id} deleted."}

# ==========================================
# WEBSITE CRAWLER & INDEXER ENDPOINTS
# ==========================================

@app.get("/api/v1/website/pages")
async def get_website_pages(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves all indexed website knowledge pages."""
    stmt = select(WebsiteKnowledge).order_by(WebsiteKnowledge.crawled_at.desc())
    res = await db.execute(stmt)
    pages = res.scalars().all()
    return [p.to_dict() for p in pages]

@app.post("/api/v1/website/crawl")
async def crawl_website_endpoint(
    payload: CrawlWebsitePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Crawls an institutional website domain and indexes all internal pages into the AI Knowledge Base."""
    from crawler_service import crawl_website
    crawl_result = await crawl_website(root_url=payload.url, max_pages=payload.max_pages or 25)

    crawled_pages = crawl_result.get("pages", [])
    if not crawled_pages:
        raise HTTPException(
            status_code=400,
            detail="Could not extract readable page content from the provided website URL. Please check the domain link."
        )

    saved_records = []
    for page in crawled_pages:
        stmt = select(WebsiteKnowledge).where(WebsiteKnowledge.url == page["url"])
        res = await db.execute(stmt)
        existing_page = res.scalar_one_or_none()

        if existing_page:
            existing_page.title = page["title"]
            existing_page.extracted_text = page["text"]
            existing_page.domain = page["domain"]
            existing_page.is_active = True
            saved_records.append(existing_page)
        else:
            new_page = WebsiteKnowledge(
                url=page["url"],
                domain=page["domain"],
                title=page["title"],
                extracted_text=page["text"],
                is_active=True
            )
            db.add(new_page)
            saved_records.append(new_page)

    await db.commit()
    return {
        "status": "success",
        "domain": crawl_result.get("domain"),
        "pages_crawled": len(saved_records)
    }

@app.patch("/api/v1/website/pages/{page_id}/toggle")
async def toggle_website_page_status(
    page_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Toggles active status of an indexed website knowledge page."""
    stmt = select(WebsiteKnowledge).where(WebsiteKnowledge.id == page_id)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Indexed web page not found.")

    page.is_active = not page.is_active
    await db.commit()
    await db.refresh(page)
    return {"status": "success", "page": page.to_dict()}

@app.delete("/api/v1/website/pages/{page_id}")
async def delete_website_page(
    page_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Deletes an indexed website page from AI Knowledge Base."""
    stmt = select(WebsiteKnowledge).where(WebsiteKnowledge.id == page_id)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if page:
        await db.delete(page)
        await db.commit()

    return {"status": "success", "message": f"Website page ID {page_id} deleted."}

# Contacts Management APIs
@app.get("/api/v1/contacts")
async def get_contacts_list(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=5000),
    search: Optional[str] = None,
    branch: Optional[str] = None,
    pipeline_tag: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves paginated, filtered contact list for the contacts directory."""
    stmt = select(Record)
    count_stmt = select(func.count()).select_from(Record)
    
    if search:
        search_pattern = f"%{search}%"
        filter_cond = or_(
            Record.student_name.ilike(search_pattern),
            Record.parent_name.ilike(search_pattern),
            Record.phone_number.ilike(search_pattern),
            Record.parent_phone_number.ilike(search_pattern),
            Record.selected_branch.ilike(search_pattern)
        )
        stmt = stmt.where(filter_cond)
        count_stmt = count_stmt.where(filter_cond)
        
    if branch and branch.lower() != "all":
        stmt = stmt.where(Record.selected_branch == branch)
        count_stmt = count_stmt.where(Record.selected_branch == branch)
        
    if pipeline_tag and pipeline_tag.lower() != "all":
        stmt = stmt.where(Record.pipeline_tag == pipeline_tag)
        count_stmt = count_stmt.where(Record.pipeline_tag == pipeline_tag)
        
    # Counselors only see contacts assigned to them or unassigned
    if (current_user.role or "super_admin") == "counselor":
        counselor_filter = or_(
            Record.assigned_counselor_id == current_user.id,
            Record.assigned_counselor_id.is_(None)
        )
        stmt = stmt.where(counselor_filter)
        count_stmt = count_stmt.where(counselor_filter)

    # Order by newest contacts first
    stmt = stmt.order_by(Record.created_at.desc()).offset((page - 1) * limit).limit(limit)
    
    res = await db.execute(stmt)
    contacts = res.scalars().all()
    
    count_res = await db.execute(count_stmt)
    total_count = count_res.scalar() or 0
    
    return {
        "contacts": [c.to_dict() for c in contacts],
        "total": total_count,
        "page": page,
        "limit": limit
    }

class AssignLeadPayload(BaseModel):
    counselor_id: Optional[int] = None
    counselor_name: Optional[str] = None

@app.post("/api/v1/contacts/{contact_id}/assign")
@app.patch("/api/v1/contacts/{contact_id}/assign")
async def assign_contact_lead(
    contact_id: int,
    payload: AssignLeadPayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Assigns or re-assigns a student/parent lead to an admission counselor."""
    stmt = select(Record).where(Record.id == contact_id)
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact lead not found.")
        
    if payload.counselor_id:
        c_stmt = select(AdminUser).where(AdminUser.id == payload.counselor_id)
        c_res = await db.execute(c_stmt)
        counselor = c_res.scalar_one_or_none()
        if counselor:
            contact.assigned_counselor_id = counselor.id
            contact.assigned_counselor_name = counselor.full_name or counselor.username
        else:
            contact.assigned_counselor_id = payload.counselor_id
            contact.assigned_counselor_name = payload.counselor_name or "Counselor"
        contact.counselor_status = 'pending'
    else:
        contact.assigned_counselor_id = None
        contact.assigned_counselor_name = None
        
    await db.commit()
    await db.refresh(contact)
    return {"status": "success", "contact": contact.to_dict()}

@app.post("/api/v1/contacts/{contact_id}/auto-assign")
async def auto_assign_lead(
    contact_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """
    Dynamically balances lead distribution among active counselors:
    1. Fetches all active counselor accounts.
    2. Queries current assigned lead count for each counselor.
    3. Selects the counselor with the MINIMUM number of assigned leads.
    4. Automatically assigns contact_id to that counselor.
    """
    stmt = select(Record).where(Record.id == contact_id)
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact lead not found.")

    # 1. Fetch active counselors
    counselors_stmt = select(AdminUser).where(
        and_(AdminUser.is_active == True, AdminUser.role == 'counselor')
    )
    counselors_res = await db.execute(counselors_stmt)
    counselors = counselors_res.scalars().all()

    if not counselors:
        counselors_stmt = select(AdminUser).where(AdminUser.is_active == True)
        counselors_res = await db.execute(counselors_stmt)
        counselors = counselors_res.scalars().all()

    if not counselors:
        raise HTTPException(status_code=400, detail="No active counselor accounts found to assign lead.")

    # 2. Count active pending assigned leads for each active counselor (excluding completed)
    counts = {}
    for c in counselors:
        count_stmt = select(func.count()).select_from(Record).where(
            and_(
                Record.assigned_counselor_id == c.id,
                or_(
                    Record.counselor_status == None,
                    Record.counselor_status != 'completed'
                )
            )
        )
        count_res = await db.execute(count_stmt)
        counts[c.id] = count_res.scalar() or 0

    # 3. Find counselor with minimum assigned lead count (lowest workload)
    min_counselor_id = min(counts, key=counts.get)
    selected_counselor = next(c for c in counselors if c.id == min_counselor_id)

    # 4. Update contact record
    contact.assigned_counselor_id = selected_counselor.id
    contact.assigned_counselor_name = selected_counselor.full_name or selected_counselor.username
    contact.counselor_status = 'pending'

    await db.commit()
    await db.refresh(contact)

    return {
        "status": "success",
        "assigned_to": selected_counselor.to_dict(),
        "workload_counts": counts,
        "contact": contact.to_dict()
    }

@app.get("/api/v1/users/workload")
async def get_counselors_workload(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Returns list of active counselors with their current active pending lead counts."""
    counselors_stmt = select(AdminUser).where(AdminUser.is_active == True)
    counselors_res = await db.execute(counselors_stmt)
    counselors = counselors_res.scalars().all()

    workload = []
    for c in counselors:
        count_stmt = select(func.count()).select_from(Record).where(
            and_(
                Record.assigned_counselor_id == c.id,
                or_(
                    Record.counselor_status == None,
                    Record.counselor_status != 'completed'
                )
            )
        )
        count_res = await db.execute(count_stmt)
        workload.append({
            "counselor": c.to_dict(),
            "assigned_lead_count": count_res.scalar() or 0
        })

    return {"workload": workload}

class UpdateLeadNotesPayload(BaseModel):
    notes: Optional[str] = None
    pipeline_tag: Optional[str] = None

@app.patch("/api/v1/contacts/{contact_id}/notes")
async def update_contact_notes(
    contact_id: int,
    payload: UpdateLeadNotesPayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Updates counselor call notes and lead pipeline stage."""
    stmt = select(Record).where(Record.id == contact_id)
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact lead not found.")
        
    if payload.notes is not None:
        contact.counselor_notes = payload.notes
    if payload.pipeline_tag:
        contact.pipeline_tag = payload.pipeline_tag
        
    await db.commit()
    await db.refresh(contact)
    return {"status": "success", "contact": contact.to_dict()}

@app.post("/api/v1/contacts")
async def create_contact(
    payload: ContactCreatePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Manually creates a new contact entry."""
    raw_phone = payload.phone_number.strip()
    cleaned_phone = "".join(filter(str.isdigit, raw_phone))
    if len(cleaned_phone) == 10:
        cleaned_phone = "91" + cleaned_phone
    elif len(cleaned_phone) < 10:
        raise HTTPException(status_code=400, detail="Invalid phone number. Must be at least 10 digits.")

    cleaned_parent_phone = None
    if payload.parent_phone_number and payload.parent_phone_number.strip():
        raw_p = payload.parent_phone_number.strip()
        cleaned_p = "".join(filter(str.isdigit, raw_p))
        if len(cleaned_p) == 10:
            cleaned_p = "91" + cleaned_p
        if len(cleaned_p) >= 10:
            cleaned_parent_phone = cleaned_p

    # Check duplicate
    stmt = select(Record).where(Record.phone_number == cleaned_phone)
    res = await db.execute(stmt)
    existing = res.scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=400, 
            detail=f"A contact with phone number {cleaned_phone} already exists."
        )
        
    contact = Record(
        student_name=payload.student_name.strip(),
        parent_name=payload.parent_name.strip(),
        phone_number=cleaned_phone,
        parent_phone_number=cleaned_parent_phone,
        selected_branch=payload.selected_branch.strip(),
        pipeline_tag=payload.pipeline_tag or "Lead",
        campaign_status="Pending",
        delivery_status="Unsent",
        parent_response="No Response",
        variables={
            "student_name": payload.student_name.strip(),
            "parent_name": payload.parent_name.strip(),
            "selected_branch": payload.selected_branch.strip()
        }
    )
    db.add(contact)
    await db.commit()
    await db.refresh(contact)
    return {"status": "success", "contact": contact.to_dict()}

@app.put("/api/v1/contacts/{id}")
async def update_contact(
    id: int,
    payload: ContactUpdatePayload,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Updates an existing contact's details."""
    stmt = select(Record).where(Record.id == id)
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found.")
        
    if payload.student_name is not None:
        contact.student_name = payload.student_name.strip()
    if payload.parent_name is not None:
        contact.parent_name = payload.parent_name.strip()
    if payload.selected_branch is not None:
        contact.selected_branch = payload.selected_branch.strip()
    if payload.pipeline_tag is not None:
        contact.pipeline_tag = payload.pipeline_tag
        
    if payload.phone_number is not None:
        raw_phone = payload.phone_number.strip()
        cleaned_phone = "".join(filter(str.isdigit, raw_phone))
        if len(cleaned_phone) == 10:
            cleaned_phone = "91" + cleaned_phone
        elif len(cleaned_phone) < 10:
            raise HTTPException(status_code=400, detail="Invalid phone number. Must be at least 10 digits.")
            
        dup_stmt = select(Record).where(Record.phone_number == cleaned_phone, Record.id != id)
        dup_res = await db.execute(dup_stmt)
        dup = dup_res.scalar_one_or_none()
        if dup:
            raise HTTPException(
                status_code=400, 
                detail=f"Another contact with phone number {cleaned_phone} already exists."
            )
        contact.phone_number = cleaned_phone

    if payload.parent_phone_number is not None:
        raw_p = payload.parent_phone_number.strip() if payload.parent_phone_number else ""
        if raw_p:
            cleaned_p = "".join(filter(str.isdigit, raw_p))
            if len(cleaned_p) == 10:
                cleaned_p = "91" + cleaned_p
            contact.parent_phone_number = cleaned_p if len(cleaned_p) >= 10 else None
        else:
            contact.parent_phone_number = None
        
    # Update variables values too
    vars_dict = dict(contact.variables or {})
    vars_dict.update({
        "student_name": contact.student_name,
        "parent_name": contact.parent_name,
        "selected_branch": contact.selected_branch
    })
    contact.variables = vars_dict
    
    await db.commit()
    await db.refresh(contact)
    return {"status": "success", "contact": contact.to_dict()}

@app.delete("/api/v1/contacts/{id}")
async def delete_contact(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Deletes a contact by ID (cascades chat histories & logs)."""
    from sqlalchemy import delete
    stmt = select(Record).where(Record.id == id)
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found.")
        
    await db.execute(delete(Record).where(Record.id == id))
    await db.commit()
    return {"status": "success", "message": f"Contact ID {id} deleted successfully."}

@app.post("/api/v1/contacts/upload")
async def upload_contacts(
    file: UploadFile = File(...), 
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Parses Excel/CSV file, normalizes phone numbers, and inserts/updates records WITHOUT resetting campaign log histories."""
    logger.info(f"upload_contacts: started parsing file '{file.filename}'...")
    if not (file.filename.endswith(".xlsx") or file.filename.endswith(".csv")):
        raise HTTPException(
            status_code=400, 
            detail="Unsupported file format. Please upload a valid Excel (.xlsx) or CSV (.csv) file."
        )
        
    try:
        df = await parse_spreadsheet_safely(file)
        logger.info(f"upload_contacts: df parsing complete, shape={df.shape}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to read file: {e}")
        raise HTTPException(status_code=400, detail=f"File parse error: {str(e)}")

    columns = [str(c).strip().lower() for c in df.columns]
    
    student_col = None
    parent_col = None
    branch_col = None
    phone_col = None
    parent_phone_col = None
    
    for i, col in enumerate(columns):
        if col in ["student name", "student_name", "student", "candidate name", "candidate"]:
            student_col = df.columns[i]
        elif col in ["parent name", "parent_name", "father name", "mother name", "parent", "guardian name"]:
            parent_col = df.columns[i]
        elif col in ["selected branch", "selected_branch", "branch", "course", "selected course"]:
            branch_col = df.columns[i]
        elif col in ["parent phone number", "parent_phone_number", "parent phone", "parent mobile", "parent_mobile", "father mobile", "father phone", "mother mobile", "mother phone", "parent_phone_no", "parent contact", "parent_contact"]:
            parent_phone_col = df.columns[i]
        elif col in ["phone number", "phone_number", "phone", "mobile", "mobile number", "contact", "phone_no", "student phone number", "student_phone_number", "student phone", "student mobile"]:
            phone_col = df.columns[i]

    if not phone_col:
        logger.warning("upload_contacts: Phone Number column is missing")
        raise HTTPException(
            status_code=400,
            detail="Phone Number column is missing. Please verify your spreadsheet contains a phone number header."
        )

    phone_numbers = []
    records_to_process = []
    
    for _, row in df.iterrows():
        raw_phone = str(row[phone_col]).strip()
        if not raw_phone or pd.isna(row[phone_col]) or raw_phone.lower() == "nan":
            continue
            
        cleaned_phone = "".join(filter(str.isdigit, raw_phone))
        
        if len(cleaned_phone) == 10:
            cleaned_phone = "91" + cleaned_phone
        elif len(cleaned_phone) < 10:
            continue

        parent_phone = None
        if parent_phone_col and not pd.isna(row[parent_phone_col]):
            raw_parent_phone = str(row[parent_phone_col]).strip()
            if raw_parent_phone and raw_parent_phone.lower() != "nan":
                cleaned_parent = "".join(filter(str.isdigit, raw_parent_phone))
                if len(cleaned_parent) == 10:
                    parent_phone = "91" + cleaned_parent
                elif len(cleaned_parent) >= 10:
                    parent_phone = cleaned_parent
            
        student_name = str(row[student_col]).strip() if student_col and not pd.isna(row[student_col]) else "N/A"
        parent_name = str(row[parent_col]).strip() if parent_col and not pd.isna(row[parent_col]) else "N/A"
        branch = str(row[branch_col]).strip() if branch_col and not pd.isna(row[branch_col]) else "N/A"
        
        if student_name.lower() == "nan": student_name = "N/A"
        if parent_name.lower() == "nan": parent_name = "N/A"
        if branch.lower() == "nan": branch = "N/A"
        
        row_variables = {}
        for col in df.columns:
            val = row[col]
            if not pd.isna(val):
                cleaned_val = str(val).strip()
                row_variables[str(col).strip().lower()] = cleaned_val
                norm_col = str(col).strip().lower().replace("_", "").replace(" ", "")
                if norm_col in ["studentname", "student", "candidatename", "candidate"]:
                    row_variables["student_name"] = cleaned_val
                    row_variables["student"] = cleaned_val
                elif norm_col in ["parentname", "parent", "fathername", "mothername", "guardianname", "guardian"]:
                    row_variables["parent_name"] = cleaned_val
                    row_variables["parent"] = cleaned_val
                elif norm_col in ["selectedbranch", "branch", "course", "selectedcourse", "status", "admissionstatus"]:
                    row_variables["selected_branch"] = cleaned_val
                    row_variables["branch"] = cleaned_val
                    row_variables["status"] = cleaned_val
        
        phone_numbers.append(cleaned_phone)
        records_to_process.append({
            "student_name": student_name,
            "parent_name": parent_name,
            "selected_branch": branch,
            "phone_number": cleaned_phone,
            "parent_phone_number": parent_phone,
            "variables": row_variables
        })

    if not records_to_process:
        logger.warning("upload_contacts: no valid records parsed")
        raise HTTPException(status_code=400, detail="No valid records parsed from the sheet.")

    logger.info(f"upload_contacts: querying {len(phone_numbers)} phone numbers from db...")
    stmt = select(Record).where(Record.phone_number.in_(phone_numbers))
    result = await db.execute(stmt)
    existing_records = {r.phone_number: r for r in result.scalars().all()}
    
    added_count = 0
    updated_count = 0
    
    for record_data in records_to_process:
        phone = record_data["phone_number"]
        if phone in existing_records:
            # Upsert contact info without resetting campaign statuses
            rec = existing_records[phone]
            rec.student_name = record_data["student_name"]
            rec.parent_name = record_data["parent_name"]
            rec.selected_branch = record_data["selected_branch"]
            if record_data.get("parent_phone_number"):
                rec.parent_phone_number = record_data["parent_phone_number"]
            rec.variables = {**(rec.variables or {}), **record_data["variables"]}
            updated_count += 1
        else:
            rec = Record(
                student_name=record_data["student_name"],
                parent_name=record_data["parent_name"],
                selected_branch=record_data["selected_branch"],
                phone_number=phone,
                parent_phone_number=record_data.get("parent_phone_number"),
                variables=record_data["variables"],
                campaign_status="Pending",
                delivery_status="Unsent",
                parent_response="No Response"
            )
            db.add(rec)
            added_count += 1

    await db.commit()
    return {
        "status": "success",
        "message": f"Excel parsed successfully. Added {added_count} new contacts, updated {updated_count} existing contacts.",
        "columns": df.columns.tolist(),
        "added": added_count,
        "updated": updated_count
    }


# --- SPA Catch-All Fallback Route ---
# Serves index.html for any frontend React routes (e.g. /super-admin/dashboard, /counselor/inbox) on hard refresh (F5)
@app.get("/{full_path:path}", response_class=HTMLResponse)
async def serve_spa_fallback(request: Request, full_path: str):
    """Fallback handler to support client-side React SPA routing on page refresh."""
    # Don't intercept API requests
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API endpoint not found.")
        
    react_index = os.path.join(DIST_DIR, "index.html")
    if os.path.exists(react_index):
        return FileResponse(react_index)
        
    legacy_index = os.path.join(templates_path, "index.html")
    if os.path.exists(legacy_index):
        return templates.TemplateResponse(request, "index.html")
        
    raise HTTPException(status_code=404, detail="Frontend build index.html not found.")
