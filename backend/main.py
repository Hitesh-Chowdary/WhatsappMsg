import io
import os
import sys
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Query, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel, Field
import pandas as pd
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

# Setup path logic to ensure clean imports when running from root or backend folder
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)

if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

from database import init_db, get_db, Record, AsyncSessionLocal, CampaignTemplate, AdminUser
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
    event: str = Field(..., description="'status_update' or 'quick_reply'")
    message_id: str = Field(..., description="Unique message tracking identifier from provider")
    status: Optional[str] = Field(None, description="'sent', 'delivered', 'read', or 'failed'")
    button_text: Optional[str] = Field(None, description="'Interested' or 'Not Interested'")

class SimulationPayload(BaseModel):
    record_id: int
    target_state: str = Field(..., description="'delivered', 'read', 'failed', 'Interested', or 'Not Interested'")

class TemplatePayload(BaseModel):
    template_name: str = Field(..., description="Name of the template")
    template_text: str = Field(..., max_length=1000, description="Custom WhatsApp campaign template text.")
    media_type: Optional[str] = Field("none", description="'none', 'image', or 'document'")
    media_url: Optional[str] = Field(None, max_length=1000, description="URL of attached media")
    language: Optional[str] = Field("en", description="Language code (e.g. 'en', 'en_US')")
    variable_names: Optional[str] = Field("", description="Comma-separated variable names")

class SetActiveTemplatePayload(BaseModel):
    template_name: str = Field(..., description="Name of the template to set active")

class BulkSendPayload(BaseModel):
    record_ids: List[int]

# Background task for bulk message broadcasting
async def run_broadcast_campaign(db_session_factory, whatsapp_client: WhatsAppClient, base_url: Optional[str] = None):
    logger.info("Starting background campaign broadcast...")
    async with db_session_factory() as db:
        # Fetch the active template text
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalar_one_or_none()
        
        # Fallback to first if none active
        if not template_obj:
            tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalar_one_or_none()
            
        template_name = template_obj.template_name if template_obj else "admission_outreach"
        template_text = template_obj.template_text if template_obj else (
            "Dear [Parent Name], greetings from College Admissions. Your child [Student Name] "
            "has been selected for the [Selected Branch] branch. To block the seat, please pay the "
            "₹50,000 advance fee. Click below to confirm interest: [Interested] / [Not Interested]"
        )
        media_type = template_obj.media_type if template_obj else "none"
        media_url = template_obj.media_url if template_obj else None
        if media_url and media_url.startswith("/") and base_url:
            media_url = f"{base_url.rstrip('/')}{media_url}"
        template_language = template_obj.language if template_obj else "en_US"
        variable_names = template_obj.variable_names if template_obj else ""

        # Fetch all pending records
        stmt = select(Record).where(Record.campaign_status == "Pending")
        result = await db.execute(stmt)
        pending_records = result.scalars().all()
        
        logger.info(f"Found {len(pending_records)} pending records to send.")
        for record in pending_records:
            try:
                # Compile template variables dynamically
                msg_body = template_text
                msg_body = msg_body.replace("[Parent Name]", record.parent_name)
                msg_body = msg_body.replace("[Student Name]", record.student_name)
                msg_body = msg_body.replace("[Selected Branch]", record.selected_branch)
                msg_body = msg_body.replace("[Phone Number]", record.phone_number)

                response = await whatsapp_client.send_message(
                    to_phone=record.phone_number,
                    message_body=msg_body,
                    media_type=media_type,
                    media_url=media_url,
                    template_variables={
                        "student": record.student_name,
                        "branch": record.selected_branch,
                        "status": record.selected_branch,
                        "student_name": record.student_name,
                        "selected_branch": record.selected_branch,
                        "parent_name": record.parent_name
                    },
                    template_name=template_name,
                    template_language=template_language,
                    variable_names=[v.strip() for v in variable_names.split(",") if v.strip()] if variable_names else []
                )
                if response.get("status") == "success":
                    record.message_id = response.get("message_id")
                    record.sent_template = template_name
                    record.campaign_status = "Sent"
                    record.delivery_status = "Sent"
                    record.sent_at = datetime.utcnow()
                else:
                    record.campaign_status = "Failed"
                    record.delivery_status = "Failed"
            except Exception as e:
                logger.error(f"Error broadcasting to {record.phone_number} (ID: {record.id}): {e}")
                record.campaign_status = "Failed"
                record.delivery_status = "Failed"
            
            # Commit after each message to update the database states in real-time
            await db.commit()
            
    logger.info("Background campaign broadcast completed.")

async def run_bulk_send_campaign(db_session_factory, whatsapp_client: WhatsAppClient, record_ids: List[int], base_url: Optional[str] = None):
    logger.info(f"Starting background bulk send campaign for {len(record_ids)} records...")
    async with db_session_factory() as db:
        # Fetch the active template text
        tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalar_one_or_none()
        
        # Fallback to first if none active
        if not template_obj:
            tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
            tmpl_res = await db.execute(tmpl_stmt)
            template_obj = tmpl_res.scalar_one_or_none()
            
        template_name = template_obj.template_name if template_obj else "admission_outreach"
        template_text = template_obj.template_text if template_obj else (
            "Dear [Parent Name], greetings from College Admissions. Your child [Student Name] "
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
        
        for record in records:
            # Skip if confirmed Interested (outbox safeguard)
            if record.parent_response == "Interested":
                logger.info(f"Skipping record ID {record.id} because parent is Interested.")
                continue
                
            try:
                # Compile template variables dynamically
                msg_body = template_text
                msg_body = msg_body.replace("[Parent Name]", record.parent_name)
                msg_body = msg_body.replace("[Student Name]", record.student_name)
                msg_body = msg_body.replace("[Selected Branch]", record.selected_branch)
                msg_body = msg_body.replace("[Phone Number]", record.phone_number)

                response = await whatsapp_client.send_message(
                    to_phone=record.phone_number,
                    message_body=msg_body,
                    media_type=media_type,
                    media_url=media_url,
                    template_variables={
                        "student": record.student_name,
                        "branch": record.selected_branch,
                        "status": record.selected_branch,
                        "student_name": record.student_name,
                        "selected_branch": record.selected_branch,
                        "parent_name": record.parent_name
                    },
                    template_name=template_name,
                    template_language=template_language,
                    variable_names=[v.strip() for v in variable_names.split(",") if v.strip()] if variable_names else []
                )
                if response.get("status") == "success":
                    record.message_id = response.get("message_id")
                    record.sent_template = template_name
                    record.campaign_status = "Sent"
                    record.delivery_status = "Sent"
                    record.parent_response = "No Response"
                    record.sent_at = datetime.utcnow()
                    record.delivered_at = None
                    record.read_at = None
                    record.responded_at = None
                else:
                    record.campaign_status = "Failed"
                    record.delivery_status = "Failed"
            except Exception as e:
                logger.error(f"Error bulk dispatching to {record.phone_number} (ID: {record.id}): {e}")
                record.campaign_status = "Failed"
                record.delivery_status = "Failed"
            
            await db.commit()
            
    logger.info("Background bulk send campaign completed.")

# FastAPI lifespan for database setup
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Setup table schemas in PostgreSQL
    try:
        await init_db()
        logger.info("PostgreSQL schemas verified and initialized.")
    except Exception as e:
        logger.error(f"Failed to initialize PostgreSQL: {e}. Ensure DATABASE_URL is valid.")
    yield

app = FastAPI(
    title="College Admission Automation Engine",
    description="Backend routing and webhook processing pipelines.",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for external/local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
JWT_SECRET = os.getenv("JWT_SECRET", "supersecretkeychangeinproduction_9f83ea01")
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

@app.post("/api/v1/auth/login")
async def login(payload: LoginPayload, db: AsyncSession = Depends(get_db)):
    """Verifies administrator credentials and issues a JWT token."""
    logger.info(f"Login attempt for user: {payload.username}")
    
    # Fetch admin user
    stmt = select(AdminUser).where(AdminUser.username == payload.username)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
        
    # Verify password using bcrypt
    pwd_bytes = payload.password.encode("utf-8")
    hashed_bytes = user.hashed_password.encode("utf-8")
    if not bcrypt.checkpw(pwd_bytes, hashed_bytes):
        raise HTTPException(status_code=401, detail="Invalid username or password")
        
    # Issue JWT
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "username": user.username
    }

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
        contents = await file.read()
        logger.info(f"upload_records: file read complete, size={len(contents)} bytes")
        if file.filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(contents))
        else:
            df = pd.read_excel(io.BytesIO(contents))
        logger.info(f"upload_records: df parsing complete, shape={df.shape}")
    except Exception as e:
        logger.error(f"Failed to read file: {e}")
        raise HTTPException(status_code=400, detail=f"File parse error: {str(e)}")

    # Case-insensitive column matching
    columns = [str(c).strip().lower() for c in df.columns]
    
    student_col = None
    parent_col = None
    branch_col = None
    phone_col = None
    
    for i, col in enumerate(columns):
        if col in ["student name", "student_name", "student", "candidate name", "candidate"]:
            student_col = df.columns[i]
        elif col in ["parent name", "parent_name", "father name", "mother name", "parent", "guardian name"]:
            parent_col = df.columns[i]
        elif col in ["selected branch", "selected_branch", "branch", "course", "selected course"]:
            branch_col = df.columns[i]
        elif col in ["phone number", "phone_number", "phone", "mobile", "mobile number", "contact", "phone_no"]:
            phone_col = df.columns[i]

    missing = []
    if not student_col: missing.append("Student Name")
    if not parent_col: missing.append("Parent Name")
    if not branch_col: missing.append("Selected Branch")
    if not phone_col: missing.append("Phone Number")
    
    if missing:
        logger.warning(f"upload_records: missing columns {missing}")
        raise HTTPException(
            status_code=400,
            detail=f"Required columns missing: {', '.join(missing)}. Please verify your spreadsheet layout."
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
            
        student_name = str(row[student_col]).strip()
        parent_name = str(row[parent_col]).strip()
        branch = str(row[branch_col]).strip()
        
        if not student_name or not parent_name:
            continue
            
        phone_numbers.append(cleaned_phone)
        records_to_process.append({
            "student_name": student_name,
            "parent_name": parent_name,
            "selected_branch": branch,
            "phone_number": cleaned_phone
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
    
    for record_data in records_to_process:
        phone = record_data["phone_number"]
        if phone in existing_records:
            # Overwrite existing record and reset statuses for retry campaigns
            rec = existing_records[phone]
            rec.student_name = record_data["student_name"]
            rec.parent_name = record_data["parent_name"]
            rec.selected_branch = record_data["selected_branch"]
            rec.campaign_status = "Pending"
            rec.delivery_status = "Unsent"
            rec.parent_response = "No Response"
            rec.message_id = None
            rec.sent_at = None
            rec.delivered_at = None
            rec.read_at = None
            rec.responded_at = None
            updated_count += 1
        else:
            # Create a brand new record
            rec = Record(
                student_name=record_data["student_name"],
                parent_name=record_data["parent_name"],
                selected_branch=record_data["selected_branch"],
                phone_number=phone,
                campaign_status="Pending",
                delivery_status="Unsent",
                parent_response="No Response"
            )
            db.add(rec)
            added_count += 1
            
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
                "text": "*_Dr. RVR NRI INSTITUTE OF TECHNOLOGY_*\n\nDear {{parent_name}}, greetings from College Admissions. Your child {{student_name}} has been selected for the {{selected_branch}} branch. To block the seat, please pay the ₹50,000 advance fee. Click below to confirm",
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
                        
            # Determine default variable names list based on text analysis or placeholders
            if name == "parent_outreach":
                variable_names = "parent_name,student_name,selected_branch"
            elif name == "admission_outreach":
                variable_names = "student,status"
            else:
                # Count placeholders (e.g. {{1}}, {{2}}...)
                import re
                placeholders = re.findall(r"\{\{(\d+)\}\}", body_text)
                if placeholders:
                    variable_names = ",".join([f"var_{p}" for p in placeholders])
                else:
                    variable_names = ""
                    
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
        tmpl = res.scalar_one_or_none()
        
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
    active_t = res.scalar_one_or_none()
    if not active_t:
        stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc())
        res = await db.execute(stmt)
        first_t = res.scalar_one_or_none()
        if first_t:
            first_t.is_active = True
            
    await db.commit()
        
    return {
        "status": "success",
        "synced": synced_count,
        "message": f"Successfully synced {synced_count} pre-approved templates from Meta."
    }

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
        contents = await file.read()
        with open(file_path, "wb") as f:
            f.write(contents)
    except Exception as e:
        logger.error(f"Failed to write template media file: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
        
    # Return URLs
    return {
        "status": "success",
        "filename": file.filename,
        "media_url": f"/static/media/{safe_filename}",
        "full_url": f"http://localhost:8000/static/media/{safe_filename}"
    }

def get_request_base_url(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
    return f"{proto}://{host}"

# Bulk Trigger Broadcast
@app.post("/api/v1/campaign/broadcast")
async def broadcast_campaign(
    request: Request,
    background_tasks: BackgroundTasks, 
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Launches the broadcast campaign for all Pending records in the background."""
    stmt = select(func.count(Record.id)).where(Record.campaign_status == "Pending")
    result = await db.execute(stmt)
    pending_count = result.scalar() or 0
    
    if pending_count == 0:
        return {"status": "ignored", "message": "No pending records found to dispatch."}
        
    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
    base_url = get_request_base_url(request)
    background_tasks.add_task(run_broadcast_campaign, AsyncSessionLocal, client, base_url)
    
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
    stmt = select(func.count(Record.id)).where(
        Record.id.in_(payload.record_ids),
        Record.parent_response != "Interested"
    )
    result = await db.execute(stmt)
    eligible_count = result.scalar() or 0
    
    if eligible_count == 0:
        return {"status": "ignored", "message": "No eligible records selected for bulk dispatch (confirmed Interested are skipped)."}
        
    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
    base_url = get_request_base_url(request)
    background_tasks.add_task(run_bulk_send_campaign, AsyncSessionLocal, client, payload.record_ids, base_url)
    
    return {
        "status": "success",
        "message": f"Bulk campaign dispatch launched in background for {eligible_count} records."
    }

# Single-Target Trigger Dispatch

@app.post("/api/v1/campaign/send-single/{id}")
async def send_single_message(
    id: int, 
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Triggers an individual WhatsApp message to a specific contact ID (retry override)."""
    stmt = select(Record).where(Record.id == id)
    result = await db.execute(stmt)
    record = result.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Student record not found.")
        
    # Fetch active custom template
    tmpl_stmt = select(CampaignTemplate).where(CampaignTemplate.is_active == True).limit(1)
    tmpl_res = await db.execute(tmpl_stmt)
    template_obj = tmpl_res.scalar_one_or_none()
    
    # Fallback to first if none active
    if not template_obj:
        tmpl_stmt = select(CampaignTemplate).order_by(CampaignTemplate.id.asc()).limit(1)
        tmpl_res = await db.execute(tmpl_stmt)
        template_obj = tmpl_res.scalar_one_or_none()
        
    template_name = template_obj.template_name if template_obj else "admission_outreach"
    template_text = template_obj.template_text if template_obj else (
        "Dear [Parent Name], greetings from College Admissions. Your child [Student Name] "
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

    # Compile message text
    msg_body = template_text
    msg_body = msg_body.replace("[Parent Name]", record.parent_name)
    msg_body = msg_body.replace("[Student Name]", record.student_name)
    msg_body = msg_body.replace("[Selected Branch]", record.selected_branch)
    msg_body = msg_body.replace("[Phone Number]", record.phone_number)

    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
    try:
        response = await client.send_message(
            to_phone=record.phone_number,
            message_body=msg_body,
            media_type=media_type,
            media_url=media_url,
            template_variables={
                "student": record.student_name,
                "branch": record.selected_branch,
                "status": record.selected_branch,
                "student_name": record.student_name,
                "selected_branch": record.selected_branch,
                "parent_name": record.parent_name
            },
            template_name=template_name,
            template_language=template_language,
            variable_names=[v.strip() for v in variable_names.split(",") if v.strip()] if variable_names else []
        )
        if response.get("status") == "success":
            record.message_id = response.get("message_id")
            record.sent_template = template_name
            record.campaign_status = "Sent"
            record.delivery_status = "Sent"
            record.parent_response = "No Response"
            record.sent_at = datetime.utcnow()
            record.delivered_at = None
            record.read_at = None
            record.responded_at = None
            await db.commit()
            return {
                "status": "success",
                "message": f"Message sent to {record.parent_name}.",
                "record": record.to_dict()
            }
        else:
            record.campaign_status = "Failed"
            record.delivery_status = "Failed"
            await db.commit()
            raise HTTPException(status_code=500, detail="WhatsApp gateway failed to send message.")
    except Exception as e:
        logger.error(f"Failed to send single campaign to ID {id}: {e}")
        record.campaign_status = "Failed"
        record.delivery_status = "Failed"
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
    stmt = select(Record).where(Record.message_id == message_id)
    result = await db.execute(stmt)
    record = result.scalar_one_or_none()
    
    if not record:
        logger.warning(f"Webhook event ignored: message_id '{message_id}' not found in database.")
        return {"status": "ignored", "reason": "unknown_message_id"}
        
    if event == "status_update":
        status_val = status.lower() if status else ""
        if status_val in ["sent", "delivered", "read", "failed"]:
            if status_val == "read":
                display_status = "Read"
            elif status_val == "failed":
                display_status = "Failed"
            else:
                display_status = status_val.capitalize()
                
            record.delivery_status = display_status
            
            if status_val == "sent":
                record.campaign_status = "Sent"
            elif status_val == "delivered":
                if not record.delivered_at:
                    record.delivered_at = datetime.utcnow()
                record.campaign_status = "Sent"
            elif status_val == "read":
                if not record.delivered_at:
                    record.delivered_at = datetime.utcnow()
                record.read_at = datetime.utcnow()
                record.campaign_status = "Sent"
            elif status_val == "failed":
                record.campaign_status = "Failed"
                record.parent_response = "No Response"
                record.delivered_at = None
                record.read_at = None
                record.responded_at = None
                
    elif event == "quick_reply":
        if button_text in ["Interested", "Not Interested"]:
            record.parent_response = button_text
            record.responded_at = datetime.utcnow()
            
            record.delivery_status = "Read"
            record.campaign_status = "Sent"
            if not record.delivered_at:
                record.delivered_at = datetime.utcnow()
            if not record.read_at:
                record.read_at = datetime.utcnow()
            
    await db.commit()
    logger.info(f"Updated record ID {record.id} status via webhook callback processing.")
    return {"status": "success", "record_id": record.id}

# Real-Time Webhook Verification Endpoint (GET)
@app.get("/api/v1/whatsapp/webhook")
async def verify_whatsapp_webhook(request: Request):
    """Verifies the webhook subscription URL with Meta Cloud API during registration."""
    params = request.query_params
    mode = params.get("hub.mode")
    verify_token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")
    
    expected_token = os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "mytestingtoken")
    
    if mode == "subscribe" and verify_token == expected_token:
        logger.info("Meta webhook verification SUCCESS.")
        from fastapi.responses import Response
        return Response(content=challenge, media_type="text/plain")
    else:
        logger.warning(f"Meta webhook verification FAILED. Mode: {mode}, Token: {verify_token}")
        raise HTTPException(status_code=403, detail="Verification token mismatch.")

# Real-Time Webhook Event Endpoint (POST)
@app.post("/api/v1/whatsapp/webhook")
async def whatsapp_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Receives event updates (sent, delivered, read) and replies from Meta Cloud API or custom simulators."""
    try:
        body = await request.json()
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
                    
                # 2. Process Interactive & Button Replies
                messages = value.get("messages", [])
                for message in messages:
                    msg_type = message.get("type")
                    context = message.get("context", {})
                    context_id = context.get("id")
                    
                    if not context_id:
                        continue
                        
                    button_text = None
                    if msg_type == "button":
                        button_text = message.get("button", {}).get("text")
                    elif msg_type == "interactive":
                        button_text = message.get("interactive", {}).get("button_reply", {}).get("title")
                    elif msg_type == "text":
                        button_text = message.get("text", {}).get("body")
                        
                    if button_text:
                        button_text = button_text.strip()
                        if button_text.lower() in ["interested", "yes"]:
                            button_text = "Interested"
                        elif button_text.lower() in ["not interested", "no"]:
                            button_text = "Not Interested"
                            
                        if button_text in ["Interested", "Not Interested"]:
                            await process_webhook_event(
                                event="quick_reply",
                                message_id=context_id,
                                button_text=button_text,
                                db=db
                            )
        return {"status": "processed"}
        
    else:
        # Fallback parsing as WebhookPayload for mock/developer simulation testing
        try:
            payload_obj = WebhookPayload(**body)
            return await process_webhook_event(
                event=payload_obj.event,
                message_id=payload_obj.message_id,
                status=payload_obj.status,
                button_text=payload_obj.button_text,
                db=db
            )
        except Exception as e:
            logger.error(f"Failed to parse webhook body: {e}")
            return {"status": "error", "message": "Invalid webhook payload format."}

# Aggregated Stats
@app.get("/api/v1/stats")
async def get_dashboard_stats(
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Returns aggregated counter statistics for metric cards."""
    total_stmt = select(func.count(Record.id))
    sent_stmt = select(func.count(Record.id)).where(Record.campaign_status == "Sent")
    unsent_stmt = select(func.count(Record.id)).where(Record.campaign_status == "Pending")
    read_stmt = select(func.count(Record.id)).where(Record.delivery_status == "Read")
    failed_stmt = select(func.count(Record.id)).where(
        or_(
            Record.campaign_status == "Failed",
            Record.delivery_status == "Failed"
        )
    )
    interested_stmt = select(func.count(Record.id)).where(Record.parent_response == "Interested")
    not_interested_stmt = select(func.count(Record.id)).where(Record.parent_response == "Not Interested")
    
    # Run async queries
    total_q = await db.execute(total_stmt)
    sent_q = await db.execute(sent_stmt)
    unsent_q = await db.execute(unsent_stmt)
    read_q = await db.execute(read_stmt)
    failed_q = await db.execute(failed_stmt)
    interested_q = await db.execute(interested_stmt)
    not_interested_q = await db.execute(not_interested_stmt)
    
    return {
        "total": total_q.scalar() or 0,
        "sent": sent_q.scalar() or 0,
        "unsent": unsent_q.scalar() or 0,
        "read": read_q.scalar() or 0,
        "failed": failed_q.scalar() or 0,
        "interested": interested_q.scalar() or 0,
        "not_interested": not_interested_q.scalar() or 0
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
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves paginated, filtered record entries for the dashboard data table."""
    stmt = select(Record)
    
    # Apply filters
    if search:
        search_pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                Record.student_name.ilike(search_pattern),
                Record.parent_name.ilike(search_pattern),
                Record.selected_branch.ilike(search_pattern),
                Record.phone_number.ilike(search_pattern)
            )
        )
        
    if delivery_status:
        if delivery_status.lower() == "undelivered":
            stmt = stmt.where(Record.campaign_status == "Sent", Record.delivery_status == "Sent")
        elif delivery_status.lower() == "delivered":
            stmt = stmt.where(Record.delivery_status.in_(["Delivered", "Read"]))
        elif delivery_status.lower() == "not_read":
            stmt = stmt.where(Record.delivery_status == "Delivered")
        elif delivery_status.lower() == "read":
            stmt = stmt.where(Record.delivery_status == "Read")
        else:
            stmt = stmt.where(Record.delivery_status.ilike(delivery_status))
        
    if parent_response:
        stmt = stmt.where(Record.parent_response.ilike(parent_response))
        
    if branch:
        stmt = stmt.where(Record.selected_branch.ilike(branch))
        
    if template and template != "All" and template != "all":
        stmt = stmt.where(Record.sent_template == template)
        
    if campaign_status:
        stmt = stmt.where(Record.campaign_status.ilike(campaign_status))
        
    if responded:
        if responded.lower() == "true":
            stmt = stmt.where(Record.parent_response != "No Response")
        else:
            stmt = stmt.where(Record.parent_response == "No Response")
            
    # Count total matches
    count_stmt = select(func.count()).select_from(stmt.subquery())
    count_result = await db.execute(count_stmt)
    total_count = count_result.scalar() or 0
    
    # Retrieve paginated items (order by newly created/modified)
    stmt = stmt.order_by(Record.id.desc()).offset((page - 1) * limit).limit(limit)
    result = await db.execute(stmt)
    records = result.scalars().all()
    
    total_pages = (total_count + limit - 1) // limit
    
    return {
        "records": [r.to_dict() for r in records],
        "total": total_count,
        "page": page,
        "limit": limit,
        "pages": total_pages
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
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Generates an Excel spreadsheet containing the filtered list of records."""
    stmt = select(Record)
    
    # Apply filters (exactly matching get_records_list)
    if search:
        search_pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                Record.student_name.ilike(search_pattern),
                Record.parent_name.ilike(search_pattern),
                Record.selected_branch.ilike(search_pattern),
                Record.phone_number.ilike(search_pattern)
            )
        )
        
    if delivery_status:
        if delivery_status.lower() == "undelivered":
            stmt = stmt.where(Record.campaign_status == "Sent", Record.delivery_status == "Sent")
        elif delivery_status.lower() == "delivered":
            stmt = stmt.where(Record.delivery_status.in_(["Delivered", "Read"]))
        elif delivery_status.lower() == "not_read":
            stmt = stmt.where(Record.delivery_status == "Delivered")
        elif delivery_status.lower() == "read":
            stmt = stmt.where(Record.delivery_status == "Read")
        else:
            stmt = stmt.where(Record.delivery_status.ilike(delivery_status))
        
    if parent_response:
        stmt = stmt.where(Record.parent_response.ilike(parent_response))
        
    if branch:
        stmt = stmt.where(Record.selected_branch.ilike(branch))
        
    if template and template != "All" and template != "all":
        stmt = stmt.where(Record.sent_template == template)
        
    if campaign_status:
        stmt = stmt.where(Record.campaign_status.ilike(campaign_status))
        
    if responded:
        if responded.lower() == "true":
            stmt = stmt.where(Record.parent_response != "No Response")
        else:
            stmt = stmt.where(Record.parent_response == "No Response")
            
    # Retrieve all matched items without pagination limits
    stmt = stmt.order_by(Record.id.desc())
    result = await db.execute(stmt)
    records = result.scalars().all()
    
    # Generate DataFrame
    data = []
    for r in records:
        data.append({
            "Student Name": r.student_name,
            "Parent Name": r.parent_name,
            "Phone Number": r.phone_number,
            "Selected Branch": r.selected_branch,
            "Delivery Status": r.delivery_status,
            "Parent Response": r.parent_response,
            "Sent Template": r.sent_template or "N/A"
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

# Developer Simulation Trigger

@app.post("/api/v1/simulation/webhook-trigger")
async def trigger_simulation_webhook(
    payload: SimulationPayload, 
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Developer helper to simulate asynchronous WhatsApp callbacks for testing."""
    stmt = select(Record).where(Record.id == payload.record_id)
    result = await db.execute(stmt)
    record = result.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Student record not found.")
        
    if not record.message_id:
        # Auto-initialize message dispatch for seamless sandbox simulation
        import uuid
        record.message_id = f"wa_msg_{uuid.uuid4().hex[:12]}"
        record.campaign_status = "Sent"
        record.delivery_status = "Sent"
        record.sent_at = datetime.utcnow()
        await db.commit()
        logger.info(f"Auto-initialized campaign dispatch for simulation on record ID {record.id}.")
        
    target = payload.target_state
    
    if target in ["delivered", "read", "failed"]:
        webhook_payload = WebhookPayload(
            event="status_update",
            message_id=record.message_id,
            status=target
        )
    elif target in ["Interested", "Not Interested"]:
        webhook_payload = WebhookPayload(
            event="quick_reply",
            message_id=record.message_id,
            button_text=target
        )
    else:
        raise HTTPException(
            status_code=400, 
            detail="Invalid simulation target state. Choose 'delivered', 'read', 'failed', 'Interested', or 'Not Interested'."
        )
        
    # Internally process using the shared webhook event processor helper
    response = await process_webhook_event(
        event=webhook_payload.event,
        message_id=webhook_payload.message_id,
        status=webhook_payload.status,
        button_text=webhook_payload.button_text,
        db=db
    )
    return {
        "status": "success",
        "simulated_event": webhook_payload.dict(),
        "handler_response": response
    }
