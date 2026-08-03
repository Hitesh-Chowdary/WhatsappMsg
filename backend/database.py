import logging
import os
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv
from sqlalchemy import String, DateTime, func, text, Boolean, ForeignKey, JSON, Text, Integer
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

logger = logging.getLogger("admission_engine")

# Load environment variables from .env file (supports running from root or backend folder)
load_dotenv()
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))

# Retrieve database connection URL from environment or .env file
DATABASE_URL = os.getenv("DATABASE_URL")

if DATABASE_URL:
    # Ensure the dialect is set to postgresql+asyncpg for async operations
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
    elif DATABASE_URL.startswith("postgresql://") and not DATABASE_URL.startswith("postgresql+asyncpg://"):
        DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
else:
    # Fallback default for local development
    DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/whatsapp_sms"

# Create async engine with pooling enabled (conditional parameters for SQLite compatibility)
engine_args = {
    "pool_recycle": 1800,
    "pool_pre_ping": True
}

# Handle sslmode and strip incompatible query parameters for asyncpg compatibility
if DATABASE_URL and not DATABASE_URL.startswith("sqlite"):
    from urllib.parse import urlparse, parse_qs, urlunparse
    try:
        parsed_url = urlparse(DATABASE_URL)
        query_params = parse_qs(parsed_url.query)
        
        # Check if SSL is requested
        has_ssl = False
        if "sslmode" in query_params:
            sslmode = query_params.get("sslmode")[0]
            if sslmode in ["require", "prefer", "allow", "verify-ca", "verify-full"]:
                has_ssl = True
        
        if has_ssl or "ssl" in query_params or (parsed_url.hostname and "neon" in parsed_url.hostname):
            engine_args["connect_args"] = {"ssl": True}
            
        # Completely strip query parameters to avoid unsupported arguments in asyncpg (e.g. channel_binding)
        parsed_url = parsed_url._replace(query="")
        DATABASE_URL = urlunparse(parsed_url)
    except Exception as e:
        # Fallback to ignore errors in parsing
        pass

if not DATABASE_URL.startswith("sqlite"):
    engine_args["pool_size"] = 20
    engine_args["max_overflow"] = 10

engine = create_async_engine(DATABASE_URL, **engine_args)

# Async session factory
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False
)

# Base class for declarative models
class Base(DeclarativeBase):
    pass

class Record(Base):
    __tablename__ = "records"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    student_name: Mapped[str] = mapped_column(String(255), nullable=False)
    parent_name: Mapped[str] = mapped_column(String(255), nullable=False)
    selected_branch: Mapped[str] = mapped_column(String(255), nullable=False)
    phone_number: Mapped[str] = mapped_column(String(50), nullable=False)
    parent_phone_number: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    
    # Statuses
    campaign_status: Mapped[str] = mapped_column(String(50), default="Pending")
    delivery_status: Mapped[str] = mapped_column(String(50), default="Unsent")
    parent_response: Mapped[str] = mapped_column(String(50), default="No Response")
    variables: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    
    # Message Tracking ID from WhatsApp API
    message_id: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True, index=True)
    
    # Template name used for dispatching
    sent_template: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    
    # Tagging/Pipeline state (e.g. Lead, Contacted, Interested, Enrolled)
    pipeline_tag: Mapped[Optional[str]] = mapped_column(String(50), default=None, nullable=True)
    
    # Counselor Lead Assignment & Notes
    assigned_counselor_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    assigned_counselor_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    counselor_notes: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    counselor_status: Mapped[Optional[str]] = mapped_column(String(50), default="active", nullable=True)
    
    # Timestamps
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    responded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        """Converts model fields to a dict serialization format."""
        return {
            "id": self.id,
            "student_name": self.student_name,
            "parent_name": self.parent_name,
            "selected_branch": self.selected_branch,
            "phone_number": self.phone_number,
            "parent_phone_number": self.parent_phone_number,
            "campaign_status": self.campaign_status,
            "delivery_status": self.delivery_status,
            "parent_response": self.parent_response,
            "message_id": self.message_id,
            "sent_template": self.sent_template,
            "pipeline_tag": self.pipeline_tag or "Lead",
            "assigned_counselor_id": self.assigned_counselor_id,
            "assigned_counselor_name": self.assigned_counselor_name,
            "counselor_notes": self.counselor_notes,
            "counselor_status": self.counselor_status or "active",
            "sent_at": self.sent_at.isoformat() if self.sent_at else None,
            "delivered_at": self.delivered_at.isoformat() if self.delivered_at else None,
            "read_at": self.read_at.isoformat() if self.read_at else None,
            "responded_at": self.responded_at.isoformat() if self.responded_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "scheduled_call": self.variables.get("scheduled_call") if self.variables else None,
            "unread_count": self.variables.get("unread_count", 0) if self.variables else 0
        }

class CampaignLog(Base):
    __tablename__ = "campaign_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(ForeignKey("records.id", ondelete="CASCADE"), nullable=False, index=True)
    template_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    recipient_type: Mapped[Optional[str]] = mapped_column(String(50), default="parent", server_default="parent", nullable=True)
    
    campaign_status: Mapped[str] = mapped_column(String(50), default="Pending")
    delivery_status: Mapped[str] = mapped_column(String(50), default="Unsent")
    parent_response: Mapped[str] = mapped_column(String(50), default="No Response")
    
    message_id: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True, index=True)
    
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    responded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        return {
            "id": self.id,
            "record_id": self.record_id,
            "template_name": self.template_name,
            "recipient_type": self.recipient_type,
            "campaign_status": self.campaign_status,
            "delivery_status": self.delivery_status,
            "parent_response": self.parent_response,
            "message_id": self.message_id,
            "sent_at": self.sent_at.isoformat() if self.sent_at else None,
            "delivered_at": self.delivered_at.isoformat() if self.delivered_at else None,
            "read_at": self.read_at.isoformat() if self.read_at else None,
            "responded_at": self.responded_at.isoformat() if self.responded_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None
        }

class CampaignTemplate(Base):
    __tablename__ = "campaign_templates"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    template_name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    template_text: Mapped[str] = mapped_column(String(1000), nullable=False)
    category: Mapped[str] = mapped_column(String(100), default="MARKETING", server_default="MARKETING")
    media_type: Mapped[Optional[str]] = mapped_column(String(50), default="none", server_default="none", nullable=True)
    media_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    language: Mapped[str] = mapped_column(String(50), default="en", server_default="en")
    variable_names: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False
    )

class AdminUser(Base):
    __tablename__ = "admin_users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True, index=True)
    full_name: Mapped[Optional[str]] = mapped_column(String(255), default="System Administrator", server_default="System Administrator", nullable=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[Optional[str]] = mapped_column(String(50), default="super_admin", server_default="super_admin", nullable=True)
    is_active: Mapped[Optional[bool]] = mapped_column(Boolean, default=True, server_default="true", nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email or f"{self.username}@institution.edu.in",
            "full_name": self.full_name or self.username.capitalize(),
            "role": self.role or "super_admin",
            "is_active": self.is_active if self.is_active is not None else True,
            "created_at": self.created_at.isoformat() if hasattr(self, "created_at") and self.created_at else None
        }

class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(ForeignKey("records.id", ondelete="CASCADE"), nullable=False, index=True)
    sender: Mapped[str] = mapped_column(String(50), nullable=False)
    message_text: Mapped[str] = mapped_column(String, nullable=False)
    media_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    message_id: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True, index=True)
    delivery_status: Mapped[Optional[str]] = mapped_column(String(50), default="sent", server_default="sent", nullable=True)
    recipient_type: Mapped[Optional[str]] = mapped_column(String(50), default="parent", server_default="parent", nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        return {
            "id": self.id,
            "record_id": self.record_id,
            "sender": self.sender,
            "message_text": self.message_text,
            "media_url": self.media_url,
            "message_id": self.message_id,
            "delivery_status": self.delivery_status,
            "recipient_type": self.recipient_type,
            "created_at": self.created_at.isoformat() if self.created_at else None
        }

class AutoReplyRule(Base):
    __tablename__ = "auto_reply_rules"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    keyword: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    reply_text: Mapped[str] = mapped_column(String, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        return {
            "id": self.id,
            "keyword": self.keyword,
            "reply_text": self.reply_text,
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat() if self.created_at else None
        }

class RecordNote(Base):
    __tablename__ = "record_notes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(ForeignKey("records.id", ondelete="CASCADE"), nullable=False, index=True)
    note_text: Mapped[str] = mapped_column(String(1000), nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), default="Counselor")
    resolved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        return {
            "id": self.id,
            "record_id": self.record_id,
            "note_text": self.note_text,
            "created_by": self.created_by,
            "resolved": self.resolved,
            "created_at": self.created_at.isoformat() if self.created_at else None
        }

class BotFlow(Base):
    __tablename__ = "bot_flows"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), default="Default Flow", server_default="Default Flow")
    flow_data: Mapped[dict] = mapped_column(JSON, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    template_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), 
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False
    )

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "flow_data": self.flow_data,
            "is_active": self.is_active,
            "template_name": self.template_name,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }

class BrochureDocument(Base):
    __tablename__ = "brochure_documents"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    extracted_text: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        text_preview = self.extracted_text[:300] + "..." if self.extracted_text and len(self.extracted_text) > 300 else self.extracted_text
        return {
            "id": self.id,
            "title": self.title,
            "filename": self.filename,
            "file_path": self.file_path,
            "is_active": self.is_active,
            "extracted_text": self.extracted_text,
            "text_preview": text_preview,
            "uploaded_at": self.uploaded_at.isoformat() if self.uploaded_at else None
        }

class WebsiteKnowledge(Base):
    __tablename__ = "website_knowledge"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    url: Mapped[str] = mapped_column(String(1000), nullable=False)
    domain: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    extracted_text: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    crawled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )

    def to_dict(self):
        text_preview = self.extracted_text[:300] + "..." if self.extracted_text and len(self.extracted_text) > 300 else self.extracted_text
        return {
            "id": self.id,
            "url": self.url,
            "domain": self.domain,
            "title": self.title,
            "is_active": self.is_active,
            "extracted_text": self.extracted_text,
            "text_preview": text_preview,
            "crawled_at": self.crawled_at.isoformat() if self.crawled_at else None
        }

async def init_db():
    """Initializes the database schema by creating required tables and seeding default template."""
    logger.info("Verifying and creating PostgreSQL database tables...")
    async with engine.begin() as conn:
        # Create all tables in the database if they do not exist
        await conn.run_sync(Base.metadata.create_all)
            
    # Execute ALTER statements in individual transactions so locks are released immediately
    alter_statements = [
        "ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS media_type VARCHAR(50) DEFAULT 'none'",
        "ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS media_url VARCHAR(1000)",
        "ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS template_name VARCHAR(255)",
        "ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'MARKETING'",
        "ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS language VARCHAR(50) DEFAULT 'en'",
        "ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS variable_names VARCHAR(500)",
        "ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT false",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS sent_template VARCHAR(255)",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS variables JSON DEFAULT '{}'",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS pipeline_tag VARCHAR(50) DEFAULT 'Lead'",
        "ALTER TABLE record_notes ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT false",
        "ALTER TABLE bot_flows ADD COLUMN IF NOT EXISTS template_name VARCHAR(255)",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS parent_phone_number VARCHAR(50)",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS assigned_counselor_id INTEGER",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS assigned_counselor_name VARCHAR(255)",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS counselor_notes TEXT",
        "ALTER TABLE records ADD COLUMN IF NOT EXISTS counselor_status VARCHAR(50) DEFAULT 'active'",
        "ALTER TABLE campaign_logs ADD COLUMN IF NOT EXISTS recipient_type VARCHAR(50) DEFAULT 'parent'",
        "ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recipient_type VARCHAR(50) DEFAULT 'parent'",
        "ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(50) DEFAULT 'sent'",
        "ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_url VARCHAR(1000)",
        "ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message_id VARCHAR(255)",
        "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email VARCHAR(255)",
        "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255) DEFAULT 'System Administrator'",
        "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'super_admin'",
        "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true",
        "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()",
        "UPDATE admin_users SET email = 'admin@institution.edu.in' WHERE email IS NULL AND username = 'admin'",
        "UPDATE admin_users SET full_name = 'System Administrator' WHERE full_name IS NULL AND username = 'admin'",
        "UPDATE admin_users SET role = 'super_admin' WHERE role IS NULL AND username = 'admin'"
    ]
    for stmt in alter_statements:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(stmt))
        except Exception as stmt_err:
            logger.warning(f"Ignored minor DDL migration notice: {stmt_err}")
        
    # Seed default templates if empty
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        
        # No default templates seeded to ensure a clean database environment.
        pass

    # Auto-delete legacy default rules to avoid conflicts with custom BotFlow builder
    async with AsyncSessionLocal() as session:
        from sqlalchemy import delete
        stmt = delete(AutoReplyRule).where(
            AutoReplyRule.keyword.in_(["default", "fees", "hostel", "eligibility"])
        )
        await session.execute(stmt)
        await session.commit()

    # Seed default admin user
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        import bcrypt
        
        # Check if ANY admin user exists in the database
        stmt = select(AdminUser).limit(1)
        result = await session.execute(stmt)
        existing_user = result.scalars().first()
        
        # Only seed if no users exist in the admin_users table
        if not existing_user:
            hashed = bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
            default_admin = AdminUser(
                username="admin",
                email="admin@institution.edu.in",
                full_name="System Administrator",
                role="super_admin",
                hashed_password=hashed,
                is_active=True
            )
            session.add(default_admin)
            await session.commit()

        # Migrate legacy records to campaign_logs
        stmt = select(Record).where(Record.sent_template != None)
        res = await session.execute(stmt)
        legacy_records = res.scalars().all()
        for r in legacy_records:
            log_stmt = select(CampaignLog).where(
                CampaignLog.record_id == r.id,
                CampaignLog.template_name == r.sent_template
            )
            log_res = await session.execute(log_stmt)
            log_obj = log_res.scalars().first()
            if not log_obj:
                new_log = CampaignLog(
                    record_id=r.id,
                    template_name=r.sent_template,
                    campaign_status=r.campaign_status,
                    delivery_status=r.delivery_status,
                    parent_response=r.parent_response,
                    message_id=r.message_id,
                    sent_at=r.sent_at,
                    delivered_at=r.delivered_at,
                    read_at=r.read_at,
                    responded_at=r.responded_at,
                    created_at=r.sent_at or r.created_at
                )
                session.add(new_log)
        await session.commit()

async def get_db():
    """Dependency for providing database sessions to FastAPI routes."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
