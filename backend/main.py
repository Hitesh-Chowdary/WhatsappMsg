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
from sqlalchemy import select, func, or_, and_, text
from sqlalchemy.ext.asyncio import AsyncSession

# Setup path logic to ensure clean imports when running from root or backend folder
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)

if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

from database import init_db, get_db, Record, AsyncSessionLocal, CampaignTemplate, AdminUser, CampaignLog, ChatMessage, AutoReplyRule
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

class BulkSendPayload(BaseModel):
    record_ids: List[int]
    template_name: Optional[str] = None

class SendMessagePayload(BaseModel):
    record_id: int
    message_text: str

class AutoReplyRulePayload(BaseModel):
    keyword: str
    reply_text: str
    is_active: Optional[bool] = True

# Background task for bulk message broadcasting
async def run_broadcast_campaign(db_session_factory, whatsapp_client: WhatsAppClient, base_url: Optional[str] = None):
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
        for record in pending_records:
            # Skip if confirmed Interested on this template
            log_stmt = select(CampaignLog).where(
                CampaignLog.record_id == record.id,
                CampaignLog.template_name == template_name
            )
            log_res = await db.execute(log_stmt)
            log_obj = log_res.scalars().first()
            if log_obj and log_obj.parent_response == "Interested":
                continue

            if not log_obj:
                log_obj = CampaignLog(
                    record_id=record.id,
                    template_name=template_name,
                    campaign_status="Pending",
                    delivery_status="Unsent",
                    parent_response="No Response"
                )
                db.add(log_obj)

            try:
                # Compile template variables dynamically
                msg_body = template_text
                msg_body = msg_body.replace("[Parent Name]", record.parent_name)
                msg_body = msg_body.replace("[Student Name]", record.student_name)
                msg_body = msg_body.replace("[Selected Branch]", record.selected_branch)
                msg_body = msg_body.replace("[Phone Number]", record.phone_number)

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

                response = await whatsapp_client.send_message(
                    to_phone=record.phone_number,
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
                        sender="system",
                        message_text=msg_body,
                        media_url=media_url if media_type != "none" else None,
                        message_id=response.get("message_id")
                    )
                    db.add(chat_msg)
                else:
                    log_obj.campaign_status = "Failed"
                    log_obj.delivery_status = "Failed"
            except Exception as e:
                logger.error(f"Error broadcasting to {record.phone_number} (ID: {record.id}): {e}")
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
            
    logger.info("Background campaign broadcast completed.")

async def run_bulk_send_campaign(db_session_factory, whatsapp_client: WhatsAppClient, record_ids: List[int], base_url: Optional[str] = None, template_name: Optional[str] = None):
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
            # Check CampaignLog status
            log_stmt = select(CampaignLog).where(
                CampaignLog.record_id == record.id,
                CampaignLog.template_name == template_name
            )
            log_res = await db.execute(log_stmt)
            log_obj = log_res.scalars().first()
            
            # Skip if confirmed Interested
            if log_obj and log_obj.parent_response == "Interested":
                logger.info(f"Skipping record ID {record.id} because parent is Interested.")
                continue
                
            if not log_obj:
                log_obj = CampaignLog(
                    record_id=record.id,
                    template_name=template_name,
                    campaign_status="Pending",
                    delivery_status="Unsent",
                    parent_response="No Response"
                )
                db.add(log_obj)

            try:
                # Compile template variables dynamically
                msg_body = template_text
                msg_body = msg_body.replace("[Parent Name]", record.parent_name)
                msg_body = msg_body.replace("[Student Name]", record.student_name)
                msg_body = msg_body.replace("[Selected Branch]", record.selected_branch)
                msg_body = msg_body.replace("[Phone Number]", record.phone_number)

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

                response = await whatsapp_client.send_message(
                    to_phone=record.phone_number,
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
                        sender="system",
                        message_text=msg_body,
                        media_url=media_url if media_type != "none" else None,
                        message_id=response.get("message_id")
                    )
                    db.add(chat_msg)
                else:
                    log_obj.campaign_status = "Failed"
                    log_obj.delivery_status = "Failed"
            except Exception as e:
                logger.error(f"Error bulk dispatching to {record.phone_number} (ID: {record.id}): {e}")
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
    
    for record_data in records_to_process:
        phone = record_data["phone_number"]
        if phone in existing_records:
            # Overwrite existing record and reset statuses for retry campaigns
            rec = existing_records[phone]
            rec.student_name = record_data["student_name"]
            rec.parent_name = record_data["parent_name"]
            rec.selected_branch = record_data["selected_branch"]
            rec.variables = record_data["variables"]
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
                variables=record_data["variables"],
                campaign_status="Pending",
                delivery_status="Unsent",
                parent_response="No Response"
            )
            db.add(rec)
            added_count += 1
    # Delete existing campaign logs for these records to reset stats for fresh campaigns
    stmt = select(Record.id).where(Record.phone_number.in_(phone_numbers))
    res = await db.execute(stmt)
    record_ids_to_reset = res.scalars().all()
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
                "text": "*_Dr. RVR NRI INSTITUTE OF TECHNOLOGY_*\n\nDear {{parent_name}}, greetings from College Admissions. Your child {{student_name}} has been selected for the {{selected_branch}} branch. To block the seat, please pay the ₹50,000 advance fee. Click below to confirm",
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
    background_tasks.add_task(run_bulk_send_campaign, AsyncSessionLocal, client, payload.record_ids, base_url, template_name)
    
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
            campaign_status="Pending",
            delivery_status="Unsent",
            parent_response="No Response"
        )
        db.add(log_obj)

    client_type = request.headers.get("x-whatsapp-client-type")
    client = get_whatsapp_client(client_type)
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

        response = await client.send_message(
            to_phone=record.phone_number,
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
                sender="system",
                message_text=msg_body,
                media_url=media_url if media_type != "none" else None,
                message_id=response.get("message_id")
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
    stmt = select(CampaignLog).where(CampaignLog.message_id == message_id)
    result = await db.execute(stmt)
    log = result.scalars().first()
    
    if not log:
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
        if button_text in ["Interested", "Not Interested"]:
            log.parent_response = button_text
            log.responded_at = datetime.utcnow()
            
            log.delivery_status = "Read"
            log.campaign_status = "Sent"
            if not log.delivered_at:
                log.delivered_at = datetime.utcnow()
            if not log.read_at:
                log.read_at = datetime.utcnow()
            
    # Mirror updates to the legacy Record table so direct database checks are synced
    rec_stmt = select(Record).where(Record.id == log.record_id)
    rec_res = await db.execute(rec_stmt)
    rec = rec_res.scalars().first()
    if rec:
        rec.campaign_status = log.campaign_status
        rec.delivery_status = log.delivery_status
        rec.parent_response = log.parent_response
        rec.message_id = log.message_id
        rec.sent_template = log.template_name
        rec.sent_at = log.sent_at
        rec.delivered_at = log.delivered_at
        rec.read_at = log.read_at
        rec.responded_at = log.responded_at
            
    await db.commit()
    logger.info(f"Updated CampaignLog ID {log.id} status via webhook callback processing.")
    
    # Trigger auto-response for quick replies (Interested, Not Interested)
    if event == "quick_reply" and button_text in ["Interested", "Not Interested"]:
        try:
            await handle_quick_reply_auto_response(log.record_id, button_text, db)
        except Exception as e:
            logger.error(f"Error triggering quick reply auto response: {e}")
            
    return {"status": "success", "record_id": log.record_id}

# Helper to process incoming quick reply button clicks (e.g. Interested, Not Interested) and trigger auto-response
async def handle_quick_reply_auto_response(
    record_id: int,
    button_text: str,
    db: AsyncSession
):
    import uuid
    # Fetch candidate record
    stmt = select(Record).where(Record.id == record_id)
    res = await db.execute(stmt)
    record = res.scalar_one_or_none()
    if not record:
        logger.warning(f"Quick reply auto response ignored: record ID {record_id} not found.")
        return
        
    # Search for matching Auto-Reply rule
    rules_stmt = select(AutoReplyRule).where(AutoReplyRule.is_active == True)
    rules_res = await db.execute(rules_stmt)
    all_rules = rules_res.scalars().all()
    
    matched_rule = None
    for rule in all_rules:
        if rule.keyword.lower().strip() == button_text.lower().strip():
            matched_rule = rule
            break
            
    # Default fallbacks if no custom rule configured
    reply_text = None
    if matched_rule:
        reply_text = matched_rule.reply_text
    else:
        if button_text.lower().strip() == "interested":
            reply_text = (
                "Thank you, [Parent Name]! We have recorded your interest for [Selected Branch]. "
                "Our admissions counselor will call you shortly to discuss seat allocation, "
                "scholarship options, and hostel facilities. 📞"
            )
        elif button_text.lower().strip() == "not interested":
            reply_text = (
                "We understand, [Parent Name]. We have updated your preference in our portal and "
                "will not send further automated updates. If you change your mind, feel free to contact "
                "us anytime. Thank you!"
            )
            
    if reply_text:
        # Compile dynamic variables if present in the reply text
        reply_text = reply_text.replace("[Parent Name]", record.parent_name or "Parent")
        reply_text = reply_text.replace("[Student Name]", record.student_name or "Student")
        reply_text = reply_text.replace("[Selected Branch]", record.selected_branch or "Selected Branch")
        reply_text = reply_text.replace("[Phone Number]", record.phone_number or "")
        
        # Send message via WhatsApp
        whatsapp_client = get_whatsapp_client()
        response = await whatsapp_client.send_free_form_message(
            to_phone=record.phone_number,
            message_text=reply_text
        )
        
        # Save auto-reply in chat history as system sender
        auto_msg_id = response.get("message_id") if response.get("status") == "success" else f"auto_fail_{uuid.uuid4().hex[:12]}"
        auto_chat_msg = ChatMessage(
            record_id=record.id,
            sender="system",
            message_text=reply_text,
            message_id=auto_msg_id
        )
        db.add(auto_chat_msg)
        await db.commit()
        logger.info(f"Auto-response sent and logged for record ID {record.id} quick reply '{button_text}'.")

# Helper to process incoming text replies and trigger auto-responder
async def handle_incoming_text_reply(
    from_phone: str,
    message_text: str,
    message_id: str,
    db: AsyncSession
) -> Dict[str, Any]:
    import uuid
    # 1. Normalize phone number (strip '+', check suffix match)
    clean_from = from_phone.strip().replace("+", "")
    
    # Check suffix match (last 10 digits) to handle international prefix variations
    stmt = select(Record).where(Record.phone_number.like(f"%{clean_from[-10:]}"))
    result = await db.execute(stmt)
    record = result.scalars().first()
    
    if not record:
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
        sender="parent",
        message_text=message_text,
        message_id=message_id
    )
    db.add(chat_msg)
    
    # 3. Check for matching Auto-Reply rule
    normalized_text = message_text.lower().strip()
    rules_stmt = select(AutoReplyRule).where(AutoReplyRule.is_active == True)
    rules_res = await db.execute(rules_stmt)
    all_rules = rules_res.scalars().all()
    
    matched_rule = None
    # Prioritize non-default keyword match
    for rule in all_rules:
        if rule.keyword != "default" and rule.keyword.lower() in normalized_text:
            matched_rule = rule
            break
            
    # Fallback to default
    if not matched_rule:
        matched_rule = next((r for r in all_rules if r.keyword == "default"), None)
        
    if matched_rule:
        whatsapp_client = get_whatsapp_client()
        response = await whatsapp_client.send_free_form_message(
            to_phone=from_phone,
            message_text=matched_rule.reply_text
        )
        
        # Save auto-reply message
        auto_msg_id = response.get("message_id") if response.get("status") == "success" else f"auto_fail_{uuid.uuid4().hex[:12]}"
        auto_chat_msg = ChatMessage(
            record_id=record.id,
            sender="system",
            message_text=matched_rule.reply_text,
            message_id=auto_msg_id
        )
        db.add(auto_chat_msg)
        
        # Update record response state
        record.parent_response = f"Replied ({matched_rule.keyword})"
        record.responded_at = datetime.utcnow()
        
        # Mirror updates to latest CampaignLog if it exists
        log_stmt = select(CampaignLog).where(CampaignLog.record_id == record.id).order_by(CampaignLog.id.desc()).limit(1)
        log_res = await db.execute(log_stmt)
        latest_log = log_res.scalars().first()
        if latest_log:
            latest_log.parent_response = f"Replied ({matched_rule.keyword})"
            latest_log.responded_at = record.responded_at
            latest_log.delivery_status = "Read"

    await db.commit()
    logger.info(f"Handled incoming reply from {from_phone} successfully. Matched rule: {matched_rule.keyword if matched_rule else 'None'}")
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
                        button_text = message.get("interactive", {}).get("button_reply", {}).get("title")
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
                        
                        # Process text message: resolving candidate, logging message, and running chatbot
                        if sender_phone:
                            await handle_incoming_text_reply(
                                from_phone=sender_phone,
                                message_text=button_text,
                                message_id=msg_id,
                                db=db
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
                # If quick_reply, let's also log the incoming text in ChatMessage
                if payload_obj.event == "quick_reply":
                    stmt = select(CampaignLog).where(CampaignLog.message_id == payload_obj.message_id)
                    res = await db.execute(stmt)
                    log = res.scalars().first()
                    if log:
                        chat_msg = ChatMessage(
                            record_id=log.record_id,
                            sender="parent",
                            message_text=payload_obj.button_text or "Interested",
                            message_id=payload_obj.message_id
                        )
                        db.add(chat_msg)
                        
                        # Trigger chatbot auto-reply for simulated quick replies too
                        # Runs handle_incoming_text_reply to mock response flow
                        rec_stmt = select(Record).where(Record.id == log.record_id)
                        rec_res = await db.execute(rec_stmt)
                        rec = rec_res.scalars().first()
                        if rec:
                            # Run async trigger without duplicating parent message
                            normalized_text = (payload_obj.button_text or "Interested").lower().strip()
                            rules_stmt = select(AutoReplyRule).where(AutoReplyRule.is_active == True)
                            rules_res = await db.execute(rules_stmt)
                            all_rules = rules_res.scalars().all()
                            matched_rule = None
                            for rule in all_rules:
                                if rule.keyword != "default" and rule.keyword.lower() in normalized_text:
                                    matched_rule = rule
                                    break
                            if not matched_rule:
                                matched_rule = next((r for r in all_rules if r.keyword == "default"), None)
                            if matched_rule:
                                import uuid
                                whatsapp_client = get_whatsapp_client()
                                response = await whatsapp_client.send_free_form_message(
                                    to_phone=rec.phone_number,
                                    message_text=matched_rule.reply_text
                                )
                                auto_chat_msg = ChatMessage(
                                    record_id=rec.id,
                                    sender="system",
                                    message_text=matched_rule.reply_text,
                                    message_id=response.get("message_id") if response.get("status") == "success" else f"auto_fail_{uuid.uuid4().hex[:12]}"
                                )
                                db.add(auto_chat_msg)
                                rec.parent_response = f"Replied ({matched_rule.keyword})"
                                rec.responded_at = datetime.utcnow()
                                log.parent_response = f"Replied ({matched_rule.keyword})"
                                log.responded_at = rec.responded_at
                                log.delivery_status = "Read"
                
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
    
    # Run async queries
    total_q = await db.execute(total_stmt)
    sent_q = await db.execute(sent_stmt)
    read_q = await db.execute(read_stmt)
    failed_q = await db.execute(failed_stmt)
    interested_q = await db.execute(interested_stmt)
    not_interested_q = await db.execute(not_interested_stmt)
    
    total_val = total_q.scalar() or 0
    sent_val = sent_q.scalar() or 0
    read_val = read_q.scalar() or 0
    failed_val = failed_q.scalar() or 0
    interested_val = interested_q.scalar() or 0
    not_interested_val = not_interested_q.scalar() or 0
    
    # Unsent/Pending: Total - Sent - Failed
    unsent_val = max(0, total_val - sent_val - failed_val)
    
    return {
        "total": total_val,
        "sent": sent_val,
        "unsent": unsent_val,
        "read": read_val,
        "failed": failed_val,
        "interested": interested_val,
        "not_interested": not_interested_val
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

    # Core query: Outer join on CampaignLog specifically for this template
    stmt = select(Record, CampaignLog).outerjoin(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template
        )
    )
    
    # Apply search filter
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
        
    # Apply template-specific status filters
    if delivery_status:
        val = delivery_status.lower()
        if val == "unsent":
            stmt = stmt.where(or_(CampaignLog.delivery_status == None, CampaignLog.delivery_status.ilike("unsent")))
        elif val == "undelivered":
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
            
    # Count total matches
    count_stmt = select(func.count()).select_from(stmt.subquery())
    count_result = await db.execute(count_stmt)
    total_count = count_result.scalar() or 0
    
    # Retrieve paginated items (order by newly created/modified)
    stmt = stmt.order_by(Record.id.desc()).offset((page - 1) * limit).limit(limit)
    result = await db.execute(stmt)
    rows = result.all()
    
    total_pages = (total_count + limit - 1) // limit
    
    records_list = []
    for r, log in rows:
        record_dict = r.to_dict()
        if log:
            record_dict["campaign_status"] = log.campaign_status
            record_dict["delivery_status"] = log.delivery_status
            record_dict["parent_response"] = log.parent_response
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
            record_dict["sent_template"] = selected_template
            record_dict["sent_at"] = None
            record_dict["delivered_at"] = None
            record_dict["read_at"] = None
            record_dict["responded_at"] = None
        records_list.append(record_dict)
    
    return {
        "records": records_list,
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

    stmt = select(Record, CampaignLog).outerjoin(
        CampaignLog,
        and_(
            CampaignLog.record_id == Record.id,
            CampaignLog.template_name == selected_template
        )
    )
    
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
        val = delivery_status.lower()
        if val == "unsent":
            stmt = stmt.where(or_(CampaignLog.delivery_status == None, CampaignLog.delivery_status.ilike("unsent")))
        elif val == "undelivered":
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
            
    # Retrieve all matched items without pagination limits
    stmt = stmt.order_by(Record.id.desc())
    result = await db.execute(stmt)
    rows = result.all()
    
    # Generate DataFrame
    data = []
    for r, log in rows:
        d_status = log.delivery_status if log else "Unsent"
        p_resp = log.parent_response if log else "No Response"
        s_tmpl = log.template_name if log else selected_template
        data.append({
            "Student Name": r.student_name,
            "Parent Name": r.parent_name,
            "Phone Number": r.phone_number,
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
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Fetches list of recent chat conversations sorted by latest message timestamp."""
    # Subquery to find the latest ChatMessage.id for each record_id
    subq = select(
        ChatMessage.record_id,
        func.max(ChatMessage.id).label("max_id")
    ).group_by(ChatMessage.record_id).subquery()
    
    # Main query to join Record, ChatMessage and the max_id subquery
    stmt = select(Record, ChatMessage).join(
        ChatMessage, Record.id == ChatMessage.record_id
    ).join(
        subq, and_(ChatMessage.record_id == subq.c.record_id, ChatMessage.id == subq.c.max_id)
    ).order_by(ChatMessage.id.desc())
    
    result = await db.execute(stmt)
    rows = result.all()
    
    recent_chats = []
    for rec, msg in rows:
        recent_chats.append({
            "record": rec.to_dict(),
            "last_message": msg.to_dict()
        })
    return recent_chats

@app.get("/api/v1/chat/history/{record_id}")
async def get_chat_history(
    record_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AdminUser = Depends(get_current_user)
):
    """Retrieves full conversation message history for a specific candidate."""
    stmt = select(ChatMessage).where(ChatMessage.record_id == record_id).order_by(ChatMessage.created_at.asc())
    res = await db.execute(stmt)
    messages = res.scalars().all()
    return [msg.to_dict() for msg in messages]

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
        
    client_type = request.headers.get("x-whatsapp-client-type")
    whatsapp_client = get_whatsapp_client(client_type)
    response = await whatsapp_client.send_free_form_message(
        to_phone=record.phone_number,
        message_text=payload.message_text
    )
    
    if response.get("status") != "success":
        raise HTTPException(status_code=500, detail=response.get("message", "Failed to dispatch WhatsApp free-form reply."))
        
    # Log message to chat history
    chat_msg = ChatMessage(
        record_id=record.id,
        sender="counselor",
        message_text=payload.message_text,
        message_id=response.get("message_id")
    )
    db.add(chat_msg)
    
    # Update candidate response state
    record.parent_response = "Counselor Replied"
    record.responded_at = datetime.utcnow()
    
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
