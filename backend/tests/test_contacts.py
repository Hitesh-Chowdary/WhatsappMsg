import pytest
import io
from httpx import AsyncClient
from backend.database import Record
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

@pytest.mark.asyncio
async def test_create_contact_success(test_client: AsyncClient, auth_headers: dict):
    """Test manual contact creation with valid inputs and phone normalization."""
    payload = {
        "student_name": "John Doe",
        "parent_name": "Richard Doe",
        "phone_number": "9998887776",
        "selected_branch": "Computer Science",
        "pipeline_tag": "Lead"
    }
    res = await test_client.post("/api/v1/contacts", json=payload, headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["contact"]["student_name"] == "John Doe"
    # phone should be normalized with 91 prefix
    assert data["contact"]["phone_number"] == "919998887776"
    assert data["contact"]["pipeline_tag"] == "Lead"

@pytest.mark.asyncio
async def test_create_contact_duplicate_phone(test_client: AsyncClient, auth_headers: dict):
    """Test manual contact creation rejects duplicate phone number."""
    payload = {
        "student_name": "John Doe",
        "parent_name": "Richard Doe",
        "phone_number": "9998887776",
        "selected_branch": "Computer Science",
        "pipeline_tag": "Lead"
    }
    # Create once
    res1 = await test_client.post("/api/v1/contacts", json=payload, headers=auth_headers)
    assert res1.status_code == 200
    
    # Create again
    res2 = await test_client.post("/api/v1/contacts", json=payload, headers=auth_headers)
    assert res2.status_code == 400
    assert "already exists" in res2.json()["detail"]

@pytest.mark.asyncio
async def test_create_contact_invalid_phone(test_client: AsyncClient, auth_headers: dict):
    """Test manual contact creation rejects invalid short phone number."""
    payload = {
        "student_name": "John Doe",
        "parent_name": "Richard Doe",
        "phone_number": "12345",
        "selected_branch": "Computer Science"
    }
    res = await test_client.post("/api/v1/contacts", json=payload, headers=auth_headers)
    assert res.status_code == 400
    assert "Invalid phone number" in res.json()["detail"]

@pytest.mark.asyncio
async def test_get_contacts_list_and_filters(test_client: AsyncClient, auth_headers: dict):
    """Test retrieving contact list, search, and branch/tag filters."""
    # Seed a couple contacts
    c1 = {
        "student_name": "Alice Smith",
        "parent_name": "Bob Smith",
        "phone_number": "9990001111",
        "selected_branch": "Computer Science",
        "pipeline_tag": "Lead"
    }
    c2 = {
        "student_name": "Bob Jones",
        "parent_name": "Cathy Jones",
        "phone_number": "9990002222",
        "selected_branch": "Information Technology",
        "pipeline_tag": "Contacted"
    }
    await test_client.post("/api/v1/contacts", json=c1, headers=auth_headers)
    await test_client.post("/api/v1/contacts", json=c2, headers=auth_headers)
    
    # Fetch all
    res = await test_client.get("/api/v1/contacts?limit=10", headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 2
    assert len(data["contacts"]) == 2
    
    # Search filter
    res_search = await test_client.get("/api/v1/contacts?search=Alice", headers=auth_headers)
    assert res_search.status_code == 200
    assert res_search.json()["total"] == 1
    assert res_search.json()["contacts"][0]["student_name"] == "Alice Smith"

    # Branch filter
    res_branch = await test_client.get("/api/v1/contacts?branch=Information Technology", headers=auth_headers)
    assert res_branch.status_code == 200
    assert res_branch.json()["total"] == 1
    assert res_branch.json()["contacts"][0]["student_name"] == "Bob Jones"

    # Tag filter
    res_tag = await test_client.get("/api/v1/contacts?pipeline_tag=Contacted", headers=auth_headers)
    assert res_tag.status_code == 200
    assert res_tag.json()["total"] == 1
    assert res_tag.json()["contacts"][0]["student_name"] == "Bob Jones"

@pytest.mark.asyncio
async def test_update_contact(test_client: AsyncClient, auth_headers: dict):
    """Test updating details of an existing contact."""
    payload = {
        "student_name": "Jane",
        "parent_name": "Tarzan",
        "phone_number": "9990003333",
        "selected_branch": "Electronics"
    }
    create_res = await test_client.post("/api/v1/contacts", json=payload, headers=auth_headers)
    cid = create_res.json()["contact"]["id"]
    
    update_payload = {
        "student_name": "Jane Doe",
        "pipeline_tag": "Interested"
    }
    update_res = await test_client.put(f"/api/v1/contacts/{cid}", json=update_payload, headers=auth_headers)
    assert update_res.status_code == 200
    updated = update_res.json()["contact"]
    assert updated["student_name"] == "Jane Doe"
    assert updated["pipeline_tag"] == "Interested"

@pytest.mark.asyncio
async def test_delete_contact(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test deleting a contact."""
    payload = {
        "student_name": "To Be Deleted",
        "parent_name": "Deleted Parent",
        "phone_number": "9990004444",
        "selected_branch": "Chemical"
    }
    create_res = await test_client.post("/api/v1/contacts", json=payload, headers=auth_headers)
    cid = create_res.json()["contact"]["id"]
    
    delete_res = await test_client.delete(f"/api/v1/contacts/{cid}", headers=auth_headers)
    assert delete_res.status_code == 200
    
    # Confirm it is deleted from the database
    stmt = select(Record).where(Record.id == cid)
    res = await db_session.execute(stmt)
    assert res.scalar_one_or_none() is None

@pytest.mark.asyncio
async def test_contacts_upload_csv(test_client: AsyncClient, auth_headers: dict):
    """Test contacts bulk upload parser using simulated CSV content."""
    contacts_csv = (
        "Student Name,Parent Name,Selected Branch,Phone Number\n"
        "Bulk Student 1,Parent 1,Computer Science,9991112222\n"
        "Bulk Student 2,Parent 2,Information Technology,9991113333\n"
    )
    csv_bytes = contacts_csv.encode("utf-8")
    files = {"file": ("contacts.csv", csv_bytes, "text/csv")}
    
    res = await test_client.post("/api/v1/contacts/upload", files=files, headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["added"] == 2
    assert data["updated"] == 0
