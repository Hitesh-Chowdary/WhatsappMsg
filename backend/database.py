import os
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv
from sqlalchemy import String, DateTime, func, text, Boolean, ForeignKey, JSON
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

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

# Create async engine with pooling enabled
engine = create_async_engine(
    DATABASE_URL,
    pool_size=20,
    max_overflow=10,
    pool_recycle=1800,
    pool_pre_ping=True
)

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
            "campaign_status": self.campaign_status,
            "delivery_status": self.delivery_status,
            "parent_response": self.parent_response,
            "message_id": self.message_id,
            "sent_template": self.sent_template,
            "pipeline_tag": self.pipeline_tag or "Lead",
            "sent_at": self.sent_at.isoformat() if self.sent_at else None,
            "delivered_at": self.delivered_at.isoformat() if self.delivered_at else None,
            "read_at": self.read_at.isoformat() if self.read_at else None,
            "responded_at": self.responded_at.isoformat() if self.responded_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "scheduled_call": self.variables.get("scheduled_call") if self.variables else None
        }

class CampaignLog(Base):
    __tablename__ = "campaign_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(ForeignKey("records.id", ondelete="CASCADE"), nullable=False, index=True)
    template_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    
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
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)

class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(ForeignKey("records.id", ondelete="CASCADE"), nullable=False, index=True)
    sender: Mapped[str] = mapped_column(String(50), nullable=False)
    message_text: Mapped[str] = mapped_column(String, nullable=False)
    media_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    message_id: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True, index=True)
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
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }

async def init_db():
    """Initializes the database schema by creating required tables and seeding default template."""
    async with engine.begin() as conn:
        # Create all tables in the database if they do not exist
        await conn.run_sync(Base.metadata.create_all)
        # Apply columns dynamically for compatibility
        await conn.execute(text("ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS media_type VARCHAR(50) DEFAULT 'none'"))
        await conn.execute(text("ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS media_url VARCHAR(1000)"))
        await conn.execute(text("ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS template_name VARCHAR(255)"))
        await conn.execute(text("ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'MARKETING'"))
        await conn.execute(text("ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS language VARCHAR(50) DEFAULT 'en'"))
        await conn.execute(text("ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS variable_names VARCHAR(500)"))
        await conn.execute(text("ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT false"))
        await conn.execute(text("ALTER TABLE records ADD COLUMN IF NOT EXISTS sent_template VARCHAR(255)"))
        await conn.execute(text("ALTER TABLE records ADD COLUMN IF NOT EXISTS variables JSON DEFAULT '{}'"))
        await conn.execute(text("ALTER TABLE records ADD COLUMN IF NOT EXISTS pipeline_tag VARCHAR(50) DEFAULT 'Lead'"))
        await conn.execute(text("ALTER TABLE record_notes ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT false"))
        
    # Seed default templates if empty
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        
        # No default templates seeded to ensure a clean database environment.
        pass

    # Seed default auto-reply rules if empty
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        stmt = select(AutoReplyRule)
        res = await session.execute(stmt)
        rules = res.scalars().all()
        if not rules:
            default_rules = [
                AutoReplyRule(
                    keyword="default",
                    reply_text="Thank you for contacting our Admissions Portal! A counselor has been notified and will respond to you shortly. Feel free to ask about fees, hostel, or eligibility."
                ),
                AutoReplyRule(
                    keyword="fees",
                    reply_text="Our annual tuition fees vary by department. Standard engineering branch fee is ₹1,20,000/year, and management/degree courses are ₹80,000/year. Scholarships are available for meritorious students."
                ),
                AutoReplyRule(
                    keyword="hostel",
                    reply_text="We offer comfortable on-campus hostel facilities for both boys and girls with 24/7 security, Wi-Fi, laundry, and dining. Hostel fee starts at ₹75,000/year."
                ),
                AutoReplyRule(
                    keyword="eligibility",
                    reply_text="For Bachelor courses, candidates must have passed 10+2 with a minimum of 50% aggregate marks. Direct admission under Management quota is open. Please submit your board marksheets for review."
                )
            ]
            session.add_all(default_rules)
            await session.commit()

    # Seed default admin user
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select, delete
        import bcrypt
        
        # Delete any admin user that is not 'admin' to ensure only one admin exists
        await session.execute(delete(AdminUser).where(AdminUser.username != "admin"))
        
        # Check if 'admin' user exists
        stmt = select(AdminUser).where(AdminUser.username == "admin")
        result = await session.execute(stmt)
        admin_user = result.scalar_one_or_none()
        
        # Seed or reset credentials to admin / admin123
        hashed = bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        if not admin_user:
            admin_user = AdminUser(username="admin", hashed_password=hashed)
            session.add(admin_user)
        else:
            admin_user.hashed_password = hashed
            
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
