import pytest
from httpx import AsyncClient
from backend.database import Record, AutoReplyRule, BotFlow
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

@pytest.mark.asyncio
async def test_chatbot_auto_reply_keyword_fees(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test chatbot matches keyword 'fees' and responds with the fees rule text."""
    # Seed a contact
    contact = Record(
        student_name="Test Student",
        parent_name="Test Parent",
        phone_number="919999999999",
        selected_branch="Computer Science",
        campaign_status="Sent",
        delivery_status="Sent",
        parent_response="No Response"
    )
    db_session.add(contact)
    await db_session.commit()
    await db_session.refresh(contact)
    
    # Simulate webhook incoming message
    payload = {
        "event": "incoming_text",
        "message_id": "wa_test_msg_fees",
        "from_phone": "919999999999",
        "text_body": "What are the college fees?"
    }
    res = await test_client.post("/api/v1/whatsapp/webhook", json=payload)
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    
    # Retrieve chat history
    history_res = await test_client.get(f"/api/v1/chat/history/{contact.id}", headers=auth_headers)
    assert history_res.status_code == 200
    history = history_res.json()["messages"]
    
    # We expect 2 messages: the parent's incoming message and the system's auto-reply
    assert len(history) >= 2
    
    # Parent message check
    parent_msg = next((m for m in history if m["sender"] == "parent"), None)
    assert parent_msg is not None
    assert parent_msg["message_text"] == "What are the college fees?"
    
    # System response check (should match the seeded 'fees' rule text: "fees reply text")
    system_msg = next((m for m in history if m["sender"] == "system"), None)
    assert system_msg is not None
    assert system_msg["message_text"] == "fees reply text"

@pytest.mark.asyncio
async def test_chatbot_auto_reply_fallback_default(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test chatbot falls back to default rule when no keyword is matched."""
    # Add a default auto-reply rule
    default_rule = AutoReplyRule(
        keyword="default",
        reply_text="This is the default response."
    )
    db_session.add(default_rule)
    await db_session.commit()
    
    contact = Record(
        student_name="Test Student",
        parent_name="Test Parent",
        phone_number="919999999998",
        selected_branch="Computer Science"
    )
    db_session.add(contact)
    await db_session.commit()
    await db_session.refresh(contact)
    
    payload = {
        "event": "incoming_text",
        "message_id": "wa_test_msg_unknown",
        "from_phone": "919999999998",
        "text_body": "Tell me something random."
    }
    res = await test_client.post("/api/v1/whatsapp/webhook", json=payload)
    assert res.status_code == 200
    
    # Retrieve chat history
    history_res = await test_client.get(f"/api/v1/chat/history/{contact.id}", headers=auth_headers)
    history = history_res.json()["messages"]
    
    system_msg = next((m for m in history if m["sender"] == "system"), None)
    assert system_msg is not None
    assert system_msg["message_text"] == "This is the default response."

@pytest.mark.asyncio
async def test_chatbot_auto_reply_variables_replacement(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test chatbot replaces variables like [Student Name] or [Parent Name] in the rule reply text."""
    # Add rule with variable placeholder
    var_rule = AutoReplyRule(
        keyword="greeting",
        reply_text="Hello [Parent Name], how is [Student Name]?"
    )
    db_session.add(var_rule)
    await db_session.commit()
    
    contact = Record(
        student_name="Alice Jones",
        parent_name="Mr. Jones",
        phone_number="919999999997",
        selected_branch="Computer Science",
        variables={"student_name": "Alice Jones", "parent_name": "Mr. Jones"}
    )
    db_session.add(contact)
    await db_session.commit()
    await db_session.refresh(contact)
    
    payload = {
        "event": "incoming_text",
        "message_id": "wa_test_msg_vars",
        "from_phone": "919999999997",
        "text_body": "Let's test greeting rule."
    }
    res = await test_client.post("/api/v1/whatsapp/webhook", json=payload)
    assert res.status_code == 200
    
    # Retrieve chat history
    history_res = await test_client.get(f"/api/v1/chat/history/{contact.id}", headers=auth_headers)
    history = history_res.json()["messages"]
    
    system_msg = next((m for m in history if m["sender"] == "system" and "Hello" in m["message_text"]), None)
    assert system_msg is not None
    assert system_msg["message_text"] == "Hello Mr. Jones, how is Alice Jones?"

@pytest.mark.asyncio
async def test_template_specific_flows(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test chatbot routes incoming messages to different flows based on the record's sent_template."""
    # 1. Create two template-specific BotFlows
    flow_admission = BotFlow(
        name="Admission Flow",
        template_name="admission_outreach",
        is_active=True,
        flow_data={
            "nodes": [
                {"id": "tr-1", "type": "trigger", "data": {"keyword": "interested"}},
                {"id": "msg-1", "type": "message", "data": {"text": "Welcome to Admission outreach flow!"}}
            ],
            "edges": [
                {"source": "tr-1", "target": "msg-1"}
            ]
        }
    )
    flow_parent = BotFlow(
        name="Parent Flow",
        template_name="parent_outreach",
        is_active=True,
        flow_data={
            "nodes": [
                {"id": "tr-2", "type": "trigger", "data": {"keyword": "interested"}},
                {"id": "msg-2", "type": "message", "data": {"text": "Welcome to Parent outreach flow!"}}
            ],
            "edges": [
                {"source": "tr-2", "target": "msg-2"}
            ]
        }
    )
    db_session.add_all([flow_admission, flow_parent])
    await db_session.commit()

    # 2. Create two contacts with different sent_templates
    contact_1 = Record(
        student_name="Student One",
        parent_name="Parent One",
        phone_number="919999999991",
        selected_branch="Computer Science",
        sent_template="admission_outreach"
    )
    contact_2 = Record(
        student_name="Student Two",
        parent_name="Parent Two",
        phone_number="919999999992",
        selected_branch="Information Technology",
        sent_template="parent_outreach"
    )
    db_session.add_all([contact_1, contact_2])
    await db_session.commit()
    await db_session.refresh(contact_1)
    await db_session.refresh(contact_2)

    # 3. Simulate "interested" text from Contact 1 (should match flow_admission)
    payload_1 = {
        "event": "incoming_text",
        "message_id": "wa_test_msg_c1",
        "from_phone": "919999999991",
        "text_body": "interested"
    }
    res_1 = await test_client.post("/api/v1/whatsapp/webhook", json=payload_1)
    assert res_1.status_code == 200

    # Verify response
    history_res_1 = await test_client.get(f"/api/v1/chat/history/{contact_1.id}", headers=auth_headers)
    history_1 = history_res_1.json()["messages"]
    system_msg_1 = next((m for m in history_1 if m["sender"] == "system"), None)
    assert system_msg_1 is not None
    assert system_msg_1["message_text"] == "Welcome to Admission outreach flow!"

    # 4. Simulate "interested" text from Contact 2 (should match flow_parent)
    payload_2 = {
        "event": "incoming_text",
        "message_id": "wa_test_msg_c2",
        "from_phone": "919999999992",
        "text_body": "interested"
    }
    res_2 = await test_client.post("/api/v1/whatsapp/webhook", json=payload_2)
    assert res_2.status_code == 200

    # Verify response
    history_res_2 = await test_client.get(f"/api/v1/chat/history/{contact_2.id}", headers=auth_headers)
    history_2 = history_res_2.json()["messages"]
    system_msg_2 = next((m for m in history_2 if m["sender"] == "system"), None)
    assert system_msg_2 is not None
    assert system_msg_2["message_text"] == "Welcome to Parent outreach flow!"
