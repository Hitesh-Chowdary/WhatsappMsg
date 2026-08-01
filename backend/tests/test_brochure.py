import pytest
import io
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from database import BrochureDocument, Record

@pytest.mark.asyncio
async def test_brochure_upload_list_toggle_delete(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test uploading a text brochure, listing it, toggling active status, and deleting it."""
    # 1. Upload brochure
    file_content = b"Welcome to Tech University. Computer Science branch tuition fee is $10,000 per year. Hostel fees are $2,000 per year."
    files = {"file": ("sample_brochure.txt", io.BytesIO(file_content), "text/plain")}
    data = {"title": "Sample Campus Brochure"}

    res = await test_client.post("/api/v1/brochures/upload", headers=auth_headers, files=files, data=data)
    assert res.status_code == 200, res.text
    resp_data = res.json()
    assert resp_data["status"] == "success"
    brochure = resp_data["brochure"]
    assert brochure["title"] == "Sample Campus Brochure"
    assert "Computer Science" in brochure["extracted_text"]
    brochure_id = brochure["id"]

    # 2. List brochures
    list_res = await test_client.get("/api/v1/brochures", headers=auth_headers)
    assert list_res.status_code == 200
    b_list = list_res.json()
    assert len(b_list) >= 1
    assert any(b["id"] == brochure_id for b in b_list)

    # 3. Toggle active status
    toggle_res = await test_client.patch(f"/api/v1/brochures/{brochure_id}/toggle", headers=auth_headers)
    assert toggle_res.status_code == 200
    assert toggle_res.json()["brochure"]["is_active"] is False

    # 4. Delete brochure
    del_res = await test_client.delete(f"/api/v1/brochures/{brochure_id}", headers=auth_headers)
    assert del_res.status_code == 200
    assert del_res.json()["status"] == "success"

@pytest.mark.asyncio
async def test_brochure_ai_chatbot_response(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test incoming WhatsApp text message auto-replies using the AI Brochure engine."""
    # Create brochure document
    doc = BrochureDocument(
        title="Official Fee Structure",
        filename="fees.txt",
        file_path="dummy/path/fees.txt",
        extracted_text="Engineering tuition fee for CSE branch is $12,000 annually. Application deadline is August 31st.",
        is_active=True
    )
    db_session.add(doc)

    # Create candidate record
    rec = Record(
        student_name="Kiran Kumar",
        parent_name="Ramesh Kumar",
        selected_branch="CSE",
        phone_number="+919888877777",
        campaign_status="Sent",
        delivery_status="Read",
        parent_response="No Response"
    )
    db_session.add(rec)
    await db_session.commit()

    # Simulate incoming WhatsApp message asking about fees
    payload = {
        "event": "incoming_text",
        "from_phone": "+919888877777",
        "message_id": "wamid.test_brochure_query_001",
        "text_body": "What is the fee for CSE branch?"
    }

    res = await test_client.post("/api/v1/whatsapp/webhook", json=payload)
    assert res.status_code == 200
    res_data = res.json()
    assert res_data["status"] == "success"
