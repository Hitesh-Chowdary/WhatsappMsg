import pytest
from httpx import AsyncClient
from backend.database import AutoReplyRule
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

@pytest.mark.asyncio
async def test_get_rules_list(test_client: AsyncClient, auth_headers: dict):
    """Test fetching the auto-reply rules list."""
    res = await test_client.get("/api/v1/chat/rules", headers=auth_headers)
    assert res.status_code == 200
    rules = res.json()
    # Check that initial rules are present
    keywords = [r["keyword"] for r in rules]
    assert "fees" in keywords
    assert "hostel" in keywords
    assert "eligibility" in keywords

@pytest.mark.asyncio
async def test_create_rule_success(test_client: AsyncClient, auth_headers: dict):
    """Test manual rule creation."""
    payload = {
        "keyword": "scholarship",
        "reply_text": "We offer top scholarships."
    }
    res = await test_client.post("/api/v1/chat/rules", json=payload, headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["rule"]["keyword"] == "scholarship"
    assert data["rule"]["reply_text"] == "We offer top scholarships."

@pytest.mark.asyncio
async def test_create_rule_duplicate(test_client: AsyncClient, auth_headers: dict):
    """Test creation updates an existing keyword rule instead of throwing an error."""
    payload = {
        "keyword": "fees",  # already exists from seeding
        "reply_text": "Updated duplicate fees text"
    }
    res = await test_client.post("/api/v1/chat/rules", json=payload, headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["rule"]["keyword"] == "fees"
    assert data["rule"]["reply_text"] == "Updated duplicate fees text"

@pytest.mark.asyncio
async def test_delete_rule(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test deleting an auto-reply rule."""
    payload = {
        "keyword": "temporary",
        "reply_text": "temporary reply text"
    }
    res = await test_client.post("/api/v1/chat/rules", json=payload, headers=auth_headers)
    rule_id = res.json()["rule"]["id"]
    
    delete_res = await test_client.delete(f"/api/v1/chat/rules/{rule_id}", headers=auth_headers)
    assert delete_res.status_code == 200
    
    # Verify from DB
    stmt = select(AutoReplyRule).where(AutoReplyRule.id == rule_id)
    db_res = await db_session.execute(stmt)
    assert db_res.scalar_one_or_none() is None
