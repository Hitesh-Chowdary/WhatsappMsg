import pytest
import io
from httpx import AsyncClient
from backend.database import Record
from sqlalchemy.ext.asyncio import AsyncSession

@pytest.mark.asyncio
async def test_get_branches_list(test_client: AsyncClient, auth_headers: dict):
    """Test branches retrieval returns empty list when database is empty."""
    res = await test_client.get("/api/v1/branches", headers=auth_headers)
    assert res.status_code == 200
    assert isinstance(res.json(), list)

@pytest.mark.asyncio
async def test_stats_aggregation_empty(test_client: AsyncClient, auth_headers: dict):
    """Test stats aggregation counts when no records are present."""
    res = await test_client.get("/api/v1/stats", headers=auth_headers)
    assert res.status_code == 200
    stats = res.json()
    assert stats["total"] == 0
    assert stats["sent"] == 0
    assert stats["read"] == 0
    assert stats["interested"] == 0

@pytest.mark.asyncio
async def test_lead_records_upload_and_export(test_client: AsyncClient, auth_headers: dict):
    """Test importing lead spreadsheet via /api/v1/upload and exporting via /api/v1/records/export."""
    csv_data = (
        "Student Name,Parent Name,Selected Branch,Phone Number\n"
        "Lead One,Parent One,Computer Science,9991114444\n"
        "Lead Two,Parent Two,Information Technology,9991115555\n"
    )
    csv_bytes = csv_data.encode("utf-8")
    files = {"file": ("leads.csv", csv_bytes, "text/csv")}
    
    # 1. Upload
    upload_res = await test_client.post("/api/v1/upload", files=files, headers=auth_headers)
    assert upload_res.status_code == 200
    assert upload_res.json()["added"] == 2
    
    # 2. Query Branches
    branches_res = await test_client.get("/api/v1/branches", headers=auth_headers)
    assert "Computer Science" in branches_res.json()
    assert "Information Technology" in branches_res.json()
    
    # 3. Query Records Grid
    records_res = await test_client.get("/api/v1/records?limit=10", headers=auth_headers)
    assert records_res.status_code == 200
    assert records_res.json()["total"] == 2
    
    # 4. Check Stats updated
    stats_res = await test_client.get("/api/v1/stats", headers=auth_headers)
    assert stats_res.json()["total"] == 2
    
    # 5. Export to Excel
    export_res = await test_client.get("/api/v1/records/export", headers=auth_headers)
    assert export_res.status_code == 200
    assert export_res.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
