import pytest
from httpx import AsyncClient
from backend.database import AdminUser
from sqlalchemy.ext.asyncio import AsyncSession

@pytest.mark.asyncio
async def test_login_success(test_client: AsyncClient):
    """Test login with valid administrator credentials."""
    login_payload = {"username": "admin", "password": "admin123"}
    res = await test_client.post("/api/v1/auth/login", json=login_payload)
    assert res.status_code == 200
    data = res.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"

@pytest.mark.asyncio
async def test_login_invalid_credentials(test_client: AsyncClient):
    """Test login with incorrect credentials returns 401."""
    login_payload = {"username": "admin", "password": "wrongpassword"}
    res = await test_client.post("/api/v1/auth/login", json=login_payload)
    assert res.status_code == 401
    assert "detail" in res.json()

@pytest.mark.asyncio
async def test_endpoint_unauthorized_access(test_client: AsyncClient):
    """Test that secured endpoints block unauthenticated requests with 401."""
    res = await test_client.get("/api/v1/stats")
    assert res.status_code == 401
