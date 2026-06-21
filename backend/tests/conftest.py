import os
import sys

# 1. Add backend directory to sys.path so 'database' and 'main' can be imported correctly
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# 2. Force SQLite in-memory DATABASE_URL before importing database module
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import pytest
import asyncio
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from httpx import AsyncClient
import jwt
import bcrypt
from datetime import datetime, timedelta

# Import top-level modules from backend
import database
import main

# Mock / Override init_db to avoid running PostgreSQL ALTER TABLE statements on SQLite
async def mock_init_db():
    async with database.engine.begin() as conn:
        await conn.run_sync(database.Base.metadata.create_all)
        
    async with database.AsyncSessionLocal() as session:
        # Seed default auto-reply rules if empty
        from sqlalchemy import select
        stmt = select(database.AutoReplyRule)
        res = await session.execute(stmt)
        rules = res.scalars().all()
        if not rules:
            default_rules = [
                database.AutoReplyRule(keyword="fees", reply_text="fees reply text"),
                database.AutoReplyRule(keyword="hostel", reply_text="hostel reply text"),
                database.AutoReplyRule(keyword="eligibility", reply_text="eligibility reply text")
            ]
            session.add_all(default_rules)
            await session.commit()
            
    async with database.AsyncSessionLocal() as session:
        # Seed default admin user
        hashed = bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        admin = database.AdminUser(username="admin", hashed_password=hashed)
        session.add(admin)
        await session.commit()

database.init_db = mock_init_db
main.init_db = mock_init_db

@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

@pytest.fixture(scope="function")
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """Create a clean database session for each test function."""
    async with database.engine.begin() as conn:
        await conn.run_sync(database.Base.metadata.create_all)
        
    async with database.AsyncSessionLocal() as session:
        # Seed default admin user
        hashed = bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        admin = database.AdminUser(username="admin", hashed_password=hashed)
        session.add(admin)
        
        # Seed default rules
        default_rules = [
            database.AutoReplyRule(keyword="fees", reply_text="fees reply text"),
            database.AutoReplyRule(keyword="hostel", reply_text="hostel reply text"),
            database.AutoReplyRule(keyword="eligibility", reply_text="eligibility reply text")
        ]
        session.add_all(default_rules)
        await session.commit()
        
    async with database.AsyncSessionLocal() as session:
        yield session
        await session.rollback()
        
    async with database.engine.begin() as conn:
        await conn.run_sync(database.Base.metadata.drop_all)

@pytest.fixture(scope="function")
async def test_client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Create a test client that uses the overridden db dependency."""
    
    async def _get_db_override():
        try:
            yield db_session
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            raise

    # Override get_db
    main.app.dependency_overrides[database.get_db] = _get_db_override
    
    from httpx import ASGITransport
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        yield client
        
    # Clear override
    main.app.dependency_overrides.pop(database.get_db, None)

@pytest.fixture(scope="function")
def auth_headers() -> dict:
    """Generate JWT authorization headers for testing."""
    payload = {
        "sub": "admin",
        "exp": datetime.utcnow() + timedelta(hours=1)
    }
    token = jwt.encode(payload, main.JWT_SECRET, algorithm=main.JWT_ALGORITHM)
    return {"Authorization": f"Bearer {token}"}
