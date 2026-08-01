import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from database import AdminUser
import bcrypt

@pytest.mark.asyncio
async def test_user_email_login_and_creation(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test user creation, email login, status toggle, and deletion."""
    # 1. Create a staff member via POST /api/v1/users
    payload = {
        "full_name": "Anitha Counselor",
        "email": "anitha@university.edu.in",
        "username": "anitha",
        "password": "counselorPass123",
        "role": "counselor"
    }
    res = await test_client.post("/api/v1/users", json=payload, headers=auth_headers)
    assert res.status_code == 200
    user_data = res.json()["user"]
    assert user_data["email"] == "anitha@university.edu.in"
    assert user_data["role"] == "counselor"
    user_id = user_data["id"]

    # 2. Login using EMAIL instead of username
    login_res = await test_client.post("/api/v1/auth/login", json={
        "username": "anitha@university.edu.in",
        "password": "counselorPass123"
    })
    assert login_res.status_code == 200
    assert "access_token" in login_res.json()
    assert login_res.json()["user"]["full_name"] == "Anitha Counselor"

    # 3. List users
    list_res = await test_client.get("/api/v1/users", headers=auth_headers)
    assert list_res.status_code == 200
    users_list = list_res.json()
    assert len(users_list) >= 2

    # 4. Toggle active status
    status_res = await test_client.patch(f"/api/v1/users/{user_id}/status", headers=auth_headers)
    assert status_res.status_code == 200
    assert status_res.json()["user"]["is_active"] is False

    # 5. Verify disabled user cannot log in
    failed_login = await test_client.post("/api/v1/auth/login", json={
        "username": "anitha@university.edu.in",
        "password": "counselorPass123"
    })
    assert failed_login.status_code == 401
    assert "deactivated" in failed_login.json()["detail"].lower()

    # 6. Delete user
    del_res = await test_client.delete(f"/api/v1/users/{user_id}", headers=auth_headers)
    assert del_res.status_code == 200
